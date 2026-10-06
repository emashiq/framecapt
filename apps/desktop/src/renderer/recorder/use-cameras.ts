import { useEffect, useState } from 'react';

export interface Cameras {
  devices: MediaDeviceInfo[];
  /** The first device list has arrived (before that "none" cannot be told from "not yet known"). */
  loaded: boolean;
}

/** Cameras (`videoinput`), refreshed when devices change. Labels are visible to the main window (see app-origin.ts). */
export function useCameras(): Cameras {
  const [state, setState] = useState<Cameras>({ devices: [], loaded: false });
  useEffect(() => {
    let active = true;
    const refresh = (): void => {
      navigator.mediaDevices
        .enumerateDevices()
        .then((all) => {
          if (active) {
            setState({
              devices: all.filter((device) => device.kind === 'videoinput'),
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
