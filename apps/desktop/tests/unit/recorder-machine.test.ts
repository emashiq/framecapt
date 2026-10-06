import { describe, expect, it } from 'vitest';
import {
  activeDurationAt,
  createInitialState,
  isFinished,
  isPreRecording,
  reduce,
  RECORDER_STATUSES,
  type AudioFlags,
  type RecorderEvent,
  type RecorderEventType,
  type RecorderMachineState,
  type RecorderStatus,
} from '../../src/shared/recorder-machine';

const BOTH: AudioFlags = { mic: true, system: true };

/** Runs events in order; every one must be accepted. */
function run(
  events: RecorderEvent[],
  from: RecorderMachineState = createInitialState(),
): RecorderMachineState {
  let state = from;
  for (const event of events) {
    const result = reduce(state, event);
    expect(result.rejected, `${event.type} in ${state.status}`).toBe(false);
    state = result.state;
  }
  return state;
}

const START: RecorderEvent = { type: 'START_REQUESTED', sessionId: 's1' };
const TO_PREFLIGHT: RecorderEvent[] = [START, { type: 'SOURCE_SELECTED' }];
const TO_COUNTDOWN: RecorderEvent[] = [...TO_PREFLIGHT, { type: 'PREFLIGHT_OK' }];
const TO_STARTING: RecorderEvent[] = [...TO_COUNTDOWN, { type: 'COUNTDOWN_DONE' }];
const STARTED = (at = 1000): RecorderEvent => ({
  type: 'STARTED',
  at,
  wallClock: 1_700_000_000_000,
  audio: BOTH,
});
const TO_RECORDING: RecorderEvent[] = [...TO_STARTING, STARTED()];
const TO_PAUSED: RecorderEvent[] = [...TO_RECORDING, { type: 'PAUSE', at: 3000 }];
const TO_STOPPING: RecorderEvent[] = [...TO_RECORDING, { type: 'STOP', at: 5000 }];
const TO_PROCESSING: RecorderEvent[] = [...TO_STOPPING, { type: 'STOPPED' }];
const TO_COMPLETED: RecorderEvent[] = [...TO_PROCESSING, { type: 'FINALIZED' }];
const TO_ERROR: RecorderEvent[] = [START, { type: 'FAILED', code: 'X', message: 'broke' }];

describe('recorder machine: the happy path', () => {
  it('walks every state in order and records the timing facts', () => {
    expect(run([START]).status).toBe('selecting');
    expect(run(TO_PREFLIGHT).status).toBe('preflight');
    expect(run(TO_COUNTDOWN).status).toBe('countdown');
    expect(run(TO_STARTING).status).toBe('starting');
    const recording = run(TO_RECORDING);
    expect(recording).toMatchObject({
      status: 'recording',
      sessionId: 's1',
      startedAt: 1_700_000_000_000,
      segmentStartedAt: 1000,
      pausedAt: null,
      audio: BOTH,
      muted: { mic: false, system: false },
      lost: { mic: false, system: false },
    });
    expect(run(TO_PAUSED).status).toBe('paused');
    expect(run(TO_STOPPING).status).toBe('stopping');
    expect(run(TO_PROCESSING).status).toBe('processing');
    expect(run(TO_COMPLETED).status).toBe('completed');
  });

  it('keeps the session id from start to completed', () => {
    expect(run(TO_COMPLETED).sessionId).toBe('s1');
  });
});

describe('recorder machine: active duration excludes paused time', () => {
  it('counts only the running segments', () => {
    // Recording from 1000, paused at 3000 (2000 ms), resumed at 8000, stopped at 9500 (1500 ms).
    const state = run([...TO_PAUSED, { type: 'RESUME', at: 8000 }, { type: 'STOP', at: 9500 }]);
    expect(state.activeDurationMs).toBe(3500);
    expect(state.segmentStartedAt).toBeNull();
    expect(state.pausedAt).toBeNull();
  });

  it('activeDurationAt adds the running segment, and nothing while paused', () => {
    const recording = run(TO_RECORDING);
    expect(activeDurationAt(recording, 1000)).toBe(0);
    expect(activeDurationAt(recording, 4000)).toBe(3000);
    const paused = run(TO_PAUSED);
    expect(paused.pausedAt).toBe(3000);
    expect(activeDurationAt(paused, 3000)).toBe(2000);
    expect(activeDurationAt(paused, 999_999)).toBe(2000);
  });

  it('survives many pause and resume cycles', () => {
    let state = run(TO_RECORDING);
    let clock = 1000;
    for (let i = 0; i < 20; i += 1) {
      clock += 100;
      state = run([{ type: 'PAUSE', at: clock }], state);
      clock += 500; // paused: not counted
      state = run([{ type: 'RESUME', at: clock }], state);
    }
    clock += 100;
    state = run([{ type: 'STOP', at: clock }], state);
    expect(state.activeDurationMs).toBe(21 * 100);
  });

  it('never goes negative when the clock steps back', () => {
    const state = run([...TO_RECORDING, { type: 'STOP', at: 500 }]);
    expect(state.activeDurationMs).toBe(0);
  });
});

