import { useEffect, useRef, useState } from 'react';
import { Copy, FolderOpen, Info, RotateCw } from 'lucide-react';
import type { AppInfo } from '../../../shared/ipc-contract';
import {
  recordOptionsFromSettings,
  type OutputTarget,
  type Settings,
} from '../../../shared/settings';
import { SHORTCUT_ACTIONS, SHORTCUT_LABELS, type ShortcutAction } from '../../../shared/shortcuts';
import { Logo } from '../../components/Logo';
import { MicrophoneSelect } from '../../components/MicrophoneSelect';
import { ShortcutField } from '../../components/ShortcutField';
import { Button } from '../../components/ui/Button';
import { Card } from '../../components/ui/Card';
import { Segmented } from '../../components/ui/Segmented';
import { Select } from '../../components/ui/Select';
import { Switch } from '../../components/ui/Switch';
import { useExportCapabilities } from '../../history/use-export-capabilities';
import { notify } from '../../lib/notify';
import { useAppInfo } from '../../lib/use-app-info';
import { usePlatformCapabilities } from '../../lib/use-platform-capabilities';
import {
  chooseOutputDir,
  updateSettings,
  resetOutputDir,
  useEffectiveDirs,
  useSettings,
  useShortcutStates,
} from '../../settings/store';
import { CaptureDiagnostics } from '../diagnostics/CaptureDiagnostics';
import { SectionCard, SettingRow } from './SettingRow';

export interface SectionProps {
  onReset: () => void;
}

// --- General -----------------------------------------------------------------------------------

const THEMES = [
  { value: 'system', label: 'System' },
  { value: 'light', label: 'Light' },
  { value: 'dark', label: 'Dark' },
] as const;

export function GeneralSection({ onReset }: SectionProps) {
  const { general } = useSettings();
  const { state } = useAppInfo();
  const trayMissing = state.status === 'ready' && !state.info.tray.active;
  return (
    <SectionCard
      id="general"
      title="General"
      description="How FrameCapt looks and behaves on your desktop."
      onReset={onReset}
    >
      <SettingRow label="Theme" description="Follow Windows, or always use light or dark.">
        {() => (
          <Segmented
            label="Theme"
            data-testid="setting-theme"
            value={general.theme}
            options={THEMES}
            onChange={(theme) => void updateSettings({ general: { theme } })}
          />
        )}
      </SettingRow>
      <SettingRow
        label="Launch at login"
        description="Start FrameCapt in the tray when you sign in to Windows."
      >
        {({ labelledBy, describedBy }) => (
          <Switch
            aria-labelledby={labelledBy}
            aria-describedby={describedBy}
            data-testid="setting-launch-at-login"
            checked={general.launchAtLogin}
            onCheckedChange={(launchAtLogin) => void updateSettings({ general: { launchAtLogin } })}
          />
        )}
      </SettingRow>
      <SettingRow
        label="Close to tray"
        description={
          trayMissing
            ? 'Closing the window quits, because Windows could not show the tray icon.'
            : 'Closing the window keeps FrameCapt running in the tray, so shortcuts keep working.'
        }
      >
        {({ labelledBy, describedBy }) => (
          <Switch
            aria-labelledby={labelledBy}
            aria-describedby={describedBy}
            data-testid="setting-close-to-tray"
            checked={general.closeToTray}
            onCheckedChange={(closeToTray) => void updateSettings({ general: { closeToTray } })}
          />
        )}
      </SettingRow>
      <SettingRow
        label="Notifications"
        description="Tell me when FrameCapt keeps running in the tray or a shortcut is unavailable."
      >
        {({ labelledBy, describedBy }) => (
          <Switch
            aria-labelledby={labelledBy}
            aria-describedby={describedBy}
            data-testid="setting-notifications"
            checked={general.showNotifications}
            onCheckedChange={(showNotifications) =>
              void updateSettings({ general: { showNotifications } })
            }
          />
        )}
      </SettingRow>
    </SectionCard>
  );
}

// --- Screenshots ---------------------------------------------------------------------------------

const FORMATS = [
  { value: 'png', label: 'PNG' },
  { value: 'jpeg', label: 'JPEG' },
] as const;

