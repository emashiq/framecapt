import { useCallback, useEffect, useRef, useState } from 'react';
import { Toaster } from 'sonner';
import type { NavigateEvent, SettingsSectionId } from '../shared/settings-ipc';
import { AppShell, type ViewId } from './components/AppShell';
import { KeyboardHelp } from './components/KeyboardHelp';
import { RecorderChoiceDialog } from './components/RecorderChoiceDialog';
import { AlertConfirm } from './components/ui/AlertConfirm';
import { TooltipProvider } from './components/ui/Tooltip';
import { useAnnouncement } from './lib/announce';
import { requestLaunch } from './lib/launch-bus';
import { notify } from './lib/notify';
import { useRecorderState, useRecorderToasts } from './recorder/use-recorder';
import { startSettingsSync } from './settings/store';
import { CaptureView } from './views/CaptureView';
import { RecordingResultView } from './views/RecordingResultView';
import { EditorView, type EditorShot } from './views/editor/EditorView';
import { HistoryView } from './views/HistoryView';
import { SettingsView } from './views/SettingsView';
import { listenToExports } from './history/export-store';

/** What the discard confirmation will do when the user agrees. */
type PendingLeave = { kind: 'leave'; then?: () => void } | { kind: 'close' };

/** True while the user is typing somewhere: single-key shortcuts must not fire. */
function isTyping(target: EventTarget | null): boolean {
  return (
    target instanceof HTMLElement &&
    !!target.closest('input, textarea, select, [contenteditable="true"]')
  );
}

/** "…\Framelet\file.png": the last two path segments, for a toast. */
function shortPath(file: string): string {
  const parts = file.split(/[\\/]/).filter(Boolean);
  return parts.length > 2 ? `…\\${parts.slice(-2).join('\\')}` : file;
}

/** One polite live region for status messages (saved, recording stopped, settings reset). */
function LiveRegion() {
  const { text, n } = useAnnouncement();
  return (
    <div
      role="status"
      aria-live="polite"
      aria-atomic="true"
      className="sr-only"
      data-testid="live-region"
    >
      {/* The counter makes an identical message announce again. */}
      <span key={n}>{text}</span>
    </div>
  );
}

/**
 * Main window UI. Navigation is plain state: three views do not need a router. A finished
 * screenshot opens in the editor (the Capture tab) until it is closed. Leaving the editor (Done,
 * Discard, another tab) or closing the window while the screenshot is unsaved asks first; the
 * session directory (the original) is deleted whenever the editor closes.
 */