describe('recorder machine: required scenarios', () => {
  it('rapid start then stop: STOP right after START cancels, nothing is left behind', () => {
    const state = run([START, { type: 'STOP', at: 1 }]);
    expect(state).toEqual(createInitialState());
  });

  it('rapid start, started, stop, stop: ends once and stays ended', () => {
    const stopping = run([...TO_RECORDING, { type: 'STOP', at: 1100 }]);
    expect(stopping.status).toBe('stopping');
    const again = reduce(stopping, { type: 'STOP', at: 1105 });
    expect(again).toEqual({ state: stopping, rejected: false });
  });

  it('stop during the countdown cancels back to idle', () => {
    const state = run([...TO_COUNTDOWN, { type: 'STOP', at: 10 }]);
    expect(state.status).toBe('idle');
    expect(state.sessionId).toBeNull();
  });

  it('cancel during starting returns to idle without a result', () => {
    const state = run([...TO_STARTING, { type: 'CANCEL' }]);
    expect(state).toEqual(createInitialState());
  });

  it('cancel works in selecting, preflight and countdown too', () => {
    for (const path of [[START], TO_PREFLIGHT, TO_COUNTDOWN]) {
      expect(run([...path, { type: 'CANCEL' }]).status).toBe('idle');
    }
  });

  it('cancel while waiting for a preflight decision returns to idle and clears the choice', () => {
    const waiting = run([
      ...TO_PREFLIGHT,
      { type: 'PREFLIGHT_NEEDS_CHOICE', choice: 'mic-missing' },
    ]);
    expect(waiting.choice).toBe('mic-missing');
    expect(waiting.status).toBe('preflight');
    expect(run([{ type: 'CANCEL' }], waiting)).toEqual(createInitialState());
  });

  it('preflight choice: a second choice replaces the first and OK clears it', () => {
    let state = run([...TO_PREFLIGHT, { type: 'PREFLIGHT_NEEDS_CHOICE', choice: 'mic-missing' }]);
    state = run([{ type: 'PREFLIGHT_NEEDS_CHOICE', choice: 'system-audio-unavailable' }], state);
    expect(state.choice).toBe('system-audio-unavailable');
    state = run([{ type: 'PREFLIGHT_OK' }], state);
    expect(state.status).toBe('countdown');
    expect(state.choice).toBeNull();
  });

  it('duplicate stop is a harmless no-op in stopping, processing and completed', () => {
    for (const path of [TO_STOPPING, TO_PROCESSING, TO_COMPLETED]) {
      const state = run(path);
      expect(reduce(state, { type: 'STOP', at: 99_999 })).toEqual({ state, rejected: false });
    }
  });

  it('pause outside recording is rejected (and changes nothing)', () => {
    for (const path of [
      [],
      [START],
      TO_COUNTDOWN,
      TO_STARTING,
      TO_PAUSED,
      TO_STOPPING,
      TO_COMPLETED,
    ]) {
      const state = run(path);
      const result = reduce(state, { type: 'PAUSE', at: 50 });
      expect(result.rejected, state.status).toBe(true);
      expect(result.state).toBe(state);
    }
  });

  it('resume when not paused is rejected', () => {
    for (const path of [[], TO_STARTING, TO_RECORDING, TO_STOPPING]) {
      const state = run(path);
      const result = reduce(state, { type: 'RESUME', at: 50 });
      expect(result.rejected, state.status).toBe(true);
      expect(result.state).toBe(state);
    }
  });

  it('source lost while paused stops the recording and keeps the paused time out', () => {
    const state = run([...TO_PAUSED, { type: 'SOURCE_LOST', at: 12_000 }]);
    expect(state.status).toBe('stopping');
    expect(state.stopReason).toBe('source-lost');
    expect(state.activeDurationMs).toBe(2000);
    expect(state.pausedAt).toBeNull();
    expect(state.error).toBeNull();
  });

  it('source lost while recording counts the time until the loss', () => {
    const state = run([...TO_RECORDING, { type: 'SOURCE_LOST', at: 4500 }]);
    expect(state).toMatchObject({
      status: 'stopping',
      stopReason: 'source-lost',
      activeDurationMs: 3500,
    });
  });

  it('source lost before recording started is an error, not a recording', () => {
    for (const path of [[START], TO_PREFLIGHT, TO_COUNTDOWN, TO_STARTING]) {
      const state = run([...path, { type: 'SOURCE_LOST', at: 1 }]);
      expect(state.status).toBe('error');
      expect(state.error?.code).toBe('SOURCE_LOST');
    }
  });

  it('write failure while recording stops it and keeps the reason', () => {
    const state = run([
      ...TO_RECORDING,
      { type: 'WRITE_FAILED', at: 3000, code: 'DISK_FULL', message: 'The disk is full.' },
    ]);
    expect(state).toMatchObject({
      status: 'stopping',
      stopReason: 'write-failed',
      activeDurationMs: 2000,
      error: { code: 'DISK_FULL', message: 'The disk is full.' },
    });
  });

  it('write failure while paused works the same and the final flush failing keeps the first error', () => {
    const stopping = run([
      ...TO_PAUSED,
      { type: 'WRITE_FAILED', at: 4000, code: 'WRITE_FAILED', message: 'first' },
    ]);
    expect(stopping.status).toBe('stopping');
    const later = run(
      [{ type: 'WRITE_FAILED', at: 4100, code: 'DISK_FULL', message: 'second' }],
      stopping,
    );
    expect(later.error?.message).toBe('first');
    expect(run([{ type: 'STOPPED' }, { type: 'FINALIZED' }], later).status).toBe('completed');
  });

  it('write failure while starting is an error', () => {
    const state = run([
      ...TO_STARTING,
      { type: 'WRITE_FAILED', at: 1, code: 'WRITE_FAILED', message: 'no' },
    ]);
    expect(state.status).toBe('error');
  });

  it('reset after completed returns to a clean idle state', () => {
    const state = run([...TO_COMPLETED, { type: 'RESET' }]);
    expect(state).toEqual(createInitialState());
  });

  it('reset after an error returns to a clean idle state', () => {
    const errored = run(TO_ERROR);
    expect(errored.error).toEqual({ code: 'X', message: 'broke' });
    expect(run([{ type: 'RESET' }], errored)).toEqual(createInitialState());
  });

  it('reset in idle is accepted and changes nothing; reset mid-recording is rejected', () => {
    expect(reduce(createInitialState(), { type: 'RESET' }).rejected).toBe(false);
    for (const path of [[START], TO_RECORDING, TO_PAUSED, TO_STOPPING, TO_PROCESSING]) {
      expect(reduce(run(path), { type: 'RESET' }).rejected).toBe(true);
    }
  });

  it('a new recording can start after completed and error (via RESET), with fresh state', () => {
    const second = run([
      ...TO_COMPLETED,
      { type: 'RESET' },
      { type: 'START_REQUESTED', sessionId: 's2' },
    ]);
    expect(second).toMatchObject({
      status: 'selecting',
      sessionId: 's2',
      activeDurationMs: 0,
      startedAt: null,
    });
  });

  it('cannot start twice, or start without a reset after a result', () => {
    expect(reduce(run([START]), START).rejected).toBe(true);
    expect(reduce(run(TO_RECORDING), START).rejected).toBe(true);
    expect(reduce(run(TO_COMPLETED), START).rejected).toBe(true);
    expect(reduce(run(TO_ERROR), START).rejected).toBe(true);
  });
});

