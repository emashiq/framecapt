import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react';
import { notify } from '../../lib/notify';
import type { ImageFormat, ShotSessionMeta } from '../../../shared/shots';
import { MAX_THUMBNAIL_BYTES } from '../../../shared/history-ipc';
import { isCommandAction, matchEditorAction } from '../../../shared/shortcuts';
import { shortPath } from '../../lib/short-path';
import { getSettings, updateSettings, useSettings } from '../../settings/store';
import { assetLimit, assetsToSave, type EditorAsset, type EditorAssets } from '../../editor/assets';
import { decodeToPng, loadAsset } from '../../editor/decode';
import { flattenThumbnail, flattenToBlob } from '../../editor/export';
import { pictureIn } from '../../editor/import-image';
import { measureText } from '../../editor/measure';
import {
  alignCommand,
  distributeCommand,
  duplicateCommand,
  zOrderCommand,
} from '../../editor/model/arrange';
import type { Command } from '../../editor/model/commands';
import { imageAt } from '../../editor/model/create';
import { largestAspectRect } from '../../editor/model/geometry';
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
import { serializeDoc } from '../../editor/model/migrate';
import {
  beautifyActive,
  createDoc,
  exportRect,
  exportSize,
  type Beautify,
  type EditorDoc,
  type Point,
  type Rect,
} from '../../editor/model/types';
import {
  ASPECT_PRESETS,
  addRecentColor,
  fontSizeFor,
  initialStyle,
  nearestStep,
  strokeWidthFor,
  type AspectId,
  type SizeStep,
} from '../../editor/presets';
import {
  applyProp,
  propsOf,
  typeForTool,
  type PropField,
  type PropValues,
} from '../../editor/properties';
import type { ReeditInfo } from '../../editor/reedit';
import { EditorStage, type StageHandle } from './EditorStage';
import { EditorToolbar } from './EditorToolbar';
import { HistoryImagePicker } from './HistoryImagePicker';
import { OptionsStrip } from './OptionsStrip';
import { PropertiesPanel, type ArrangeAction } from './PropertiesPanel';
import { TOOLS, toolForAction, type ToolId } from './tools';
import { AlertConfirm } from '../../components/ui/AlertConfirm';
import { Button } from '../../components/ui/Button';

export interface EditorShot {
  /** Set when "save after capture" already saved the capture: nothing is unsaved yet. */
  savedPath?: string;
  session: ShotSessionMeta;
  /** The original capture (PNG). It stays in memory only as the decoded base image. */
  png: ArrayBuffer;
  /** Set when the screenshot was opened from History (Edit): Save writes over that item. */
  edit?: ReeditInfo;
  /** An image the user opened, dropped or pasted: nothing is lost until it is edited. */
  imported?: boolean;
}

