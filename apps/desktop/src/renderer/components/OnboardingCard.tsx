import type { ReactNode } from 'react';
import { Keyboard, MonitorUp, ShieldCheck } from 'lucide-react';
import { acceleratorKeys } from '../../shared/shortcuts';
import { useSettings } from '../settings/store';
import { Button } from './ui/Button';
import { Card } from './ui/Card';
import { Kbd } from './ui/Kbd';

function Point({ icon, children }: { icon: ReactNode; children: ReactNode }) {
  return (
    <li className="flex items-start gap-3">
      <span
        aria-hidden="true"
        className="mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-lg bg-accent-soft text-accent-fg"
      >
        {icon}
      </span>
      <span className="min-w-0 flex-1 text-sm text-fg-muted">{children}</span>
    </li>
  );
}

export interface OnboardingCardProps {
  onDismiss: () => void;
}

/**
 * The first-run card on the Capture view: what stays on your device, the global shortcuts as they are
 * set right now, and what closing the window does. Dismissing it is remembered (settings, notices).
 */
export function OnboardingCard({ onDismiss }: OnboardingCardProps) {
  const { shortcuts, general } = useSettings();
  const region = shortcuts.screenshotRegion;
  const screen = shortcuts.screenshotScreen;
  return (
    <Card
      padding="lg"
      className="mb-5"
      data-testid="onboarding-card"
      role="region"
      aria-labelledby="onboarding-heading"
    >
      <h2 id="onboarding-heading" className="text-lg font-semibold text-fg">
        Welcome to FrameCapt
      </h2>
      <p className="mt-0.5 text-sm text-fg-muted">Three things worth knowing before you start.</p>
      <ul className="mt-4 flex flex-col gap-3.5">
        <Point icon={<ShieldCheck className="size-4" />}>
          <span className="font-medium text-fg">Everything stays on your device.</span> There is no
          account and nothing is uploaded: screenshots and recordings are saved in the folders you
          choose.
        </Point>
        <Point icon={<Keyboard className="size-4" />}>
          <span className="font-medium text-fg">Shortcuts work from any app.</span>{' '}
          {region || screen ? (
            <>
              {region ? (
                <>
                  Press <Kbd keys={acceleratorKeys(region)} className="mx-0.5 align-middle" /> to
                  grab a region
                </>
              ) : null}
              {region && screen ? ' or ' : null}
              {screen ? (
                <>
                  <Kbd keys={acceleratorKeys(screen)} className="mx-0.5 align-middle" /> for the
                  whole screen
                </>
              ) : null}
              . You can change every one of them in Settings, Shortcuts.
            </>
          ) : (
            'The screenshot shortcuts are turned off: set them in Settings, Shortcuts.'
          )}
        </Point>
        <Point icon={<MonitorUp className="size-4" />}>
          <span className="font-medium text-fg">
            {general.closeToTray ? 'It keeps running in the tray.' : 'Closing the window quits.'}
          </span>{' '}
          {general.closeToTray
            ? 'Closing the window hides it, so the shortcuts keep working. To quit, use the tray icon’s menu.'
            : 'Close to tray is off in Settings, so shortcuts only work while the window is open.'}
        </Point>
      </ul>
      <div className="mt-5 flex flex-wrap gap-2">
        <Button variant="primary" data-testid="onboarding-dismiss" onClick={onDismiss}>
          Got it
        </Button>
      </div>
    </Card>
  );
}
