import { TriangleAlert } from 'lucide-react';
import { isMicrophoneMissing, useMicrophones } from '../recorder/use-microphones';
import { Select } from './ui/Select';

export interface MicrophoneSelectProps {
  /** The saved device (undefined = the default microphone). */
  deviceId: string | undefined;
  /** Picking a device (or the default, undefined) turns the microphone on. */
  onChange: (deviceId: string | undefined) => void;
  disabled?: boolean;
  labelledBy?: string;
  /** Where the "not found" line goes; it is always rendered inside this component. */
  testId?: string;
  className?: string;
}

/**
 * The microphone choice: the default device or one of the connected ones. A saved device that is no
 * longer connected is not dropped silently: the line below says it is not found and that the default
 * is used, and recording asks again if it still cannot be opened.
 */
export function MicrophoneSelect({
  deviceId,
  onChange,
  disabled,
  labelledBy,
  testId,
  className,
}: MicrophoneSelectProps) {
  const microphones = useMicrophones();
  const missing = isMicrophoneMissing(microphones, deviceId);
  const none = microphones.loaded && microphones.devices.length === 0;
  const listed = microphones.devices.filter(
    (device) =>
      device.deviceId !== 'default' &&
      device.deviceId !== 'communications' &&
      device.deviceId !== '',
  );
  return (
    <div className={className}>
      <Select
        value={missing ? '' : (deviceId ?? '')}
        onChange={(value) => onChange(value === '' ? undefined : value)}
        options={listed.map((device, index) => ({
          value: device.deviceId,
          label: device.label || `Microphone ${index + 1}`,
        }))}
        disabled={disabled || none}
        label="Microphone device"
        {...(labelledBy && { labelledBy })}
        {...(testId && { 'data-testid': testId })}
      >
        <option value="">Default microphone</option>
      </Select>
      {missing && !none ? (
        <p
          role="status"
          data-testid="mic-missing"
          className="mt-1.5 flex items-center gap-1.5 text-xs text-warning"
        >
          <TriangleAlert className="size-3.5 shrink-0" aria-hidden="true" />
          Saved microphone not found — using default
        </p>
      ) : null}
      {none ? <p className="mt-1.5 text-xs text-fg-subtle">No microphone found</p> : null}
    </div>
  );
}
