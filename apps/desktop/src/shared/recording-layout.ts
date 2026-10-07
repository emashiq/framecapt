import { z } from 'zod';
import type { Rect } from './rect';

/** A multi-source recording joins at most this many screens and windows into one picture. */
export const MAX_MULTI_SOURCES = 4;

/**
 * Where each source of a multi-source recording sits in the recorded picture. Names are generic
 * ("Screen 1", "Window 2"): window titles name documents and people and are never stored
 * (docs/security-review.md S-05).
 */
export const LayoutSourceSchema = z.strictObject({
  name: z.string().min(1).max(40),
  kind: z.enum(['screen', 'window']),
  /** The source's tile in the output picture, in pixels (even aligned). */
  rect: z.strictObject({
    x: z.number().int().min(0).max(16384),
    y: z.number().int().min(0).max(16384),
    width: z.number().int().min(2).max(16384),
    height: z.number().int().min(2).max(16384),
  }),
});
export type LayoutSource = z.infer<typeof LayoutSourceSchema>;

export const RecordingLayoutSchema = z.strictObject({
  width: z.number().int().min(2).max(16384),
  height: z.number().int().min(2).max(16384),
  sources: z.array(LayoutSourceSchema).min(1).max(MAX_MULTI_SOURCES),
});
export type RecordingLayout = z.infer<typeof RecordingLayoutSchema>;

/** "Screen 1", "Window 2": the generic name of the n-th (0-based) source. */
export function layoutSourceName(kind: 'screen' | 'window', index: number): string {
  return `${kind === 'screen' ? 'Screen' : 'Window'} ${index + 1}`;
}

/**
 * The crop of one source in the recorded picture (null when the index is out of range). The hook a
 * later editor uses to open one source of a `.fcap`; the extract job crops with it too.
 */
export function layoutSourceRect(
  layout: Pick<RecordingLayout, 'sources'>,
  index: number,
): Rect | null {
  const source = layout.sources[index];
  return source ? { ...source.rect } : null;
}

/** Where the WebM payload starts in a `.fcap` file (format version 1; see docs/recording-persistence.md). */
export const FCAP_PAYLOAD_OFFSET = 4096;
