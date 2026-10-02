import { useCallback, useEffect, useRef, useState, type JSX } from 'react';
import { Toaster, toast } from 'sonner';
import { AppShell, type ViewId } from './components/AppShell';
import { AlertConfirm } from './components/ui/AlertConfirm';
import { TooltipProvider } from './components/ui/Tooltip';
import { CaptureView } from './views/CaptureView';
import { EditorView, type EditorShot } from './views/editor/EditorView';
import { HistoryView } from './views/HistoryView';
import { SettingsView } from './views/SettingsView';

const VIEWS: Record<ViewId, () => JSX.Element> = {
  capture: CaptureView,
  history: HistoryView,
  settings: SettingsView,
};

/** What the discard confirmation will do when the user agrees. */
type PendingLeave = { kind: 'leave'; then?: () => void } | { kind: 'close' };

/**
 * Main window UI. Navigation is plain state: three views do not need a router. A finished
 * screenshot opens in the editor (the Capture tab) until it is closed. Leaving the editor (Done,
 * Discard, another tab) or closing the window while the screenshot is unsaved asks first; the
 * session directory (the original) is deleted whenever the editor closes.
 */
export function App() {
  const [view, setView] = useState<ViewId>('capture');
  const [shot, setShot] = useState<EditorShot | null>(null);
  const [dirty, setDirty] = useState(false);
  const [pending, setPending] = useState<PendingLeave | null>(null);
  const shotRef = useRef<EditorShot | null>(null);

  useEffect(() => {
    shotRef.current = shot;
  }, [shot]);

  useEffect(
    () =>
      window.framelet.on('shot:ready', ({ session }) => {
        void window.framelet.invoke('shot:get', { sessionId: session.id }).then((response) => {
          if (!response.ok) {
            toast.error(response.error.message);
            return;
          }
          const previous = shotRef.current;
          if (previous) {
            void window.framelet.invoke('shot:discard', { sessionId: previous.session.id });
          }
          setShot({ session: response.data.session, png: response.data.png });
          setDirty(true); // nothing is saved yet
          setView('capture');
        });
      }),
    [],
  );

  // Main asks before closing the window while the editor has unsaved work.
  useEffect(() => window.framelet.on('app:confirmClose', () => setPending({ kind: 'close' })), []);

  // Main needs to know whether closing would lose work.
  useEffect(() => {
    void window.framelet.invoke('editor:setDirty', { dirty: shot !== null && dirty });
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
    (next: ViewId) => {
      if (shotRef.current && next !== 'capture') requestLeave(() => setView(next));
      else setView(next);
    },
    [requestLeave],
  );

  const showEditor = view === 'capture' && shot !== null;
  const View = VIEWS[view];

  return (
    <TooltipProvider>
      <AppShell view={view} onNavigate={navigate} editor={showEditor}>
        {showEditor ? (
          <EditorView
            key={shot.session.id}
            shot={shot}
            blocked={pending !== null}
            onDirtyChange={setDirty}
            onRequestLeave={() => requestLeave()}
          />
        ) : (
          <View />
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
