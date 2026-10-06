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
import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import {
  MASK_KINDS,
  MIN_ITEM_MS,
  newAudio,
  newImage,
  outputDurationMs,
  projectSegments,
  sourceToOutput,
  type PixelRect,
  type TextItem,
} from '../../../shared/video-edit';
import { decodeToPng } from '../../editor/decode';
import { HistoryImagePicker } from '../editor/HistoryImagePicker';
import { Button } from '../../components/ui/Button';
import { EmptyState } from '../../components/ui/EmptyState';
import { IconButton } from '../../components/ui/IconButton';
import { Kbd } from '../../components/ui/Kbd';
import { Loader } from '../../components/Loader';
import { Tooltip } from '../../components/ui/Tooltip';
import { announce, notify } from '../../lib/notify';
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
import { clipSpecs } from './clip-spec';
import { PreviewStage, type DrawTool } from './PreviewStage';
import { rasterizeText } from './text-draw';
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
  const [tool, setTool] = useState<DrawTool | null>(null);
  const [historyPicker, setHistoryPicker] = useState(false);
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

  // Text is drawn here (the same code as the preview) and handed to the export as pictures.
  const exportNow = useCallback(async () => {
    const current = projectRef.current;
    if (!current) return;
    const texts = current.items.filter((item): item is TextItem => item.kind === 'text');
    try {
      const overlays = await Promise.all(
        texts.map(async (item) => ({ itemId: item.id, png: await rasterizeText(item) })),
      );
      await startVideoExport(historyId, current, current.export.format, overlays);
    } catch {
      notify.error('A text box is too large to export. Make it smaller and try again.');
    }
  }, [historyId]);

  // The audio clips play along in the preview; the player's audio elements go with the editor.
  const specs = useMemo(
    () => (project ? clipSpecs(historyId, project.items) : []),
    [project, historyId],
  );
  useEffect(() => player.setClips(specs), [player, specs]);
  useEffect(() => () => player.dispose(), [player]);

  /** Where a new item goes in time: from the playhead for three seconds, inside the trim. */
  const defaultSpan = useCallback((): { startMs: number; endMs: number } | null => {
    const current = projectRef.current;
    if (!current) return null;
    const { trim } = current;
    const now = player.getSnapshot().timeMs;
    const endMs = Math.min(trim.endMs, Math.max(trim.startMs, now) + 3000);
    return { startMs: Math.max(trim.startMs, Math.min(now, endMs - MIN_ITEM_MS)), endMs };
  }, [player]);

  /** A picture (PNG bytes) becomes an image item in the middle of the frame, a few seconds long. */
  const addPicture = useCallback(
    async (png: ArrayBuffer) => {
      const current = projectRef.current;
      const span = defaultSpan();
      if (!current || !span) return;
      const response = await window.framecapt.invoke('video:addImage', { historyId, png });
      if (!response.ok) {
        notify.error(response.error);
        return;
      }
      const bitmap = await createImageBitmap(new Blob([png], { type: 'image/png' }));
      const natural = { width: bitmap.width, height: bitmap.height };
      bitmap.close();
      const { width: frameWidth, height: frameHeight } = current.source;
      const scale = Math.min(
        1,
        (frameWidth * 0.4) / natural.width,
        (frameHeight * 0.4) / natural.height,
      );
      const width = Math.max(8, Math.round(natural.width * scale));
      const height = Math.max(8, Math.round(natural.height * scale));
      const rect: PixelRect = {
        x: Math.round((frameWidth - width) / 2),
        y: Math.round((frameHeight - height) / 2),
        width,
        height,
      };
      const id = newId();
      commit({
        type: 'addItem',
        item: newImage(id, response.data.assetId, rect, span.startMs, span.endMs),
      });
      setSelection({ kind: 'item', id });
    },
    [commit, defaultSpan, historyId],
  );

  const pictureFromFile = useCallback(async () => {
    const response = await window.framecapt.invoke('editor:pickImage');
    if (!response.ok) {
      notify.error(response.error);
      return;
    }
    if (!('bytes' in response.data)) return;
    try {
      await addPicture((await decodeToPng(new Blob([response.data.bytes]))).png);
    } catch {
      notify.error('That picture could not be read.');
    }
  }, [addPicture]);

  const pictureFromHistory = useCallback(
    async (id: string) => {
      setHistoryPicker(false);
      const response = await window.framecapt.invoke('editor:historyImage', { historyId: id });
      if (response.ok) await addPicture(response.data.png);
      else notify.error(response.error);
    },
    [addPicture],
  );

  /** Add audio: a file dialog in main, then a clip at the playhead (it can be moved and trimmed). */
  const addAudio = useCallback(async () => {
    const response = await window.framecapt.invoke('video:pickAudio', { historyId });
    if (!response.ok) {
      notify.error(response.error);
      return;
    }
    if ('cancelled' in response.data) return;
    const { assetId, ext, name, durationMs } = response.data;
    const current = projectRef.current;
    if (!current) return;
    const at = Math.min(
      current.source.durationMs - MIN_ITEM_MS,
      Math.max(current.trim.startMs, player.getSnapshot().timeMs),
    );
    const id = newId();
    commit({
      type: 'addItem',
      item: newAudio(id, { assetId, ext, name, clipMs: durationMs }, at),
    });
    setSelection({ kind: 'item', id });
    announce('Audio clip added');
  }, [commit, historyId, player]);

  // Keyboard.
  useEffect(() => {
    if (blocked || historyPicker || !loaded) return;
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
    historyPicker,
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
    if (event.detail > 0 && target instanceof Element) {
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
  const toolDefs = [...MASK_KINDS, 'text' as const].map((kind) => ({
    kind,
    ...KIND_STYLES[kind],
  }));
  const ImageIcon = KIND_STYLES.image.icon;
  const AudioIcon = KIND_STYLES.audio.icon;

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
            onExport={() => void exportNow()}
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
                    aria-label={label}
                    icon={<Icon className="size-4" aria-hidden="true" />}
                    onClick={() => {
                      setCropMode(false);
                      setTool(tool === kind ? null : kind);
                    }}
                  >
                    <span className="hidden 2xl:inline">{label}</span>
                  </Button>
                </Tooltip>
              ))}
              <DropdownMenu.Root>
                <Tooltip content={KIND_STYLES.image.hint} side="top">
                  <DropdownMenu.Trigger asChild>
                    <Button
                      size="sm"
                      variant="secondary"
                      data-testid="tool-image"
                      aria-label="Image"
                      icon={<ImageIcon className="size-4" aria-hidden="true" />}
                    >
                      <span className="hidden 2xl:inline">Image</span>
                    </Button>
                  </DropdownMenu.Trigger>
                </Tooltip>
                <DropdownMenu.Portal>
                  <DropdownMenu.Content
                    align="end"
                    sideOffset={6}
                    className="z-50 min-w-48 rounded-xl border border-line bg-surface p-1.5 text-[13px] text-fg shadow-raised"
                  >
                    <DropdownMenu.Item
                      data-testid="image-from-file"
                      onSelect={() => void pictureFromFile()}
                      className="flex cursor-default items-center rounded-lg px-2.5 py-2 outline-none data-[highlighted]:bg-accent-soft data-[highlighted]:text-accent-fg"
                    >
                      From a file…
                    </DropdownMenu.Item>
                    <DropdownMenu.Item
                      data-testid="image-from-history"
                      onSelect={() => setHistoryPicker(true)}
                      className="flex cursor-default items-center rounded-lg px-2.5 py-2 outline-none data-[highlighted]:bg-accent-soft data-[highlighted]:text-accent-fg"
                    >
                      From History…
                    </DropdownMenu.Item>
                  </DropdownMenu.Content>
                </DropdownMenu.Portal>
              </DropdownMenu.Root>
              <Tooltip content={KIND_STYLES.audio.hint} side="top">
                <Button
                  size="sm"
                  variant="secondary"
                  data-testid="tool-audio"
                  aria-label="Audio"
                  icon={<AudioIcon className="size-4" aria-hidden="true" />}
                  onClick={() => void addAudio()}
                >
                  <span className="hidden 2xl:inline">Audio</span>
                </Button>
              </Tooltip>
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
      <HistoryImagePicker
        open={historyPicker}
        onClose={() => setHistoryPicker(false)}
        onPick={(id) => void pictureFromHistory(id)}
      />
    </div>
  );
}
