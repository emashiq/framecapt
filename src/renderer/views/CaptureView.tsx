import { useEffect, useRef, useState, type ReactNode } from 'react';
import {
  AppWindow,
  Camera,
  Keyboard,
  Lightbulb,
  Loader2,
  Monitor,
  ScanLine,
  TriangleAlert,
  Video,
  X,
} from 'lucide-react';
import { friendlyError } from '../../shared/error-messages';
import type { RecordTarget } from '../../shared/recorder-ipc';
import { patchFromRecordOptions, recordOptionsFromSettings } from '../../shared/settings';
import type { SettingsSectionId, StartRequestEvent } from '../../shared/settings-ipc';
import { acceleratorKeys, type ShortcutAction } from '../../shared/shortcuts';
import type { ShotKind } from '../../shared/shots';
import { PageHeader } from '../components/PageHeader';
import { RecentCaptures } from '../components/RecentCaptures';
import { RecordOptions } from '../components/RecordOptions';
import { RecoveryBanner } from '../components/RecoveryBanner';
import { SourcePicker } from '../components/SourcePicker';
import { Button } from '../components/ui/Button';
import { Card } from '../components/ui/Card';
import { Kbd } from '../components/ui/Kbd';
import { useCaptureFlow } from '../capture/use-capture-flow';
import { subscribeLaunch } from '../lib/launch-bus';
import { notify } from '../lib/notify';
import { useRecorderState } from '../recorder/use-recorder';
import {
  problemCount,
  updateSettings,
  useEffectiveDirs,
  useSettings,
  useSettingsLoaded,
  useShortcutStates,
} from '../settings/store';

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

/** The configured shortcut of an action, "Not set", or a warning when it could not be registered. */
function ShortcutHint({ action }: { action: ShortcutAction }) {
  const { shortcuts } = useSettings();
  const loaded = useSettingsLoaded();
  const state = useShortcutStates()?.[action];
  const accelerator = shortcuts[action];
  if (!loaded) return <span className="h-6 w-24" aria-hidden="true" />;
  if (accelerator === null) {
    return (
      <span className="text-xs text-fg-muted" data-testid={`hint-${action}`}>
        Not set
      </span>
    );
  }
  const unavailable = state?.status === 'conflict' || state?.status === 'invalid';
  return (
    <span
      className="inline-flex items-center gap-1.5"
      data-testid={`hint-${action}`}
      data-status={state?.status ?? 'unknown'}
      title={unavailable ? state?.message : undefined}
    >
      {unavailable ? (
        <TriangleAlert
          className="size-4 text-warning"
          role="img"
          aria-label={`${accelerator} is unavailable: ${state?.message ?? 'in use by another app'}`}
        />
      ) : null}
      <Kbd keys={acceleratorKeys(accelerator)} className={unavailable ? 'opacity-60' : undefined} />
    </span>
  );
}

interface ModeCardProps {
  title: string;
  description: string;
  icon: ReactNode;
  /** Shortcut actions for Screen, Window and Region (their configured keys are shown). */
  actions: readonly [ShortcutAction, ShortcutAction, ShortcutAction];
  /** Prefix of the buttons' test ids: `<prefix>-screen` and so on. */
  testPrefix: 'shot' | 'record';
  /** The one primary button of the page (the main flow). */
  primaryTarget?: (typeof SOURCES)[number]['target'];
  onStart: (target: ShotKind, trigger: HTMLElement) => void;
  /** While something runs, the card's buttons are disabled. */
  busy?: boolean;
}

function ModeCard({
  title,
  description,
  icon,
  actions,
  testPrefix,
  primaryTarget,
  onStart,
  busy = false,
}: ModeCardProps) {
  return (
    <Card padding="lg" className="flex h-full flex-col" data-testid={`mode-${title.toLowerCase()}`}>
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
      <ul className="mt-auto flex flex-col gap-2.5">
        {SOURCES.map(({ label, target, icon: Icon }, index) => (
          <li key={label} className="flex items-center gap-3">
            <Button
              variant={primaryTarget === target ? 'primary' : 'secondary'}
              className="flex-1 justify-start"
              icon={
                <Icon
                  className={primaryTarget === target ? 'size-4' : 'size-4 text-fg-subtle'}
                  aria-hidden="true"
                />
              }
              disabled={busy}
              onClick={(event) => onStart(target, event.currentTarget)}
              data-testid={`${testPrefix}-${target}`}
            >
              {label}
            </Button>
            <div className="flex min-w-32 justify-end">
              <ShortcutHint action={actions[index] ?? actions[0]} />
            </div>
          </li>
        ))}
      </ul>
    </Card>
  );
}

function Banner({
  tone,
  icon,
  children,
  action,
  testId,
}: {
  tone: 'tip' | 'warning';
  icon: ReactNode;
  children: ReactNode;
  action?: ReactNode;
  testId: string;
}) {
  return (
    <div
      data-testid={testId}
      className={
        tone === 'tip'
          ? 'mb-5 flex items-center gap-3 rounded-xl border border-line bg-accent-soft px-4 py-3 text-sm text-fg'
          : 'mb-5 flex items-center gap-3 rounded-xl bg-warning-soft px-4 py-3 text-sm text-warning'
      }
    >
      <span aria-hidden="true" className="shrink-0 text-accent-fg">
        {icon}
      </span>
      <span className="min-w-0 flex-1">{children}</span>
      {action}
    </div>
  );
}

