import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react';
import {
  AlertTriangle,
  ArrowLeft,
  Check,
  Crop,
  Pause,
  Play,
  Redo2,
  StepBack,
  StepForward,
  Undo2,
} from 'lucide-react';
import {
  ITEM_KINDS,
  outputDurationMs,
  projectSegments,
  sourceToOutput,
  type ItemKind,
} from '../../../shared/video-edit';
import { Button } from '../../components/ui/Button';
import { EmptyState } from '../../components/ui/EmptyState';
import { IconButton } from '../../components/ui/IconButton';
import { Kbd } from '../../components/ui/Kbd';
import { Loader } from '../../components/Loader';
import { Tooltip } from '../../components/ui/Tooltip';
import { announce } from '../../lib/notify';
import { cn } from '../../lib/cn';
import {
  cancelVideoExport,
  startVideoExport,
  useVideoExport,
} from '../../history/video-export-store';
import { ExportControls } from './ExportControls';
import { Inspector } from './Inspector';
import { KIND_STYLES } from './item-kinds';
import { Player } from './player';
import { PreviewStage } from './PreviewStage';
import { ASPECTS, type AspectId } from './rect-drag';
import { Timeline, type TimeRange, type TimelineSelection } from './Timeline';
import { formatTimecode } from './timeline-math';
import { useVideoProject, type SaveState } from './use-video-project';

export interface VideoEditorViewProps {
  historyId: string;
  /** True while a dialog is open over the editor: shortcuts are ignored. */
  blocked: boolean;
  /** Back to History. */
  onBack: () => void;
  /** Hands the app a function that writes pending changes (it asks before the editor is left). */
  registerFlush: (flush: (() => Promise<boolean>) | null) => void;
}

const SAVE_TEXT: Record<SaveState, string> = {
  saved: 'All changes saved',
  saving: 'Saving…',
  unsaved: 'Unsaved changes',
  failed: 'Could not save',
};

/** True while the user is typing or choosing in a control that owns the keys. */
function ownsKeys(target: EventTarget | null): boolean {
  return (
    target instanceof HTMLElement &&
    !!target.closest(
      'input:not([type="range"]), textarea, select, [contenteditable="true"], [role="menu"], [role="radiogroup"], [role="slider"]',
    )
  );
}

const newId = (): string => crypto.randomUUID();

/** Time read-outs that follow the player without re-rendering the editor. */
function TimeReadout({
  player,
  totalMs,
  segments,
}: {
  player: Player;
  totalMs: number;
  segments: ReturnType<typeof projectSegments>;
}) {
  const { timeMs } = useSyncExternalStore(player.subscribe, player.getSnapshot);
  const output = sourceToOutput(segments, timeMs);
  return (
    <div
      className="flex min-w-0 items-baseline gap-3 text-[13px] tabular-nums"
      data-testid="video-time"
    >
      <span className="text-fg" data-testid="time-source">
        {formatTimecode(timeMs)}
      </span>
      <span className="text-fg-subtle">
        Result {formatTimecode(output)} / {formatTimecode(totalMs)}
      </span>
    </div>
  );
}

/**
 * The video editor: preview with a drawing layer, timeline, inspector. Everything the user edits is
 * a command on the project (trim, cuts, items, crop, audio, fades), undoable, saved by itself;
 * "Export" makes a new file and never changes the recording.
 */
