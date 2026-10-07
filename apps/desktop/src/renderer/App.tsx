import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { Toaster } from 'sonner';
import type { EditorOpenRequest, EditorState } from '../shared/editor-ipc';
import type { NavigateEvent, SettingsSectionId, StartRequestEvent } from '../shared/settings-ipc';
import { AppShell, type ViewId } from './components/AppShell';
import { KeyboardHelp } from './components/KeyboardHelp';
import { LiveRegion } from './components/LiveRegion';
import { RecorderChoiceDialog } from './components/RecorderChoiceDialog';
import { AlertConfirm } from './components/ui/AlertConfirm';
import { TooltipProvider } from './components/ui/Tooltip';
import { isTyping } from './lib/is-typing';
import { requestLaunch } from './lib/launch-bus';
import { notify } from './lib/notify';
import { useRecorderState, useRecorderToasts } from './recorder/use-recorder';
import { CaptureView } from './views/CaptureView';
import { RecordingResultView } from './views/RecordingResultView';
import { FlowView } from './views/flow/FlowView';
import { HistoryView } from './views/HistoryView';
import { SettingsView } from './views/SettingsView';
import { listenToBulk } from './history/bulk-store';
import { listenToExports } from './history/export-store';
import { importPicture, pictureIn } from './editor/import-image';
import { matchEditorAction } from '../shared/shortcuts';
import { getSettings, startSettingsSync } from './settings/store';

/**
 * Main window UI. Navigation is plain state: Capture, History, Settings and a saved step guide do
 * not need a router. Screenshots and videos are edited in the Editor window (editor-window/): this
 * window only asks main to open them there (`editor:open`).
 */
