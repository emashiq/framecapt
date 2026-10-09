import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import {
  AppWindow,
  FileVideo,
  Fullscreen,
  ImagePlus,
  Keyboard,
  Layers,
  Lightbulb,
  ListOrdered,
  Loader2,
  Monitor,
  ScanLine,
  TriangleAlert,
  X,
  type LucideIcon,
} from 'lucide-react';
import { friendlyError } from '../../shared/error-messages';
import type { HistoryItemView } from '../../shared/history-ipc';
import type { RecordTarget } from '../../shared/recorder-ipc';
import { patchFromRecordOptions, recordOptionsFromSettings } from '../../shared/settings';
import type { SettingsSectionId, StartRequestEvent } from '../../shared/settings-ipc';
import { MAX_MULTI_SOURCES } from '../../shared/recording-layout';
import { acceleratorKeys, type ShortcutAction } from '../../shared/shortcuts';
import type { CaptureTarget } from '../../shared/shots';
import { Loader } from '../components/Loader';
import { OnboardingCard } from '../components/OnboardingCard';
import { RecentCaptures } from '../components/RecentCaptures';
import { RecordOptions } from '../components/RecordOptions';
import { RecoveryBanner } from '../components/RecoveryBanner';
import { SourcePicker } from '../components/SourcePicker';
import { Button } from '../components/ui/Button';
import { Kbd } from '../components/ui/Kbd';
import { Tooltip } from '../components/ui/Tooltip';
import { useCaptureFlow } from '../capture/use-capture-flow';
import { SavingTo } from '../library/SavingTo';
import { cn } from '../lib/cn';
import { subscribeLaunch } from '../lib/launch-bus';
import { notify } from '../lib/notify';
import { useMultiDisplay } from '../lib/use-multi-display';
import { useRecorderState } from '../recorder/use-recorder';
import {
  problemCount,
  updateSettings,
  useEffectiveDirs,
  useSettings,
  useSettingsLoaded,
  useShortcutStates,
} from '../settings/store';

