import {
  useCallback,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
  type CSSProperties,
} from 'react';
import { Toaster } from 'sonner';
import { EDITOR_TAB_WARN, type EditorOpenTabEvent } from '../../shared/editor-ipc';
import { matchEditorAction } from '../../shared/shortcuts';
import { KeyboardHelp } from '../components/KeyboardHelp';
import { LiveRegion } from '../components/LiveRegion';
import { AlertConfirm } from '../components/ui/AlertConfirm';
import { TooltipProvider } from '../components/ui/Tooltip';
import { importPicture } from '../editor/import-image';
import { openFromHistory } from '../editor/reedit';
import {
  cancelVideoExport,
  listenToVideoExports,
  useExportingVideos,
} from '../history/video-export-store';
import { isTyping } from '../lib/is-typing';
import { notify } from '../lib/notify';
import { shortPath } from '../lib/short-path';
import { getSettings, startSettingsSync } from '../settings/store';
import { EditorView, type EditorShot } from '../views/editor/EditorView';
import { VideoEditorView } from '../views/video-editor/VideoEditorView';
import { TabStrip } from './TabStrip';
import {
  dirtyTabs,
  emptyTabs,
  findByKey,
  tabIndexForDigit,
  tabsReducer,
  type Tab,
  type TabsState,
} from './tabs';

type TabData = { kind: 'shot'; shot: EditorShot } | { kind: 'video'; historyId: string };

/** What the window is asking the user right now (one question at a time). */
type Ask =
  | { kind: 'save'; id: string }
  | { kind: 'export'; id: string }
  | { kind: 'video-leave'; id: string }
  | { kind: 'window' };

/** What the open tabs report back to the window: how to save, how to write pending changes. */
interface TabHost {
  setDirty: (id: string, dirty: boolean) => void;
  setSave: (id: string, save: (() => Promise<boolean>) | null) => void;
  setFlush: (id: string, flush: (() => Promise<boolean>) | null) => void;
  requestClose: (id: string) => void;
}

const reducer = tabsReducer<TabData>;
const initial: TabsState<TabData> = emptyTabs;

function ShotTab({ tab, shot, active, blocked, host }: PanelProps & { shot: EditorShot }) {
  const { id } = tab;
  const onDirtyChange = useCallback((dirty: boolean) => host.setDirty(id, dirty), [host, id]);
  const onRequestLeave = useCallback(() => host.requestClose(id), [host, id]);
  const registerSave = useCallback(
    (save: (() => Promise<boolean>) | null) => host.setSave(id, save),
    [host, id],
  );
  return (
    <EditorView
      shot={shot}
      blocked={blocked}
      active={active}
      onDirtyChange={onDirtyChange}
      onRequestLeave={onRequestLeave}
      registerSave={registerSave}
    />
  );
}

function VideoTab({ tab, historyId, active, blocked, host }: PanelProps & { historyId: string }) {
  const { id } = tab;
  const onClose = useCallback(() => host.requestClose(id), [host, id]);
  const registerFlush = useCallback(
    (flush: (() => Promise<boolean>) | null) => host.setFlush(id, flush),
    [host, id],
  );
  return (
    <VideoEditorView
      historyId={historyId}
      blocked={blocked}
      active={active}
      onClose={onClose}
      registerFlush={registerFlush}
    />
  );
}

interface PanelProps {
  tab: Tab<TabData>;
  active: boolean;
  blocked: boolean;
  host: TabHost;
}

/** The shot of a session (a capture, an opened picture): fetched from main, which owns the original. */
async function loadSession(event: Extract<EditorOpenTabEvent, { kind: 'session' }>) {
  const response = await window.framecapt.invoke('shot:get', { sessionId: event.sessionId });
  if (!response.ok) return { ok: false as const, error: response.error };
  const shot: EditorShot = {
    session: response.data.session,
    png: response.data.png,
    ...(event.savedPath && { savedPath: event.savedPath }),
    ...(event.imported && { imported: true }),
  };
  return { ok: true as const, shot };
}

