import { useCallback, useEffect, useState } from 'react';
import type { AppInfo } from '../../shared/ipc-contract';

export type AppInfoState =
  { status: 'loading' } | { status: 'ready'; info: AppInfo } | { status: 'error'; message: string };

/** Loads app:getInfo through the preload bridge. */
export function useAppInfo(): { state: AppInfoState; reload: () => void } {
  const [state, setState] = useState<AppInfoState>({ status: 'loading' });
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let cancelled = false;
    window.framelet
      .invoke('app:getInfo')
      .then((result) => {
        if (cancelled) return;
        setState(
          result.ok
            ? { status: 'ready', info: result.data }
            : { status: 'error', message: result.error.message },
        );
      })
      .catch(() => {
        if (!cancelled) setState({ status: 'error', message: 'Could not reach the app.' });
      });
    return () => {
      cancelled = true;
    };
  }, [attempt]);

  const reload = useCallback(() => {
    setState({ status: 'loading' });
    setAttempt((n) => n + 1);
  }, []);

  return { state, reload };
}
