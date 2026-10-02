import { useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import type { RecorderSnapshot } from '../../shared/recorder-ipc';

export const IDLE_SNAPSHOT: RecorderSnapshot = {
  status: 'idle',
  sessionId: null,
  target: null,
  startedAt: null,
  activeMs: 0,
  runningSince: null,
  error: null,
  stopReason: null,
  audio: { mic: false, system: false },
  muted: { mic: false, system: false },
  lost: { mic: false, system: false },
  choice: null,
  choiceCanUseDefault: false,
  quitting: false,
  countdown: null,
  width: null,
  height: null,
  result: null,
};

/**
 * The authoritative recorder state from main: fetched once, then every `recorder:state` broadcast.
 * Windows never hold their own copy of "what is recording": they only render this.
 */
export function useRecorderState(): RecorderSnapshot {
  const [snapshot, setSnapshot] = useState<RecorderSnapshot>(IDLE_SNAPSHOT);
  useEffect(() => {
    let active = true;
    const off = window.framelet.on('recorder:state', (next) => {
      if (active) setSnapshot(next);
    });
    void window.framelet.invoke('recorder:getState').then((result) => {
      if (active && result.ok)
        setSnapshot((current) => (current === IDLE_SNAPSHOT ? result.data : current));
    });
    return () => {
      active = false;
      off();
    };
  }, []);
  return snapshot;
}

/** Active recording time in ms, ticking while the recording runs (paused time is excluded). */
export function useActiveMs(snapshot: RecorderSnapshot): number {
  const [now, setNow] = useState(() => Date.now());
  const running = snapshot.runningSince !== null;
  useEffect(() => {
    if (!running) return;
    const id = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(id);
  }, [running, snapshot.runningSince]);
  return (
    snapshot.activeMs +
    (snapshot.runningSince === null ? 0 : Math.max(0, now - snapshot.runningSince))
  );
}

/** Raises a toast when a microphone or system audio source is lost during a recording. */
export function useRecorderToasts(snapshot: RecorderSnapshot): void {
  const previous = useRef(snapshot.lost);
  useEffect(() => {
    if (snapshot.lost.mic && !previous.current.mic) {
      toast.warning('Microphone disconnected. The recording continues without it.');
    }
    if (snapshot.lost.system && !previous.current.system) {
      toast.warning('System audio ended. The recording continues without it.');
    }
    previous.current = snapshot.lost;
  }, [snapshot.lost]);
}