const AFTER_CAPTURE = [
  { value: 'editor', label: 'Open in the editor' },
  { value: 'copy-and-editor', label: 'Copy to the clipboard, then open the editor' },
  { value: 'save-and-editor', label: 'Save to the folder, then open the editor' },
] as const;

/** A range input that applies as you drag, but sends a change only after you stop. */
function QualitySlider({
  value,
  disabled,
  labelledBy,
  describedBy,
  onCommit,
}: {
  value: number;
  disabled: boolean;
  labelledBy: string;
  describedBy: string;
  onCommit: (value: number) => void;
}) {
  // While the slider is being moved `draft` shows it; the change is sent once it rests.
  const [dragged, setDragged] = useState<number | null>(null);
  const draft = dragged ?? Math.round(value * 100);
  const timer = useRef<number | undefined>(undefined);
  useEffect(() => () => window.clearTimeout(timer.current), []);
  return (
    <div className="flex items-center gap-3">
      <input
        type="range"
        min={50}
        max={100}
        step={1}
        value={draft}
        disabled={disabled}
        aria-labelledby={labelledBy}
        aria-describedby={describedBy}
        aria-valuetext={`${draft} percent`}
        data-testid="setting-jpeg-quality"
        onChange={(event) => {
          const next = Number(event.target.value);
          setDragged(next);
          window.clearTimeout(timer.current);
          timer.current = window.setTimeout(() => {
            onCommit(next / 100);
            setDragged(null);
          }, 250);
        }}
        className="h-8 w-40 cursor-pointer accent-accent-solid disabled:cursor-default disabled:opacity-50"
      />
      <span className="w-10 text-right text-[13px] text-fg-muted tabular-nums">{draft}%</span>
    </div>
  );
}

export function ScreenshotsSection({ onReset }: SectionProps) {
  const { screenshots } = useSettings();
  return (
    <SectionCard
      id="screenshots"
      title="Screenshots"
      description="What happens after a capture and how it is saved."
      onReset={onReset}
    >
      <SettingRow label="Format" description="PNG is lossless. JPEG makes smaller files.">
        {() => (
          <Segmented
            label="Screenshot format"
            data-testid="setting-format"
            value={screenshots.format}
            options={FORMATS}
            onChange={(format) => void updateSettings({ screenshots: { format } })}
          />
        )}
      </SettingRow>
      <SettingRow
        label="JPEG quality"
        description="Higher is sharper and larger. Redactions stay solid black at any quality."
      >
        {({ labelledBy, describedBy }) => (
          <QualitySlider
            value={screenshots.jpegQuality}
            disabled={screenshots.format !== 'jpeg'}
            labelledBy={labelledBy}
            describedBy={describedBy}
            onCommit={(jpegQuality) => void updateSettings({ screenshots: { jpegQuality } })}
          />
        )}
      </SettingRow>
      <SettingRow
        label="After a capture"
        description="Every screenshot opens in the editor; this adds a copy or a save first."
      >
        {({ labelledBy }) => (
          <Select
            className="w-80 max-w-full"
            value={screenshots.afterCapture}
            options={AFTER_CAPTURE}
            labelledBy={labelledBy}
            data-testid="setting-after-capture"
            onChange={(afterCapture) => void updateSettings({ screenshots: { afterCapture } })}
          />
        )}
      </SettingRow>
      <SettingRow
        label="Copy to the clipboard when saving"
        description="Saving from the editor also puts the image on the clipboard."
      >
        {({ labelledBy, describedBy }) => (
          <Switch
            aria-labelledby={labelledBy}
            aria-describedby={describedBy}
            data-testid="setting-copy-on-save"
            checked={screenshots.copyToClipboardOnSave}
            onCheckedChange={(copyToClipboardOnSave) =>
              void updateSettings({ screenshots: { copyToClipboardOnSave } })
            }
          />
        )}
      </SettingRow>
    </SectionCard>
  );
}

// --- Recording -----------------------------------------------------------------------------------

