import {
  useCallback,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
  type Dispatch,
  type ReactNode,
} from 'react';
import { EDITOR_TAB_WARN, type EditorOpenTabEvent } from '../../shared/editor-ipc';
import { AlertConfirm } from '../components/ui/AlertConfirm';
import { openFromHistory } from '../editor/reedit';
import {
  cancelVideoExport,
  listenToVideoExports,
  useExportingVideos,
} from '../history/video-export-store';
import { notify } from '../lib/notify';
import { shortPath } from '../lib/short-path';
import { EditorView, type EditorShot } from '../views/editor/EditorView';
import { FlowView } from '../views/flow/FlowView';
import { VideoEditorView } from '../views/video-editor/VideoEditorView';
import {
  dirtyTabs,
  findByKey,
  homeTabs,
  tabIndexForDigit,
  tabsReducer,
  type Tab,
  type TabsAction,
  type TabsState,
} from './tabs';

/** What a tab renders. The pinned Home tab has no data of its own: App draws its section. */
export type TabData =
  | { kind: 'home' }
  | { kind: 'shot'; shot: EditorShot }
  | { kind: 'video'; historyId: string }
  | { kind: 'flow'; historyId: string };

/** What the window is asking the user right now (one question at a time). */
type Ask =
  | { kind: 'save'; id: string }
  | { kind: 'export'; id: string }
  | { kind: 'video-leave'; id: string }
  | { kind: 'window' };

/** What the open tabs report back: how to save, how to write pending changes. */
interface TabHost {
  setDirty: (id: string, dirty: boolean) => void;
  setSave: (id: string, save: (() => Promise<boolean>) | null) => void;
  setFlush: (id: string, flush: (() => Promise<boolean>) | null) => void;
  requestClose: (id: string) => void;
}

const reducer = tabsReducer<TabData>;
const HOME_DATA: TabData = { kind: 'home' };

interface PanelProps {
  tab: Tab<TabData>;
  active: boolean;
  blocked: boolean;
  host: TabHost;
}

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

export interface EditorTabs {
  state: TabsState<TabData>;
  dispatch: Dispatch<TabsAction<TabData>>;
  /** Opens (or focuses) a tab for what main resolved (`editor:openTab`). */
  openTab: (event: EditorOpenTabEvent) => Promise<void>;
  requestClose: (id: string) => void;
  /** A question is open: the keyboard belongs to it. */
  asking: boolean;
  /** The body of a tab that is an edited item (the pinned tab is drawn by the app). */
  panel: (tab: Tab<TabData>, active: boolean, blockedByApp: boolean) => ReactNode;
  /** The confirmation dialogs (save changes, cancel export, quit with unsaved tabs). */
  dialogs: ReactNode;
  /** Whether any tab holds unsaved work or an export runs (main asks before quitting). */
  needsAsk: boolean;
}

/**
 * The tabs of the main window: the pinned Home tab and one tab per edited item. Every item tab
 * stays mounted so its undo history, selection, zoom and playhead survive a switch; hidden ones
 * are `inert` and invisible (the app draws them that way: not `display: none`, so a canvas keeps
 * its size) and a hidden video is paused. Closing an unsaved screenshot, or quitting with unsaved
 * tabs, asks first; Ctrl+Tab, Ctrl+W and Alt+1..9 work on the strip.
 */
export function useEditorTabs(): EditorTabs {
  const [state, dispatch] = useReducer(reducer, HOME_DATA, homeTabs<TabData>);
  const [ask, setAsk] = useState<Ask | null>(null);
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
  useEffect(() => listenToVideoExports(), []);

  const question = useCallback((next: Ask | null) => {
    askRef.current = next;
    setAsk(next);
  }, []);

  // --- closing -------------------------------------------------------------------------------

  const closeTab = useCallback((id: string) => {
    const tab = stateRef.current.tabs.find((candidate) => candidate.id === id);
    if (!tab || tab.pinned) return;
    if (tab.data.kind === 'shot') discardSession(tab.data.shot.session.id);
    saves.current.delete(id);
    flushes.current.delete(id);
    dispatch({ type: 'close', id });
  }, []);

  const requestClose = useCallback(
    (id: string) => {
      const tab = stateRef.current.tabs.find((candidate) => candidate.id === id);
      if (!tab || tab.pinned) return;
      dispatch({ type: 'activate', id });
      const { data } = tab;
      if (data.kind === 'shot') {
        if (tab.dirty) question({ kind: 'save', id });
        else closeTab(id);
        return;
      }
      if (data.kind === 'flow') {
        closeTab(id);
        return;
      }
      if (data.kind !== 'video') return;
      if (exportingRef.current.includes(data.historyId)) {
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
    // The strip counts Home too: this is the number of open items after this one.
    if (stateRef.current.tabs.length === EDITOR_TAB_WARN) {
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
      } else if (event.kind === 'flow') {
        const key = `flow:${event.historyId}`;
        if (!known(key)) {
          open(key, 'flow', event.title, { kind: 'flow', historyId: event.historyId });
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

  // --- what main knows ---------------------------------------------------------------------

  const unsaved = dirtyTabs(state);
  const needsAsk = unsaved.length > 0 || exporting.length > 0;
  useEffect(() => {
    void window.framecapt.invoke('editor:setState', { dirty: needsAsk });
  }, [needsAsk]);

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
        // Never the window's own "close": it closes the tab, and never the pinned Home tab.
        event.preventDefault();
        const id = stateRef.current.activeId;
        if (!locked) requestCloseRef.current(id);
        return;
      }
      if (event.altKey && !event.ctrlKey && !event.metaKey && !event.shiftKey) {
        const index = tabIndexForDigit(/^Digit(\d)$/.exec(event.code)?.[1] ?? '');
        if (index === null) return;
        event.preventDefault();
        if (!locked) dispatch({ type: 'index', index });
      }
    };
    // Capture phase: the editors' own handlers must not see these keys first.
    window.addEventListener('keydown', onKeyDown, true);
    return () => window.removeEventListener('keydown', onKeyDown, true);
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

  const askTitle = ask && ask.kind !== 'window' ? titleOf(ask.id) : '';
  const unsavedNames = unsaved.map((tab) => tab.title).join(', ');

  const panel = (tab: Tab<TabData>, active: boolean, blockedByApp: boolean): ReactNode => {
    const blocked = blockedByApp || ask !== null || !active;
    const { data } = tab;
    if (data.kind === 'shot') {
      return <ShotTab tab={tab} shot={data.shot} active={active} blocked={blocked} host={host} />;
    }
    if (data.kind === 'video') {
      return (
        <VideoTab
          tab={tab}
          historyId={data.historyId}
          active={active}
          blocked={blocked}
          host={host}
        />
      );
    }
    if (data.kind === 'flow') {
      return (
        <div className="mx-auto max-w-4xl px-8 py-6">
          <FlowView
            historyId={data.historyId}
            onBack={() => dispatch({ type: 'activate', id: 'home' })}
            onEditStep={(historyId, index) =>
              void openTab({
                kind: 'step',
                historyId,
                index,
                title: `${tab.title} (step ${index + 1})`,
              })
            }
          />
        </div>
      );
    }
    return null;
  };

  const dialogs = (
    <>
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
        title="Close FrameCapt?"
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
    </>
  );

  return {
    state,
    dispatch,
    openTab,
    requestClose,
    asking: ask !== null,
    panel,
    dialogs,
    needsAsk,
  };
}
