import { useCallback, useEffect, useRef, useState } from 'react';
import { notify } from '../lib/notify';
import type { ShotKind } from '../../shared/shots';

export interface CaptureFlow {
  /** The target of the running flow, or null when idle. */
  running: ShotKind | null;
  /**
   * Starts a screenshot flow. `trigger` is the element to focus again when the flow is cancelled
   * or fails (after a completed flow the result view takes over).
   */
  start: (target: ShotKind, trigger: HTMLElement | null, sourceId?: string) => Promise<void>;
}

/** Drives `capture:startScreenshot` and follows its outcome events from main. */
export function useCaptureFlow(): CaptureFlow {
  const [running, setRunning] = useState<ShotKind | null>(null);
  const triggerRef = useRef<HTMLElement | null>(null);
  const refocus = useRef(false);

  useEffect(
    () =>
      window.framelet.on('capture:flowEnded', (event) => {
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

  const start = useCallback<CaptureFlow['start']>(async (target, trigger, sourceId) => {
    triggerRef.current = trigger;
    setRunning(target);
    const result = await window.framelet.invoke('capture:startScreenshot', {
      target,
      ...(sourceId !== undefined && { sourceId }),
    });
    if (!result.ok) {
      setRunning(null);
      notify.error(result.error);
      trigger?.focus();
    }
  }, []);

  return { running, start };
}