const QUALITY = [
  { value: '1080p', label: '1080p' },
  { value: 'source', label: 'Source' },
] as const;
const FPS = [
  { value: 30, label: '30' },
  { value: 60, label: '60' },
] as const;

export function RecordingSection({ onReset }: SectionProps) {
  const { recording } = useSettings();
  const options = recordOptionsFromSettings(recording);
  const caps = useExportCapabilities();
  const mp4Unavailable = caps !== null && !caps.mp4Available;
  const platform = usePlatformCapabilities();
  return (
    <SectionCard
      id="recording"
      title="Recording"
      description="Defaults for every recording. You can change them on the home screen too."
      onReset={onReset}
    >
      <SettingRow
        label="Quality"
        description={
          recording.quality === '1080p'
            ? 'Fits the picture inside 1920 × 1080.'
            : 'Records at the full resolution of the screen: larger files.'
        }
      >
        {() => (
          <Segmented
            label="Recording quality"
            data-testid="setting-quality"
            value={recording.quality}
            options={QUALITY}
            onChange={(quality) => void updateSettings({ recording: { quality } })}
          />
        )}
      </SettingRow>
      <SettingRow label="Frame rate" description="Frames per second. 60 needs a faster computer.">
        {() => (
          <Segmented
            label="Frame rate"
            data-testid="setting-fps"
            value={recording.fps}
            options={FPS}
            onChange={(fps) => void updateSettings({ recording: { fps } })}
          />
        )}
      </SettingRow>
      <SettingRow label="Countdown" description="A 3-2-1 countdown before the recording starts.">
        {({ labelledBy, describedBy }) => (
          <Switch
            aria-labelledby={labelledBy}
            aria-describedby={describedBy}
            data-testid="setting-countdown"
            checked={recording.countdown}
            onCheckedChange={(countdown) => void updateSettings({ recording: { countdown } })}
          />
        )}
      </SettingRow>
      <SettingRow label="Microphone" description="Record your voice along with the screen.">
        {({ labelledBy, describedBy }) => (
          <Switch
            aria-labelledby={labelledBy}
            aria-describedby={describedBy}
            data-testid="setting-mic"
            checked={recording.micEnabled}
            onCheckedChange={(micEnabled) => void updateSettings({ recording: { micEnabled } })}
          />
        )}
      </SettingRow>
      <SettingRow
        label="Microphone device"
        description="Which microphone to use. The default follows Windows."
      >
        {({ labelledBy }) => (
          <MicrophoneSelect
            className="w-72 max-w-full"
            deviceId={options.mic.deviceId}
            disabled={!recording.micEnabled}
            labelledBy={labelledBy}
            testId="setting-mic-device"
            onChange={(deviceId) =>
              void updateSettings({
                recording: { micEnabled: true, micDeviceId: deviceId ?? null },
              })
            }
          />
        )}
      </SettingRow>
      <SettingRow
        label="System audio"
        description={
          platform.systemAudio
            ? 'Record everything you hear on this PC.'
            : (platform.systemAudioReason ?? 'Not available on this system.')
        }
      >
        {({ labelledBy, describedBy }) => (
          <Switch
            aria-labelledby={labelledBy}
            aria-describedby={describedBy}
            data-testid="setting-system-audio"
            disabled={!platform.systemAudio}
            checked={recording.systemAudio && platform.systemAudio}
            onCheckedChange={(systemAudio) => void updateSettings({ recording: { systemAudio } })}
          />
        )}
      </SettingRow>
      <SettingRow
        label="Also save an MP4"
        description={
          mp4Unavailable
            ? (caps?.reason ?? 'MP4 export is not available in this build.')
            : 'After each recording, convert it to MP4 next to the original. Takes a moment.'
        }
      >
        {({ labelledBy, describedBy }) => (
          <Switch
            aria-labelledby={labelledBy}
            aria-describedby={describedBy}
            data-testid="setting-auto-mp4"
            checked={recording.autoExportMp4 && !mp4Unavailable}
            disabled={mp4Unavailable}
            onCheckedChange={(autoExportMp4) =>
              void updateSettings({ recording: { autoExportMp4 } })
            }
          />
        )}
      </SettingRow>
    </SectionCard>
  );
}

