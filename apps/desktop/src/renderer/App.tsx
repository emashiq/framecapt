import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from 'react';
import { Toaster } from 'sonner';
import type { EditorOpenRequest } from '../shared/editor-ipc';
import type { HistoryItemView } from '../shared/history-ipc';
import type { NavigateEvent, SettingsSectionId, StartRequestEvent } from '../shared/settings-ipc';
import { matchEditorAction } from '../shared/shortcuts';
import { AppShell } from './components/AppShell';
import { KeyboardHelp } from './components/KeyboardHelp';
import { LiveRegion } from './components/LiveRegion';
import { Rail, type SectionId } from './components/Rail';
import { RecorderChoiceDialog } from './components/RecorderChoiceDialog';
import { AlertConfirm } from './components/ui/AlertConfirm';
import { TooltipProvider } from './components/ui/Tooltip';
import { importPicture, pictureIn } from './editor/import-image';
import { listenToBulk } from './history/bulk-store';
import { listenToExports } from './history/export-store';
import { cn } from './lib/cn';
import { isTyping } from './lib/is-typing';
import { requestLaunch } from './lib/launch-bus';
import { notify } from './lib/notify';
import { ALL_SELECTION, type FolderSelection } from './library/tree';
import { toggleLibrarySidebar } from './library/view-prefs';
import { useRecorderState, useRecorderToasts } from './recorder/use-recorder';
import { getSettings, startSettingsSync } from './settings/store';
import { useEditorTabs } from './tabs/EditorTabs';
import { TabStrip } from './tabs/TabStrip';
import { HOME_ID } from './tabs/tabs';
import { HomeView } from './views/HomeView';
import { LibraryView } from './views/LibraryView';
import { RecordingResultView } from './views/RecordingResultView';
import { SettingsView } from './views/SettingsView';
import { canEditItem } from './views/history/actions';

/** What the pinned tab shows: Guides is the Library filtered to step guides. */
const SECTION_LABEL: Record<SectionId, string> = {
  home: 'Home',
  library: 'Library',
  guides: 'Guides',
  settings: 'Settings',
};

type PinnedView = 'home' | 'library' | 'settings';
const GUIDES: FolderSelection = { kind: 'type', type: 'flow' };

/**
 * Main window UI. The pinned Home tab shows one section at a time (Home, Library, Guides,
 * Settings: the icon rail picks it; plain state, no router) and every screenshot, video or step
 * guide being edited is a tab beside it (tabs/EditorTabs.tsx). Windows ask main to open an item
 * (`editor:open`); main answers with the tab to open.
 */
