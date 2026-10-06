import { registerAudioContext } from './resource-registry';

export interface TestTone {
  stop(): void;
}

/**
 * Plays a quiet 440 Hz tone through the default output in its OWN AudioContext, so that Windows
 * loopback capture has something audible to record. Deliberately separate from the recording mix:
 * the mix itself is never played back.
 */
export function startTestTone(gain = 0.05): TestTone {
  const ctx = registerAudioContext(new AudioContext());
  const oscillator = ctx.createOscillator();
  oscillator.type = 'sine';
  oscillator.frequency.value = 440;
  const level = ctx.createGain();
  level.gain.value = gain;
  oscillator.connect(level);
  level.connect(ctx.destination);
  oscillator.start();
  void ctx.resume();

  let stopped = false;
  return {
    stop() {
      if (stopped) return;
      stopped = true;
      try {
        oscillator.stop();
      } catch {
        // already stopped
      }
      oscillator.disconnect();
      level.disconnect();
      void ctx.close().catch(() => undefined);
    },
  };
}