describe('recorder machine: failure, mute and lost audio', () => {
  it('FAILED ends any active state in error', () => {
    for (const path of [
      [START],
      TO_PREFLIGHT,
      TO_COUNTDOWN,
      TO_STARTING,
      TO_RECORDING,
      TO_PAUSED,
      TO_STOPPING,
      TO_PROCESSING,
    ]) {
      const state = run([...path, { type: 'FAILED', code: 'E', message: 'm' }]);
      expect(state.status).toBe('error');
      expect(state.segmentStartedAt).toBeNull();
      expect(state.error).toEqual({ code: 'E', message: 'm' });
    }
  });

  it('FAILED is rejected in idle, completed and error', () => {
    for (const path of [[], TO_COMPLETED, TO_ERROR]) {
      expect(reduce(run(path), { type: 'FAILED', code: 'E', message: 'm' }).rejected).toBe(true);
    }
  });

  it('mute is part of the state and only for sources in the recording', () => {
    const recording = run(TO_RECORDING);
    const muted = run([{ type: 'MUTE_SET', source: 'mic', muted: true }], recording);
    expect(muted.muted).toEqual({ mic: true, system: false });
    expect(run([{ type: 'MUTE_SET', source: 'mic', muted: false }], muted).muted.mic).toBe(false);

    const micOnly = run([
      ...TO_STARTING,
      { type: 'STARTED', at: 1, wallClock: 1, audio: { mic: true, system: false } },
    ]);
    expect(reduce(micOnly, { type: 'MUTE_SET', source: 'system', muted: true }).rejected).toBe(
      true,
    );
  });

  it('mute works while paused and not after stopping', () => {
    expect(
      run([...TO_PAUSED, { type: 'MUTE_SET', source: 'system', muted: true }]).muted.system,
    ).toBe(true);
    expect(
      reduce(run(TO_STOPPING), { type: 'MUTE_SET', source: 'mic', muted: true }).rejected,
    ).toBe(true);
  });

  it('a lost source is marked, the recording goes on, and it can no longer be muted', () => {
    const state = run([...TO_RECORDING, { type: 'AUDIO_LOST', source: 'mic' }]);
    expect(state.status).toBe('recording');
    expect(state.lost).toEqual({ mic: true, system: false });
    expect(reduce(state, { type: 'MUTE_SET', source: 'mic', muted: true }).rejected).toBe(true);
    expect(run([{ type: 'STOP', at: 2000 }], state).status).toBe('stopping');
  });

  it('losing audio that was never recorded is rejected', () => {
    const noAudio = run([
      ...TO_STARTING,
      { type: 'STARTED', at: 1, wallClock: 1, audio: { mic: false, system: false } },
    ]);
    expect(reduce(noAudio, { type: 'AUDIO_LOST', source: 'mic' }).rejected).toBe(true);
  });

  it('STARTED resets mute and lost flags from an earlier session', () => {
    // A fresh START always begins from createInitialState, so nothing carries over.
    const second = run([
      ...TO_RECORDING,
      { type: 'MUTE_SET', source: 'mic', muted: true },
      { type: 'AUDIO_LOST', source: 'system' },
      { type: 'STOP', at: 2000 },
      { type: 'STOPPED' },
      { type: 'FINALIZED' },
      { type: 'RESET' },
      ...TO_RECORDING,
    ]);
    expect(second.muted).toEqual({ mic: false, system: false });
    expect(second.lost).toEqual({ mic: false, system: false });
  });
});

