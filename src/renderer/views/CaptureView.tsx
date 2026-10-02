import type { ReactNode } from 'react';
import { AppWindow, Camera, Images, Monitor, ScanLine, Video } from 'lucide-react';
import { PageHeader } from '../components/PageHeader';
import { Button } from '../components/ui/Button';
import { Card } from '../components/ui/Card';
import { EmptyState } from '../components/ui/EmptyState';
import { Kbd } from '../components/ui/Kbd';
import { Tooltip } from '../components/ui/Tooltip';

const SOURCES = [
  { label: 'Screen', icon: Monitor },
  { label: 'Window', icon: AppWindow },
  { label: 'Region', icon: ScanLine },
] as const;

interface ModeCardProps {
  title: string;
  description: string;
  icon: ReactNode;
  /** Shortcut hints for Screen, Window and Region (labels only). */
  shortcuts: readonly [string, string, string];
}

function ModeCard({ title, description, icon, shortcuts }: ModeCardProps) {
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
        {SOURCES.map(({ label, icon: Icon }, index) => (
          <li key={label} className="flex items-center gap-3">
            <Tooltip content="Available in the next build">
              <Button
                unavailable
                variant="secondary"
                className="flex-1 justify-start"
                icon={<Icon className="size-4 text-fg-subtle" aria-hidden="true" />}
              >
                {label}
              </Button>
            </Tooltip>
            <Kbd keys={['Ctrl', 'Shift', shortcuts[index] ?? '']} />
          </li>
        ))}
      </ul>
    </Card>
  );
}

export function CaptureView() {
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
        />
        <ModeCard
          title="Record"
          description="Capture video with optional audio."
          icon={<Video className="size-5" />}
          shortcuts={['5', '6', '7']}
        />
      </div>

      <section aria-labelledby="recent-heading" className="mt-10">
        <h2 id="recent-heading" className="mb-3 text-sm font-semibold text-fg">
          Recent captures
        </h2>
        <EmptyState
          icon={<Images className="size-6" />}
          title="No captures yet"
          description="Your screenshots and recordings will show up here for quick access."
        />
      </section>
    </>
  );
}