const STATUS_TEXT: Record<CaptureTarget, string> = {
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

/**
 * What a tile says under its label: the configured shortcut of an action ("Not set" when there is
 * none) or, when it could not be registered, a warning. Shown on hover and focus; always there for
 * a shortcut that does not work. Assistive technology gets the same words as the button's
 * description (the button's name stays its label).
 */
function ShortcutHint({ action, id }: { action: ShortcutAction; id: string }) {
  const { shortcuts } = useSettings();
  const loaded = useSettingsLoaded();
  const state = useShortcutStates()?.[action];
  const accelerator = shortcuts[action];
  if (!loaded) return <span className="h-4" aria-hidden="true" />;
  const unavailable = state?.status === 'conflict' || state?.status === 'invalid';
  const keys = accelerator === null ? 'Not set' : acceleratorKeys(accelerator).join('+');
  return (
    <>
      <span id={id} className="sr-only">
        {unavailable
          ? `${accelerator ?? 'The shortcut'} is unavailable: ${state?.message ?? 'in use by another app'}`
          : accelerator === null
            ? 'No shortcut set'
            : `Shortcut ${keys}`}
      </span>
      <span
        aria-hidden="true"
        className={cn(
          'inline-flex h-4 items-center gap-1 text-[11px] leading-4',
          unavailable
            ? 'text-warning'
            : 'invisible text-fg-subtle group-focus-visible/tile:visible group-hover/tile:visible',
        )}
        data-testid={`hint-${action}`}
        data-status={state?.status ?? 'unknown'}
        title={unavailable ? state?.message : undefined}
      >
        {unavailable ? <TriangleAlert className="size-3" /> : null}
        {keys}
      </span>
    </>
  );
}

interface TileProps {
  label: string;
  icon: LucideIcon;
  testId: string;
  onClick: (trigger: HTMLElement) => void;
  disabled?: boolean;
  /** The configured shortcut under the label... */
  action?: ShortcutAction;
  /** ...or a plain note. */
  note?: string;
  /** The main flow of the page: tinted. */
  primary?: boolean;
  /** Names the button's shortcut for assistive technology. */
  keyShortcuts?: string | null;
  /** A longer explanation on hover and focus. */
  tooltip?: string;
}

/** A square tile of the dashboard: an icon, a label and a hint that shows on hover and focus. */
function Tile({
  label,
  icon: Icon,
  testId,
  onClick,
  disabled = false,
  action,
  note,
  primary = false,
  keyShortcuts,
  tooltip,
}: TileProps) {
  const hintId = useId();
  const button = (
    <button
      type="button"
      data-testid={testId}
      disabled={disabled}
      aria-label={label}
      aria-keyshortcuts={keyShortcuts ?? undefined}
      aria-describedby={action ? hintId : undefined}
      onClick={(event) => onClick(event.currentTarget)}
      className={cn(
        'group/tile flex h-[88px] w-24 shrink-0 flex-col items-center justify-center gap-1 rounded-xl border px-1 shadow-card',
        'transition-[border-color,background-color,box-shadow] duration-150 disabled:opacity-50',
        primary
          ? 'border-accent-solid/35 bg-accent-soft text-accent-fg hover:border-accent-solid/60'
          : 'border-line bg-surface text-fg hover:border-line-strong hover:bg-surface-2',
        'not-disabled:hover:shadow-raised',
      )}
    >
      <Icon className={cn('size-6', !primary && 'text-accent-fg')} aria-hidden="true" />
      <span className="max-w-full truncate text-[13px] font-medium">{label}</span>
      {action ? (
        <ShortcutHint action={action} id={hintId} />
      ) : (
        <span className="invisible h-4 max-w-full truncate text-[11px] leading-4 text-fg-subtle group-focus-visible/tile:visible group-hover/tile:visible">
          {note}
        </span>
      )}
    </button>
  );
  return tooltip ? (
    <Tooltip content={tooltip} side="bottom">
      {button}
    </Tooltip>
  ) : (
    button
  );
}

function Group({
  title,
  testId,
  children,
}: {
  title: string;
  testId?: string;
  children: ReactNode;
}) {
  return (
    <section aria-label={title} data-testid={testId}>
      <h2 className="mb-2 text-[11px] font-semibold tracking-wider text-fg-subtle uppercase">
        {title}
      </h2>
      <div className="flex flex-wrap gap-2">{children}</div>
    </section>
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
          ? 'mb-4 flex items-center gap-3 rounded-lg border border-line bg-accent-soft px-3.5 py-2 text-[13px] text-fg'
          : 'mb-4 flex items-center gap-3 rounded-lg bg-warning-soft px-3.5 py-2 text-[13px] text-warning'
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

export interface HomeViewProps {
  /** Opens a picture file in the editor (File > Open image). */
  onOpenImage: () => void;
  /** Opens a video file in the video editor (File > Open video). */
  onOpenVideo: () => void;
  /** Opens a capture: a tab for what the editors take, the Library's details for the rest. */
  onOpenItem: (item: HistoryItemView) => void;
  /** The Library section of the pinned tab. */
  onOpenLibrary: () => void;
  onOpenSettings: (section?: SettingsSectionId) => void;
}

/**
 * The Home section of the pinned tab: the capture dashboard. Screenshot and Record tiles, Steps,
 * Open image and Open video, the recording options and the latest captures.
 */
export function HomeView({
  onOpenImage,
  onOpenVideo,
  onOpenItem,
  onOpenLibrary,
  onOpenSettings,
}: HomeViewProps) {
  const flow = useCaptureFlow();
  const recorder = useRecorderState();
  const settings = useSettings();
  const dirs = useEffectiveDirs();
  const shortcutStates = useShortcutStates();
  const multiDisplay = useMultiDisplay();
  const [picker, setPicker] = useState<'shot' | 'record' | 'multi' | null>(null);
  const [windowTrigger, setWindowTrigger] = useState<HTMLElement | null>(null);

  const options = recordOptionsFromSettings(settings.recording);
  const recordingBusy = !['idle', 'completed', 'error'].includes(recorder.status);
  const anythingBusy = flow.running !== null || recordingBusy;
  // A screenshot may start while a recording is live (recording or paused), not while one starts or finishes.
  const recordingLive = recorder.status === 'recording' || recorder.status === 'paused';
  const screenshotBusy = flow.running !== null || (recordingBusy && !recordingLive);
  const problems = problemCount(shortcutStates);
  const regionShortcut = settings.shortcuts.screenshotRegion;
  const openImageShortcut = settings.editorShortcuts.openImage;
  const showTip =
    problems === 0 &&
    !settings.notices.homeTipDismissed &&
    regionShortcut !== null &&
    shortcutStates?.screenshotRegion.status === 'ok';

  function startScreenshot(
    target: CaptureTarget,
    trigger: HTMLElement | null,
    allScreens = false,
  ): void {
    if (target === 'window') {
      setWindowTrigger(trigger);
      setPicker('shot');
      return;
    }
    void flow.start(target, trigger, undefined, allScreens);
  }

  async function startRecording(
    target: RecordTarget,
    trigger: HTMLElement | null,
    sourceId?: string,
  ): Promise<void> {
    const result = await window.framecapt.invoke('recorder:start', {
      target,
      ...(sourceId !== undefined && { sourceId }),
      options,
    });
    if (!result.ok) {
      notify.error(result.error);
      trigger?.focus();
    }
  }

  async function startSteps(): Promise<void> {
    const result = await window.framecapt.invoke('steps:start');
    if (!result.ok) notify.error(result.error);
  }

  /** Records 2 to 4 screens and/or windows together into one `.fcap` (the first is the primary). */
  async function startMulti(sourceIds: string[], trigger: HTMLElement | null): Promise<void> {
    const result = await window.framecapt.invoke('recorder:start', {
      target: 'multi',
      sources: sourceIds.map((sourceId) => ({ sourceId })),
      options,
    });
    if (!result.ok) {
      notify.error(result.error);
      trigger?.focus();
    }
  }

  /** Every screen (the primary first, then left to right), up to the limit. */
  async function recordAllScreens(trigger: HTMLElement | null): Promise<void> {
    const [displays, screens] = await Promise.all([
      window.framecapt.invoke('capture:listDisplays'),
      window.framecapt.invoke('capture:listSources', { types: ['screen'], thumbnailWidth: 0 }),
    ]);
    if (!displays.ok) return void notify.error(displays.error);
    if (!screens.ok) return void notify.error(screens.error);
    const order = [...displays.data].sort(
      (a, b) => Number(b.isPrimary) - Number(a.isPrimary) || a.bounds.x - b.bounds.x,
    );
    const ids = order.flatMap((display) =>
      screens.data.filter((source) => source.displayId === display.id).map((source) => source.id),
    );
    if (ids.length < 2) {
      notify.error({ code: 'SOURCE_MISSING', message: 'Only one screen was found.' });
      return;
    }
    await startMulti(ids.slice(0, MAX_MULTI_SOURCES), trigger);
  }

  function onRecordClick(
    target: RecordTarget,
    trigger: HTMLElement | null,
    allScreens = false,
  ): void {
    if (target === 'multi') {
      if (allScreens) void recordAllScreens(trigger);
      else {
        setWindowTrigger(trigger);
        setPicker('multi');
      }
      return;
    }
    if (target === 'window') {
      setWindowTrigger(trigger);
      setPicker('record');
      return;
    }
    void startRecording(target, trigger);
  }

  // A tray or shortcut action that needed the main window (a picker).
  const launchHandler = useRef<(request: StartRequestEvent) => void>(() => undefined);
  useEffect(() => {
    launchHandler.current = (request) => {
      if (request.kind === 'screenshot') {
        if (request.target !== 'multi') startScreenshot(request.target, null, request.allScreens);
      } else onRecordClick(request.target, null, request.allScreens);
    };
  });
  useEffect(() => subscribeLaunch((request) => launchHandler.current(request)), []);

  const statusText = flow.running
    ? flow.allScreens
      ? 'Capturing all screens…'
      : STATUS_TEXT[flow.running]
    : recordingBusy
      ? `${RECORD_STATUS_TEXT[recorder.status] ?? ''}${
          recorder.progress !== null ? ` ${Math.round(recorder.progress * 100)}%` : ''
        }`
      : '';

  /** Finishing a recording is a brand moment (the logo loader); the other steps keep the plain spinner. */
  const saving = flow.running === null && ['stopping', 'processing'].includes(recorder.status);

  return (
    <>
      <header className="mb-5 flex flex-wrap items-center justify-between gap-x-6 gap-y-2">
        <h1 className="text-xl font-semibold tracking-tight text-fg">Capture</h1>
        <SavingTo />
      </header>

      <RecoveryBanner busy={anythingBusy} />

      {recorder.status === 'error' && recorder.error ? (
        <div
          role="alert"
          data-testid="record-error"
          data-code={recorder.error.code}
          className="mb-4 flex items-center gap-3 rounded-lg bg-danger-soft px-3.5 py-2 text-[13px] text-danger"
        >
          <TriangleAlert className="size-4 shrink-0" aria-hidden="true" />
          <span className="flex-1">
            {friendlyError(recorder.error.code, recorder.error.message)}
          </span>
          <Button
            variant="secondary"
            size="sm"
            data-testid="record-error-dismiss"
            onClick={() => void window.framecapt.invoke('recorder:reset')}
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

      {settings.notices.onboardingDismissed ? null : (
        <OnboardingCard
          onDismiss={() =>
            // The first-run tip below says the same about the region key: one "Got it" clears both.
            void updateSettings({ notices: { onboardingDismissed: true, homeTipDismissed: true } })
          }
        />
      )}

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

      <div className="flex flex-wrap gap-x-10 gap-y-5">
        <Group title="Screenshot" testId="mode-screenshot">
          <Tile
            label="Region"
            icon={ScanLine}
            testId="shot-region"
            primary
            action="screenshotRegion"
            keyShortcuts={settings.shortcuts.screenshotRegion}
            disabled={screenshotBusy}
            onClick={(trigger) => startScreenshot('region', trigger)}
          />
          <Tile
            label="Screen"
            icon={Monitor}
            testId="shot-screen"
            action="screenshotScreen"
            keyShortcuts={settings.shortcuts.screenshotScreen}
            disabled={screenshotBusy}
            onClick={(trigger) => startScreenshot('screen', trigger)}
          />
          <Tile
            label="Window"
            icon={AppWindow}
            testId="shot-window"
            action="screenshotWindow"
            keyShortcuts={settings.shortcuts.screenshotWindow}
            disabled={screenshotBusy}
            onClick={(trigger) => startScreenshot('window', trigger)}
          />
          {multiDisplay ? (
            <Tile
              label="All screens"
              icon={Fullscreen}
              testId="shot-all-screens"
              action="screenshotAllScreens"
              keyShortcuts={settings.shortcuts.screenshotAllScreens}
              disabled={screenshotBusy}
              onClick={(trigger) => startScreenshot('screen', trigger, true)}
            />
          ) : null}
        </Group>

        <Group title="Record" testId="mode-record">
          <Tile
            label="Screen"
            icon={Monitor}
            testId="record-screen"
            action="recordScreen"
            keyShortcuts={settings.shortcuts.recordScreen}
            disabled={anythingBusy}
            onClick={(trigger) => onRecordClick('screen', trigger)}
          />
          <Tile
            label="Region"
            icon={ScanLine}
            testId="record-region"
            action="recordRegion"
            keyShortcuts={settings.shortcuts.recordRegion}
            disabled={anythingBusy}
            onClick={(trigger) => onRecordClick('region', trigger)}
          />
          <Tile
            label="Window"
            icon={AppWindow}
            testId="record-window"
            action="recordWindow"
            keyShortcuts={settings.shortcuts.recordWindow}
            disabled={anythingBusy}
            onClick={(trigger) => onRecordClick('window', trigger)}
          />
          {multiDisplay ? (
            <Tile
              label="All screens"
              icon={Fullscreen}
              testId="record-all-screens"
              note="One video"
              disabled={anythingBusy}
              onClick={(trigger) => void recordAllScreens(trigger)}
            />
          ) : null}
          <Tile
            label="Multiple…"
            icon={Layers}
            testId="record-multi"
            note="Screens and windows"
            disabled={anythingBusy}
            onClick={(trigger) => onRecordClick('multi', trigger)}
          />
        </Group>

        <Group title="More" testId="mode-steps">
          <Tile
            label="Steps"
            icon={ListOrdered}
            testId="steps-start"
            action="stepsToggle"
            keyShortcuts={settings.shortcuts.stepsToggle}
            tooltip="Capture a step-by-step guide: move the mouse to an item and pause, and FrameCapt screenshots it."
            disabled={anythingBusy}
            onClick={() => void startSteps()}
          />
          <span className="sr-only" data-testid="steps-hint">
            Steps: move the mouse to an item and pause, and FrameCapt takes a screenshot with the
            pointer highlighted. Press Done to save the guide.
          </span>
          <Tile
            label="Open image"
            icon={ImagePlus}
            testId="open-image"
            note={
              openImageShortcut ? acceleratorKeys(openImageShortcut).join('+') : 'Or drop one here'
            }
            keyShortcuts={openImageShortcut}
            onClick={onOpenImage}
          />
          <Tile
            label="Open video"
            icon={FileVideo}
            testId="open-video"
            note="MP4, WebM, MOV, MKV"
            onClick={onOpenVideo}
          />
        </Group>
      </div>

      <p
        role="status"
        data-testid="flow-status"
        className="mt-3 flex h-5 items-center gap-2 text-[13px] text-fg-muted"
      >
        {statusText ? (
          <>
            {saving ? (
              <Loader size="sm" decorative />
            ) : (
              <Loader2 className="size-4 animate-spin" aria-hidden="true" />
            )}
            {statusText}
          </>
        ) : null}
      </p>

      <div className="mt-2">
        <RecordOptions
          compact
          options={options}
          onChange={(next) => void updateSettings(patchFromRecordOptions(next))}
          disabled={anythingBusy}
          outputDir={dirs.recordingsDir}
          onOpenSettings={() => onOpenSettings('recording')}
          cameraStyle={{
            shape: settings.recording.cameraShape,
            size: settings.recording.cameraSize,
            corner: settings.recording.cameraCorner,
          }}
        />
      </div>

      <RecentCaptures onOpen={onOpenItem} onViewAll={onOpenLibrary} />

      <SourcePicker
        open={picker !== null}
        purpose={picker === 'record' || picker === 'multi' ? 'record' : 'capture'}
        mode={picker === 'multi' ? 'many' : 'one'}
        onClose={() => setPicker(null)}
        onPickMany={(sources) => {
          setPicker(null);
          void startMulti(
            sources.map((source) => source.id),
            windowTrigger,
          );
        }}
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