/** Which events each status accepts (everything else must be rejected). Written out on purpose. */
const ACCEPTED: Record<RecorderStatus, RecorderEventType[]> = {
  idle: ['START_REQUESTED', 'RESET'],
  selecting: ['SOURCE_SELECTED', 'CANCEL', 'STOP', 'FAILED', 'SOURCE_LOST'],
  preflight: ['PREFLIGHT_OK', 'PREFLIGHT_NEEDS_CHOICE', 'CANCEL', 'STOP', 'FAILED', 'SOURCE_LOST'],
  countdown: ['COUNTDOWN_DONE', 'CANCEL', 'STOP', 'FAILED', 'SOURCE_LOST'],
  starting: ['STARTED', 'CANCEL', 'STOP', 'FAILED', 'SOURCE_LOST', 'WRITE_FAILED'],
  recording: ['PAUSE', 'STOP', 'SOURCE_LOST', 'WRITE_FAILED', 'FAILED', 'MUTE_SET', 'AUDIO_LOST'],
  paused: ['RESUME', 'STOP', 'SOURCE_LOST', 'WRITE_FAILED', 'FAILED', 'MUTE_SET', 'AUDIO_LOST'],
  stopping: ['STOP', 'SOURCE_LOST', 'WRITE_FAILED', 'STOPPED', 'FAILED'],
  processing: ['STOP', 'FINALIZED', 'FAILED'],
  completed: ['STOP', 'RESET'],
  error: ['RESET'],
};

