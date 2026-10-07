import { useEffect, useState } from 'react';
import type { StepsSnapshot } from '../../shared/flow-ipc';

export const IDLE_STEPS: StepsSnapshot = {
  state: 'idle',
  auto: true,
  count: 0,
  max: 200,
  notice: null,
};

/**
 * The authoritative step-capture state from main: fetched once, then every `steps:state`
 * broadcast. The pill and the main window only render it and send commands back.
 */
export function useStepsState(): StepsSnapshot {
  const [snapshot, setSnapshot] = useState<StepsSnapshot>(IDLE_STEPS);
  useEffect(() => {
    let active = true;
    const off = window.framecapt.on('steps:state', (next) => {
      if (active) setSnapshot(next);
    });
    void window.framecapt.invoke('steps:getState').then((result) => {
      if (active && result.ok)
        setSnapshot((current) => (current === IDLE_STEPS ? result.data : current));
    });
    return () => {
      active = false;
      off();
    };
  }, []);
  return snapshot;
}
