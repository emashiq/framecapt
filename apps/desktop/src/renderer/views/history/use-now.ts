import { useEffect, useState } from 'react';

/**
 * The current time, refreshed when the window comes back into view or gets focus, so "2 min ago" is
 * right whenever the user looks at it. There is deliberately no timer: an idle window must not wake
 * up just to repaint a relative time.
 */
export function useNow(): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const refresh = (): void => setNow(Date.now());
    const onVisibility = (): void => {
      if (document.visibilityState === 'visible') refresh();
    };
    window.addEventListener('focus', refresh);
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      window.removeEventListener('focus', refresh);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, []);
  return now;
}
