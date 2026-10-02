import { useId, type ReactNode } from 'react';
import { ChevronDown } from 'lucide-react';
import type { RecordOptions as Options } from '../../shared/recorder-ipc';
import type { RecordFps, RecordQuality } from '../../shared/recording';
import { useMicrophones } from '../recorder/use-microphones';
import { Card } from './ui/Card';
import { Segmented } from './ui/Segmented';
import { Switch } from './ui/Switch';

export interface RecordOptionsProps {
  options: Options;
  onChange: (options: Options) => void;
  /** Locked while a recording is being set up or running. */
  disabled?: boolean;
}

const QUALITY = [
  { value: '1080p', label: '1080p' },
  { value: 'source', label: 'Source' },
] as const;
const FPS = [
  { value: 30, label: '30' },
  { value: 60, label: '60' },
] as const;

function Row({
  id,
  label,
  hint,
  children,
}: {
  id: string;
  label: string;
  hint?: string | undefined;
  children: ReactNode;
}) {
  return (
    <div className="flex min-h-10 items-center justify-between gap-3">
      <div className="min-w-0">
        <span id={id} className="text-[13px] font-medium text-fg">
          {label}
        </span>
        {hint ? <p className="text-xs text-fg-subtle">{hint}</p> : null}
      </div>
      <div className="flex shrink-0 items-center gap-2.5">{children}</div>
    </div>
  );
}

/**
 * The record options under the Record card: microphone (and device), system audio, quality, frame
 * rate and countdown. Anything unavailable says why instead of silently doing nothing.
 */
export function RecordOptions({ options, onChange, disabled = false }: RecordOptionsProps) {
  const micId = useId();
  const systemId = useId();
  const qualityId = useId();
  const fpsId = useId();
  const countdownId = useId();
  const microphones = useMicrophones();
  const noMic = microphones.length === 0;
  const selected = options.mic.deviceId ?? '';
  const known = selected === '' || microphones.some((device) => device.deviceId === selected);

  return (
    <Card padding="none" className="px-4 py-1.5" data-testid="record-options">
      <Row id={micId} label="Microphone" hint={noMic ? 'No microphone found' : undefined}>
        <div className="relative">
          <select
            aria-label="Microphone device"
            data-testid="opt-mic-device"
            value={known ? selected : ''}
            disabled={disabled || noMic || !options.mic.enabled}
            onChange={(event) =>
              onChange({
                ...options,
                mic: { enabled: true, ...(event.target.value && { deviceId: event.target.value }) },
              })
            }
            className="h-8 w-44 appearance-none truncate rounded-lg border border-line bg-surface pr-7 pl-2.5 text-[13px] text-fg disabled:opacity-50"
          >
            <option value="">Default microphone</option>
            {microphones
              .filter(
                (device) => device.deviceId !== 'default' && device.deviceId !== 'communications',
              )
              .map((device, index) => (
                <option key={device.deviceId} value={device.deviceId}>
                  {device.label || `Microphone ${index + 1}`}
                </option>
              ))}
          </select>
          <ChevronDown
            className="pointer-events-none absolute top-1/2 right-2 size-4 -translate-y-1/2 text-fg-subtle"
            aria-hidden="true"
          />
        </div>
        <Switch
          aria-labelledby={micId}
          data-testid="opt-mic"
          checked={options.mic.enabled && !noMic}
          disabled={disabled || noMic}
          onCheckedChange={(enabled) => onChange({ ...options, mic: { ...options.mic, enabled } })}
        />
      </Row>
      <Row id={systemId} label="System audio">
        <Switch
          aria-labelledby={systemId}
          data-testid="opt-system"
          checked={options.systemAudio}
          disabled={disabled}
          onCheckedChange={(systemAudio) => onChange({ ...options, systemAudio })}
        />
      </Row>
      <Row
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
      </Row>
      <Row id={fpsId} label="Frame rate">
        <Segmented<RecordFps>
          label="Frame rate"
          data-testid="opt-fps"
          value={options.fps}
          options={FPS}
          disabled={disabled}
          onChange={(fps) => onChange({ ...options, fps })}
        />
      </Row>
      <Row id={countdownId} label="Countdown" hint="3 seconds before it starts">
        <Switch
          aria-labelledby={countdownId}
          data-testid="opt-countdown"
          checked={options.countdown}
          disabled={disabled}
          onCheckedChange={(countdown) => onChange({ ...options, countdown })}
        />
      </Row>
    </Card>
  );
}
