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

const TYPES: Record<string, string> = {
  '.webm': 'video/webm',
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
