import { useEffect, useState } from 'react';

/** Microphones, refreshed when devices change. Labels may be empty until permission is granted. */
export function useMicrophones(): MediaDeviceInfo[] {
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([]);
  useEffect(() => {
    let active = true;
    const refresh = (): void => {
      navigator.mediaDevices
        .enumerateDevices()
        .then((all) => {
          if (active) setDevices(all.filter((device) => device.kind === 'audioinput'));
        })
        .catch(() => {
          if (active) setDevices([]);
        });
    };
    refresh();
    navigator.mediaDevices.addEventListener('devicechange', refresh);
    return () => {
      active = false;
      navigator.mediaDevices.removeEventListener('devicechange', refresh);
    };
  }, []);
  return devices;
}
