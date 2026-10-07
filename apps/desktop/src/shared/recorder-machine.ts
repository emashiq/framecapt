/**
 * The recorder state machine. Pure (no Electron, no clock): main feeds it events with monotonic
 * timestamps and keeps the one authoritative state; every window only ever sees snapshots.
 *
 *   idle -> selecting -> preflight -> countdown -> starting -> recording <-> paused
 *        -> stopping -> processing -> completed | error
 *
 * The cancel paths (selecting, preflight, countdown, starting) return to idle. An event that is not
 * valid in the current state is rejected: the same state comes back with `rejected: true` and
 * nothing throws. STOP is idempotent once the recording is already ending.
 */

export const RECORDER_STATUSES = [
  'idle',
  'selecting',
  'preflight',
  'countdown',
  'starting',
  'recording',
  'paused',
  'stopping',
  'processing',
  'completed',
  'error',
] as const;
export type RecorderStatus = (typeof RECORDER_STATUSES)[number];

/** What preflight found that the user must decide about (see the audio rules in phase 05). */
export type PreflightChoiceKind =
  'system-audio-unavailable' | 'mic-missing' | 'mic-denied' | 'mic-unavailable' | 'camera-missing';

export type AudioSource = 'mic' | 'system';

export interface AudioFlags {
  mic: boolean;
  system: boolean;
}

/** Why a recording is ending, for the result and the log. */
export type StopReason = 'user' | 'source-lost' | 'write-failed' | 'engine-closed' | 'app-quit';

export interface RecorderError {
  code: string;
  message: string;
}

export interface RecorderMachineState {
  status: RecorderStatus;
  sessionId: string | null;
  /** Wall clock (epoch ms) of the moment recording started. */
  startedAt: number | null;
  /** Active recording time of all finished segments (paused time is never in here), ms. */
  activeDurationMs: number;
  /** Monotonic timestamp (ms) at which the running segment began; null unless recording. */
  segmentStartedAt: number | null;
  /** Monotonic timestamp (ms) of the current pause; null unless paused. */
  pausedAt: number | null;
  /** Failure (status error) or the reason a recording ended early (status completed). */
  error: RecorderError | null;
  stopReason: StopReason | null;
  /** Audio sources that are part of the recording (set when it starts). */
  audio: AudioFlags;
  /** Gain is 0 for these. */
  muted: AudioFlags;
  /** The device or track is gone; the recording goes on without it. */
  lost: AudioFlags;
  /** Set while preflight waits for the user's decision. */
  choice: PreflightChoiceKind | null;
}

export type RecorderEvent =
  | { type: 'START_REQUESTED'; sessionId: string }
  | { type: 'SOURCE_SELECTED' }
  | { type: 'PREFLIGHT_OK' }
  | { type: 'PREFLIGHT_NEEDS_CHOICE'; choice: PreflightChoiceKind }
  | { type: 'COUNTDOWN_DONE' }
  | { type: 'STARTED'; at: number; wallClock: number; audio: AudioFlags }
  | { type: 'PAUSE'; at: number }
  | { type: 'RESUME'; at: number }
  | { type: 'STOP'; at: number; reason?: StopReason }
  | { type: 'CANCEL' }
  | { type: 'SOURCE_LOST'; at: number; code?: string; message?: string }
  | { type: 'WRITE_FAILED'; at: number; code: string; message: string }
  /** Extra to the brief's list: the engine has flushed its last chunk (stopping -> processing). */
  | { type: 'STOPPED' }
  | { type: 'FINALIZED' }
  | { type: 'FAILED'; code: string; message: string }
  | { type: 'RESET' }
  /** Extra: a mute toggle (part of the recorder state). */
  | { type: 'MUTE_SET'; source: AudioSource; muted: boolean }
  /** Extra: a microphone or system audio track ended (device unplugged, source closed). */
  | { type: 'AUDIO_LOST'; source: AudioSource };

export type RecorderEventType = RecorderEvent['type'];

export interface ReduceResult {
  state: RecorderMachineState;
  /** True when the event is not valid in the current state; `state` is then unchanged. */
  rejected: boolean;
}

const NO_AUDIO: AudioFlags = { mic: false, system: false };

export function createInitialState(): RecorderMachineState {
  return {
    status: 'idle',
    sessionId: null,
    startedAt: null,
    activeDurationMs: 0,
    segmentStartedAt: null,
    pausedAt: null,
    error: null,
    stopReason: null,
    audio: { ...NO_AUDIO },
    muted: { ...NO_AUDIO },
    lost: { ...NO_AUDIO },
    choice: null,
  };
}

/** Statuses before the recording exists: STOP and CANCEL mean "never mind". */
const PRE_RECORDING: readonly RecorderStatus[] = [
  'selecting',
  'preflight',
  'countdown',
  'starting',
];

export function isPreRecording(status: RecorderStatus): boolean {
  return PRE_RECORDING.includes(status);
}

/** True while a recorder command may start something new (idle or showing a finished outcome). */
export function isFinished(status: RecorderStatus): boolean {
  return status === 'idle' || status === 'completed' || status === 'error';
}

/** Active recording time at monotonic time `now`: finished segments plus the running one. */
export function activeDurationAt(state: RecorderMachineState, now: number): number {
  const running = state.segmentStartedAt === null ? 0 : Math.max(0, now - state.segmentStartedAt);
  return state.activeDurationMs + running;
}

const reject = (state: RecorderMachineState): ReduceResult => ({ state, rejected: true });
const accept = (state: RecorderMachineState): ReduceResult => ({ state, rejected: false });
const noop = (state: RecorderMachineState): ReduceResult => accept(state);

