import { useState, type ReactNode } from 'react';
import { toast } from 'sonner';
import {
  AppWindow,
  Camera,
  Images,
  Loader2,
  Monitor,
  ScanLine,
  TriangleAlert,
  Video,
} from 'lucide-react';
import { PageHeader } from '../components/PageHeader';
import { RecordOptions } from '../components/RecordOptions';
import { SourcePicker } from '../components/SourcePicker';
import { Button } from '../components/ui/Button';
import { Card } from '../components/ui/Card';
import { EmptyState } from '../components/ui/EmptyState';
import { Kbd } from '../components/ui/Kbd';
import { useCaptureFlow } from '../capture/use-capture-flow';
import { useRecordOptions } from '../recorder/options-store';
import { useRecorderState } from '../recorder/use-recorder';
import type { RecordTarget } from '../../shared/recorder-ipc';
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

const RECORD_STATUS_TEXT: Record<string, string> = {
  selecting: 'Choose what to record…',
  preflight: 'Checking your sources…',
  countdown: 'Get ready…',
  starting: 'Starting the recording…',
  recording: 'Recording…',
  paused: 'Recording paused',
  stopping: 'Saving the recording…',
  processing: 'Saving the recording…',
};

interface ModeCardProps {
  title: string;
  description: string;
  icon: ReactNode;
  /** Shortcut hints for Screen, Window and Region (labels only). */
  shortcuts: readonly [string, string, string];
  /** Prefix of the buttons' test ids: `<prefix>-screen` and so on. */
  testPrefix: 'shot' | 'record';
  onStart: (target: ShotKind, trigger: HTMLElement) => void;
  /** While something runs, the card's buttons are disabled. */
  busy?: boolean;
}

function ModeCard({
  title,
  description,
  icon,
  shortcuts,
  testPrefix,
  onStart,
  busy = false,
}: ModeCardProps) {
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
        {SOURCES.map(({ label, target, icon: Icon }, index) => (
          <li key={label} className="flex items-center gap-3">
            <Button
              variant="secondary"
              className="flex-1 justify-start"
              icon={<Icon className="size-4 text-fg-subtle" aria-hidden="true" />}
              disabled={busy}
              onClick={(event) => onStart(target, event.currentTarget)}
              data-testid={`${testPrefix}-${target}`}
            >
              {label}
            </Button>
            <Kbd keys={['Ctrl', 'Shift', shortcuts[index] ?? '']} />
          </li>
        ))}
      </ul>
    </Card>
  );
}

export function CaptureView() {
  const flow = useCaptureFlow();
  const recorder = useRecorderState();
  const [options, setOptions] = useRecordOptions();
  const [picker, setPicker] = useState<'shot' | 'record' | null>(null);
  const [windowTrigger, setWindowTrigger] = useState<HTMLElement | null>(null);

  const recordingBusy = !['idle', 'completed', 'error'].includes(recorder.status);
  const anythingBusy = flow.running !== null || recordingBusy;

  function startScreenshot(target: ShotKind, trigger: HTMLElement): void {
    if (target === 'window') {
      setWindowTrigger(trigger);
      setPicker('shot');
      return;
    }
    void flow.start(target, trigger);
  }

  async function startRecording(
    target: RecordTarget,
    trigger: HTMLElement | null,
    sourceId?: string,
  ): Promise<void> {
    const result = await window.framelet.invoke('recorder:start', {
      target,
      ...(sourceId !== undefined && { sourceId }),
      options,
    });
    if (!result.ok) {
      toast.error(
        result.error.code === 'BUSY' ? 'A capture is already in progress.' : result.error.message,
      );
      trigger?.focus();
    }
  }

  function onRecordClick(target: RecordTarget, trigger: HTMLElement): void {
    if (target === 'window') {
      setWindowTrigger(trigger);
      setPicker('record');
      return;
    }
    void startRecording(target, trigger);
  }

  const statusText = flow.running
    ? STATUS_TEXT[flow.running]
    : recordingBusy
      ? (RECORD_STATUS_TEXT[recorder.status] ?? '')
      : '';

  return (
    <>
      <PageHeader
        title="What would you like to capture?"
        description="Pick a mode and a source. Everything stays on your device, no account needed."
      />

      {recorder.status === 'error' && recorder.error ? (
        <div
          role="alert"
          data-testid="record-error"
          data-code={recorder.error.code}
          className="mb-5 flex items-center gap-3 rounded-xl bg-danger-soft px-4 py-3 text-sm text-danger"
        >
          <TriangleAlert className="size-4 shrink-0" aria-hidden="true" />
          <span className="flex-1">{recorder.error.message}</span>
          <Button
            variant="secondary"
            size="sm"
            data-testid="record-error-dismiss"
            onClick={() => void window.framelet.invoke('recorder:reset')}
          >
            Dismiss
          </Button>
        </div>
      ) : null}

      <div className="grid items-start gap-5 md:grid-cols-2">
        <ModeCard
          title="Screenshot"
          description="Grab a still image, then mark it up."
          icon={<Camera className="size-5" />}
          shortcuts={['1', '2', '3']}
          testPrefix="shot"
          onStart={startScreenshot}
          busy={anythingBusy}
        />
        <div className="flex flex-col gap-3">
          <ModeCard
            title="Record"
            description="Capture video with optional audio."
            icon={<Video className="size-5" />}
            shortcuts={['5', '6', '7']}
            testPrefix="record"
            onStart={onRecordClick}
            busy={anythingBusy}
          />
          <RecordOptions options={options} onChange={setOptions} disabled={anythingBusy} />
        </div>
      </div>

      <p
        role="status"
        data-testid="flow-status"
        className="mt-4 flex h-5 items-center gap-2 text-sm text-fg-muted"
      >
        {statusText ? (
          <>
            <Loader2 className="size-4 animate-spin" aria-hidden="true" />
            {statusText}
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
        open={picker !== null}
        purpose={picker === 'record' ? 'record' : 'capture'}
        onClose={() => setPicker(null)}
        onPick={(source) => {
          const purpose = picker;
          setPicker(null);
          if (purpose === 'record') void startRecording('window', windowTrigger, source.id);
          else void flow.start('window', windowTrigger, source.id);
        }}
      />
    </>
  );
}
