import { useState, type JSX } from 'react';
import { Toaster } from 'sonner';
import { AppShell, type ViewId } from './components/AppShell';
import { TooltipProvider } from './components/ui/Tooltip';
import { CaptureView } from './views/CaptureView';
import { HistoryView } from './views/HistoryView';
import { SettingsView } from './views/SettingsView';

const VIEWS: Record<ViewId, () => JSX.Element> = {
  capture: CaptureView,
  history: HistoryView,
  settings: SettingsView,
};

/** Main window UI. Navigation is plain state: three views do not need a router. */
export function App() {
  const [view, setView] = useState<ViewId>('capture');
  const View = VIEWS[view];

  return (
    <TooltipProvider>
      <AppShell view={view} onNavigate={setView}>
        <View />
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
