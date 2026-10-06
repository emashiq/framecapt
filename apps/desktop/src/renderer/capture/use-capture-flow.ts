import { useCallback, useEffect, useRef, useState } from 'react';
import { notify } from '../lib/notify';
import type { CaptureTarget } from '../../shared/shots';

export interface CaptureFlow {
  /** The target of the running flow, or null when idle. */
  running: CaptureTarget | null;
  /** The running flow captures every screen in one image. */
  allScreens: boolean;
  /**
   * Starts a screenshot flow. `trigger` is the element to focus again when the flow is cancelled
   * or fails (after a completed flow the result view takes over).
   */
  start: (
    target: CaptureTarget,
    trigger: HTMLElement | null,
    sourceId?: string,
    allScreens?: boolean,
  ) => Promise<void>;
}

/** Drives `capture:startScreenshot` and follows its outcome events from main. */
export function useCaptureFlow(): CaptureFlow {
  const [running, setRunning] = useState<CaptureTarget | null>(null);
  const [allScreens, setAllScreens] = useState(false);
  const triggerRef = useRef<HTMLElement | null>(null);
  const refocus = useRef(false);

  useEffect(
    () =>
      window.framecapt.on('capture:flowEnded', (event) => {
        setRunning(null);
        if (event.outcome === 'error') {
          notify.error({ code: event.code, message: event.message ?? 'The capture failed.' });
        }
        // The main window was just shown again: put focus back where the user started (after
        // the buttons are enabled again, see the effect below).
        refocus.current = event.outcome !== 'completed';
      }),
    [],
  );

  useEffect(() => {
    if (running === null && refocus.current) {
      refocus.current = false;
      triggerRef.current?.focus();
    }
  }, [running]);

  const start = useCallback<CaptureFlow['start']>(async (target, trigger, sourceId, all) => {
    triggerRef.current = trigger;
    setRunning(target);
    setAllScreens(all === true);
    const result = await window.framecapt.invoke('capture:startScreenshot', {
      target,
      ...(sourceId !== undefined && { sourceId }),
      ...(all && { allScreens: true }),
    });
    if (!result.ok) {
      setRunning(null);
      notify.error(result.error);
      trigger?.focus();
    }
  }, []);

  return { running, allScreens, start };
}
