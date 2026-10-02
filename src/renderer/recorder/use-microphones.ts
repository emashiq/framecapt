import { useEffect, useState } from 'react';

export interface Microphones {
  devices: MediaDeviceInfo[];
  /** The first device list has arrived (before that "missing" cannot be told from "not yet known"). */
  loaded: boolean;
}

/** Microphones, refreshed when devices change. Labels may be empty until permission is granted. */
export function useMicrophones(): Microphones {
  const [state, setState] = useState<Microphones>({ devices: [], loaded: false });
  useEffect(() => {
    let active = true;
    const refresh = (): void => {
      navigator.mediaDevices
        .enumerateDevices()
        .then((all) => {
          if (active) {
            setState({
              devices: all.filter((device) => device.kind === 'audioinput'),
              loaded: true,
            });
          }
        })
        .catch(() => {
          if (active) setState({ devices: [], loaded: true });
        });
    };
    refresh();
    navigator.mediaDevices.addEventListener('devicechange', refresh);
    return () => {
      active = false;
      navigator.mediaDevices.removeEventListener('devicechange', refresh);
    };
  }, []);
  return state;
}

/** The saved device id is gone: a device list is known and does not contain it. */
export function isMicrophoneMissing(
  microphones: Microphones,
  deviceId: string | undefined,
): boolean {
  if (deviceId === undefined || !microphones.loaded) return false;
  const named = microphones.devices.filter((device) => device.deviceId !== '');
  // Without microphone permission Chromium hides device ids: then nothing can be said.
  if (named.length === 0) return microphones.devices.length === 0;
  return !named.some((device) => device.deviceId === deviceId);
}
