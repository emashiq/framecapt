/** MediaRecorder MIME candidates probed at runtime (see recorder-probe.ts). */
export const RECORDER_CANDIDATES = [
  'video/webm;codecs=vp9,opus',
  'video/webm;codecs=vp8,opus',
  'video/webm;codecs=av1,opus',
  'video/webm;codecs=h264,opus',
  'video/mp4;codecs=avc1,mp4a.40.2',
  'video/x-matroska;codecs=avc1,opus',
] as const;

/**
 * Default preference, best first: VP9 -> VP8 -> H.264 in WebM. WebM is the reliable, streamable
 * container for incremental persistence; mp4/mkv/av1 are probed and reported but never chosen as
 * the default (MP4 is produced later by a tested FFmpeg conversion, never by renaming).
 */
export const DEFAULT_PREFERENCE: readonly string[] = [
  'video/webm;codecs=vp9,opus',
  'video/webm;codecs=vp8,opus',
  'video/webm;codecs=h264,opus',
];

/** Picks the first preferred MIME type that the runtime reports as supported, or null. */
export function pickDefaultFormat(
  support: Readonly<Record<string, boolean>>,
  preference: readonly string[] = DEFAULT_PREFERENCE,
): string | null {
  return preference.find((mime) => support[mime] === true) ?? null;
}
