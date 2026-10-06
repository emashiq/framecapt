import { TriangleAlert } from 'lucide-react';
import { useCameras } from '../recorder/use-cameras';
import { Select } from './ui/Select';

export interface CameraSelectProps {
  /** The saved device (undefined = the default camera). */
  deviceId: string | undefined;
  onChange: (deviceId: string | undefined) => void;
  disabled?: boolean;
  labelledBy?: string;
  testId?: string;
  className?: string;
}

/**
 * The camera choice: the default device or one of the connected ones. A saved device that is no
 * longer connected is said so below; recording then uses the default camera.
 */
export function CameraSelect({
  deviceId,
  onChange,
  disabled,
  labelledBy,
  testId,
  className,
}: CameraSelectProps) {
  const cameras = useCameras();
  const listed = cameras.devices.filter((device) => device.deviceId !== '');
  const none = cameras.loaded && cameras.devices.length === 0;
  const missing =
    deviceId !== undefined &&
    cameras.loaded &&
    listed.length > 0 &&
    !listed.some((device) => device.deviceId === deviceId);
  return (
    <div className={className}>
      <Select
        value={missing ? '' : (deviceId ?? '')}
        onChange={(value) => onChange(value === '' ? undefined : value)}
        options={listed.map((device, index) => ({
          value: device.deviceId,
          label: device.label || `Camera ${index + 1}`,
        }))}
        disabled={disabled || none}
        label="Camera device"
        {...(labelledBy && { labelledBy })}
        {...(testId && { 'data-testid': testId })}
      >
        <option value="">Default camera</option>
      </Select>
      {missing ? (
        <p
          role="status"
          data-testid="camera-missing"
          className="mt-1.5 flex items-center gap-1.5 text-xs text-warning"
        >
          <TriangleAlert className="size-3.5 shrink-0" aria-hidden="true" />
          Saved camera not found — using default
        </p>
      ) : null}
      {none ? <p className="mt-1.5 text-xs text-fg-subtle">No camera found</p> : null}
    </div>
  );
}