// --- Shortcuts -----------------------------------------------------------------------------------

const SHORTCUT_GROUPS: { title: string; actions: readonly ShortcutAction[] }[] = [
  { title: 'Screenshots', actions: SHORTCUT_ACTIONS.slice(0, 3) },
  { title: 'Recording', actions: SHORTCUT_ACTIONS.slice(3) },
];

export function ShortcutsSection({ onReset }: SectionProps) {
  const { shortcuts } = useSettings();
  const states = useShortcutStates();
  return (
    <SectionCard
      id="shortcuts"
      title="Shortcuts"
      description="Work from any app while FrameCapt runs. Include Ctrl or Alt; F-keys and PrintScreen work alone."
      onReset={onReset}
    >
      {SHORTCUT_GROUPS.map((group) => (
        <div key={group.title} role="group" aria-label={group.title}>
          <p className="bg-surface-2 px-6 py-2 text-xs font-semibold tracking-wide text-fg-muted uppercase">
            {group.title}
          </p>
          <div className="divide-y divide-line">
            {group.actions.map((action) => (
              <SettingRow
                key={action}
                label={SHORTCUT_LABELS[action]}
                description={describeAction(action)}
                data-testid={`shortcut-row-${action}`}
              >
                {() => (
                  <ShortcutField
                    action={action}
                    label={SHORTCUT_LABELS[action]}
                    accelerator={shortcuts[action]}
                    state={states?.[action]}
                    onChange={(accelerator) =>
                      void updateSettings({ shortcuts: { [action]: accelerator } })
                    }
                  />
                )}
              </SettingRow>
            ))}
          </div>
        </div>
      ))}
    </SectionCard>
  );
}

function describeAction(action: ShortcutAction): string {
  switch (action) {
    case 'screenshotScreen':
      return 'Capture a whole screen.';
    case 'screenshotWindow':
      return 'Pick a window, then capture it.';
    case 'screenshotRegion':
      return 'Drag over the part of the screen you want.';
    case 'recordScreen':
      return 'Record a whole screen. Press again to stop.';
    case 'recordWindow':
      return 'Pick a window, then record it. Press again to stop.';
    case 'recordRegion':
      return 'Record part of the screen. Press again to stop.';
    case 'stopRecording':
      return 'Stop and save the recording.';
    case 'pauseRecording':
      return 'Pause the recording, or resume it.';
  }
}

// --- Storage -------------------------------------------------------------------------------------

function FolderRow({
  target,
  label,
  description,
  folder,
  isDefault,
}: {
  target: OutputTarget;
  label: string;
  description: string;
  folder: string;
  isDefault: boolean;
}) {
  return (
    <SettingRow label={label} description={description} stacked data-testid={`folder-${target}`}>
      {() => (
        <div className="flex w-full flex-wrap items-center gap-3">
          <p
            className="selectable min-w-0 flex-1 basis-64 rounded-lg border border-line bg-surface-2 px-3 py-2 text-[13px] break-all text-fg"
            data-testid={`folder-path-${target}`}
          >
            {folder || '…'}
            {isDefault ? <span className="ml-2 text-fg-muted">(default)</span> : null}
          </p>
          <div className="flex items-center gap-2">
            <Button
              size="sm"
              variant="secondary"
              data-testid={`folder-change-${target}`}
              aria-label={`Change the ${label.toLowerCase()}`}
              onClick={() => void chooseOutputDir(target)}
            >
              Change…
            </Button>
            <Button
              size="sm"
              variant="secondary"
              icon={<FolderOpen className="size-3.5" aria-hidden="true" />}
              data-testid={`folder-open-${target}`}
              aria-label={`Open the ${label.toLowerCase()}`}
              onClick={() =>
                void window.framecapt
                  .invoke('settings:openOutputDir', { target })
                  .then((response) => {
                    if (!response.ok) notify.error(response.error);
                  })
              }
            >
              Open
            </Button>
            <Button
              size="sm"
              variant="ghost"
              disabled={isDefault}
              data-testid={`folder-default-${target}`}
              aria-label={`Use the default ${label.toLowerCase()}`}
              onClick={() => void resetOutputDir(target)}
            >
              Use default
            </Button>
          </div>
        </div>
      )}
    </SettingRow>
  );
}

