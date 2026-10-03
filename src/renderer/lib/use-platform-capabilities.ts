import { useEffect, useState } from 'react';
import { platformCapabilities, type PlatformCapabilities } from '../../shared/platform';

/** Windows-like until the platform is known (it never changes while the app runs). */
const DEFAULT = platformCapabilities('win32');
let cached: PlatformCapabilities | null = null;

/** What this OS supports (system audio, toolbar exclusion), from `app:getInfo`. */
export function usePlatformCapabilities(): PlatformCapabilities {
  const [value, setValue] = useState<PlatformCapabilities>(cached ?? DEFAULT);
  useEffect(() => {
    if (cached) return;
    let live = true;
    void window.framecapt.invoke('app:getInfo').then((result) => {
      if (!result.ok) return;
      cached = platformCapabilities(result.data.platform);
      if (live) setValue(cached);
    });
    return () => {
      live = false;
    };
  }, []);
  return value;
}