/** One step of a guide: a flattened picture of it; Save writes it back over that step's image. */
async function loadStep(event: Extract<EditorOpenTabEvent, { kind: 'step' }>) {
  const response = await window.framecapt.invoke('flow:openStepInEditor', {
    historyId: event.historyId,
    index: event.index,
  });
  if (!response.ok) return { ok: false as const, error: response.error };
  const shot: EditorShot = {
    session: response.data.session,
    png: response.data.png,
    edit: {
      historyId: event.historyId,
      format: 'png',
      mode: 'flattened',
      doc: null,
      notice: null,
      assets: [],
    },
  };
  return { ok: true as const, shot };
}

const discardSession = (sessionId: string): void =>
  void window.framecapt.invoke('shot:discard', { sessionId });

/**
 * The Editor window: a tab strip over one panel per open item. Every tab stays mounted so its
 * undo history, selection, zoom and playhead survive a switch; hidden ones are `inert` and
 * invisible (not `display: none`, so a canvas keeps its size) and a hidden video is paused.
 * Closing an unsaved screenshot, or the window with unsaved tabs, asks first.
 */
export function EditorApp() {
  const [state, dispatch] = useReducer(reducer, initial);
  const [ask, setAsk] = useState<Ask | null>(null);
  const [helpOpen, setHelpOpen] = useState(false);
  const exporting = useExportingVideos();
  const stateRef = useRef(state);
  const askRef = useRef<Ask | null>(null);
  const saves = useRef(new Map<string, () => Promise<boolean>>());
  const flushes = useRef(new Map<string, () => Promise<boolean>>());
  const exportingRef = useRef<string[]>([]);

  useEffect(() => {
    stateRef.current = state;
  }, [state]);
  useEffect(() => {
    exportingRef.current = exporting;
  }, [exporting]);

  useEffect(() => startSettingsSync(false), []);
  useEffect(() => listenToVideoExports(), []);

  const question = useCallback((next: Ask | null) => {
    askRef.current = next;
    setAsk(next);
  }, []);

  // --- closing -------------------------------------------------------------------------------

  const closeTab = useCallback((id: string) => {
    const tab = stateRef.current.tabs.find((candidate) => candidate.id === id);
    if (!tab) return;
    if (tab.data.kind === 'shot') discardSession(tab.data.shot.session.id);
    saves.current.delete(id);
    flushes.current.delete(id);
    dispatch({ type: 'close', id });
  }, []);

  const requestClose = useCallback(
    (id: string) => {
      const tab = stateRef.current.tabs.find((candidate) => candidate.id === id);
      if (!tab) return;
      dispatch({ type: 'activate', id });
      if (tab.data.kind === 'shot') {
        if (tab.dirty) question({ kind: 'save', id });
        else closeTab(id);
        return;
      }
      if (exportingRef.current.includes(tab.data.historyId)) {
        question({ kind: 'export', id });
        return;
      }
      // A video saves itself; leaving writes what is pending, and asks only if that fails.
      void (flushes.current.get(id)?.() ?? Promise.resolve(true)).then((saved) => {
        if (saved) closeTab(id);
        else question({ kind: 'video-leave', id });
      });
    },
    [closeTab, question],
  );

  const requestCloseRef = useRef(requestClose);
  useEffect(() => {
    requestCloseRef.current = requestClose;
  }, [requestClose]);

  const host = useMemo<TabHost>(
    () => ({
      setDirty: (id, dirty) => dispatch({ type: 'dirty', id, dirty }),
      setSave: (id, save) => {
        if (save) saves.current.set(id, save);
        else saves.current.delete(id);
      },
      setFlush: (id, flush) => {
        if (flush) flushes.current.set(id, flush);
        else flushes.current.delete(id);
      },
      requestClose: (id) => requestCloseRef.current(id),
    }),
    [],
  );
  // --- opening -------------------------------------------------------------------------------

  const open = useCallback((key: string, kind: Tab['kind'], title: string, data: TabData) => {
    dispatch({ type: 'open', tab: { id: crypto.randomUUID(), key, kind, title, data } });
    if (stateRef.current.tabs.length + 1 === EDITOR_TAB_WARN) {
      notify.info(
        `${EDITOR_TAB_WARN} items are open. Close the ones you are done with to keep the editor quick.`,
      );
    }
  }, []);

  /** Opens a loaded screenshot, unless the same item was opened meanwhile (then that tab shows). */
  const openShot = useCallback(
    (key: string, title: string, shot: EditorShot) => {
      const existing = findByKey(stateRef.current, key);
      if (existing) {
        discardSession(shot.session.id);
        dispatch({ type: 'activate', id: existing.id });
        return;
      }
      open(key, 'shot', title, { kind: 'shot', shot });
    },
    [open],
  );

  const openTab = useCallback(
    async (event: EditorOpenTabEvent) => {
      const known = (key: string): boolean => {
        const existing = findByKey(stateRef.current, key);
        if (existing) dispatch({ type: 'activate', id: existing.id });
        return existing !== undefined;
      };
      if (event.kind === 'video') {
        const key = `video:${event.historyId}`;
        if (!known(key)) {
          open(key, 'video', event.title, { kind: 'video', historyId: event.historyId });
        }
      } else if (event.kind === 'shot') {
        const key = `shot:${event.historyId}`;
        if (known(key)) return;
        const result = await openFromHistory(window.framecapt, event.historyId);
        if (!result.ok) notify.error(result.error);
        else openShot(key, event.title, result.shot);
      } else if (event.kind === 'step') {
        const key = `step:${event.historyId}:${event.index}`;
        if (known(key)) return;
        const result = await loadStep(event);
        if (!result.ok) notify.error(result.error);
        else openShot(key, event.title, result.shot);
      } else {
        const result = await loadSession(event);
        if (!result.ok) {
          notify.error(result.error);
          return;
        }
        open(`session:${event.sessionId}`, 'shot', event.imported ? 'Image' : 'Screenshot', {
          kind: 'shot',
          shot: result.shot,
        });
        const { savedPath } = event;
        if (savedPath) {
          notify.success(`Saved to ${shortPath(savedPath)}`, {
            action: {
              label: 'Show in folder',
              onClick: () =>
                void window.framecapt.invoke('shell:showItemInFolder', { path: savedPath }),
            },
          });
        }
      }
    },
    [open, openShot],
  );

  // Main sends what was asked for (also what was asked before this window was ready).
  useEffect(() => {
    const off = window.framecapt.on('editor:openTab', (event) => void openTab(event));
    void window.framecapt.invoke('editor:ready');
    return off;
  }, [openTab]);

  /** Ctrl+O: the Open dialog, then the picture is a tab of its own. */
  const openImage = useCallback(async () => {
    const response = await window.framecapt.invoke('shot:openImage');
    if (!response.ok) {
      notify.error(response.error);
      return;
    }
    if (!('bytes' in response.data)) return;
    const result = await importPicture(window.framecapt, new Blob([response.data.bytes]));
    if (!result.ok) notify.error(result.error);
    else await openTab({ kind: 'session', sessionId: result.session.id, imported: true });
  }, [openTab]);

  // --- what main knows ---------------------------------------------------------------------

  const unsaved = dirtyTabs(state);
  const needsAsk = unsaved.length > 0 || exporting.length > 0;
  const everOpened = useRef(false);
  useEffect(() => {
    if (state.tabs.length > 0) everOpened.current = true;
    // Before the first tab there is nothing to report (and reporting zero would close the window).
    else if (!everOpened.current) return;
    void window.framecapt.invoke('editor:setState', { tabs: state.tabs.length, dirty: needsAsk });
  }, [state.tabs.length, needsAsk]);

  // Main asks before the window closes (or the app quits) with unsaved tabs.
  useEffect(
    () => window.framecapt.on('editor:confirmClose', () => question({ kind: 'window' })),
    [question],
  );

  // --- keyboard ----------------------------------------------------------------------------

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.repeat || event.isComposing) return;
      const locked = askRef.current !== null || document.querySelector('dialog[open]') !== null;
      if (event.ctrlKey && !event.altKey && !event.metaKey && event.key === 'Tab') {
        event.preventDefault();
        if (!locked) dispatch({ type: 'step', delta: event.shiftKey ? -1 : 1 });
        return;
      }
      if (event.ctrlKey && !event.altKey && !event.shiftKey && event.key.toLowerCase() === 'w') {
        event.preventDefault();
        const id = stateRef.current.activeId;
        if (!locked && id) requestCloseRef.current(id);
        return;
      }
      if (event.altKey && !event.ctrlKey && !event.metaKey && !event.shiftKey) {
        const index = tabIndexForDigit(/^Digit(\d)$/.exec(event.code)?.[1] ?? '');
        if (index === null) return;
        event.preventDefault();
        if (!locked) dispatch({ type: 'index', index });
        return;
      }
      if (matchEditorAction(event, getSettings().editorShortcuts) === 'openImage') {
        event.preventDefault();
        if (!locked) void openImage();
      }
    };
    // Capture phase: the editors' own handlers must not see these keys first.
    window.addEventListener('keydown', onKeyDown, true);
    return () => window.removeEventListener('keydown', onKeyDown, true);
  }, [openImage]);

  // `?` or F1 opens the keyboard help (not while typing, not over a dialog).
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.defaultPrevented || isTyping(event.target)) return;
      if (event.ctrlKey || event.altKey || event.metaKey) return;
      if (askRef.current !== null || document.querySelector('dialog[open]')) return;
      if (event.key === '?' || event.key === 'F1') {
        event.preventDefault();
        setHelpOpen(true);
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

  // A file dropped outside a canvas must never navigate the window (a canvas takes its own drop).
  useEffect(() => {
    const hasFiles = (event: DragEvent): boolean =>
      event.dataTransfer?.types.includes('Files') === true;
    const claim = (event: DragEvent): void => {
      if (hasFiles(event)) event.preventDefault();
    };
    window.addEventListener('dragover', claim);
    window.addEventListener('drop', claim);
    return () => {
      window.removeEventListener('dragover', claim);
      window.removeEventListener('drop', claim);
    };
  }, []);

  // --- the questions -----------------------------------------------------------------------

  const titleOf = (id: string): string =>
    state.tabs.find((tab) => tab.id === id)?.title ?? 'this item';

  /** Answers settle once: the dialog also reports "cancel" when any of its buttons closes it. */
  const answer = (handler: (current: Ask) => void): void => {
    const current = askRef.current;
    if (!current) return;
    question(null);
    handler(current);
  };

  const saveAnswer = (how: 'save' | 'discard'): void =>
    answer((current) => {
      if (current.kind !== 'save') return;
      if (how === 'discard') closeTab(current.id);
      else
        void (saves.current.get(current.id)?.() ?? Promise.resolve(false)).then((saved) => {
          if (saved) closeTab(current.id);
        });
    });

  const windowAnswer = (discard: boolean): void =>
    answer(() => {
      if (discard) for (const id of exportingRef.current) void cancelVideoExport(id);
      void window.framecapt.invoke('editor:resolveClose', { discard });
    });

  const blockedByDialog = ask !== null || helpOpen;
  const askTitle = ask && ask.kind !== 'window' ? titleOf(ask.id) : '';
  const unsavedNames = unsaved.map((tab) => tab.title).join(', ');

  return (
    <TooltipProvider>
      <div className="flex h-full flex-col bg-bg">
        <TabStrip
          tabs={state.tabs}
          activeId={state.activeId}
          onActivate={(id) => dispatch({ type: 'activate', id })}
          onClose={requestClose}
          onMove={(id, toIndex) => dispatch({ type: 'move', id, toIndex })}
        />
        <main id="main-content" className="relative min-h-0 flex-1 bg-bg">
          {state.tabs.map((tab) => {
            const active = tab.id === state.activeId;
            const blocked = blockedByDialog || !active;
            return (
              <section
                key={tab.id}
                aria-label={tab.title}
                data-testid="editor-panel"
                data-kind={tab.kind}
                data-active={active}
                inert={!active}
                className={active ? 'absolute inset-0' : 'invisible absolute inset-0'}
              >
                {tab.data.kind === 'shot' ? (
                  <ShotTab
                    tab={tab}
                    shot={tab.data.shot}
                    active={active}
                    blocked={blocked}
                    host={host}
                  />
                ) : (
                  <VideoTab
                    tab={tab}
                    historyId={tab.data.historyId}
                    active={active}
                    blocked={blocked}
                    host={host}
                  />
                )}
              </section>
            );
          })}
          {state.tabs.length === 0 ? (
            <p className="p-8 text-sm text-fg-muted" data-testid="editor-empty">
              Opening…
            </p>
          ) : null}
        </main>
      </div>
      <AlertConfirm
        open={ask?.kind === 'save'}
        title={`Save changes to ${askTitle}?`}
        description="Your changes have not been saved. Closing without saving discards them."
        cancelLabel="Cancel"
        confirmLabel="Don't save"
        extra={{ label: 'Save', onClick: () => saveAnswer('save') }}
        onConfirm={() => saveAnswer('discard')}
        onCancel={() => answer(() => undefined)}
      />
      <AlertConfirm
        open={ask?.kind === 'export'}
        title="Cancel the export and close?"
        description={`${askTitle} is still being exported. Closing it cancels the export; the recording is not changed.`}
        cancelLabel="Keep open"
        confirmLabel="Cancel export & close"
        onConfirm={() =>
          answer((current) => {
            if (current.kind !== 'export') return;
            const tab = stateRef.current.tabs.find((candidate) => candidate.id === current.id);
            if (tab?.data.kind === 'video') void cancelVideoExport(tab.data.historyId);
            closeTab(current.id);
          })
        }
        onCancel={() => answer(() => undefined)}
      />
      <AlertConfirm
        open={ask?.kind === 'video-leave'}
        title="Close without saving?"
        description="The latest changes to this video could not be saved. The recording itself is not affected."
        cancelLabel="Keep editing"
        confirmLabel="Close"
        onConfirm={() =>
          answer((current) => {
            if (current.kind === 'video-leave') closeTab(current.id);
          })
        }
        onCancel={() => answer(() => undefined)}
      />
      <AlertConfirm
        open={ask?.kind === 'window'}
        title="Close the editor?"
        description={
          unsaved.length > 0
            ? `These have unsaved changes: ${unsavedNames}. Closing discards them.${exporting.length > 0 ? ' Exports in progress are cancelled.' : ''}`
            : 'An export is still running. Closing cancels it; your recording is not changed.'
        }
        cancelLabel="Keep editing"
        confirmLabel="Discard & close"
        onConfirm={() => windowAnswer(true)}
        onCancel={() => windowAnswer(false)}
      />
      <KeyboardHelp open={helpOpen} onClose={() => setHelpOpen(false)} />
      <LiveRegion />
      <Toaster
        position="bottom-left"
        offset={12}
        style={{ '--width': '216px' } as CSSProperties}
        theme="system"
        toastOptions={{
          style: {
            background: 'var(--surface)',
            color: 'var(--fg)',
            border: '1px solid var(--line)',
            borderRadius: '12px',
            boxShadow: 'var(--shadow-raised)',
            fontFamily: 'var(--font-sans)',
          },
        }}
      />
    </TooltipProvider>
  );
}
