import { segmentAtOrAfter, type Segment } from '../../../shared/video-edit';

/**
 * What playback does next. The video element plays the whole recording; the editor skips the cut
 * pieces and stops at the end of the trim, so what you watch is what an export contains.
 */
export type PlaybackStep =
  { kind: 'play' } | { kind: 'jump'; toMs: number } | { kind: 'stop'; atMs: number };

/** Called with the current source time while playing. */
export function playbackStep(segments: readonly Segment[], ms: number): PlaybackStep {
  const last = segments[segments.length - 1];
  if (!last) return { kind: 'stop', atMs: 0 };
  if (ms >= last.endMs) return { kind: 'stop', atMs: last.endMs };
  const segment = segmentAtOrAfter(segments, ms);
  if (!segment) return { kind: 'stop', atMs: last.endMs };
  if (ms < segment.startMs) return { kind: 'jump', toMs: segment.startMs };
  return { kind: 'play' };
}

/** Where pressing Play starts: here, or the next kept piece, or the beginning when at the end. */
export function playStart(segments: readonly Segment[], ms: number): number {
  const first = segments[0];
  const last = segments[segments.length - 1];
  if (!first || !last) return 0;
  if (ms >= last.endMs - 30) return first.startMs;
  const segment = segmentAtOrAfter(segments, ms);
  return segment ? Math.max(ms, segment.startMs) : first.startMs;
}

/**
 * One step of `deltaMs` (a frame, a second) from `ms`, kept inside the pieces that stay: it moves
 * over a cut to the other side and stops at the ends of the trim.
 */
export function stepTime(segments: readonly Segment[], ms: number, deltaMs: number): number {
  const first = segments[0];
  const last = segments[segments.length - 1];
  if (!first || !last) return 0;
  const target = ms + deltaMs;
  if (target <= first.startMs) return first.startMs;
  if (target >= last.endMs) return last.endMs;
  const inside = segments.find((segment) => target >= segment.startMs && target <= segment.endMs);
  if (inside) return target;
  // In a cut: land on the edge in the direction of travel.
  if (deltaMs > 0) return segmentAtOrAfter(segments, target)?.startMs ?? last.endMs;
  const before = [...segments].reverse().find((segment) => segment.endMs <= target);
  return before?.endMs ?? first.startMs;
}
