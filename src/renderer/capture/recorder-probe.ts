import {
  DEFAULT_PREFERENCE,
  pickDefaultFormat,
  RECORDER_CANDIDATES,
} from '../../shared/recorder-formats';

export interface RecorderFormats {
  /** MediaRecorder.isTypeSupported() for every candidate, in candidate order. */
  supported: Record<string, boolean>;
  /** First supported entry of the preference order (VP9 -> VP8 -> H.264 in WebM), or null. */
  defaultMime: string | null;
}

/** Probes the runtime; the result is what the recorder uses, never a hard-coded assumption. */
export function detectRecorderFormats(): RecorderFormats {
  const supported: Record<string, boolean> = {};
  for (const mime of RECORDER_CANDIDATES) {
    supported[mime] = typeof MediaRecorder !== 'undefined' && MediaRecorder.isTypeSupported(mime);
  }
  // E2E builds only: a hosted CI runner (one core, no GPU) cannot encode 1080p VP9 in real time.
  const preference = __FRAMECAPT_E2E__
    ? ['video/webm;codecs=vp8,opus', ...DEFAULT_PREFERENCE]
    : DEFAULT_PREFERENCE;
  return { supported, defaultMime: pickDefaultFormat(supported, preference) };
}
