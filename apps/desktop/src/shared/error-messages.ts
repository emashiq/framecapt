import type { IpcErrorCode } from './types';

/**
 * Friendly copy for every typed error code the app can show, each with a next step. One place, so
 * the same failure reads the same in a toast, a banner and a tray notification. Codes come from
 * IPC failures, the recorder and its start-up, the media tools (export, remux) and the capture
 * layer; the unit test scans the sources so a new code cannot be added without copy.
 */

interface Entry {
  /** What happened and what to do next. */
  text: string;
  /** The server message is specific enough to lead ("That window is no longer available."). */
  keepServerText?: true;
  /** Appended after a kept server message. */
  next?: string;
}

const RESTART = 'Try again; if it keeps happening, restart FrameCapt.';
const DISK =
  'Your disk is almost full. Free up space or choose another folder in Settings → Recording.';
const KEPT = 'What was recorded so far was kept.';

const ENTRIES = {
  // IPC
  FORBIDDEN: { text: `FrameCapt blocked that request. ${RESTART}` },
  INVALID_PAYLOAD: {
    text: `That request wasn't valid. ${RESTART}`,
    keepServerText: true,
    next: 'Try again.',
  },
  UNKNOWN_CHANNEL: { text: `Something went wrong inside FrameCapt. ${RESTART}` },
  NOT_FOUND: {
    text: 'That item is no longer available. Refresh the list and try again.',
    keepServerText: true,
    next: 'Refresh and try again.',
  },
  BUSY: {
    text: 'Another capture or recording is already running. Finish or cancel it first.',
  },
  INTERNAL: { text: `Something went wrong inside FrameCapt. ${RESTART}` },
  SEQ_GAP: {
    text: `The recording data arrived out of order, so it was stopped. ${KEPT} FrameCapt will offer to recover it.`,
  },
  DUPLICATE_MISMATCH: {
    text: `The recording data was inconsistent, so it was stopped. ${KEPT} FrameCapt will offer to recover it.`,
  },
  CHUNK_TOO_LARGE: {
    text: `The recorder produced more data than FrameCapt accepts at once, so the recording was stopped. ${KEPT} Try a lower quality.`,
  },
  SESSION_INACTIVE: {
    text: `That recording is no longer active. ${KEPT} Start a new recording when you are ready.`,
  },
  WRITE_FAILED: {
    text: `FrameCapt couldn't write the recording to disk. ${KEPT} Check the folder and free space in Settings → Recording, then try again.`,
  },
  DISK_FULL: { text: DISK },
  LOW_DISK: { text: DISK },
  DISK_LOW: { text: DISK },
  FFMPEG_MISSING: {
    text: "FrameCapt's video tools are missing, so recordings can't be finished. Reinstall FrameCapt.",
    keepServerText: true,
    next: 'Reinstall FrameCapt if this keeps happening.',
  },
  FINALIZE_FAILED: {
    text: `The recording couldn't be finished. ${KEPT} FrameCapt will offer to recover it the next time it starts.`,
  },
  OUTPUT_DIR_UNWRITABLE: {
    text: "FrameCapt can't save to that folder. Choose a folder you can write to (Settings → Storage).",
  },
  // Recorder and its start-up
  SOURCE_MISSING: {
    text: 'That screen or window is no longer available. Pick it again.',
  },
  SOURCE_LOST: {
    text: `The recorded screen or window went away. ${KEPT}`,
  },
  DISPLAYS_CHANGED: { text: 'Your screens changed — please try again.' },
  WORKER_TIMEOUT: { text: `Capturing took too long. ${RESTART}` },
  WORKER_CLOSED: { text: `The capture engine closed unexpectedly. ${RESTART}` },
  WORKER_BAD_RESULT: { text: `The capture engine returned something unexpected. ${RESTART}` },
  ENGINE_CLOSED: { text: `The recorder closed unexpectedly. ${KEPT} ${RESTART}` },
  ENGINE_TIMEOUT: { text: `The recorder didn't answer in time. ${RESTART}` },
  ENGINE_LOST: {
    text: `The recorder stopped unexpectedly. ${KEPT} The recording may be incomplete.`,
  },
  PREPARE_FAILED: {
    text: "Recording couldn't start. Check that the screen or window is still visible, then try again.",
  },
  START_FAILED: {
    text: "Recording couldn't start. Check that the screen or window is still visible, then try again.",
  },
  CAPTURE_FAILED: { text: 'Could not capture the screen. Try again.' },
  TOO_LARGE: {
    text: 'Your screens together are too large for one image. Capture them one at a time.',
    keepServerText: true,
  },
  WINDOW_UNAVAILABLE: {
    text: "That window is minimized or can't be captured. Restore it and try again.",
  },
  QUEUE_OVERFLOW: {
    text: `The disk couldn't keep up with the recording, so it was stopped. ${KEPT} Try a lower quality or another folder.`,
  },
  UPLOAD_FAILED: {
    text: `The recording couldn't be written, so it was stopped. ${KEPT} Check free space and try again.`,
  },
  RECORDER_ERROR: {
    text: `The recorder stopped unexpectedly. ${KEPT} The recording may be incomplete.`,
  },
  CANCELLED: { text: 'Cancelled.' },
  ALREADY_RECORDING: { text: 'A recording is already running. Stop it first.' },
  NOT_RECORDING: { text: 'There is no recording to stop.' },
  NOT_PREPARED: { text: `The recorder wasn't ready. ${RESTART}` },
  NO_VIDEO: { text: 'There was no picture to record. Make sure the screen or window is visible.' },
  // Media tools: export, remux, recovery
  REMUX_FAILED: {
    text: `The recording couldn't be repaired. ${KEPT} FrameCapt will offer to try again the next time it starts.`,
  },
  UNREPAIRABLE: {
    text: `The recording couldn't be recovered. The raw data was kept in the recordings folder.`,
  },
  MANIFEST_CORRUPT: {
    text: `The record of this recording was unreadable. The raw data was kept in the recordings folder.`,
  },
  ABORTED: { text: 'Finishing was interrupted. FrameCapt will finish it the next time it starts.' },
  FFMPEG_ABORTED: { text: 'Cancelled. Your recording was not changed.' },
  FFMPEG_FAILED: {
    text: "The video couldn't be converted. Your recording was not changed. Try again.",
  },
  FFMPEG_TIMEOUT: {
    text: 'The conversion took too long and was stopped. Your recording was not changed.',
  },
  PROBE_FAILED: { text: "FrameCapt couldn't read that video. Check that the file still exists." },
  VERIFY_FAILED: {
    text: "The converted video didn't pass FrameCapt's check, so it was not kept. Your recording was not changed. Try again.",
  },
  FAILED: { text: "The video couldn't be converted. Your recording was not changed. Try again." },
  TIMEOUT: {
    text: 'The conversion took too long and was stopped. Your recording was not changed.',
  },
  INVALID_DESTINATION: { text: 'Choose a different file name ending in .mp4.' },
  SOURCE_UNREADABLE: {
    text: "FrameCapt couldn't read the recording. Check that the file still exists.",
  },
  // Capture layer (renderer)
  denied: { text: 'Windows or FrameCapt refused the capture. Try again.' },
  cancelled: { text: 'Cancelled.' },
  'source-gone': { text: 'That screen or window is no longer available. Pick it again.' },
  'system-audio-unavailable': {
    text: "System audio isn't available. Record without it, or check your Windows sound settings.",
  },
  unknown: { text: `Capturing failed. ${RESTART}` },
} as const satisfies Record<string, Entry>;

export type KnownErrorCode = keyof typeof ENTRIES;
export const KNOWN_ERROR_CODES = Object.keys(ENTRIES) as KnownErrorCode[];

/** Compile-time check: every IPC error code has copy. */
type MissingIpcCopy = Exclude<IpcErrorCode, KnownErrorCode>;
const _allIpcCodesHaveCopy: MissingIpcCopy extends never ? true : never = true;
void _allIpcCodesHaveCopy;

export function isKnownErrorCode(code: string | undefined): code is KnownErrorCode {
  return code !== undefined && Object.hasOwn(ENTRIES, code);
}

/**
 * The text to show for a failure: the friendly copy for its code. Where main's own message is more
 * specific it leads and the next step follows. Unknown codes show main's message, or a generic line.
 */
export function friendlyError(code: string | undefined, serverMessage?: string): string {
  if (!isKnownErrorCode(code)) return serverMessage?.trim() || `Something went wrong. ${RESTART}`;
  const entry: Entry = ENTRIES[code];
  const server = serverMessage?.trim();
  if (entry.keepServerText && server) {
    return entry.next ? `${server} ${entry.next}` : server;
  }
  return entry.text;
}
