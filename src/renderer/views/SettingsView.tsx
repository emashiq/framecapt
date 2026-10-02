import { Copy, Info, RotateCw } from 'lucide-react';
import { toast } from 'sonner';
import { PageHeader } from '../components/PageHeader';
import { Button } from '../components/ui/Button';
import { Card } from '../components/ui/Card';
import { IconButton } from '../components/ui/IconButton';
import type { AppInfo } from '../../shared/ipc-contract';
import { useAppInfo } from '../lib/use-app-info';
import { CaptureDiagnostics } from './diagnostics/CaptureDiagnostics';

function infoRows(info: AppInfo): { id: string; label: string; value: string }[] {
  return [
    { id: 'version', label: 'Framelet', value: info.version },
    { id: 'electron', label: 'Electron', value: info.electron },
    { id: 'chrome', label: 'Chromium', value: info.chrome },
    { id: 'node', label: 'Node.js', value: info.node },
    { id: 'platform', label: 'Platform', value: `${info.platform} (${info.arch})` },
    { id: 'build', label: 'Build', value: info.isPackaged ? 'Packaged' : 'Development' },
  ];
}

function About() {
  const { state, reload } = useAppInfo();

  async function copyDetails(info: AppInfo) {
    const text = infoRows(info)
      .map((row) => `${row.label}: ${row.value}`)
      .join('\n');
    try {
      await navigator.clipboard.writeText(text);
      toast.success('Copied app details');
    } catch {
      toast.error('Could not copy to the clipboard');
    }
  }

  return (
    <section aria-labelledby="about-heading" data-testid="about-section">
      <Card padding="lg">
        <div className="mb-4 flex items-center gap-3">
          <div
            className="flex size-9 items-center justify-center rounded-lg bg-accent-soft text-accent-fg"
            aria-hidden="true"
          >
            <Info className="size-[18px]" />
          </div>
          <h2 id="about-heading" className="flex-1 text-lg font-semibold text-fg">
            About
          </h2>
          {state.status === 'ready' ? (
            <IconButton
              aria-label="Copy app details"
              icon={<Copy className="size-4" aria-hidden="true" />}
              onClick={() => void copyDetails(state.info)}
            />
          ) : null}
        </div>

        {state.status === 'loading' ? (
          <div className="space-y-2" aria-busy="true" aria-label="Loading app details">
            {[0, 1, 2, 3].map((n) => (
              <div key={n} className="h-5 w-full animate-pulse rounded-md bg-surface-3" />
            ))}
          </div>
        ) : null}

        {state.status === 'error' ? (
          <div role="alert" className="flex items-center justify-between gap-4 text-sm">
            <p className="text-danger">{state.message}</p>
            <Button
              size="sm"
              icon={<RotateCw className="size-3.5" aria-hidden="true" />}
              onClick={reload}
            >
              Try again
            </Button>
          </div>
        ) : null}

        {state.status === 'ready' ? (
          <dl className="selectable divide-y divide-line text-sm">
            {infoRows(state.info).map((row) => (
              <div key={row.id} className="flex items-center justify-between py-2.5">
                <dt className="text-fg-muted">{row.label}</dt>
                <dd className="font-medium text-fg tabular-nums" data-testid={`about-${row.id}`}>
                  {row.value}
                </dd>
              </div>
            ))}
          </dl>
        ) : null}

        <p className="mt-5 text-xs text-fg-subtle">
          Framelet works fully offline and sends no telemetry. Licensed under GPL-3.0-only.
        </p>
      </Card>
    </section>
  );
}

export function SettingsView() {
  return (
    <>
      <PageHeader
        title="Settings"
        description="Shortcuts, appearance and save locations will live here. For now, here is what you are running."
      />
      <div className="space-y-6">
        <About />
        <CaptureDiagnostics />
      </div>
    </>
  );
}