/** Closes the running segment at `at` (no-op when none is running). */
function closeSegment(state: RecorderMachineState, at: number): RecorderMachineState {
  if (state.segmentStartedAt === null) return state;
  return {
    ...state,
    activeDurationMs: state.activeDurationMs + Math.max(0, at - state.segmentStartedAt),
    segmentStartedAt: null,
  };
}

function toIdle(): ReduceResult {
  return accept(createInitialState());
}

function toError(state: RecorderMachineState, code: string, message: string): ReduceResult {
  return accept({
    ...state,
    status: 'error',
    segmentStartedAt: null,
    pausedAt: null,
    choice: null,
    error: { code, message },
  });
}

function stopping(
  state: RecorderMachineState,
  at: number,
  reason: StopReason,
  error?: RecorderError,
): ReduceResult {
  return accept({
    ...closeSegment(state, at),
    status: 'stopping',
    pausedAt: null,
    stopReason: reason,
    error: error ?? state.error,
  });
}

/** The one transition function. Never throws; invalid events are rejected. */
export function reduce(state: RecorderMachineState, event: RecorderEvent): ReduceResult {
  switch (state.status) {
    case 'idle':
      if (event.type === 'START_REQUESTED') {
        return accept({ ...createInitialState(), status: 'selecting', sessionId: event.sessionId });
      }
      if (event.type === 'RESET') return noop(state);
      return reject(state);

    case 'selecting':
    case 'preflight':
    case 'countdown':
    case 'starting':
      return reducePreRecording(state, event);

    case 'recording':
    case 'paused':
      return reduceRecording(state, event);

    case 'stopping':
      switch (event.type) {
        case 'STOP':
        case 'SOURCE_LOST':
          return noop(state);
        case 'WRITE_FAILED':
          // The final flush failed: the file is shorter than the recording. Say so.
          return accept({
            ...state,
            error: state.error ?? { code: event.code, message: event.message },
          });
        case 'STOPPED':
          return accept({ ...state, status: 'processing' });
        case 'FAILED':
          return toError(state, event.code, event.message);
        default:
          return reject(state);
      }

    case 'processing':
      switch (event.type) {
        case 'STOP':
          return noop(state);
        case 'FINALIZED':
          return accept({ ...state, status: 'completed' });
        case 'FAILED':
          return toError(state, event.code, event.message);
        default:
          return reject(state);
      }

    case 'completed':
      if (event.type === 'STOP') return noop(state);
      if (event.type === 'RESET') return toIdle();
      return reject(state);

    case 'error':
      if (event.type === 'RESET') return toIdle();
      return reject(state);
  }
}

function reducePreRecording(state: RecorderMachineState, event: RecorderEvent): ReduceResult {
  switch (event.type) {
    case 'CANCEL':
    case 'STOP':
      return toIdle();
    case 'FAILED':
      return toError(state, event.code, event.message);
    case 'SOURCE_LOST':
      return toError(state, event.code ?? 'SOURCE_LOST', event.message ?? 'The source went away.');
    case 'SOURCE_SELECTED':
      return state.status === 'selecting'
        ? accept({ ...state, status: 'preflight' })
        : reject(state);
    case 'PREFLIGHT_NEEDS_CHOICE':
      return state.status === 'preflight'
        ? accept({ ...state, choice: event.choice })
        : reject(state);
    case 'PREFLIGHT_OK':
      return state.status === 'preflight'
        ? accept({ ...state, status: 'countdown', choice: null })
        : reject(state);
    case 'COUNTDOWN_DONE':
      return state.status === 'countdown'
        ? accept({ ...state, status: 'starting' })
        : reject(state);
    case 'STARTED':
      return state.status === 'starting'
        ? accept({
            ...state,
            status: 'recording',
            startedAt: event.wallClock,
            activeDurationMs: 0,
            segmentStartedAt: event.at,
            audio: { ...event.audio },
            muted: { ...NO_AUDIO },
            lost: { ...NO_AUDIO },
          })
        : reject(state);
    case 'WRITE_FAILED':
      return state.status === 'starting'
        ? toError(state, event.code, event.message)
        : reject(state);
    default:
      return reject(state);
  }
}

function reduceRecording(state: RecorderMachineState, event: RecorderEvent): ReduceResult {
  const recording = state.status === 'recording';
  switch (event.type) {
    case 'PAUSE':
      return recording
        ? accept({
            ...closeSegment(state, event.at),
            status: 'paused',
            pausedAt: event.at,
          })
        : reject(state);
    case 'RESUME':
      return recording
        ? reject(state)
        : accept({ ...state, status: 'recording', pausedAt: null, segmentStartedAt: event.at });
    case 'STOP':
      return stopping(state, event.at, event.reason ?? 'user');
    case 'SOURCE_LOST':
      return stopping(state, event.at, 'source-lost');
    case 'WRITE_FAILED':
      return stopping(state, event.at, 'write-failed', {
        code: event.code,
        message: event.message,
      });
    case 'FAILED':
      return toError(state, event.code, event.message);
    case 'MUTE_SET':
      return state.audio[event.source] && !state.lost[event.source]
        ? accept({ ...state, muted: { ...state.muted, [event.source]: event.muted } })
        : reject(state);
    case 'AUDIO_LOST':
      return state.audio[event.source]
        ? accept({ ...state, lost: { ...state.lost, [event.source]: true } })
        : reject(state);
    default:
      return reject(state);
  }
}
