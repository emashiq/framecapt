import { useCallback, useEffect, useState, type JSX } from 'react';
import { Toaster, toast } from 'sonner';
import { AppShell, type ViewId } from './components/AppShell';
import { TooltipProvider } from './components/ui/Tooltip';
import { CaptureView } from './views/CaptureView';
import { HistoryView } from './views/HistoryView';
import { ResultView, type ShotResult } from './views/ResultView';
import { SettingsView } from './views/SettingsView';

const VIEWS: Record<ViewId, () => JSX.Element> = {
  capture: CaptureView,
  history: HistoryView,
  settings: SettingsView,
};

/**
 * Main window UI. Navigation is plain state: three views do not need a router. A finished
 * screenshot is shown in the Capture tab (as the result view) until it is discarded or replaced
 * by "New capture"; switching tabs keeps it, and with it the "already saved" state.
 */
export function App() {
  const [view, setView] = useState<ViewId>('capture');
  const [result, setResult] = useState<ShotResult | null>(null);

  useEffect(
    () =>
      window.framelet.on('shot:ready', ({ session }) => {
        void window.framelet.invoke('shot:get', { sessionId: session.id }).then((response) => {
          if (!response.ok) {
            toast.error(response.error.message);
            return;
          }
          setResult({ session: response.data.session, png: response.data.png, safe: false });
          setView('capture');
        });
      }),
    [],
  );

  const markSafe = useCallback(
    () => setResult((current) => current && { ...current, safe: true }),
    [],
  );
  const closeResult = useCallback(() => setResult(null), []);

  const showResult = view === 'capture' && result !== null;
  const View = VIEWS[view];

  return (
    <TooltipProvider>
      <AppShell view={view} onNavigate={setView} wide={showResult}>
        {showResult ? (
          <ResultView shot={result} onSafe={markSafe} onDone={closeResult} />
        ) : (
          <View />
        )}
      </AppShell>
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