export interface CaptureViewProps {
  /** Opens History, with one item selected when an id is given. */
  onOpenHistory: (id?: string) => void;
  onOpenSettings: (section?: SettingsSectionId) => void;
}

export function CaptureView({ onOpenHistory, onOpenSettings }: CaptureViewProps) {
  const flow = useCaptureFlow();
  const recorder = useRecorderState();
  const settings = useSettings();
  const dirs = useEffectiveDirs();
  const shortcutStates = useShortcutStates();
  const [picker, setPicker] = useState<'shot' | 'record' | null>(null);
  const [windowTrigger, setWindowTrigger] = useState<HTMLElement | null>(null);

  const options = recordOptionsFromSettings(settings.recording);
  const recordingBusy = !['idle', 'completed', 'error'].includes(recorder.status);
  const anythingBusy = flow.running !== null || recordingBusy;
  const problems = problemCount(shortcutStates);
  const regionShortcut = settings.shortcuts.screenshotRegion;
  const showTip =
    problems === 0 &&
    !settings.notices.homeTipDismissed &&
    regionShortcut !== null &&
    shortcutStates?.screenshotRegion.status === 'ok';

  function startScreenshot(target: ShotKind, trigger: HTMLElement | null): void {
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
      notify.error(result.error);
      trigger?.focus();
    }
  }

  function onRecordClick(target: RecordTarget, trigger: HTMLElement | null): void {
    if (target === 'window') {
      setWindowTrigger(trigger);
      setPicker('record');
      return;
    }
    void startRecording(target, trigger);
  }

  // A tray or shortcut action that needed the main window (a picker, or the editor to close first).
  const launchHandler = useRef<(request: StartRequestEvent) => void>(() => undefined);
  useEffect(() => {
    launchHandler.current = (request) => {
      if (request.kind === 'screenshot') startScreenshot(request.target, null);
      else onRecordClick(request.target, null);
    };
  });
  useEffect(() => subscribeLaunch((request) => launchHandler.current(request)), []);

  const statusText = flow.running
    ? STATUS_TEXT[flow.running]
    : recordingBusy
      ? `${RECORD_STATUS_TEXT[recorder.status] ?? ''}${
          recorder.progress !== null ? ` ${Math.round(recorder.progress * 100)}%` : ''
        }`
      : '';

  return (
    <>
      <PageHeader
        title="What would you like to capture?"
        description="Pick a mode and a source. Everything stays on your device, no account needed."
      />

      <RecoveryBanner busy={anythingBusy} />

      {recorder.status === 'error' && recorder.error ? (
        <div
          role="alert"
          data-testid="record-error"
          data-code={recorder.error.code}
          className="mb-5 flex items-center gap-3 rounded-xl bg-danger-soft px-4 py-3 text-sm text-danger"
        >
          <TriangleAlert className="size-4 shrink-0" aria-hidden="true" />
          <span className="flex-1">
            {friendlyError(recorder.error.code, recorder.error.message)}
          </span>
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

      {problems > 0 ? (
        <Banner
          tone="warning"
          testId="shortcut-problems"
          icon={<Keyboard className="size-4 text-warning" />}
          action={
            <Button
              size="sm"
              variant="secondary"
              data-testid="shortcut-problems-fix"
              onClick={() => onOpenSettings('shortcuts')}
            >
              Fix in Settings
            </Button>
          }
        >
          {problems === 1
            ? '1 shortcut is unavailable because another app uses it.'
            : `${problems} shortcuts are unavailable because other apps use them.`}
        </Banner>
      ) : null}

      {showTip && regionShortcut ? (
        <Banner
          tone="tip"
          testId="home-tip"
          icon={<Lightbulb className="size-4" />}
          action={
            <Button
              size="sm"
              variant="ghost"
              icon={<X className="size-3.5" aria-hidden="true" />}
              aria-label="Dismiss tip"
              data-testid="home-tip-dismiss"
              onClick={() => void updateSettings({ notices: { homeTipDismissed: true } })}
            >
              Got it
            </Button>
          }
        >
          Tip: press <Kbd keys={acceleratorKeys(regionShortcut)} className="mx-1 align-middle" /> to
          grab a region from anywhere.
        </Banner>
      ) : null}

      <div className="grid items-stretch gap-5 md:grid-cols-2">
        <ModeCard
          title="Screenshot"
          description="Grab a still image, then mark it up."
          icon={<Camera className="size-5" />}
          actions={['screenshotScreen', 'screenshotWindow', 'screenshotRegion']}
          testPrefix="shot"
          primaryTarget="region"
          onStart={startScreenshot}
          busy={anythingBusy}
        />
        <ModeCard
          title="Record"
          description="Capture video with optional audio."
          icon={<Video className="size-5" />}
          actions={['recordScreen', 'recordWindow', 'recordRegion']}
          testPrefix="record"
          onStart={onRecordClick}
          busy={anythingBusy}
        />
      </div>

      <div className="mt-5">
        <RecordOptions
          options={options}
          onChange={(next) => void updateSettings(patchFromRecordOptions(next))}
          disabled={anythingBusy}
          outputDir={dirs.recordingsDir}
          onOpenSettings={() => onOpenSettings('recording')}
        />
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

      <RecentCaptures onOpen={(id) => onOpenHistory(id)} onViewAll={() => onOpenHistory()} />

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
