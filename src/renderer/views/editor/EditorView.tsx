import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react';
import { toast } from 'sonner';
import type { ImageFormat, ShotSessionMeta } from '../../../shared/shots';
import { flattenToBlob } from '../../editor/export';
import type { Command } from '../../editor/model/commands';
import {
  canRedo,
  canUndo,
  commit,
  createHistory,
  endGesture,
  redo,
  undo,
  type History,
} from '../../editor/model/history';
import { moveAnnotation } from '../../editor/model/hit-test';
import { createDoc, exportSize, type Rect } from '../../editor/model/types';
import {
  DEFAULT_COLOR,
  fontSizeFor,
  nearestStep,
  strokeWidthFor,
  type SizeStep,
} from '../../editor/presets';
import { EditorStage, type StageHandle } from './EditorStage';
import { EditorToolbar } from './EditorToolbar';
import { OptionsStrip } from './OptionsStrip';
import { TOOLS, toolForKey, type ToolId } from './tools';
import { Button } from '../../components/ui/Button';

export interface EditorShot {
  session: ShotSessionMeta;
  /** The original capture (PNG). It stays in memory only as the decoded base image. */
  png: ArrayBuffer;
}

export interface EditorViewProps {
  shot: EditorShot;
  /** True while a dialog is open over the editor: shortcuts are ignored. */
  blocked: boolean;
  /** Edits or nothing saved yet: leaving would lose work. */
  onDirtyChange: (dirty: boolean) => void;
  /** Done / Discard was pressed. The app decides whether to confirm. */
  onRequestLeave: () => void;
}

type HistoryAction =
  | { type: 'commit'; command: Command; gesture?: string }
  | { type: 'endGesture' }
  | { type: 'undo' }
  | { type: 'redo' };

function historyReducer(state: History, action: HistoryAction): History {
  switch (action.type) {
    case 'commit':
      return commit(state, action.command, action.gesture);
    case 'endGesture':
      return endGesture(state);
    case 'undo':
      return undo(state);
    case 'redo':
      return redo(state);
  }
}

/** "…\Framelet\file.png" for a toast: the last two path segments. */
function shortPath(file: string): string {
  const parts = file.split(/[\\/]/).filter(Boolean);
  return parts.length > 2 ? `…\\${parts.slice(-2).join('\\')}` : file;
}

/** Decodes the original once; everything else draws from this bitmap. */
export function EditorView(props: EditorViewProps) {
  const [bitmap, setBitmap] = useState<ImageBitmap | null>(null);
  const [failed, setFailed] = useState(false);
  const { png } = props.shot;

  useEffect(() => {
    let cancelled = false;
    let decoded: ImageBitmap | null = null;
    createImageBitmap(new Blob([png], { type: 'image/png' }), {
      premultiplyAlpha: 'none',
      colorSpaceConversion: 'none',
    })
      .then((result) => {
        if (cancelled) result.close();
        else {
          decoded = result;
          setBitmap(result);
        }
      })
      .catch(() => {
        if (!cancelled) setFailed(true);
      });
    return () => {
      cancelled = true;
      decoded?.close();
    };
  }, [png]);

  if (failed) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-4 text-center">
        <p className="text-sm text-fg-muted">This screenshot could not be opened.</p>
        <Button onClick={props.onRequestLeave}>Close</Button>
      </div>
    );
  }
  if (!bitmap) return <div className="h-full" data-testid="editor-loading" aria-busy="true" />;
  return <EditorWorkspace {...props} bitmap={bitmap} />;
}