export function App() {
  const [view, setView] = useState<PinnedView>('home');
  const [libraryScope, setLibraryScope] = useState<FolderSelection>(ALL_SELECTION);
  const [settingsSection, setSettingsSection] = useState<SettingsSectionId | undefined>(undefined);
  /** An item to open in the Library (picked in Recent captures or the command center). */
  const [historyFocus, setHistoryFocus] = useState<string | null>(null);
  const [quitAsk, setQuitAsk] = useState(false);
  const [helpOpen, setHelpOpen] = useState(false);
  const recorder = useRecorderState();
  useRecorderToasts(recorder);
  const editor = useEditorTabs();
  const { state, dispatch, openTab } = editor;

  const section: SectionId =
    view === 'library' && libraryScope.kind === 'type' && libraryScope.type === 'flow'
      ? 'guides'
      : view;
  const homeActive = state.activeId === HOME_ID;
  const homeRef = useRef<HTMLElement>(null);
  const homeShowing = useRef({ active: true, section });
  useEffect(() => {
    homeShowing.current = { active: homeActive, section };
  }, [homeActive, section]);

  // A video playing in the Library's details stops when the pinned tab is not showing.
  useEffect(() => {
    if (!homeActive) homeRef.current?.querySelectorAll('video').forEach((video) => video.pause());
  }, [homeActive]);

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

  // The pinned tab's icon and label follow the section it shows.
  useEffect(() => {
    dispatch({ type: 'section', kind: section, title: SECTION_LABEL[section] });
  }, [section, dispatch]);

  // After switching to the pinned tab or its section, focus lands in the content.
  const firstRender = useRef(true);
  useEffect(() => {
    if (firstRender.current) {
      firstRender.current = false;
      return;
    }
    if (homeActive) homeRef.current?.focus({ preventScroll: true });
  }, [homeActive, section]);

  const recorderStatus = useRef(recorder.status);
  useEffect(() => {
    recorderStatus.current = recorder.status;
  }, [recorder.status]);

  /** Shows a section in the pinned tab (and the pinned tab itself). */
  const navigate = useCallback(
    (next: SectionId, settings?: SettingsSectionId) => {
      dispatch({ type: 'activate', id: HOME_ID });
      // Home is always Home: a finished recording's summary is dismissed (it is in the Library).
      if (next === 'home' && recorderStatus.current === 'completed') {
        void window.framecapt.invoke('recorder:reset');
      }
      if (next === 'guides') {
        setView('library');
        setLibraryScope(GUIDES);
        return;
      }
      setView(next);
      if (next === 'settings') setSettingsSection(settings);
      // Library from Guides shows everything again.
      if (next === 'library') {
        setLibraryScope((scope) =>
          scope.kind === 'type' && scope.type === 'flow' ? ALL_SELECTION : scope,
        );
      }
    },
    [dispatch],
  );

  /** Asks main to open an item as a tab (it resolves what the item is and names the tab). */
  const openInEditor = useCallback((request: EditorOpenRequest) => {
    void window.framecapt.invoke('editor:open', request).then((response) => {
      if (!response.ok) notify.error(response.error);
    });
  }, []);

  /**
   * An item of history opens as a tab: a screenshot or editable recording in a viewer first (its
   * Edit button turns the tab into the editor), a guide as it is.
   */
  const openItem = useCallback(
    (item: HistoryItemView) => {
      if (item.exists && (canEditItem(item) || item.type === 'flow')) {
        openInEditor({
          kind: 'history',
          historyId: item.id,
          ...(item.type !== 'flow' && { viewer: true }),
        });
        return;
      }
      setHistoryFocus(item.id);
      navigate('library');
    },
    [openInEditor, navigate],
  );

  const openHistoryId = useCallback(
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
        const latest = response.data.items.find((item) => item.exists && canEditItem(item));
        if (latest) openHistoryId(latest.id);
        else notify.info('There is no recording to edit yet. Record something first.');
      });
  }, [openHistoryId]);

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
        void openTab({ kind: 'session', sessionId: result.session.id, imported: true });
      });
    },
    [openTab],
  );

  /** File > Open image: the Open dialog first. */
  const openImage = useCallback(async () => {
    const response = await window.framecapt.invoke('shot:openImage');
    if (!response.ok) notify.error(response.error);
    else if ('bytes' in response.data) openPicture(new Blob([response.data.bytes]));
  }, [openPicture]);

  /** File > Open video: the Open dialog; the video opens in a new video editor tab. */
  const openVideo = useCallback(async () => {
    const response = await window.framecapt.invoke('editor:openVideo');
    if (!response.ok) notify.error(response.error);
  }, []);

  /** File > Open project: main's dialog imports a .fcimage / .fcvideo into history; it opens as a tab. */
  const openProject = useCallback(async () => {
    const response = await window.framecapt.invoke('history:openProjectFile');
    if (!response.ok) notify.error(response.error);
    else if ('historyId' in response.data) {
      openInEditor({ kind: 'history', historyId: response.data.historyId });
    }
  }, [openInEditor]);

  /** "Edit as separate videos": every source of a multi-source recording opens as its own tab. */
  const splitRecording = useCallback(
    async (historyId: string) => {
      const response = await window.framecapt.invoke('history:splitSources', { id: historyId });
      if (!response.ok) {
        notify.error(response.error);
        return;
      }
      for (const id of response.data.ids) openInEditor({ kind: 'history', historyId: id });
    },
    [openInEditor],
  );

  /**
   * Starts a screenshot or recording through Home's own handlers (its buttons, with the window
   * picker for "window"): a tray or shortcut action, and the menus and command center.
   */
  const startRequest = useCallback(
    (request: StartRequestEvent) => {
      navigate('home');
      requestLaunch(request);
    },
    [navigate],
  );

  // The tray menu asks for a view; a shortcut or the tray asks to start something here.
  const latest = useRef({ navigate, startRequest, openImage, openPicture, openHistoryId });
  useEffect(() => {
    latest.current = { navigate, startRequest, openImage, openPicture, openHistoryId };
  });
  // A step guide was saved (Done in the pill, or its shortcut): it opens as a tab.
  useEffect(
    () =>
      window.framecapt.on('steps:finished', ({ historyId }) =>
        latest.current.openHistoryId(historyId),
      ),
    [],
  );
  useEffect(
    () =>
      window.framecapt.on('app:navigate', (event: NavigateEvent) =>
        latest.current.navigate(
          event.view === 'capture' ? 'home' : event.view === 'history' ? 'library' : 'settings',
          event.section,
        ),
      ),
    [],
  );
  useEffect(
    () =>
      window.framecapt.on('app:startRequest', (request) => latest.current.startRequest(request)),
    [],
  );

  // Open image (Settings, Shortcuts; Ctrl+O by default) and Ctrl+B (the Library's folder sidebar)
  // work in the whole main window.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.repeat || event.defaultPrevented) return;
      // A dialog (help, a confirmation, the command center) owns the keyboard while it is open.
      if (document.querySelector('dialog[open]')) return;
      if (matchEditorAction(event, getSettings().editorShortcuts) === 'openImage') {
        event.preventDefault();
        void latest.current.openImage();
        return;
      }
      const shown = homeShowing.current;
      if (
        shown.active &&
        shown.section !== 'home' &&
        shown.section !== 'settings' &&
        event.ctrlKey &&
        !event.shiftKey &&
        !event.altKey &&
        event.key.toLowerCase() === 'b'
      ) {
        event.preventDefault();
        toggleLibrarySidebar();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

  // A picture dropped on Home or pasted on it opens as a tab. Dropping a file anywhere
  // must never navigate the window, so every file drag is claimed here.
  useEffect(() => {
    const hasFiles = (event: DragEvent): boolean =>
      event.dataTransfer?.types.includes('Files') === true;
    const onDragOver = (event: DragEvent): void => {
      if (hasFiles(event)) event.preventDefault();
    };
    const onDrop = (event: DragEvent): void => {
      if (!hasFiles(event)) return;
      // An editor's canvas takes a picture dropped on it (an image layer); only Home opens a new tab.
      const takenByCanvas = event.defaultPrevented;
      event.preventDefault();
      const picture = pictureIn(event.dataTransfer?.files);
      if (picture && !takenByCanvas && homeShowing.current.active)
        latest.current.openPicture(picture);
    };
    // The DOM paste event carries the clipboard's files: no clipboard permission is involved.
    const onPaste = (event: ClipboardEvent): void => {
      const shown = homeShowing.current;
      if (event.defaultPrevented || !shown.active || shown.section !== 'home') return;
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
  const askingRef = useRef(false);
  useEffect(() => {
    askingRef.current = editor.asking;
  }, [editor.asking]);
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.defaultPrevented || isTyping(event.target)) return;
      if (event.ctrlKey || event.altKey || event.metaKey) return;
      if (askingRef.current || document.querySelector('dialog[open]')) return;
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
        navigate: (next: SectionId, settings?: SettingsSectionId) => navigate(next, settings),
        toggleLibrarySidebar: () => {
          navigate('library');
          toggleLibrarySidebar();
        },
        showKeyboardHelp: () => setHelpOpen(true),
        editVideo: editLatestVideo,
        openImage: () => void openImage(),
        openVideo: () => void openVideo(),
        openProject: () => void openProject(),
        startSteps: () =>
          void window.framecapt.invoke('steps:start').then((result) => {
            if (!result.ok) notify.error(result.error);
          }),
      },
      onOpenCapture: (id: string) => {
        setHistoryFocus(id);
        navigate('library');
      },
    }),
    [startRequest, navigate, editLatestVideo, openImage, openVideo, openProject],
  );

  const showRecording = view === 'home' && recorder.status === 'completed';
  const recording = recorder.status === 'recording' || recorder.status === 'paused';

  /** The section the pinned tab shows. */
  const homeContent =
    showRecording && recorder.result ? (
      <Scroller key="result">
        <RecordingResultView
          snapshot={recorder}
          result={recorder.result}
          onNewRecording={() => void window.framecapt.invoke('recorder:reset')}
          onOpenHistory={() => navigate('library')}
          onSplitSources={splitRecording}
        />
      </Scroller>
    ) : view === 'home' ? (
      <Scroller key="home">
        <HomeView
          onOpenImage={() => void openImage()}
          onOpenVideo={() => void openVideo()}
          onOpenItem={openItem}
          onOpenLibrary={() => navigate('library')}
          onOpenSettings={(next) => navigate('settings', next)}
        />
      </Scroller>
    ) : view === 'library' ? (
      <LibraryView
        active={homeActive}
        scope={libraryScope}
        onScopeChange={setLibraryScope}
        focusId={historyFocus}
        onFocusConsumed={() => setHistoryFocus(null)}
        onEditItem={openHistoryId}
        onEditVideo={openHistoryId}
        onOpenFlow={openHistoryId}
      />
    ) : (
      <Scroller key="settings">
        <SettingsView section={settingsSection} onSectionChange={setSettingsSection} />
      </Scroller>
    );

  return (
    <TooltipProvider>
      <AppShell
        titleBar={titleBar}
        rail={
          <Rail
            section={homeActive ? section : null}
            onNavigate={(next) => navigate(next)}
            onHelp={() => setHelpOpen(true)}
            recording={recording}
          />
        }
        strip={
          <TabStrip
            tabs={state.tabs}
            activeId={state.activeId}
            onActivate={(id) => dispatch({ type: 'activate', id })}
            onClose={editor.requestClose}
            onMove={(id, toIndex) => dispatch({ type: 'move', id, toIndex })}
          />
        }
      >
        {state.tabs.map((tab) => {
          const active = tab.id === state.activeId;
          return (
            <section
              key={tab.id}
              ref={tab.pinned ? homeRef : undefined}
              tabIndex={tab.pinned ? -1 : undefined}
              aria-label={tab.title}
              data-testid={tab.pinned ? 'home-panel' : 'editor-panel'}
              data-kind={tab.pinned ? undefined : tab.kind}
              data-active={active}
              inert={!active}
              className={cn('absolute inset-0 outline-none', !active && 'invisible')}
            >
              {tab.pinned ? homeContent : editor.panel(tab, active, helpOpen)}
            </section>
          );
        })}
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
      {editor.dialogs}
      <RecorderChoiceDialog
        snapshot={recorder}
        onAnswer={(answer) => void window.framecapt.invoke('recorder:resolveChoice', { answer })}
      />
      <KeyboardHelp open={helpOpen} onClose={() => setHelpOpen(false)} />
      <LiveRegion />
      {/* Bottom left, clear of the rail: nothing the user has to press is there, whereas the
          right side holds the primary actions of every view (New recording, Export, Save). */}
      <Toaster
        position="bottom-left"
        offset={{ left: 68, bottom: 12 }}
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

/** A section that scrolls on its own, in a centred column. */
function Scroller({ children }: { children: ReactNode }) {
  return (
    <div className="h-full overflow-y-auto">
      <div className="view-in mx-auto max-w-5xl px-8 py-7">{children}</div>
    </div>
  );
}
