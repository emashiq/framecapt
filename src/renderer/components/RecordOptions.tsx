import { useId, type ReactNode } from 'react';
import { Settings2 } from 'lucide-react';
import type { RecordOptions as Options } from '../../shared/recorder-ipc';
import type { RecordFps, RecordQuality } from '../../shared/recording';
import { useMicrophones } from '../recorder/use-microphones';
import { MicrophoneSelect } from './MicrophoneSelect';
import { Button } from './ui/Button';
import { Card } from './ui/Card';
import { Segmented } from './ui/Segmented';
import { Switch } from './ui/Switch';

export interface RecordOptionsProps {
  options: Options;
  onChange: (options: Options) => void;
  /** Locked while a recording is being set up or running. */
  disabled?: boolean;
  /** Where finished recordings go (shown as a line; the folder itself is chosen in Settings). */
  outputDir?: string;
  onOpenSettings?: () => void;
}

const QUALITY = [
  { value: '1080p', label: '1080p' },
  { value: 'source', label: 'Source' },
] as const;
const FPS = [
  { value: 30, label: '30' },
  { value: 60, label: '60' },
] as const;

function Cell({
  id,
  label,
  hint,
  control,
  children,
}: {
  id: string;
  label: string;
  hint?: ReactNode;
  /** A switch on the label row. */
  control?: ReactNode;
  children?: ReactNode;
}) {
  return (
    <div className="flex min-w-0 flex-col gap-2">
      <div className="flex min-h-6 items-center justify-between gap-3">
        <span id={id} className="text-[13px] font-medium text-fg">
          {label}
        </span>
        {control}
      </div>
      {children}
      {hint ? <p className="text-xs text-fg-muted">{hint}</p> : null}
    </div>
  );
}

/**
 * Recording options, one strip under both mode cards: microphone (and device), system audio,
 * countdown, quality and frame rate. They are the recording settings (Settings → Recording shows the
 * same values); anything unavailable says why instead of silently doing nothing.
 */
export function RecordOptions({
  options,
  onChange,
  disabled = false,
  outputDir,
  onOpenSettings,
}: RecordOptionsProps) {
  const micId = useId();
  const systemId = useId();
  const qualityId = useId();
  const fpsId = useId();
  const countdownId = useId();
  const microphones = useMicrophones();
  const noMic = microphones.loaded && microphones.devices.length === 0;

  return (
    <Card padding="lg" data-testid="record-options" aria-label="Recording options" role="group">
      <div className="mb-4 flex items-center justify-between gap-3">
        <h2 className="text-[15px] font-semibold text-fg">Recording options</h2>
        {onOpenSettings ? (
          <Button
            size="sm"
            variant="ghost"
            icon={<Settings2 className="size-3.5" aria-hidden="true" />}
            onClick={onOpenSettings}
            data-testid="record-options-settings"
          >
            More in Settings
          </Button>
        ) : null}
      </div>
      <div className="grid gap-x-8 gap-y-5 sm:grid-cols-2 lg:grid-cols-3">
        <Cell
          id={micId}
          label="Microphone"
          control={
            <Switch
              aria-labelledby={micId}
              data-testid="opt-mic"
              checked={options.mic.enabled && !noMic}
              disabled={disabled || noMic}
              onCheckedChange={(enabled) =>
                onChange({ ...options, mic: { ...options.mic, enabled } })
              }
            />
          }
        >
          <MicrophoneSelect
            deviceId={options.mic.deviceId}
            disabled={disabled || !options.mic.enabled}
            labelledBy={micId}
            testId="opt-mic-device"
            onChange={(deviceId) =>
              onChange({ ...options, mic: { enabled: true, ...(deviceId && { deviceId }) } })
            }
          />
        </Cell>
        <Cell
          id={systemId}
          label="System audio"
          hint="Everything you hear on this PC"
          control={
            <Switch
              aria-labelledby={systemId}
              data-testid="opt-system"
              checked={options.systemAudio}
              disabled={disabled}
              onCheckedChange={(systemAudio) => onChange({ ...options, systemAudio })}
            />
          }
        />
        <Cell
          id={countdownId}
          label="Countdown"
          hint="3 seconds before it starts"
          control={
            <Switch
              aria-labelledby={countdownId}
              data-testid="opt-countdown"
              checked={options.countdown}
              disabled={disabled}
              onCheckedChange={(countdown) => onChange({ ...options, countdown })}
            />
          }
        />
        <Cell
          id={qualityId}
          label="Quality"
          hint={options.quality === '1080p' ? 'Fits 1920 × 1080' : 'Full resolution, larger files'}
        >
          <Segmented<RecordQuality>
            label="Quality"
            data-testid="opt-quality"
            value={options.quality}
            options={QUALITY}
            disabled={disabled}
            onChange={(quality) => onChange({ ...options, quality })}
          />
        </Cell>
        <Cell id={fpsId} label="Frame rate" hint="Frames per second">
          <Segmented<RecordFps>
            label="Frame rate"
            data-testid="opt-fps"
            value={options.fps}
            options={FPS}
            disabled={disabled}
            onChange={(fps) => onChange({ ...options, fps })}
          />
        </Cell>
        {outputDir ? (
          <Cell id={`${fpsId}-dir`} label="Saves to">
            <p
              className="truncate text-[13px] text-fg-muted"
              title={outputDir}
              data-testid="record-output-dir"
            >
              {outputDir}
            </p>
          </Cell>
        ) : null}
      </div>
    </Card>
  );
}