export function App() {
  const [view, setView] = useState<ViewId>('capture');
  const [settingsSection, setSettingsSection] = useState<SettingsSectionId | undefined>(undefined);
  /** An item to open in History (picked in the Recent captures strip). */
  const [historyFocus, setHistoryFocus] = useState<string | null>(null);
  /** The step guide the Flow view shows. */
  const [flowId, setFlowId] = useState<string | null>(null);
  const [quitAsk, setQuitAsk] = useState(false);
  const [helpOpen, setHelpOpen] = useState(false);
  /** What the Editor window holds: its button shows the tab count. */
  const [editor, setEditor] = useState<EditorState>({ tabs: 0, dirty: false });
  const viewRef = useRef<ViewId>('capture');
  const recorder = useRecorderState();
  useRecorderToasts(recorder);

  useEffect(() => {
    viewRef.current = view;
  }, [view]);

  // The settings (and the theme) load once; main pushes every later change.
  useEffect(() => startSettingsSync(), []);

  // MP4 export progress and results are shown wherever the user is.
  useEffect(() => listenToExports(), []);
  useEffect(() => listenToBulk(), []);

  // A damaged history file is set aside at startup; say so once.
  useEffect(() => {
    void window.framecapt.invoke('history:consumeNotice').then((response) => {
      if (response.ok && response.data.reset) {
        notify.info(
          'History was reset because its file was damaged. Your files were not touched.',
          {
            duration: 10_000,
          },
        );
      }
    });
  }, []);

  // The Editor window's tab count (its button is shown while it has tabs).
  useEffect(() => {
    let live = true;
    const off = window.framecapt.on('editor:stateChanged', setEditor);
    void window.framecapt.invoke('editor:getState').then((response) => {
      if (live && response.ok) setEditor(response.data);
    });
    return () => {
      live = false;
      off();
    };
  }, []);

  // Quit (tray, menu) while a recording runs: stop and save it first, or keep recording.
  useEffect(() => window.framecapt.on('app:confirmQuit', () => setQuitAsk(true)), []);

  // Messages from shortcuts and the tray (a capture is already running, a start failed).
  useEffect(
    () =>
      window.framecapt.on('app:toast', ({ level, message }) => {
        if (level === 'error') notify.error(message);
        else notify.info(message);
      }),
    [],
  );

  const navigate = useCallback((next: ViewId, section?: SettingsSectionId) => {
    setView(next);
    if (next === 'settings') setSettingsSection(section);
  }, []);

  /** Opens something as a tab of the Editor window (made on first use, brought to the front). */
  const openInEditor = useCallback((request: EditorOpenRequest) => {
    void window.framecapt.invoke('editor:open', request).then((response) => {
      if (!response.ok) notify.error(response.error);
    });
  }, []);

  /** History's Edit video action, and "Edit the latest recording". */
  const editVideo = useCallback(
    (id: string) => openInEditor({ kind: 'history', historyId: id }),
    [openInEditor],
  );

  /** The command center's "Edit the latest recording". */
  const editLatestVideo = useCallback(() => {
    void window.framecapt
      .invoke('history:list', { filter: 'recording', limit: 50 })
      .then((response) => {
        if (!response.ok) {
          notify.error(response.error);
          return;
        }
        const latest = response.data.items.find(
          (item) =>
            item.exists &&
            (item.format === 'webm' || item.format === 'mp4' || item.format === 'fcap'),
        );
        if (latest) editVideo(latest.id);
        else notify.info('There is no recording to edit yet. Record something first.');
      });
  }, [editVideo]);

  /** Opens a saved step guide (after Done, or from History). */
  const openFlow = useCallback((id: string) => {
    setFlowId(id);
    setView('flow');
  }, []);

  /** The Flow view's "Open in editor": one step of a guide, saved back over its own picture. */
  const editFlowStep = useCallback(
    (historyId: string, index: number) => openInEditor({ kind: 'step', historyId, index }),
    [openInEditor],
  );

  /**
   * A new editor tab from a picture (Open image, a drop, a paste). The picture is not saved
   * anywhere; it is only an editable copy.
   */
  const openPicture = useCallback(
    (picture: Blob) => {
      void importPicture(window.framecapt, picture).then((result) => {
        if (!result.ok) {
          notify.error(result.error);
          return;
        }
        openInEditor({ kind: 'session', sessionId: result.session.id, imported: true });
      });
    },
    [openInEditor],
  );

  /** File > Open image: the Open dialog first. */
  const openImage = useCallback(async () => {
    const response = await window.framecapt.invoke('shot:openImage');
    if (!response.ok) notify.error(response.error);
    else if ('bytes' in response.data) openPicture(new Blob([response.data.bytes]));
  }, [openPicture]);

  /**
   * Starts a screenshot or recording through the Capture view's own handlers (its buttons, with the
   * window picker for "window"): a tray or shortcut action, and the menus and command center.
   */
  const startRequest = useCallback((request: StartRequestEvent) => {
    setView('capture');
    requestLaunch(request);
  }, []);

  // The tray menu asks for a view; a shortcut or the tray asks to start something here.
  const latest = useRef({ navigate, startRequest, openImage, openPicture, openFlow });
  useEffect(() => {
    latest.current = { navigate, startRequest, openImage, openPicture, openFlow };
  });
  // A step guide was saved (Done in the pill, or its shortcut): it opens here.
  useEffect(
    () =>
      window.framecapt.on('steps:finished', ({ historyId }) => latest.current.openFlow(historyId)),
    [],
  );
  useEffect(
    () =>
      window.framecapt.on('app:navigate', (event: NavigateEvent) =>
        latest.current.navigate(event.view, event.section),
      ),
    [],
  );
  useEffect(
    () =>
      window.framecapt.on('app:startRequest', (request) => latest.current.startRequest(request)),
    [],
  );

  // Open image: its key (Settings, Shortcuts; Ctrl+O by default) works in the whole main window.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.repeat || event.defaultPrevented) return;
      if (matchEditorAction(event, getSettings().editorShortcuts) !== 'openImage') return;
      // A dialog (help, a confirmation, the command center) owns the keyboard while it is open.
      if (document.querySelector('dialog[open]')) return;
      event.preventDefault();
      void latest.current.openImage();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

  // A picture dropped on the window or pasted on the Capture view opens in the Editor window.
  // Dropping a file anywhere must never navigate the window, so every file drag is claimed here.
  useEffect(() => {
    const hasFiles = (event: DragEvent): boolean =>
      event.dataTransfer?.types.includes('Files') === true;
    const onDragOver = (event: DragEvent): void => {
      if (hasFiles(event)) event.preventDefault();
    };
    const onDrop = (event: DragEvent): void => {
      if (!hasFiles(event)) return;
      event.preventDefault();
      const picture = pictureIn(event.dataTransfer?.files);
      if (picture) latest.current.openPicture(picture);
    };
    // The DOM paste event carries the clipboard's files: no clipboard permission is involved.
    const onPaste = (event: ClipboardEvent): void => {
      if (event.defaultPrevented || viewRef.current !== 'capture') return;
      if (isTyping(event.target)) return;
      const picture = pictureIn(event.clipboardData?.files);
      if (!picture) return;
      event.preventDefault();
      latest.current.openPicture(picture);
    };
    window.addEventListener('dragover', onDragOver);
    window.addEventListener('drop', onDrop);
    window.addEventListener('paste', onPaste);
    return () => {
      window.removeEventListener('dragover', onDragOver);
      window.removeEventListener('drop', onDrop);
      window.removeEventListener('paste', onPaste);
    };
  }, []);

  // `?` or F1 opens the keyboard help (not while typing, not over a dialog).
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.defaultPrevented || isTyping(event.target)) return;
      if (event.ctrlKey || event.altKey || event.metaKey) return;
      if (event.key === '?' || event.key === 'F1') {
        event.preventDefault();
        setHelpOpen(true);
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

  const titleBar = useMemo(
    () => ({
      actions: {
        startCapture: (
          kind: StartRequestEvent['kind'],
          target: StartRequestEvent['target'],
          allScreens?: boolean,
        ) => startRequest({ kind, target, ...(allScreens && { allScreens }) }),
        navigate: (next: ViewId, section?: SettingsSectionId) => navigate(next, section),
        showKeyboardHelp: () => setHelpOpen(true),
        editVideo: editLatestVideo,
        openImage: () => void openImage(),
        startSteps: () =>
          void window.framecapt.invoke('steps:start').then((result) => {
            if (!result.ok) notify.error(result.error);
          }),
      },
      onOpenCapture: (id: string) => {
        setHistoryFocus(id);
        navigate('history');
      },
      editorTabs: editor.tabs,
      onShowEditor: () =>
        void window.framecapt.invoke('editor:show').then((result) => {
          if (!result.ok) notify.error(result.error);
        }),
    }),
    [startRequest, navigate, editLatestVideo, openImage, editor.tabs],
  );

  const showRecording = view === 'capture' && recorder.status === 'completed';

  return (
    <TooltipProvider>
      <AppShell
        view={view}
        onNavigate={(next) => navigate(next)}
        wide={view === 'history' || view === 'flow'}
        onHelp={() => setHelpOpen(true)}
        titleBar={titleBar}
      >
        {showRecording && recorder.result ? (
          <RecordingResultView
            snapshot={recorder}
            result={recorder.result}
            onNewRecording={() => void window.framecapt.invoke('recorder:reset')}
            onOpenHistory={() => navigate('history')}
          />
        ) : view === 'capture' ? (
          <CaptureView
            onOpenImage={() => void openImage()}
            onOpenHistory={(id) => {
              setHistoryFocus(id ?? null);
              navigate('history');
            }}
            onOpenSettings={(section) => navigate('settings', section)}
          />
        ) : view === 'history' ? (
          <HistoryView
            focusId={historyFocus}
            onFocusConsumed={() => setHistoryFocus(null)}
            onEditItem={(id) => openInEditor({ kind: 'history', historyId: id })}
            onEditVideo={editVideo}
            onOpenFlow={openFlow}
          />
        ) : view === 'flow' && flowId ? (
          <FlowView
            key={flowId}
            historyId={flowId}
            onBack={() => navigate('history')}
            onEditStep={editFlowStep}
          />
        ) : view === 'settings' ? (
          <SettingsView section={settingsSection} onSectionChange={setSettingsSection} />
        ) : null}
      </AppShell>
      <AlertConfirm
        open={quitAsk}
        title="Quit while recording?"
        description="A recording is in progress. Stop and save it before quitting?"
        cancelLabel="Keep recording"
        confirmLabel="Stop & quit"
        onConfirm={() => {
          setQuitAsk(false);
          void window.framecapt.invoke('app:resolveQuit', { stop: true });
        }}
        onCancel={() => {
          setQuitAsk(false);
          void window.framecapt.invoke('app:resolveQuit', { stop: false });
        }}
      />
      <RecorderChoiceDialog
        snapshot={recorder}
        onAnswer={(answer) => void window.framecapt.invoke('recorder:resolveChoice', { answer })}
      />
      <KeyboardHelp open={helpOpen} onClose={() => setHelpOpen(false)} />
      <LiveRegion />
      {/* Bottom left, over the sidebar: nothing the user has to press is there, whereas the
          right side holds the primary actions of every view (New recording, Export, Save). */}
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