export function VideoEditorView({
  historyId,
  blocked,
  onBack,
  registerFlush,
}: VideoEditorViewProps) {
  const api = useVideoProject(historyId);
  const { project, commit, endGesture } = api;
  const exportState = useVideoExport(historyId);
  const [picked, setSelection] = useState<TimelineSelection>(null);
  const [range, setRange] = useState<TimeRange | null>(null);
  const [tool, setTool] = useState<ItemKind | null>(null);
  const [cropMode, setCropMode] = useState(false);
  const [cropAspect, setCropAspect] = useState<AspectId>('free');

  const projectRef = useRef(project);
  const segments = useMemo(() => (project ? projectSegments(project) : []), [project]);
  const [player] = useState(() => new Player());
  useLayoutEffect(() => {
    projectRef.current = project;
    player.configure({
      segments,
      fps: project?.source.fps,
      durationMs: project?.source.durationMs ?? 0,
    });
  }, [project, segments, player]);

  useEffect(() => {
    registerFlush(api.flush);
    return () => registerFlush(null);
  }, [api.flush, registerFlush]);

  // The first frame of the trim is where the editor opens.
  const startMs = project?.trim.startMs ?? 0;
  const loaded = api.load.status === 'ready';
  useEffect(() => {
    if (loaded) player.seek(startMs);
    // Only when the project first loads.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loaded, player]);

  // Something that no longer exists cannot stay selected (undo removed it).
  const selection: TimelineSelection =
    picked &&
    project &&
    (picked.kind === 'item'
      ? project.items.some((item) => item.id === picked.id)
      : project.cuts.some((cut) => cut.id === picked.id))
      ? picked
      : null;

  const cutRange = useCallback(() => {
    if (!range) return;
    commit({ type: 'addCut', id: newId(), startMs: range.startMs, endMs: range.endMs });
    setRange(null);
    announce('Range cut out');
  }, [range, commit]);

  const removeSelection = useCallback(() => {
    if (!selection) return;
    commit(
      selection.kind === 'item'
        ? { type: 'removeItem', id: selection.id }
        : { type: 'removeCut', id: selection.id },
    );
    setSelection(null);
  }, [selection, commit]);

  const mark = useCallback(
    (edge: 'in' | 'out') => {
      const current = projectRef.current;
      if (!current) return;
      const at = Math.max(
        current.trim.startMs,
        Math.min(current.trim.endMs, player.getSnapshot().timeMs),
      );
      setSelection(null);
      setRange((previous) =>
        edge === 'in'
          ? {
              startMs: at,
              endMs: previous && previous.endMs > at ? previous.endMs : current.trim.endMs,
            }
          : {
              startMs: previous && previous.startMs < at ? previous.startMs : current.trim.startMs,
              endMs: at,
            },
      );
    },
    [player],
  );

  const exportNow = useCallback(() => {
    const current = projectRef.current;
    if (current) void startVideoExport(historyId, current, current.export.format);
  }, [historyId]);

  // Keyboard.
  useEffect(() => {
    if (blocked || !loaded) return;
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.defaultPrevented || event.isComposing) return;
      const typing = ownsKeys(event.target);
      const mod = event.ctrlKey || event.metaKey;
      const key = event.key.toLowerCase();
      if (mod && !event.altKey) {
        if (key === 'z' && !typing) {
          event.preventDefault();
          if (event.shiftKey) api.redo();
          else api.undo();
        } else if (key === 'y' && !typing) {
          event.preventDefault();
          api.redo();
        } else if (key === 's') {
          event.preventDefault();
          void api.flush();
        }
        return;
      }
      if (typing || event.altKey) return;
      const onButton =
        event.target instanceof HTMLElement &&
        !!event.target.closest('button, a, [role="switch"], [role="button"]');
      if (event.key === ' ' && !onButton) {
        event.preventDefault();
        player.toggle();
      } else if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
        event.preventDefault();
        const direction = event.key === 'ArrowRight' ? 1 : -1;
        player.step(direction * (event.shiftKey ? 1000 : player.frameMs));
      } else if (event.key === 'Home' || event.key === 'End') {
        event.preventDefault();
        const trim = projectRef.current?.trim;
        if (trim) player.seek(event.key === 'Home' ? trim.startMs : trim.endMs);
      } else if (key === 'i' && !event.shiftKey) {
        mark('in');
      } else if (key === 'o' && !event.shiftKey) {
        mark('out');
      } else if (event.key === 'Delete' || event.key === 'Backspace') {
        if (selection) removeSelection();
        else if (range) cutRange();
        else return;
        event.preventDefault();
      } else if (event.key === 'Escape') {
        if (tool) setTool(null);
        else if (cropMode) setCropMode(false);
        else if (selection || range) {
          setSelection(null);
          setRange(null);
        } else return;
        event.preventDefault();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [
    blocked,
    loaded,
    api,
    player,
    mark,
    selection,
    range,
    tool,
    cropMode,
    removeSelection,
    cutRange,
  ]);

  // A pointer click on a button must not leave it holding the keyboard (Space would press it again).
  const releaseFocus = (event: React.MouseEvent): void => {
    const target = event.target;
    if (event.detail > 0 && target instanceof HTMLElement) {
      const button = target.closest('button');
      if (button && !button.hasAttribute('aria-haspopup') && !button.closest('[role="menu"]'))
        button.blur();
    }
  };

  const playing = useSyncExternalStore(player.subscribe, () => player.getSnapshot().playing);

  if (api.load.status !== 'ready' || !project) {
    return (
      <div className="flex h-full items-center justify-center p-8" data-testid="video-editor">
        {api.load.status === 'error' ? (
          <EmptyState
            icon={<AlertTriangle className="size-6" aria-hidden="true" />}
            title="This recording can't be edited"
            description={api.load.message}
            action={<Button onClick={onBack}>Back to History</Button>}
          />
        ) : (
          <Loader size="md" label="Opening the recording" showLabel />
        )}
      </div>
    );
  }

  const total = outputDurationMs(segments);
  const toolDefs = ITEM_KINDS.map((kind) => ({ kind, ...KIND_STYLES[kind] }));

  return (
    <div
      data-testid="video-editor"
      className="flex h-full min-h-0 flex-col bg-bg"
      onClick={releaseFocus}
    >
      <header className="flex h-12 shrink-0 items-center gap-2 border-b border-line bg-surface px-3">
        <Button
          size="sm"
          variant="ghost"
          data-testid="video-back"
          icon={<ArrowLeft className="size-4" aria-hidden="true" />}
          onClick={onBack}
        >
          History
        </Button>
        <h1 className="min-w-0 truncate text-sm font-semibold text-fg" data-testid="video-title">
          {api.fileName}
        </h1>
        <span className="hidden text-xs text-fg-subtle sm:inline">Video editor</span>
        <span className="mx-1 h-5 w-px bg-line" aria-hidden="true" />
        <IconButton
          size="sm"
          aria-label="Undo"
          data-testid="video-undo"
          disabled={!api.canUndo}
          icon={<Undo2 className="size-4" aria-hidden="true" />}
          onClick={api.undo}
        />
        <IconButton
          size="sm"
          aria-label="Redo"
          data-testid="video-redo"
          disabled={!api.canRedo}
          icon={<Redo2 className="size-4" aria-hidden="true" />}
          onClick={api.redo}
        />
        <span
          data-testid="video-save-status"
          data-state={api.save}
          className={cn(
            'ml-1 flex items-center gap-1.5 text-xs',
            api.save === 'failed' ? 'text-danger' : 'text-fg-muted',
          )}
        >
          {api.save === 'saved' ? (
            <Check className="size-3.5 text-success" aria-hidden="true" />
          ) : null}
          {SAVE_TEXT[api.save]}
        </span>
        <div className="ml-auto">
          <ExportControls
            project={project}
            state={exportState}
            commit={commit}
            onExport={exportNow}
            onCancel={() => void cancelVideoExport(historyId)}
          />
        </div>
      </header>

      <div className="flex min-h-0 flex-1">
        <div className="flex min-w-0 flex-1 flex-col">
          <PreviewStage
            historyId={historyId}
            project={project}
            player={player}
            selectedId={selection?.kind === 'item' ? selection.id : null}
            onSelect={(id) => setSelection(id ? { kind: 'item', id } : null)}
            tool={tool}
            onToolDone={() => setTool(null)}
            cropMode={cropMode}
            cropAspect={ASPECTS.find((aspect) => aspect.id === cropAspect)?.ratio ?? null}
            commit={commit}
            endGesture={endGesture}
            newId={newId}
          />
          <div className="flex h-12 shrink-0 items-center gap-2 border-t border-line bg-surface px-3">
            <Tooltip
              content={
                <span className="flex items-center gap-2">
                  {playing ? 'Pause' : 'Play'} <Kbd keys={['Space']} />
                </span>
              }
              side="top"
            >
              <Button
                size="sm"
                variant="primary"
                data-testid="video-play"
                aria-label={playing ? 'Pause' : 'Play'}
                onClick={() => player.toggle()}
                className="w-10 px-0"
                icon={
                  playing ? (
                    <Pause className="size-4" aria-hidden="true" />
                  ) : (
                    <Play className="size-4" aria-hidden="true" />
                  )
                }
              />
            </Tooltip>
            <IconButton
              size="sm"
              aria-label="Back one frame"
              data-testid="video-frame-back"
              icon={<StepBack className="size-4" aria-hidden="true" />}
              onClick={() => player.step(-player.frameMs)}
            />
            <IconButton
              size="sm"
              aria-label="Forward one frame"
              data-testid="video-frame-forward"
              icon={<StepForward className="size-4" aria-hidden="true" />}
              onClick={() => player.step(player.frameMs)}
            />
            <TimeReadout player={player} totalMs={total} segments={segments} />
            <div
              role="toolbar"
              aria-label="Editing tools"
              className="ml-auto flex items-center gap-1"
            >
              {toolDefs.map(({ kind, label, hint, icon: Icon }) => (
                <Tooltip key={kind} content={hint} side="top">
                  <Button
                    size="sm"
                    variant={tool === kind ? 'primary' : 'secondary'}
                    data-testid={`tool-${kind}`}
                    aria-pressed={tool === kind}
                    icon={<Icon className="size-4" aria-hidden="true" />}
                    onClick={() => {
                      setCropMode(false);
                      setTool(tool === kind ? null : kind);
                    }}
                  >
                    {label}
                  </Button>
                </Tooltip>
              ))}
              <Tooltip content="Crop the picture" side="top">
                <Button
                  size="sm"
                  variant={cropMode ? 'primary' : 'secondary'}
                  data-testid="tool-crop"
                  aria-pressed={cropMode}
                  icon={<Crop className="size-4" aria-hidden="true" />}
                  onClick={() => {
                    setTool(null);
                    setCropMode(!cropMode);
                  }}
                >
                  Crop
                </Button>
              </Tooltip>
            </div>
          </div>
        </div>
        <Inspector
          project={project}
          player={player}
          selection={selection}
          range={range}
          commit={commit}
          endGesture={endGesture}
          onRemoveSelection={removeSelection}
          onCutRange={cutRange}
          cropMode={cropMode}
          onCropMode={(on) => {
            setTool(null);
            setCropMode(on);
          }}
          cropAspect={cropAspect}
          onCropAspect={setCropAspect}
        />
      </div>

      <Timeline
        project={project}
        player={player}
        selection={selection}
        onSelect={setSelection}
        range={range}
        onRange={setRange}
        commit={commit}
        endGesture={endGesture}
        onCutRange={cutRange}
        onMarkIn={() => mark('in')}
        onMarkOut={() => mark('out')}
      />
    </div>
  );
}