export interface EditorViewProps {
  shot: EditorShot;
  /** True while a dialog is open over the editor, or its tab is hidden: shortcuts are ignored. */
  blocked: boolean;
  /** This tab is the one showing: it takes the keyboard focus. */
  active: boolean;
  /** Edits or nothing saved yet: leaving would lose work. */
  onDirtyChange: (dirty: boolean) => void;
  /** Done / Discard was pressed. The window decides whether to confirm. */
  onRequestLeave: () => void;
  /**
   * Hands the window the way to save this screenshot (the "Save" of the unsaved-tab question): it
   * resolves true once the picture is saved, false when the user cancelled or it failed.
   */
  registerSave: (save: (() => Promise<boolean>) | null) => void;
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

const PANEL_KEY = 'framecapt.editor.panel';
const RECENT_KEY = 'framecapt.editor.recentColors';

/** A per-viewer convenience: the browser storage may be missing, blocked or full. */
function readStored<T>(key: string, fallback: T, parse: (raw: string) => T): T {
  try {
    const raw = window.localStorage.getItem(key);
    return raw === null ? fallback : parse(raw);
  } catch {
    return fallback;
  }
}
function writeStored(key: string, value: string): void {
  try {
    window.localStorage.setItem(key, value);
  } catch {
    // not remembered: fine
  }
}

/** Decodes the original once (and the pictures of its image layers); everything else draws from these bitmaps. */
export function EditorView(props: EditorViewProps) {
  const [bitmap, setBitmap] = useState<ImageBitmap | null>(null);
  const [assets, setAssets] = useState<EditorAssets | null>(null);
  const [failed, setFailed] = useState(false);
  const { png } = props.shot;
  const stored = props.shot.edit?.assets;

  useEffect(() => {
    let cancelled = false;
    const loaded: EditorAsset[] = [];
    void Promise.all(
      (stored ?? []).map((asset) =>
        // A picture that cannot be read leaves its layer with the placeholder.
        loadAsset(asset.png)
          .then((value) => loaded.push(value))
          .catch(() => undefined),
      ),
    ).then(() => {
      if (cancelled) for (const asset of loaded) asset.image.close();
      else setAssets(new Map(loaded.map((asset) => [asset.id, asset])));
    });
    return () => {
      cancelled = true;
      for (const asset of loaded) asset.image.close();
    };
  }, [stored]);

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
  if (!bitmap || !assets) {
    return <div className="h-full" data-testid="editor-loading" aria-busy="true" />;
  }
  return <EditorWorkspace {...props} bitmap={bitmap} initialAssets={assets} />;
}

function Banner({
  testId,
  children,
  onDismiss,
  tone = 'info',
}: {
  testId: string;
  children: React.ReactNode;
  onDismiss?: () => void;
  tone?: 'info' | 'warning';
}) {
  return (
    <div
      role="status"
      data-testid={testId}
      className={
        tone === 'warning'
          ? 'flex items-center gap-3 border-b border-line bg-warning-soft px-4 py-2 text-[13px] text-fg'
          : 'flex items-center gap-3 border-b border-line bg-accent-soft px-4 py-2 text-[13px] text-fg'
      }
    >
      <span className="flex-1">{children}</span>
      {onDismiss && (
        <Button size="sm" variant="secondary" onClick={onDismiss} data-testid={`${testId}-dismiss`}>
          Got it
        </Button>
      )}
    </div>
  );
}

function EditorWorkspace({
  shot,
  bitmap,
  blocked,
  active,
  onDirtyChange,
  onRequestLeave,
  registerSave,
  initialAssets,
}: EditorViewProps & { bitmap: ImageBitmap; initialAssets: EditorAssets }) {
  const [history, dispatch] = useReducer(historyReducer, undefined, () =>
    createHistory(shot.edit?.doc ?? createDoc(bitmap.width, bitmap.height)),
  );
  const doc = history.present;
  const [tool, setTool] = useState<ToolId>('select');
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [style, setStyle] = useState(() =>
    initialStyle({ width: bitmap.width, height: bitmap.height }),
  );
  const [cropDraft, setCropDraftState] = useState<Rect | null>(null);
  const [cropAspect, setCropAspect] = useState<AspectId>('free');
  const [snap, setSnap] = useState(true);
  const [previewExport, setPreviewExport] = useState(false);
  const [panelOpen, setPanelOpen] = useState(() =>
    readStored(PANEL_KEY, true, (raw) => raw !== 'closed'),
  );
  const [recentColors, setRecentColors] = useState<string[]>(() =>
    readStored(RECENT_KEY, [], (raw) => {
      const parsed: unknown = JSON.parse(raw);
      return Array.isArray(parsed)
        ? parsed.filter((c): c is string => typeof c === 'string').slice(0, 8)
        : [];
    }),
  );
  const [zoom, setZoom] = useState(1);
  const [busy, setBusy] = useState<'copy' | ImageFormat | null>(null);
  const [announcement, setAnnouncement] = useState({ text: '', n: 0 });
  /** The history item this session saves over (Edit from History); null for a fresh capture. */
  const [reedit, setReedit] = useState(() =>
    shot.edit ? { historyId: shot.edit.historyId, format: shot.edit.format } : null,
  );
  const [confirmOver, setConfirmOver] = useState(false);
  const overwriteOk = useRef(false);
  /** The document as of the last save or copy; null until the first one. */
  const [savedDoc, setSavedDoc] = useState<typeof doc | null>(() =>
    shot.savedPath || shot.edit || shot.imported ? history.present : null,
  );
  /** The pictures of the document's image layers (all inserted ones; only the used ones are saved). */
  const [assets, setAssets] = useState(initialAssets);
  const assetsRef = useRef(assets);
  const [historyPicker, setHistoryPicker] = useState(false);
  const stageRef = useRef<StageHandle>(null);
  const settings = useSettings();
  const saveFormat = settings.screenshots.format;

  // A capture that was just opened, or a tab that was just shown: the keyboard works on the canvas
  // straight away.
  useEffect(() => {
    if (active) stageRef.current?.focus();
  }, [active]);

  const dirty = doc !== savedDoc;
  useEffect(() => {
    onDirtyChange(dirty);
  }, [dirty, onDirtyChange]);

  const announce = useCallback(
    (text: string) => setAnnouncement((current) => ({ text, n: current.n + 1 })),
    [],
  );

  const selected = useMemo(
    () => doc.annotations.filter((annotation) => selectedIds.includes(annotation.id)),
    [doc.annotations, selectedIds],
  );
  const single = selected.length === 1 ? (selected[0] ?? null) : null;
  const values = propsOf(single, style);

  // --- history ---------------------------------------------------------------------------

  const onCommit = useCallback(
    (command: Command, gesture?: string) =>
      dispatch({ type: 'commit', command, ...(gesture !== undefined && { gesture }) }),
    [],
  );
  const onEndGesture = useCallback(() => dispatch({ type: 'endGesture' }), []);
  const onSelect = useCallback((ids: string[]) => setSelectedIds(ids), []);

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
      // A drawing tool makes new marks: nothing stays selected, so the panel shows the tool's own settings.
      if (next !== 'select') setSelectedIds([]);
      setPreviewExport(false);
      setTool(next);
      announce(`${TOOLS.find((candidate) => candidate.id === next)?.label ?? next} tool`);
    },
    [tool, cropDraft, doc.crop, onCommit, onEndGesture, announce],
  );

  const chooseCropAspect = useCallback(
    (id: AspectId) => {
      setCropAspect(id);
      const ratio = ASPECT_PRESETS.find((preset) => preset.id === id)?.ratio ?? null;
      if (tool !== 'crop') selectTool('crop');
      if (ratio === null) return;
      const within = cropDraft ?? doc.crop ?? { x: 0, y: 0, width: doc.width, height: doc.height };
      const fitted = largestAspectRect(within, ratio);
      setCropDraft({
        x: Math.round(fitted.x),
        y: Math.round(fitted.y),
        width: Math.max(1, Math.round(fitted.width)),
        height: Math.max(1, Math.round(fitted.height)),
      });
    },
    [tool, selectTool, cropDraft, doc.crop, doc.width, doc.height, setCropDraft],
  );

  // --- properties ------------------------------------------------------------------------

  const rememberColor = useCallback((color: string) => {
    setRecentColors((current) => {
      const next = addRecentColor(current, color);
      writeStored(RECENT_KEY, JSON.stringify(next));
      return next;
    });
  }, []);

  /** One panel or strip field changed: the next element is made that way and the selection follows. */
  const setProp = useCallback(
    <F extends PropField>(field: F, value: PropValues[F]) => {
      const kind = single?.type ?? typeForTool(tool);
      const next = applyProp(field, value, style, kind);
      setStyle(next.style);
      if (
        typeof value === 'string' &&
        /^#[0-9a-f]{6}$/i.test(value) &&
        field !== 'textBackground'
      ) {
        rememberColor(value);
      }
      if (selected.length === 0) return;
      const commands: Command[] = selected.map((annotation) => ({
        type: 'update',
        id: annotation.id,
        patch: next.patch,
      }));
      onCommit(
        commands.length === 1 ? (commands[0] as Command) : { type: 'batch', commands },
        `prop:${field}`,
      );
    },
    [single, tool, style, selected, onCommit, rememberColor],
  );

  const resetSteps = useCallback(() => {
    setStyle((current) => ({ ...current, stepNumber: 1 }));
    announce('Step numbering restarts at 1');
  }, [announce]);

  const onStepPlaced = useCallback(() => {
    setStyle((current) => ({ ...current, stepNumber: current.stepNumber + 1 }));
  }, []);

  const changeBeautify = useCallback(
    (beautify: Beautify | null) => {
      onCommit({ type: 'setBeautify', beautify }, 'beautify');
    },
    [onCommit],
  );

  const arrange = useCallback(
    (action: ArrangeAction) => {
      if (selectedIds.length === 0) return;
      let command: Command | null = null;
      if (action.type === 'z') command = zOrderCommand(doc, selectedIds, action.move);
      else if (action.type === 'delete') {
        command = {
          type: 'batch',
          commands: selectedIds.map((id) => ({ type: 'remove', id }) as const),
        };
        setSelectedIds([]);
      } else if (action.type === 'duplicate') {
        const made = duplicateCommand(doc, selectedIds, 12, () => crypto.randomUUID());
        if (made) {
          command = made.command;
          setSelectedIds(made.ids);
        }
      } else if (action.type === 'align') {
        command = alignCommand(doc, selectedIds, action.mode, exportRect(doc), measureText);
      } else {
        command = distributeCommand(doc, selectedIds, action.axis, measureText);
      }
      if (command) {
        onCommit(command);
        onEndGesture();
      }
    },
    [doc, selectedIds, onCommit, onEndGesture],
  );

  // --- image layers -----------------------------------------------------------------------

  /**
   * Places a picture (PNG bytes) as a new image layer: centered on `center` (default the middle of
   * the canvas), scaled to fit 60 % of it, selected. The picture is kept once per distinct content.
   */
  const insertPicture = useCallback(
    async (png: ArrayBuffer, center?: Point) => {
      try {
        const asset = await loadAsset(png);
        const limit = assetLimit(assetsRef.current, asset.id, png.byteLength);
        if (limit) {
          asset.image.close();
          notify.error(limit);
          return;
        }
        if (assetsRef.current.has(asset.id)) asset.image.close();
        else {
          assetsRef.current = new Map(assetsRef.current).set(asset.id, asset);
          setAssets(assetsRef.current);
        }
        const layer = imageAt(
          crypto.randomUUID(),
          asset.id,
          asset,
          { width: doc.width, height: doc.height },
          center,
        );
        stageRef.current?.commitText();
        selectTool('select');
        onCommit({ type: 'add', annotation: layer });
        onEndGesture();
        setSelectedIds([layer.id]);
        announce('Image inserted');
      } catch {
        notify.error('That picture could not be inserted.');
      }
    },
    [doc.width, doc.height, selectTool, onCommit, onEndGesture, announce],
  );

  /** A picture file, drop or paste of any format the browser decodes. */
  const insertBlob = useCallback(
    async (blob: Blob, center?: Point) => {
      try {
        await insertPicture((await decodeToPng(blob)).png, center);
      } catch {
        notify.error('That picture could not be read.');
      }
    },
    [insertPicture],
  );

  const insertFromFile = useCallback(async () => {
    const response = await window.framecapt.invoke('editor:pickImage');
    if (!response.ok) notify.error(response.error);
    else if ('bytes' in response.data) await insertBlob(new Blob([response.data.bytes]));
  }, [insertBlob]);

  const insertFromHistory = useCallback(
    async (historyId: string) => {
      setHistoryPicker(false);
      const response = await window.framecapt.invoke('editor:historyImage', { historyId });
      if (response.ok) await insertPicture(response.data.png);
      else notify.error(response.error);
    },
    [insertPicture],
  );

  /** "Reset size": the selected picture goes back to its own pixel size, around its center. */
  const resetImageSize = useCallback(() => {
    if (single?.type !== 'image') return;
    const asset = assetsRef.current.get(single.assetId);
    if (!asset) return;
    const { rect } = single;
    onCommit({
      type: 'update',
      id: single.id,
      patch: {
        rect: {
          x: Math.round(rect.x + rect.width / 2 - asset.width / 2),
          y: Math.round(rect.y + rect.height / 2 - asset.height / 2),
          width: asset.width,
          height: asset.height,
        },
      },
    });
    onEndGesture();
    announce('Image size reset');
  }, [single, onCommit, onEndGesture, announce]);

  // The quick controls of the options strip are shortcuts to the same fields as the panel.
  const widthStep = nearestStep(
    values.strokeWidth,
    ([0, 1, 2] as const).map((step) => strokeWidthFor(step, doc)),
  ) as 0 | 1 | 2;
  const fontStep = nearestStep(
    values.fontSize,
    [0, 1, 2, 3].map((step) => fontSizeFor(step as SizeStep, doc)),
  ) as SizeStep;
  const changeColor = useCallback(
    (next: string) => {
      setProp('color', next);
      onEndGesture();
    },
    [setProp, onEndGesture],
  );
  const changeWidth = useCallback(
    (step: 0 | 1 | 2) => {
      setProp('strokeWidth', strokeWidthFor(step, doc));
      onEndGesture();
    },
    [setProp, doc, onEndGesture],
  );
  const changeFont = useCallback(
    (step: SizeStep) => {
      setProp('fontSize', fontSizeFor(step, doc));
      onEndGesture();
    },
    [setProp, doc, onEndGesture],
  );

  // --- save and copy ---------------------------------------------------------------------

  const copy = useCallback(async () => {
    if (busy) return;
    stageRef.current?.commitText();
    const exporting = doc;
    setBusy('copy');
    try {
      const bytes = await (
        await flattenToBlob(bitmap, exporting, 'png', undefined, assetsRef.current)
      ).arrayBuffer();
      const result = await window.framecapt.invoke('shot:copy', {
        sessionId: shot.session.id,
        bytes,
      });
      if (result.ok) {
        setSavedDoc(exporting);
        notify.success('Copied to clipboard');
        announce('Image copied');
      } else notify.error(result.error);
    } catch {
      notify.error('Could not copy the image.');
    } finally {
      setBusy(null);
    }
  }, [busy, doc, bitmap, shot.session.id, announce]);

  /** The flattened bytes and thumbnail of `exporting`, plus the editable project to keep with them. */
  const prepareExport = useCallback(
    async (exporting: EditorDoc, format: ImageFormat) => {
      const pictures = assetsRef.current;
      const bytes = await (
        await flattenToBlob(
          bitmap,
          exporting,
          format,
          getSettings().screenshots.jpegQuality,
          pictures,
        )
      ).arrayBuffer();
      // History shows a thumbnail of the FLATTENED result (redactions applied), never of the
      // original capture. Without one the entry just has no thumbnail; saving still works.
      const thumbnail = await flattenThumbnail(bitmap, exporting, undefined, pictures)
        .then((blob) => (blob.size <= MAX_THUMBNAIL_BYTES ? blob.arrayBuffer() : undefined))
        .catch(() => undefined);
      const keep = getSettings().screenshots.keepEditableOriginals || shot.edit !== undefined;
      // Only the pictures the document still uses are kept with the project.
      const used = assetsToSave(exporting, pictures);
      return {
        bytes,
        ...(thumbnail && { thumbnail }),
        ...(keep && {
          project: { doc: serializeDoc(exporting), ...(used.length > 0 && { assets: used }) },
        }),
      };
    },
    [bitmap, shot.edit],
  );

  /**
   * "Save as...": a file dialog and a NEW history item (from History: a copy of the item). With
   * `quick` there is no dialog: main saves into the screenshots folder under a free name.
   */
  const save = useCallback(
    async (format: ImageFormat, quick = false): Promise<boolean> => {
      if (busy) return false;
      stageRef.current?.commitText();
      const exporting = doc;
      const before = savedDoc;
      let done = false;
      setBusy(format);
      try {
        const prepared = await prepareExport(exporting, format);
        const request = { sessionId: shot.session.id, format, ...prepared };
        const result = quick
          ? await window.framecapt.invoke('shot:quickSave', request)
          : await window.framecapt.invoke('shot:export', request);
        if (!result.ok) {
          notify.error(result.error);
        } else if ('path' in result.data) {
          const saved = result.data.path;
          done = true;
          setSavedDoc(exporting);
          // A copy made from History becomes the item this session saves over from now on.
          if (reedit && result.data.historyId) {
            setReedit({ historyId: result.data.historyId, format });
          }
          const savedId = result.data.historyId;
          notify.success(`Saved to ${shortPath(saved)}`, {
            action: {
              label: 'Show in folder',
              onClick: () =>
                void window.framecapt.invoke('shell:showItemInFolder', { path: saved }),
            },
          });
          announce('Image saved');
          if (quick && !reedit && savedId) {
            // Quick save has no dialog to cancel, so the toast offers the way back: the file goes
            // to the Recycle Bin and leaves history, and the editor is unsaved again.
            notify.info('Quick saved', {
              duration: 6000,
              action: {
                label: 'Undo',
                onClick: () =>
                  void window.framecapt
                    .invoke('history:deleteFile', { id: savedId })
                    .then((undone) => {
                      if (undone.ok) {
                        setSavedDoc(before);
                        notify.success('Moved to the Recycle Bin');
                      } else notify.error(undone.error);
                    }),
              },
            });
          }
        }
      } catch {
        notify.error('Could not save the image.');
      } finally {
        setBusy(null);
      }
      return done;
    },
    [busy, doc, savedDoc, shot.session.id, announce, prepareExport, reedit],
  );

  const quickSave = useCallback(() => {
    void save(getSettings().screenshots.format, true);
  }, [save]);

  /** "Save changes": writes over the history item, in its own format, atomically (no dialog). */
  const saveOver = useCallback(async (): Promise<boolean> => {
    if (busy || !reedit) return false;
    stageRef.current?.commitText();
    const exporting = doc;
    let done = false;
    setBusy(reedit.format);
    try {
      const prepared = await prepareExport(exporting, reedit.format);
      const result = await window.framecapt.invoke('shot:saveOver', {
        sessionId: shot.session.id,
        format: reedit.format,
        ...prepared,
      });
      if (!result.ok) {
        notify.error(result.error);
      } else {
        done = true;
        setSavedDoc(exporting);
        notify.success(`Changes saved to ${shortPath(result.data.path)}`);
        announce('Changes saved');
      }
    } catch {
      notify.error('Could not save the changes.');
    } finally {
      setBusy(null);
    }
    return done;
  }, [busy, reedit, doc, shot.session.id, announce, prepareExport]);

  /** The first overwrite of a session asks: the previous version of the image is not kept. */
  /** Saves the edits (first writing unsaved ones over the item) as a `.fcimage` project file. */
  const saveProjectFile = useCallback(async () => {
    if (!reedit) return;
    if (dirty && !(await saveOver())) return;
    const response = await window.framecapt.invoke('history:saveProjectFile', {
      id: reedit.historyId,
    });
    if (!response.ok) notify.error(response.error);
    else if ('path' in response.data) notify.success('Project file saved');
  }, [reedit, dirty, saveOver]);

  const requestSaveOver = useCallback(() => {
    if (!reedit) return;
    if (overwriteOk.current) void saveOver();
    else setConfirmOver(true);
  }, [reedit, saveOver]);

  // The Save key: a fresh capture saves like always; a screenshot from History saves its changes.
  const saveKey = useCallback(() => {
    if (reedit) requestSaveOver();
    else void save(getSettings().screenshots.format);
  }, [reedit, requestSaveOver, save]);

  // The "Save" of the unsaved-tab question: a screenshot from History saves its changes (the
  // question already was the confirmation), a fresh capture goes through the Save dialog.
  const saveForClose = useCallback(
    () => (reedit ? saveOver() : save(getSettings().screenshots.format)),
    [reedit, saveOver, save],
  );
  useEffect(() => {
    registerSave(saveForClose);
    return () => registerSave(null);
  }, [saveForClose, registerSave]);

  // --- keyboard (this view only) ------------------------------------------------------------

  const keys = useRef({
    blocked: blocked || confirmOver || historyPicker,
    tool,
    selected,
    cropDraft,
    doUndo,
    doRedo,
    copy,
    saveKey,
    quickSave,
    insertFromFile,
    insertBlob,
    selectTool,
    applyCrop,
    cancelCrop,
    onCommit,
    onEndGesture,
    onSelect,
    arrange,
    allIds: doc.annotations.map((annotation) => annotation.id),
  });
  useEffect(() => {
    keys.current = {
      blocked: blocked || confirmOver || historyPicker,
      tool,
      selected,
      cropDraft,
      doUndo,
      doRedo,
      copy,
      saveKey,
      quickSave,
      insertFromFile,
      insertBlob,
      selectTool,
      applyCrop,
      cancelCrop,
      onCommit,
      onEndGesture,
      onSelect,
      arrange,
      allIds: doc.annotations.map((annotation) => annotation.id),
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
        'button, [role="radio"], [role="toolbar"], [role="menuitem"], [role="switch"]',
      );
      const stage = stageRef.current;
      const mod = event.ctrlKey || event.metaKey;
      const key = event.key;

      // The customizable keys (tools, undo, save, copy, zoom): settings, Editor shortcuts.
      const action = matchEditorAction(event, getSettings().editorShortcuts);
      // The command center's keys belong to the title bar.
      if (action !== null && isCommandAction(action)) return;
      if (action === 'copy' && window.getSelection()?.toString()) return; // the native copy
      if (action) {
        event.preventDefault();
        if (action === 'undo') k.doUndo();
        else if (action === 'redo') k.doRedo();
        else if (action === 'save') k.saveKey();
        else if (action === 'quickSave') k.quickSave();
        else if (action === 'insertImage') void k.insertFromFile();
        else if (action === 'copy') void k.copy();
        else if (action === 'zoomIn') stage?.zoomIn();
        else if (action === 'zoomOut') stage?.zoomOut();
        else if (action === 'zoomFit') stage?.fit();
        else if (action === 'zoomActual') stage?.actualSize();
        else if (action === 'duplicate') k.arrange({ type: 'duplicate' });
        else if (action === 'bringForward') k.arrange({ type: 'z', move: 'forward' });
        else if (action === 'sendBackward') k.arrange({ type: 'z', move: 'backward' });
        else if (action === 'bringToFront') k.arrange({ type: 'z', move: 'front' });
        else if (action === 'sendToBack') k.arrange({ type: 'z', move: 'back' });
        else if (action === 'selectAll') k.onSelect(k.allIds);
        else {
          const next = toolForAction(action);
          if (next) k.selectTool(next);
        }
        return;
      }
      if (mod) {
        // Ctrl+Y also redoes (the Windows habit) unless it is bound to something else.
        if (key.toLowerCase() === 'y') {
          event.preventDefault();
          k.doRedo();
        }
        return;
      }
      if (event.altKey) return;

      if (key === 'Escape') {
        if (stage?.cancel()) return;
        if (k.tool === 'crop') k.cancelCrop();
        else k.onSelect([]);
        return;
      }
      if (key === 'Delete' || key === 'Backspace') {
        if (k.selected.length === 0) return;
        event.preventDefault();
        k.arrange({ type: 'delete' });
        return;
      }
      if (key === 'Enter' && !onControl && k.tool === 'crop' && k.cropDraft) {
        event.preventDefault();
        k.applyCrop();
        return;
      }
      const nudge = NUDGE[key];
      if (nudge && !onControl && k.selected.length > 0) {
        event.preventDefault();
        const step = event.shiftKey ? 10 : 1;
        const commands: Command[] = k.selected.map((annotation) => ({
          type: 'update',
          id: annotation.id,
          patch: moveAnnotation(annotation, nudge[0] * step, nudge[1] * step),
        }));
        k.onCommit(
          commands.length === 1 ? (commands[0] as Command) : { type: 'batch', commands },
          `nudge:${k.selected.map((annotation) => annotation.id).join(',')}`,
        );
        return;
      }
    };
    const onKeyUp = (event: KeyboardEvent): void => {
      if (event.key.startsWith('Arrow')) keys.current.onEndGesture();
    };
    // Ctrl+V with a picture on the clipboard (not while typing): it becomes an image layer. The
    // DOM paste event carries the clipboard's files, so no clipboard permission is needed.
    const onPaste = (event: ClipboardEvent): void => {
      const target = event.target instanceof HTMLElement ? event.target : null;
      if (
        keys.current.blocked ||
        target?.closest('input, textarea, select, [contenteditable="true"]')
      ) {
        return;
      }
      const picture = pictureIn(event.clipboardData?.files);
      if (!picture) return;
      event.preventDefault();
      void keys.current.insertBlob(picture);
    };
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);
    window.addEventListener('paste', onPaste);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
      window.removeEventListener('paste', onPaste);
    };
  }, []);

  // --- render ------------------------------------------------------------------------------

  const out = exportSize(doc);
  const cropSize =
    tool === 'crop' && cropDraft ? { width: cropDraft.width, height: cropDraft.height } : null;
  const hasRedaction = doc.annotations.some((annotation) => annotation.type === 'redact');
  const showEditableNote =
    hasRedaction &&
    settings.screenshots.keepEditableOriginals &&
    !settings.notices.editableNoticeShown;
  const aspectRatio = ASPECT_PRESETS.find((preset) => preset.id === cropAspect)?.ratio ?? null;
  const togglePanel = useCallback(() => {
    setPanelOpen((open) => {
      writeStored(PANEL_KEY, open ? 'closed' : 'open');
      return !open;
    });
  }, []);
  const optionsKind = selected.length > 1 ? 'multiple' : (single?.type ?? null);

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
        saveFormat={saveFormat}
        onSave={(format) => void save(format)}
        onDone={onRequestLeave}
        onDiscard={onRequestLeave}
        panelOpen={panelOpen}
        onTogglePanel={togglePanel}
        reedit={reedit ? { format: reedit.format } : undefined}
        onSaveCopy={(format) => void save(format)}
        onSaveProject={reedit ? () => void saveProjectFile() : undefined}
        onQuickSave={quickSave}
        onSaveOver={requestSaveOver}
        onInsertFile={() => void insertFromFile()}
        onInsertHistory={() => setHistoryPicker(true)}
      />
      {shot.edit?.notice && (
        <Banner testId="editor-reedit-notice" tone="warning">
          {shot.edit.notice}
        </Banner>
      )}
      {showEditableNote && (
        <Banner
          testId="editor-redaction-notice"
          onDismiss={() => void updateSettings({ notices: { editableNoticeShown: true } })}
        >
          Redactions are applied in the exported image; the editable original keeps the pixels
          underneath. You can turn this off in Settings, or delete the editable data of an item in
          History.
        </Banner>
      )}
      <OptionsStrip
        tool={tool}
        selectedType={optionsKind}
        color={values.color}
        widthStep={widthStep}
        fontStep={fontStep}
        onColor={changeColor}
        onWidthStep={changeWidth}
        onFontStep={changeFont}
        cropSize={cropSize}
        hasCrop={doc.crop !== null}
        onApplyCrop={applyCrop}
        onResetCrop={resetCrop}
        cropAspect={cropAspect}
        onCropAspect={chooseCropAspect}
        highlightMode={style.highlightMode}
        onHighlightMode={(mode) => setStyle((current) => ({ ...current, highlightMode: mode }))}
        nextStep={style.stepNumber}
        onResetSteps={resetSteps}
      />
      <div className="relative flex min-h-0 flex-1">
        <div className="relative flex min-h-0 min-w-0 flex-1 flex-col">
          <EditorStage
            handleRef={stageRef}
            bitmap={bitmap}
            doc={doc}
            tool={tool}
            selectedIds={selectedIds}
            defaults={style}
            cropDraft={cropDraft}
            cropAspect={aspectRatio}
            onCropDraft={setCropDraft}
            snap={snap}
            previewExport={previewExport}
            onCommit={onCommit}
            onEndGesture={onEndGesture}
            onSelect={onSelect}
            onZoom={setZoom}
            onStepPlaced={onStepPlaced}
            assets={assets}
            onDropImage={(file, at) => void insertBlob(file, at)}
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
            {beautifyActive(doc) && (
              <>
                <span aria-hidden="true">·</span>
                <span>framed</span>
              </>
            )}
          </div>
        </div>
        {panelOpen && (
          <PropertiesPanel
            doc={doc}
            tool={tool}
            selected={selected}
            style={style}
            recentColors={recentColors}
            onProp={setProp}
            onEndGesture={onEndGesture}
            onArrange={arrange}
            snap={snap}
            onSnap={setSnap}
            cropAspect={cropAspect}
            onCropAspect={chooseCropAspect}
            onBeautify={changeBeautify}
            previewExport={previewExport}
            onPreview={setPreviewExport}
            onResetSteps={resetSteps}
            onResetImageSize={resetImageSize}
          />
        )}
      </div>
      <div role="status" aria-live="polite" className="sr-only" data-testid="editor-live">
        {announcement.text}
      </div>
      <HistoryImagePicker
        open={historyPicker}
        onClose={() => setHistoryPicker(false)}
        onPick={(id) => void insertFromHistory(id)}
      />
      <AlertConfirm
        open={confirmOver}
        title="Replace the saved screenshot?"
        description="Your changes will replace the image in History and its file. The previous version is not kept."
        cancelLabel="Keep editing"
        confirmLabel="Replace"
        onCancel={() => setConfirmOver(false)}
        onConfirm={() => {
          setConfirmOver(false);
          overwriteOk.current = true;
          void saveOver();
        }}
      />
    </div>
  );
}