const SAMPLE: Record<RecorderEventType, RecorderEvent> = {
  START_REQUESTED: START,
  SOURCE_SELECTED: { type: 'SOURCE_SELECTED' },
  PREFLIGHT_OK: { type: 'PREFLIGHT_OK' },
  PREFLIGHT_NEEDS_CHOICE: { type: 'PREFLIGHT_NEEDS_CHOICE', choice: 'mic-denied' },
  COUNTDOWN_DONE: { type: 'COUNTDOWN_DONE' },
  STARTED: STARTED(2000),
  PAUSE: { type: 'PAUSE', at: 6000 },
  RESUME: { type: 'RESUME', at: 6000 },
  STOP: { type: 'STOP', at: 6000 },
  CANCEL: { type: 'CANCEL' },
  SOURCE_LOST: { type: 'SOURCE_LOST', at: 6000 },
  WRITE_FAILED: { type: 'WRITE_FAILED', at: 6000, code: 'WRITE_FAILED', message: 'm' },
  STOPPED: { type: 'STOPPED' },
  FINALIZED: { type: 'FINALIZED' },
  FAILED: { type: 'FAILED', code: 'E', message: 'm' },
  RESET: { type: 'RESET' },
  MUTE_SET: { type: 'MUTE_SET', source: 'mic', muted: true },
  AUDIO_LOST: { type: 'AUDIO_LOST', source: 'mic' },
};

const PATHS: Record<RecorderStatus, RecorderEvent[]> = {
  idle: [],
  selecting: [START],
  preflight: TO_PREFLIGHT,
  countdown: TO_COUNTDOWN,
  starting: TO_STARTING,
  recording: TO_RECORDING,
  paused: TO_PAUSED,
  stopping: TO_STOPPING,
  processing: TO_PROCESSING,
  completed: TO_COMPLETED,
  error: TO_ERROR,
};

describe('recorder machine: every event in every state', () => {
  it('has a path to every status', () => {
    for (const status of RECORDER_STATUSES) expect(run(PATHS[status]).status).toBe(status);
  });

  for (const status of RECORDER_STATUSES) {
    it(`${status}: accepts exactly ${ACCEPTED[status].join(', ')}`, () => {
      const state = run(PATHS[status]);
      for (const type of Object.keys(SAMPLE) as RecorderEventType[]) {
        const result = reduce(state, SAMPLE[type]);
        const accepted = ACCEPTED[status].includes(type);
        expect(result.rejected, `${type} in ${status}`).toBe(!accepted);
        if (!accepted) expect(result.state, `${type} in ${status}`).toBe(state);
      }
    });
  }

  it('never throws, whatever the order of events', () => {
    const types = Object.keys(SAMPLE) as RecorderEventType[];
    let seed = 12345;
    const next = (): number => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed;
    };
    for (let run = 0; run < 200; run += 1) {
      let state = createInitialState();
      for (let step = 0; step < 40; step += 1) {
        const type = types[next() % types.length] as RecorderEventType;
        state = reduce(state, SAMPLE[type]).state;
        expect(RECORDER_STATUSES).toContain(state.status);
        expect(state.activeDurationMs).toBeGreaterThanOrEqual(0);
      }
    }
  });
});

describe('recorder machine: status helpers', () => {
  it('classifies statuses', () => {
    expect(RECORDER_STATUSES.filter(isPreRecording)).toEqual([
      'selecting',
      'preflight',
      'countdown',
      'starting',
    ]);
    expect(RECORDER_STATUSES.filter(isFinished)).toEqual(['idle', 'completed', 'error']);
  });
});