export function App() {
  const [view, setView] = useState<ViewId>('capture');
  const [settingsSection, setSettingsSection] = useState<SettingsSectionId | undefined>(undefined);
  const [shot, setShot] = useState<EditorShot | null>(null);
  const [dirty, setDirty] = useState(false);
  /** An item to open in History (picked in the Recent captures strip). */
  const [historyFocus, setHistoryFocus] = useState<string | null>(null);
  const [pending, setPending] = useState<PendingLeave | null>(null);
  const [quitAsk, setQuitAsk] = useState(false);
  const [helpOpen, setHelpOpen] = useState(false);
  const shotRef = useRef<EditorShot | null>(null);
  const recorder = useRecorderState();
  useRecorderToasts(recorder);

  useEffect(() => {
    shotRef.current = shot;
  }, [shot]);

  // The settings (and the theme) load once; main pushes every later change.
  useEffect(() => startSettingsSync(), []);

  useEffect(
    () =>
      window.framelet.on('shot:ready', ({ session, savedPath }) => {
        void window.framelet.invoke('shot:get', { sessionId: session.id }).then((response) => {
          if (!response.ok) {
            notify.error(response.error);
            return;
          }
          const previous = shotRef.current;
          if (previous) {
            void window.framelet.invoke('shot:discard', { sessionId: previous.session.id });
          }
          setShot({
            session: response.data.session,
            png: response.data.png,
            ...(savedPath && { savedPath }),
          });
          setDirty(savedPath === undefined); // unsaved, unless "save after capture" already saved it
          setView('capture');
          if (savedPath) {
            notify.success(`Saved to ${shortPath(savedPath)}`, {
              action: {
                label: 'Show in folder',
                onClick: () =>
                  void window.framelet.invoke('shell:showItemInFolder', { path: savedPath }),
              },
            });
          }
        });
      }),
    [],
  );

  // MP4 export progress and results are shown wherever the user is.
  useEffect(() => listenToExports(), []);

  // A damaged history file is set aside at startup; say so once.
  useEffect(() => {
    void window.framelet.invoke('history:consumeNotice').then((response) => {
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

  // Main asks before closing the window while the editor has unsaved work.
  useEffect(() => window.framelet.on('app:confirmClose', () => setPending({ kind: 'close' })), []);

  // Quit (tray, menu) while a recording runs: stop and save it first, or keep recording.
  useEffect(() => window.framelet.on('app:confirmQuit', () => setQuitAsk(true)), []);

  // Messages from shortcuts and the tray (a capture is already running, a start failed).
  useEffect(
    () =>
      window.framelet.on('app:toast', ({ level, message }) => {
        if (level === 'error') notify.error(message);
        else notify.info(message);
      }),
    [],
  );

  // Main needs to know whether closing would lose work, and whether an editor is open at all.
  useEffect(() => {
    void window.framelet.invoke('editor:setDirty', {
      dirty: shot !== null && dirty,
      open: shot !== null,
    });
  }, [shot, dirty]);

  const endSession = useCallback(async () => {
    const current = shotRef.current;
    if (current) await window.framelet.invoke('shot:discard', { sessionId: current.session.id });
    setShot(null);
    setDirty(false);
  }, []);

  const requestLeave = useCallback(
    (then?: () => void) => {
      if (shotRef.current && dirty) {
        setPending({ kind: 'leave', ...(then && { then }) });
        return;
      }
      void endSession().then(then);
    },
    [dirty, endSession],
  );

  const confirmDiscard = useCallback(async () => {
    const request = pending;
    setPending(null);
    if (!request) return;
    await endSession();
    if (request.kind === 'leave') request.then?.();
    else await window.framelet.invoke('editor:resolveClose', { discard: true });
  }, [pending, endSession]);

  const keepEditing = useCallback(() => {
    const request = pending;
    setPending(null);
    if (request?.kind === 'close') {
      void window.framelet.invoke('editor:resolveClose', { discard: false });
    }
  }, [pending]);

  const navigate = useCallback(
    (next: ViewId, section?: SettingsSectionId) => {
      const go = (): void => {
        setView(next);
        if (next === 'settings') setSettingsSection(section);
      };
      if (shotRef.current && next !== 'capture') requestLeave(go);
      else go();
    },
    [requestLeave],
  );

  // The tray menu asks for a view; a shortcut or the tray asks to start something here.
  const latest = useRef({ navigate, requestLeave });
  useEffect(() => {
    latest.current = { navigate, requestLeave };
  });
  useEffect(
    () =>
      window.framelet.on('app:navigate', (event: NavigateEvent) =>
        latest.current.navigate(event.view, event.section),
      ),
    [],
  );
  useEffect(
    () =>
      window.framelet.on('app:startRequest', (request) =>
        latest.current.requestLeave(() => {
          setView('capture');
          requestLaunch(request);
        }),
      ),
    [],
  );

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

  const showEditor = view === 'capture' && shot !== null;
  const showRecording = view === 'capture' && !showEditor && recorder.status === 'completed';

  return (
    <TooltipProvider>
      <AppShell
        view={view}
        onNavigate={(next) => navigate(next)}
        editor={showEditor}
        wide={view === 'history'}
        onHelp={() => setHelpOpen(true)}
      >
        {showEditor ? (
          <EditorView
            key={shot.session.id}
            shot={shot}
            blocked={pending !== null || helpOpen}
            onDirtyChange={setDirty}
            onRequestLeave={() => requestLeave()}
          />
        ) : showRecording && recorder.result ? (
          <RecordingResultView
            snapshot={recorder}
            result={recorder.result}
            onNewRecording={() => void window.framelet.invoke('recorder:reset')}
            onOpenHistory={() => navigate('history')}
          />
        ) : view === 'capture' ? (
          <CaptureView
            onOpenHistory={(id) => {
              setHistoryFocus(id ?? null);
              navigate('history');
            }}
            onOpenSettings={(section) => navigate('settings', section)}
          />
        ) : view === 'history' ? (
          <HistoryView focusId={historyFocus} onFocusConsumed={() => setHistoryFocus(null)} />
        ) : (
          <SettingsView section={settingsSection} onSectionChange={setSettingsSection} />
        )}
      </AppShell>
      <AlertConfirm
        open={pending !== null}
        title="Discard this screenshot?"
        description="It has not been saved or copied since your last change. Discarding deletes it for good."
        cancelLabel="Keep editing"
        confirmLabel="Discard"
        onConfirm={() => void confirmDiscard()}
        onCancel={keepEditing}
      />
      <AlertConfirm
        open={quitAsk}
        title="Quit while recording?"
        description="A recording is in progress. Stop and save it before quitting?"
        cancelLabel="Keep recording"
        confirmLabel="Stop & quit"
        onConfirm={() => {
          setQuitAsk(false);
          void window.framelet.invoke('app:resolveQuit', { stop: true });
        }}
        onCancel={() => {
          setQuitAsk(false);
          void window.framelet.invoke('app:resolveQuit', { stop: false });
        }}
      />
      <RecorderChoiceDialog
        snapshot={recorder}
        onAnswer={(answer) => void window.framelet.invoke('recorder:resolveChoice', { answer })}
      />
      <KeyboardHelp open={helpOpen} onClose={() => setHelpOpen(false)} />
      <LiveRegion />
      <Toaster
        position="bottom-right"
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
