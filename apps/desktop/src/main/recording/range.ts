export type ByteRange = { start: number; end: number };

/**
 * Parses an HTTP `Range` header for a file of `size` bytes. Returns the inclusive byte range,
 * `null` when there is no (usable) single range (serve the whole file), or `'unsatisfiable'`
 * (answer 416). Only a single `bytes=` range is supported, which is all <video> sends.
 */
export function parseRange(
  header: string | null,
  size: number,
): ByteRange | null | 'unsatisfiable' {
  if (!header) return null;
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!match) return null;
  const [, first = '', last = ''] = match;
  if (first === '' && last === '') return null;
  if (size <= 0) return 'unsatisfiable';
  if (first === '') {
    // Suffix: the last N bytes.
    const suffix = Number(last);
    if (suffix <= 0) return 'unsatisfiable';
    return { start: Math.max(0, size - suffix), end: size - 1 };
  }
  const start = Number(first);
  const end = last === '' ? size - 1 : Math.min(Number(last), size - 1);
  if (start >= size || end < start) return 'unsatisfiable';
  return { start, end };
}

/**
 * A byte window inside a file: the WebM payload of a `.fcap` (the bytes before it are FrameCapt's
 * own header and are never served).
 */
export interface PayloadWindow {
  offset: number;
  length: number;
}

export type MediaSlice =
  | { status: 416; contentRange: string }
  | {
      status: 200 | 206;
      /** First and last byte to read from the FILE (inclusive); the window's offset is already added. */
      start: number;
      end: number;
      length: number;
      /** `Content-Range` of a 206, in the coordinates the client sees (the payload's own). */
      contentRange: string | null;
    };

/**
 * What to answer for a `Range` header: the file itself, or only `window` of it (a `.fcap` payload,
 * offset-shifted so the client sees a file that starts at byte 0).
 */
export function planMediaSlice(
  rangeHeader: string | null,
  fileSize: number,
  window?: PayloadWindow,
): MediaSlice {
  const total = window ? window.length : fileSize;
  const base = window ? window.offset : 0;
  const range = parseRange(rangeHeader, total);
  if (range === 'unsatisfiable') return { status: 416, contentRange: `bytes */${total}` };
  const start = range?.start ?? 0;
  const end = range?.end ?? total - 1;
  return {
    status: range ? 206 : 200,
    start: base + start,
    end: base + end,
    length: total === 0 ? 0 : end - start + 1,
    contentRange: range ? `bytes ${start}-${end}/${total}` : null,
  };
}

const TYPES: Record<string, string> = {
  '.webm': 'video/webm',
  // A `.fcap` is served as its WebM payload only (see the media protocol).
  '.fcap': 'video/webm',
  '.mp4': 'video/mp4',
  '.mkv': 'video/x-matroska',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
};

export function mediaContentType(file: string): string {
  const dot = file.lastIndexOf('.');
  return TYPES[dot === -1 ? '' : file.slice(dot).toLowerCase()] ?? 'application/octet-stream';
}
