import { useId, type ReactNode } from 'react';
import { Settings2 } from 'lucide-react';
import {
  DEFAULT_CAMERA_STYLE,
  type CameraCorner,
  type CameraShape,
  type CameraSize,
} from '../../shared/camera';
import type { RecordOptions as Options } from '../../shared/recorder-ipc';
import type { RecordFps, RecordQuality } from '../../shared/recording';
import { followFromSetting, type FollowMouseSetting } from '../../shared/settings';
import { cn } from '../lib/cn';
import { usePlatformCapabilities } from '../lib/use-platform-capabilities';
import { useCameras } from '../recorder/use-cameras';
import { useMicrophones } from '../recorder/use-microphones';
import { CameraSelect } from './CameraSelect';
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
  /** The remembered camera style: used when the camera is switched on (undefined: the defaults). */
  cameraStyle?: { shape: CameraShape; size: CameraSize; corner: CameraCorner };
  /** The dashboard's dense form: four columns, no explanatory lines. */
  compact?: boolean;
}

const QUALITY = [
  { value: '1080p', label: '1080p' },
  { value: 'source', label: 'Source' },
] as const;
const FPS = [
  { value: 30, label: '30' },
  { value: 60, label: '60' },
] as const;

export const CAMERA_SHAPE_OPTIONS = [
  { value: 'circle', label: 'Circle' },
  { value: 'rounded', label: 'Rounded' },
] as const;
export const CAMERA_SIZE_OPTIONS = [
  { value: 's', label: 'S' },
  { value: 'm', label: 'M' },
  { value: 'l', label: 'L' },
] as const;

const FOLLOW = [
  { value: 'off', label: 'Off' },
  { value: '1.5', label: '1.5×' },
  { value: '2', label: '2×' },
  { value: '3', label: '3×' },
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
  cameraStyle = DEFAULT_CAMERA_STYLE,
  compact = false,
}: RecordOptionsProps) {
  /** Explanations are for the roomy form; what a switch cannot do is always said. */
  const note = (text: ReactNode): ReactNode => (compact ? undefined : text);
  const micId = useId();
  const cameraId = useId();
  const systemId = useId();
  const qualityId = useId();
  const fpsId = useId();
  const followId = useId();
  const countdownId = useId();
  const microphones = useMicrophones();
  const noMic = microphones.loaded && microphones.devices.length === 0;
  const cameras = useCameras();
  const noCamera = cameras.loaded && cameras.devices.length === 0;
  const camera = options.camera;
  const platform = usePlatformCapabilities();

  return (
    <Card
      padding={compact ? 'md' : 'lg'}
      data-testid="record-options"
      aria-label="Recording options"
      role="group"
    >
      <div className={cn('flex items-center justify-between gap-3', compact ? 'mb-3' : 'mb-4')}>
        <h2 className={cn('font-semibold text-fg', compact ? 'text-[13px]' : 'text-[15px]')}>
          Recording options
        </h2>
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
      <div
        className={cn(
          'grid sm:grid-cols-2',
          compact ? 'gap-x-6 gap-y-4 lg:grid-cols-4' : 'gap-x-8 gap-y-5 lg:grid-cols-3',
        )}
      >
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
          id={cameraId}
          label="Camera"
          hint={note('Your webcam, in the corner of the video. Drag the bubble to move it.')}
          control={
            <Switch
              aria-labelledby={cameraId}
              data-testid="opt-camera"
              checked={camera !== undefined && !noCamera}
              disabled={disabled || noCamera}
              onCheckedChange={(enabled) => {
                const { camera: _drop, ...rest } = options;
                onChange(enabled ? { ...rest, camera: { ...cameraStyle } } : rest);
              }}
            />
          }
        >
          <CameraSelect
            deviceId={camera?.deviceId}
            disabled={disabled || camera === undefined}
            labelledBy={cameraId}
            testId="opt-camera-device"
            onChange={(deviceId) => {
              if (!camera) return;
              const { deviceId: _old, ...rest } = camera;
              onChange({ ...options, camera: { ...rest, ...(deviceId && { deviceId }) } });
            }}
          />
          {camera ? (
            <div className="flex flex-wrap gap-2">
              <Segmented<CameraShape>
                label="Camera shape"
                data-testid="opt-camera-shape"
                value={camera.shape}
                options={CAMERA_SHAPE_OPTIONS}
                disabled={disabled}
                onChange={(shape) => onChange({ ...options, camera: { ...camera, shape } })}
              />
              <Segmented<CameraSize>
                label="Camera size"
                data-testid="opt-camera-size"
                value={camera.size}
                options={CAMERA_SIZE_OPTIONS}
                disabled={disabled}
                onChange={(size) => onChange({ ...options, camera: { ...camera, size } })}
              />
            </div>
          ) : null}
        </Cell>
        <Cell
          id={systemId}
          label="System audio"
          hint={
            platform.systemAudio
              ? note('Everything you hear on this PC')
              : platform.systemAudioReason
          }
          control={
            <Switch
              aria-labelledby={systemId}
              data-testid="opt-system"
              checked={options.systemAudio && platform.systemAudio}
              disabled={disabled || !platform.systemAudio}
              onCheckedChange={(systemAudio) => onChange({ ...options, systemAudio })}
            />
          }
        />
        <Cell
          id={countdownId}
          label="Countdown"
          hint={note('3 seconds before it starts')}
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
          hint={note(
            options.quality === '1080p' ? 'Fits 1920 × 1080' : 'Full resolution, larger files',
          )}
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
        <Cell id={fpsId} label="Frame rate" hint={note('Frames per second')}>
          <Segmented<RecordFps>
            label="Frame rate"
            data-testid="opt-fps"
            value={options.fps}
            options={FPS}
            disabled={disabled}
            onChange={(fps) => onChange({ ...options, fps })}
          />
        </Cell>
        <Cell
          id={followId}
          label="Follow mouse"
          hint={note(
            'Zooms in and pans to the mouse. Screen recordings only: window and region recordings ignore it.',
          )}
        >
          <Segmented<FollowMouseSetting>
            label="Follow mouse"
            data-testid="opt-follow"
            value={options.follow ? (String(options.follow.zoom) as FollowMouseSetting) : 'off'}
            options={FOLLOW}
            disabled={disabled}
            onChange={(value) => {
              const { follow: _drop, ...rest } = options;
              const follow = followFromSetting(value);
              onChange({ ...rest, ...(follow && { follow }) });
            }}
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
      {platform.toolbarNote ? (
        <p className="mt-4 text-xs text-fg-muted" data-testid="record-toolbar-note">
          {platform.toolbarNote}
        </p>
      ) : null}
    </Card>
  );
}