function EditorWorkspace({
  shot,
  bitmap,
  blocked,
  onDirtyChange,
  onRequestLeave,
}: EditorViewProps & { bitmap: ImageBitmap }) {
  const [history, dispatch] = useReducer(historyReducer, undefined, () =>
    createHistory(createDoc(bitmap.width, bitmap.height)),
  );
  const doc = history.present;
  const [tool, setTool] = useState<ToolId>('select');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [color, setColor] = useState<string>(DEFAULT_COLOR);
  const [widthStep, setWidthStep] = useState<0 | 1 | 2>(1);
  const [fontStep, setFontStep] = useState<SizeStep>(1);
  const [cropDraft, setCropDraftState] = useState<Rect | null>(null);
  const [zoom, setZoom] = useState(1);
  const [busy, setBusy] = useState<'copy' | ImageFormat | null>(null);
  const [announcement, setAnnouncement] = useState({ text: '', n: 0 });
  /** The document as of the last save or copy; null until the first one. */
  const [savedDoc, setSavedDoc] = useState<typeof doc | null>(null);
  const stageRef = useRef<StageHandle>(null);

  const dirty = doc !== savedDoc;
  useEffect(() => {
    onDirtyChange(dirty);
  }, [dirty, onDirtyChange]);

  const announce = useCallback(
    (text: string) => setAnnouncement((current) => ({ text, n: current.n + 1 })),
    [],
  );

  const selected = doc.annotations.find((annotation) => annotation.id === selectedId) ?? null;
  const { width: docWidth, height: docHeight } = doc;
  const defaults = useMemo(() => {
    const size = { width: docWidth, height: docHeight };
    return {
      color,
      strokeWidth: strokeWidthFor(widthStep, size),
      fontSize: fontSizeFor(fontStep, size),
      fontWeight: 600,
    };
  }, [color, widthStep, fontStep, docWidth, docHeight]);

  // --- history ---------------------------------------------------------------------------

  const onCommit = useCallback(
    (command: Command, gesture?: string) =>
      dispatch({ type: 'commit', command, ...(gesture !== undefined && { gesture }) }),
    [],
  );
  const onEndGesture = useCallback(() => dispatch({ type: 'endGesture' }), []);

  const onSelect = useCallback(
    (id: string | null) => {
      setSelectedId(id);
      const annotation = doc.annotations.find((candidate) => candidate.id === id);
      if (!annotation) return;
      // The options strip shows (and edits) what the selected annotation looks like.
      if ('color' in annotation) setColor(annotation.color);
      if (annotation.type === 'arrow' || annotation.type === 'rect') {
        setWidthStep(
          nearestStep(
            annotation.width,
            ([0, 1, 2] as const).map((step) => strokeWidthFor(step, doc)),
          ) as 0 | 1 | 2,
        );
      }
      if (annotation.type === 'text') {
        setFontStep(
          nearestStep(
            annotation.fontSize,
            [0, 1, 2, 3].map((step) => fontSizeFor(step as SizeStep, doc)),
          ) as SizeStep,
        );
      }
    },
    [doc],
  );

  const setCropDraft = useCallback((rect: Rect | null) => {
    setCropDraftState(rect && rect.width >= 1 && rect.height >= 1 ? rect : null);
  }, []);

  const doUndo = useCallback(() => {
    if (!canUndo(history)) return;
    stageRef.current?.cancel();
    dispatch({ type: 'undo' });
    if (tool === 'crop') setCropDraftState(undo(history).present.crop);
    announce('Undo');
  }, [history, tool, announce]);

  const doRedo = useCallback(() => {
    if (!canRedo(history)) return;
    stageRef.current?.cancel();
    dispatch({ type: 'redo' });
    if (tool === 'crop') setCropDraftState(redo(history).present.crop);
    announce('Redo');
  }, [history, tool, announce]);

  // --- tools and crop -------------------------------------------------------------------

  const applyCrop = useCallback(() => {
    if (!cropDraft) return;
    onCommit({ type: 'setCrop', crop: cropDraft });
    onEndGesture();
    setCropDraftState(null);
    setTool('select');
    announce(`Cropped to ${cropDraft.width} by ${cropDraft.height} pixels`);
  }, [cropDraft, onCommit, onEndGesture, announce]);

  const resetCrop = useCallback(() => {
    onCommit({ type: 'setCrop', crop: null });
    onEndGesture();
    setCropDraftState(null);
    announce('Crop reset');
  }, [onCommit, onEndGesture, announce]);

  /** Esc in the crop tool: drop the unapplied selection and go back to Select. */
  const cancelCrop = useCallback(() => {
    setCropDraftState(null);
    setTool('select');
    announce('Crop cancelled');
  }, [announce]);

  const selectTool = useCallback(
    (next: ToolId) => {
      if (next === tool) return;
      stageRef.current?.commitText();
      if (tool === 'crop' && cropDraft) {
        onCommit({ type: 'setCrop', crop: cropDraft });
        onEndGesture();
        setCropDraftState(null);
      }
      if (next === 'crop') setCropDraftState(doc.crop);
      setTool(next);
      announce(`${TOOLS.find((candidate) => candidate.id === next)?.label ?? next} tool`);
    },
    [tool, cropDraft, doc.crop, onCommit, onEndGesture, announce],
  );

  // --- options ---------------------------------------------------------------------------

  const changeColor = useCallback(
    (next: string) => {
      setColor(next);
      if (selected && selected.type !== 'redact') {
        onCommit({ type: 'update', id: selected.id, patch: { color: next } });
        onEndGesture();
      }
    },
    [selected, onCommit, onEndGesture],
  );
  const changeWidth = useCallback(
    (step: 0 | 1 | 2) => {
      setWidthStep(step);
      if (selected && (selected.type === 'arrow' || selected.type === 'rect')) {
        onCommit({ type: 'update', id: selected.id, patch: { width: strokeWidthFor(step, doc) } });
        onEndGesture();
      }
    },
    [selected, doc, onCommit, onEndGesture],
  );
  const changeFont = useCallback(
    (step: SizeStep) => {
      setFontStep(step);
      if (selected?.type === 'text') {
        onCommit({ type: 'update', id: selected.id, patch: { fontSize: fontSizeFor(step, doc) } });
        onEndGesture();
      }
    },
    [selected, doc, onCommit, onEndGesture],
  );

  // --- save and copy ---------------------------------------------------------------------

  const copy = useCallback(async () => {
    if (busy) return;
    const exporting = doc;
    setBusy('copy');
    try {
      const bytes = await (await flattenToBlob(bitmap, exporting, 'png')).arrayBuffer();
      const result = await window.framelet.invoke('shot:copy', {
        sessionId: shot.session.id,
        bytes,
      });
      if (result.ok) {
        setSavedDoc(exporting);
        toast.success('Copied to clipboard');
        announce('Image copied');
      } else toast.error(result.error.message);
    } catch {
      toast.error('Could not copy the image.');
    } finally {
      setBusy(null);
    }
  }, [busy, doc, bitmap, shot.session.id, announce]);

  const save = useCallback(
    async (format: ImageFormat) => {
      if (busy) return;
      const exporting = doc;
      setBusy(format);
      try {
        const bytes = await (await flattenToBlob(bitmap, exporting, format)).arrayBuffer();
        const result = await window.framelet.invoke('shot:export', {
          sessionId: shot.session.id,
          format,
          bytes,
        });
        if (!result.ok) {
          toast.error(result.error.message);
        } else if ('path' in result.data) {
          const saved = result.data.path;
          setSavedDoc(exporting);
          toast.success(`Saved to ${shortPath(saved)}`, {
            action: {
              label: 'Show in folder',
              onClick: () => void window.framelet.invoke('shell:showItemInFolder', { path: saved }),
            },
          });
          announce('Image saved');
        }
      } catch {
        toast.error('Could not save the image.');
      } finally {
        setBusy(null);
      }
    },
    [busy, doc, bitmap, shot.session.id, announce],
  );

  // --- keyboard (this view only) ------------------------------------------------------------

  const keys = useRef({
    blocked,
    tool,
    selected,
    cropDraft,
    doUndo,
    doRedo,
    copy,
    save,
    selectTool,
    applyCrop,
    cancelCrop,
    onCommit,
    onEndGesture,
    onSelect,
  });
  useEffect(() => {
    keys.current = {
      blocked,
      tool,
      selected,
      cropDraft,
      doUndo,
      doRedo,
      copy,
      save,
      selectTool,
      applyCrop,
      cancelCrop,
      onCommit,
      onEndGesture,
      onSelect,
    };
  });

  useEffect(() => {
    const NUDGE: Record<string, [number, number]> = {
      ArrowLeft: [-1, 0],
      ArrowRight: [1, 0],
      ArrowUp: [0, -1],
      ArrowDown: [0, 1],
    };
    const onKeyDown = (event: KeyboardEvent): void => {
      const k = keys.current;
      if (k.blocked || event.defaultPrevented) return;
      const target = event.target instanceof HTMLElement ? event.target : null;
      if (target?.closest('input, textarea, select, [contenteditable="true"], [role="menu"]'))
        return;
      const onControl = !!target?.closest(
        'button, [role="radio"], [role="toolbar"], [role="menuitem"]',
      );
      const stage = stageRef.current;
      const mod = event.ctrlKey || event.metaKey;
      const key = event.key;

      if (mod) {
        const lower = key.toLowerCase();
        if (lower === 'z') {
          event.preventDefault();
          if (event.shiftKey) k.doRedo();
          else k.doUndo();
        } else if (lower === 'y') {
          event.preventDefault();
          k.doRedo();
        } else if (lower === 's' && !event.shiftKey) {
          event.preventDefault();
          void k.save('png');
        } else if (lower === 'c' && !event.shiftKey && !window.getSelection()?.toString()) {
          event.preventDefault();
          void k.copy();
        } else if (key === '=' || key === '+') {
          event.preventDefault();
          stage?.zoomIn();
        } else if (key === '-' || key === '_') {
          event.preventDefault();
          stage?.zoomOut();
        } else if (key === '0') {
          event.preventDefault();
          stage?.fit();
        } else if (key === '1') {
          event.preventDefault();
          stage?.actualSize();
        }
        return;
      }
      if (event.altKey) return;

      if (key === 'Escape') {
        if (stage?.cancel()) return;
        if (k.tool === 'crop') k.cancelCrop();
        else k.onSelect(null);
        return;
      }
      if (key === 'Delete' || key === 'Backspace') {
        if (!k.selected) return;
        event.preventDefault();
        k.onCommit({ type: 'remove', id: k.selected.id });
        k.onEndGesture();
        k.onSelect(null);
        return;
      }
      if (key === 'Enter' && !onControl && k.tool === 'crop' && k.cropDraft) {
        event.preventDefault();
        k.applyCrop();
        return;
      }
      const nudge = NUDGE[key];
      if (nudge && !onControl && k.selected) {
        event.preventDefault();
        const step = event.shiftKey ? 10 : 1;
        k.onCommit(
          {
            type: 'update',
            id: k.selected.id,
            patch: moveAnnotation(k.selected, nudge[0] * step, nudge[1] * step),
          },
          `nudge:${k.selected.id}`,
        );
        return;
      }
      if (!event.shiftKey && key.length === 1) {
        const next = toolForKey(key);
        if (next) {
          event.preventDefault();
          k.selectTool(next);
        }
      }
    };
    const onKeyUp = (event: KeyboardEvent): void => {
      if (event.key.startsWith('Arrow')) keys.current.onEndGesture();
    };
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
    };
  }, []);

  // --- render ------------------------------------------------------------------------------

  const out = exportSize(doc);
  const cropSize =
    tool === 'crop' && cropDraft ? { width: cropDraft.width, height: cropDraft.height } : null;

  return (
    <div className="flex h-full min-h-0 flex-col" data-testid="editor-view">
      <EditorToolbar
        tool={tool}
        onTool={selectTool}
        canUndo={canUndo(history)}
        canRedo={canRedo(history)}
        onUndo={doUndo}
        onRedo={doRedo}
        zoom={zoom}
        onZoomIn={() => stageRef.current?.zoomIn()}
        onZoomOut={() => stageRef.current?.zoomOut()}
        onFit={() => stageRef.current?.fit()}
        onActualSize={() => stageRef.current?.actualSize()}
        busy={busy}
        onCopy={() => void copy()}
        onSave={(format) => void save(format)}
        onDone={onRequestLeave}
        onDiscard={onRequestLeave}
      />
      <OptionsStrip
        tool={tool}
        selectedType={selected?.type ?? null}
        color={color}
        widthStep={widthStep}
        fontStep={fontStep}
        onColor={changeColor}
        onWidthStep={changeWidth}
        onFontStep={changeFont}
        cropSize={cropSize}
        hasCrop={doc.crop !== null}
        onApplyCrop={applyCrop}
        onResetCrop={resetCrop}
      />
      <div className="relative flex min-h-0 flex-1 flex-col">
        <EditorStage
          handleRef={stageRef}
          bitmap={bitmap}
          doc={doc}
          tool={tool}
          selectedId={selectedId}
          defaults={defaults}
          cropDraft={cropDraft}
          onCropDraft={setCropDraft}
          onCommit={onCommit}
          onEndGesture={onEndGesture}
          onSelect={onSelect}
          onZoom={setZoom}
        />
        <div
          data-testid="editor-status"
          className="pointer-events-none absolute right-3 bottom-3 flex items-center gap-2 rounded-lg border border-line bg-surface/90 px-2.5 py-1 text-xs font-medium text-fg-muted shadow-card backdrop-blur"
          title={
            doc.crop
              ? `Cropped from ${doc.width} × ${doc.height}. Zoom does not change the exported size.`
              : 'Zoom does not change the exported size.'
          }
        >
          <span data-testid="editor-dimensions" className="tabular-nums">
            {out.width} × {out.height}
          </span>
          <span aria-hidden="true">·</span>
          <span data-testid="editor-zoom" className="tabular-nums">
            {Math.round(zoom * 100)}%
          </span>
        </div>
      </div>
      <div role="status" aria-live="polite" className="sr-only" data-testid="editor-live">
        {announcement.text}
      </div>
    </div>
  );
}
