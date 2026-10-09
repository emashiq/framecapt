import { isFinished, isPreRecording, type RecorderStatus } from './recorder-machine';

/**
 * Several recordings at once, as pure rules (no Electron): how many may run, which one the
 * "single recording" UI (result view, tray, shortcuts) follows, and who owns the resources that
 * cannot be shared (system audio, the camera bubble). Lists are in start order, oldest first.
 */

export const MAX_CONCURRENT_RECORDINGS = 3;

export const SYSTEM_AUDIO_BUSY_MESSAGE =
  'System audio is already being recorded by another recording.';
export const CAMERA_BUSY_MESSAGE = 'The camera is already used by another recording.';

interface HasStatus {
  status: RecorderStatus;
}

/** Recording or paused. */
export function isLiveStatus(status: RecorderStatus): boolean {
  return status === 'recording' || status === 'paused';
}

/** Stopping or saving the file. */
export function isFinishingStatus(status: RecorderStatus): boolean {
  return status === 'stopping' || status === 'processing';
}

/** Anything between the request and the end of the file: it takes a slot and its resources. */
export function isActiveStatus(status: RecorderStatus): boolean {
  return status !== 'idle' && !isFinished(status);
}

/**
 * A new recording may start: fewer than the maximum are active, and none is still starting (the
 * selection overlays, the countdown and the toolbar placement belong to one start-up at a time).
 */
export function canStart(sessions: readonly HasStatus[]): boolean {
  const active = sessions.filter((session) => isActiveStatus(session.status));
  return (
    active.length < MAX_CONCURRENT_RECORDINGS &&
    !active.some((session) => isPreRecording(session.status))
  );
}

/**
 * The recording the single-recording UI follows: the one in start-up, else the newest live one,
 * else the newest that is finishing, else the newest with a result (or error) not yet reset.
 */
export function primaryOf<T extends HasStatus>(sessions: readonly T[]): T | undefined {
  const newest = (match: (status: RecorderStatus) => boolean): T | undefined =>
    [...sessions].reverse().find((session) => match(session.status));
  return (
    newest(isPreRecording) ??
    newest(isLiveStatus) ??
    newest(isFinishingStatus) ??
    newest((status) => status === 'completed' || status === 'error')
  );
}

/**
 * System audio belongs to the first recording that asked for it (two loopback captures would
 * play every sound twice): a later one asking while it is held gets it dropped.
 */
export function allocateSystemAudio(
  sessions: readonly (HasStatus & { systemAudio: boolean })[],
  requested: boolean,
): { systemAudio: boolean; dropped: boolean } {
  const held = sessions.some((session) => isActiveStatus(session.status) && session.systemAudio);
  return held && requested
    ? { systemAudio: false, dropped: true }
    : { systemAudio: requested, dropped: false };
}

/** The camera bubble has one owner: a later recording asking for it while it is shown is refused. */
export function allocateCamera(
  sessions: readonly (HasStatus & { camera: boolean })[],
  requested: boolean,
): { camera: boolean; dropped: boolean } {
  const held = sessions.some((session) => isActiveStatus(session.status) && session.camera);
  return held && requested
    ? { camera: false, dropped: true }
    : { camera: requested, dropped: false };
}