describe('recorder machine: invariants under random event streams (seeded)', () => {
  /** Builds one event of a type, with the fields it needs (timestamps from a monotonic clock). */
  function make(type: RecorderEventType, random: () => number, at: number): RecorderEvent {
    const source = random() < 0.5 ? ('mic' as const) : ('system' as const);
    switch (type) {
      case 'START_REQUESTED':
        return { type, sessionId: `s${Math.floor(random() * 1e6)}` };
      case 'PREFLIGHT_NEEDS_CHOICE':
        return { type, choice: 'mic-denied' };
      case 'STARTED':
        return { type, at, wallClock: 1_700_000_000_000 + at, audio: BOTH };
      case 'PAUSE':
      case 'RESUME':
      case 'SOURCE_LOST':
        return { type, at };
      case 'STOP':
        return random() < 0.5 ? { type, at } : { type, at, reason: 'app-quit' };
      case 'WRITE_FAILED':
        return { type, at, code: 'DISK_FULL', message: 'm' };
      case 'FAILED':
        return { type, code: 'E', message: 'm' };
      case 'MUTE_SET':
        return { type, source, muted: random() < 0.5 };
      case 'AUDIO_LOST':
        return { type, source };
      default:
        return { type } as RecorderEvent;
    }
  }

  /**
   * Mostly an event the current status accepts (so runs get deep into a recording: pauses, stops,
   * failures), sometimes any event at all (which must be rejected without harm).
   */
  function randomEvent(
    random: () => number,
    clock: { now: number },
    status: RecorderStatus,
  ): RecorderEvent {
    clock.now += Math.floor(random() * 400);
    const all = Object.keys(SAMPLE) as RecorderEventType[];
    const accepted = ACCEPTED[status];
    // The terminal-ish events are rare among the accepted ones, or no run would last.
    const calm = accepted.filter(
      (type) =>
        !['STOP', 'CANCEL', 'FAILED', 'SOURCE_LOST', 'WRITE_FAILED', 'RESET'].includes(type),
    );
    const pool = random() < 0.12 ? all : random() < 0.85 && calm.length > 0 ? calm : accepted;
    return make(pool[Math.floor(random() * pool.length)] as RecorderEventType, random, clock.now);
  }

  it('holds the machine rules after every event of 600 random runs', () => {
    let seed = 987654321;
    const next = (): number => {
      seed = (seed * 1664525 + 1013904223) % 4294967296;
      return seed / 4294967296;
    };
    const reached = new Set<string>();
    for (let run = 0; run < 600; run += 1) {
      const clock = { now: 1000 };
      let state = createInitialState();
      let lastActive = 0;
      let lastSession: string | null = null;
      for (let step = 0; step < 60; step += 1) {
        const event = randomEvent(next, clock, state.status);
        const before = state;
        const result = reduce(before, event);
        state = result.state;
        reached.add(state.status);
        const where = `run ${run} step ${step}: ${event.type} in ${before.status}`;

        // A rejected event changes nothing at all (same object back).
        if (result.rejected) expect(state, where).toBe(before);

        // One session at a time: a session exists exactly while the status is not idle, and it
        // never changes except through a fresh START from idle.
        expect(state.sessionId === null, where).toBe(state.status === 'idle');
        if (
          event.type !== 'START_REQUESTED' &&
          state.status !== 'idle' &&
          before.status !== 'idle'
        ) {
          expect(state.sessionId, where).toBe(before.sessionId);
        }
        if (event.type === 'START_REQUESTED' && !result.rejected) {
          expect(before.status, where).toBe('idle');
          lastSession = state.sessionId;
          lastActive = 0;
        }
        if (result.rejected && event.type === 'START_REQUESTED') {
          expect(state.sessionId, `${where}: second start must not replace the session`).toBe(
            before.sessionId,
          );
        }
        expect(
          lastSession === null || state.status === 'idle' || state.sessionId === lastSession,
          where,
        ).toBe(true);

        // Durations are never negative and never run backwards within a session.
        expect(state.activeDurationMs, where).toBeGreaterThanOrEqual(0);
        const duration = activeDurationAt(state, clock.now);
        expect(duration, where).toBeGreaterThanOrEqual(0);
        // (An error state carries no recording, so its time restarts at zero by design.)
        if (state.status === 'error') lastActive = 0;
        else if (state.status !== 'idle') {
          expect(duration, `${where}: active time went backwards`).toBeGreaterThanOrEqual(
            lastActive,
          );
          lastActive = duration;
        }

        // The clock fields agree with the status.
        expect(state.segmentStartedAt !== null, where).toBe(state.status === 'recording');
        expect(state.pausedAt !== null, where).toBe(state.status === 'paused');
        // Mute and loss only ever concern sources that are part of the recording.
        for (const source of ['mic', 'system'] as const) {
          if (state.muted[source])
            expect(state.audio[source], `${where}: muted ${source}`).toBe(true);
          if (state.lost[source])
            expect(state.audio[source], `${where}: lost ${source}`).toBe(true);
        }
        // A finished recording keeps its result facts; an error always has its reason.
        if (state.status === 'error') expect(state.error, where).not.toBeNull();
        if (state.status === 'idle') expect(state.choice, where).toBeNull();
      }
    }
    // The runs were deep enough to mean something.
    for (const status of ['recording', 'paused', 'stopping', 'processing', 'completed', 'error'])
      expect(reached.has(status), `${status} was reached`).toBe(true);
  });
});
