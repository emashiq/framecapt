import { useState, type ReactNode } from 'react';
import { AppWindow, Camera, Images, Loader2, Monitor, ScanLine, Video } from 'lucide-react';
import { PageHeader } from '../components/PageHeader';
import { SourcePicker } from '../components/SourcePicker';
import { Button } from '../components/ui/Button';
import { Card } from '../components/ui/Card';
import { EmptyState } from '../components/ui/EmptyState';
import { Kbd } from '../components/ui/Kbd';
import { Tooltip } from '../components/ui/Tooltip';
import { useCaptureFlow } from '../capture/use-capture-flow';
import type { ShotKind } from '../../shared/shots';

const SOURCES = [
  { label: 'Screen', target: 'screen', icon: Monitor },
  { label: 'Window', target: 'window', icon: AppWindow },
  { label: 'Region', target: 'region', icon: ScanLine },
] as const;

const STATUS_TEXT: Record<ShotKind, string> = {
  screen: 'Choose a screen…',
  window: 'Capturing the window…',
  region: 'Select an area…',
};

interface ModeCardProps {
  title: string;
  description: string;
  icon: ReactNode;
  /** Shortcut hints for Screen, Window and Region (labels only). */
  shortcuts: readonly [string, string, string];
  /** Present for modes that work; absent modes show unavailable buttons. */
  onStart?: (target: ShotKind, trigger: HTMLElement) => void;
  /** While a flow runs, the cards are disabled. */
  busy?: boolean;
}

function ModeCard({ title, description, icon, shortcuts, onStart, busy = false }: ModeCardProps) {
  return (
    <Card padding="lg" className="flex flex-col" data-testid={`mode-${title.toLowerCase()}`}>
      <div className="mb-5 flex items-start gap-4">
        <div
          className="flex size-11 shrink-0 items-center justify-center rounded-xl bg-accent-soft text-accent-fg"
          aria-hidden="true"
        >
          {icon}
        </div>
        <div>
          <h2 className="text-lg font-semibold text-fg">{title}</h2>
          <p className="text-sm text-fg-muted">{description}</p>
        </div>
      </div>
      <ul className="flex flex-col gap-2.5">
        {SOURCES.map(({ label, target, icon: Icon }, index) => {
          const button = (
            <Button
              variant="secondary"
              className="flex-1 justify-start"
              icon={<Icon className="size-4 text-fg-subtle" aria-hidden="true" />}
              unavailable={!onStart}
              disabled={busy}
              onClick={(event) => onStart?.(target, event.currentTarget)}
              data-testid={onStart ? `shot-${target}` : `record-${target}`}
            >
              {label}
            </Button>
          );
          return (
            <li key={label} className="flex items-center gap-3">
              {onStart ? (
                button
              ) : (
                <Tooltip content="Recording arrives in the next build">{button}</Tooltip>
              )}
              <Kbd keys={['Ctrl', 'Shift', shortcuts[index] ?? '']} />
            </li>
          );
        })}
      </ul>
    </Card>
  );
}

export function CaptureView() {
  const flow = useCaptureFlow();
  const [pickerOpen, setPickerOpen] = useState(false);
  const [windowTrigger, setWindowTrigger] = useState<HTMLElement | null>(null);

  function startScreenshot(target: ShotKind, trigger: HTMLElement): void {
    if (target === 'window') {
      setWindowTrigger(trigger);
      setPickerOpen(true);
      return;
    }
    void flow.start(target, trigger);
  }

  return (
    <>
      <PageHeader
        title="What would you like to capture?"
        description="Pick a mode and a source. Everything stays on your device, no account needed."
      />
      <div className="grid gap-5 md:grid-cols-2">
        <ModeCard
          title="Screenshot"
          description="Grab a still image, then mark it up."
          icon={<Camera className="size-5" />}
          shortcuts={['1', '2', '3']}
          onStart={startScreenshot}
          busy={flow.running !== null}
        />
        <ModeCard
          title="Record"
          description="Capture video with optional audio."
          icon={<Video className="size-5" />}
          shortcuts={['5', '6', '7']}
        />
      </div>

      <p
        role="status"
        data-testid="flow-status"
        className="mt-4 flex h-5 items-center gap-2 text-sm text-fg-muted"
      >
        {flow.running ? (
          <>
            <Loader2 className="size-4 animate-spin" aria-hidden="true" />
            {STATUS_TEXT[flow.running]}
          </>
        ) : null}
      </p>

      <section aria-labelledby="recent-heading" className="mt-6">
        <h2 id="recent-heading" className="mb-3 text-sm font-semibold text-fg">
          Recent captures
        </h2>
        <EmptyState
          icon={<Images className="size-6" />}
          title="No captures yet"
          description="Your screenshots and recordings will show up here for quick access."
        />
      </section>

      <SourcePicker
        open={pickerOpen}
        onClose={() => setPickerOpen(false)}
        onPick={(source) => {
          setPickerOpen(false);
          void flow.start('window', windowTrigger, source.id);
        }}
      />
    </>
  );
}