export function StorageSection({ onReset }: SectionProps) {
  const settings: Settings = useSettings();
  const dirs = useEffectiveDirs();
  return (
    <SectionCard
      id="storage"
      title="Storage"
      description="Where FrameCapt saves what you capture. Nothing leaves this computer."
      onReset={onReset}
    >
      <FolderRow
        target="screenshots"
        label="Screenshots folder"
        description="Saved screenshots go here (you still choose the name when you save)."
        folder={dirs.screenshotsDir}
        isDefault={settings.screenshots.outputDir === null}
      />
      <FolderRow
        target="recording"
        label="Recordings folder"
        description="Finished recordings and MP4 exports go here."
        folder={dirs.recordingsDir}
        isDefault={settings.recording.outputDir === null}
      />
      <div className="px-6 py-4 text-[13px] text-fg-muted">
        Unfinished recordings and screenshot originals wait in FrameCapt&apos;s app data folder
        until you save, discard or recover them. Changing a folder never moves files you already
        saved.
      </div>
    </SectionCard>
  );
}

// --- Advanced and About --------------------------------------------------------------------------

export function AdvancedSection() {
  return (
    <div className="space-y-4" data-testid="settings-advanced">
      <p className="text-[13px] text-fg-muted">
        Checks that screen and audio capture work on this computer. Nothing here changes your
        settings.
      </p>
      <CaptureDiagnostics />
    </div>
  );
}

/** The About line for the update adapter. Plain words: an unconfigured build never checks. */
export function updatesLabel(updates: AppInfo['updates']): string {
  switch (updates.state) {
    case 'unconfigured':
      return 'Not configured for this build';
    case 'idle':
      return 'Configured, not checked';
    case 'checking':
      return 'Checking...';
    case 'available':
    case 'downloading':
      return 'Downloading an update...';
    case 'ready':
      return 'Update ready, restart to install';
    case 'error':
      return updates.message ? `Error: ${updates.message}` : 'Error';
  }
}

function infoRows(info: AppInfo): { id: string; label: string; value: string }[] {
  return [
    { id: 'version', label: 'FrameCapt', value: info.version },
    { id: 'electron', label: 'Electron', value: info.electron },
    { id: 'chrome', label: 'Chromium', value: info.chrome },
    { id: 'node', label: 'Node.js', value: info.node },
    { id: 'platform', label: 'Platform', value: `${info.platform} (${info.arch})` },
    { id: 'build', label: 'Build', value: info.isPackaged ? 'Packaged' : 'Development' },
    { id: 'tray', label: 'Tray icon', value: info.tray.active ? 'Active' : 'Unavailable' },
    { id: 'updates', label: 'Updates', value: updatesLabel(info.updates) },
  ];
}

export function AboutSection() {
  const { state, reload } = useAppInfo();

  async function copyDetails(info: AppInfo): Promise<void> {
    const text = infoRows(info)
      .map((row) => `${row.label}: ${row.value}`)
      .join('\n');
    try {
      await navigator.clipboard.writeText(text);
      notify.success('Copied app details');
    } catch {
      notify.error('Could not copy to the clipboard');
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
            <Button
              size="sm"
              variant="secondary"
              icon={<Copy className="size-3.5" aria-hidden="true" />}
              onClick={() => void copyDetails(state.info)}
            >
              Copy details
            </Button>
          ) : null}
        </div>

        <div className="mb-5 flex items-center gap-5" data-testid="about-brand">
          <Logo size={112} />
          <div>
            <p className="text-2xl font-semibold tracking-tight text-fg">FrameCapt</p>
            <p className="text-sm text-fg-muted">
              {state.status === 'ready'
                ? `Version ${state.info.version}`
                : 'Screenshots and screen recordings, offline.'}
            </p>
          </div>
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

        <p className="mt-5 text-xs text-fg-muted">
          FrameCapt works fully offline and sends no telemetry. Licensed under GPL-3.0-only.
        </p>
      </Card>
    </section>
  );
}
