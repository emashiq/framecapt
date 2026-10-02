import path from 'node:path';

/**
 * The production renderer is served from a privileged custom scheme, `app://framelet/`, instead of
 * file:// (ADR-033). That lets the GrantFileProtocolExtraPrivileges fuse stay off: nothing loads
 * from file:// any more. This module is the pure part: names, MIME types and the URL -> file
 * resolver with strict containment. No Electron imports, so it is unit-tested directly.
 */
export const APP_SCHEME = 'app';
export const APP_HOST = 'framelet';
export const APP_ORIGIN = `${APP_SCHEME}://${APP_HOST}`;
/** Production windows load this document; the window role is the location hash. */
export const APP_ENTRY_URL = `${APP_ORIGIN}/index.html`;

/** The only file types the built renderer contains. Anything else is a 404, whatever exists on disk. */
const MIME_TYPES: Readonly<Record<string, string>> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.json': 'application/json; charset=utf-8',
};

export type AppAssetResult =
  { ok: true; file: string; contentType: string } | { ok: false; status: 400 | 404 };

/**
 * Maps an `app://framelet/<path>` URL to a file inside `rendererDir`, or says why not. Rejected
 * (never resolved): another scheme or host, a port or credentials, `..` or `.` segments (also
 * percent-encoded, even doubly encoded), backslashes, NUL, drive letters / `:`, empty segments
 * (`//`), unknown extensions, and any result that does not stay inside `rendererDir`.
 * The query and the hash are ignored (the hash carries the window role).
 */
export function resolveAppAsset(url: string, rendererDir: string): AppAssetResult {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { ok: false, status: 400 };
  }
  if (
    parsed.protocol !== `${APP_SCHEME}:` ||
    parsed.hostname.toLowerCase() !== APP_HOST ||
    parsed.port !== '' ||
    parsed.username !== '' ||
    parsed.password !== ''
  ) {
    return { ok: false, status: 404 };
  }

  // Inspect the path as it was written, not as the URL parser folded it: the parser silently turns
  // "/a/../x" and "/%2e%2e/x" into "/x", which would hide a traversal attempt.
  const written = url.replace(/^[a-z][a-z0-9+.-]*:\/\/[^/?#]*/i, '').split(/[?#]/)[0] ?? '';
  const rawPath = written === '' || written === '/' ? '/index.html' : written;
  // Decode twice, so a double-encoded traversal cannot survive either, and inspect what is left.
  let decoded: string;
  try {
    decoded = decodeURIComponent(decodeURIComponent(rawPath));
  } catch {
    return { ok: false, status: 400 };
  }
  if (decoded.includes('\\') || decoded.includes('\0') || decoded.includes(':')) {
    return { ok: false, status: 400 };
  }
  const segments = decoded.split('/').slice(1); // the path starts with "/"
  if (segments.length === 0 || segments.some((s) => s === '' || s === '.' || s === '..')) {
    return { ok: false, status: 400 };
  }

  const contentType = MIME_TYPES[path.extname(segments[segments.length - 1] ?? '').toLowerCase()];
  if (!contentType) return { ok: false, status: 404 };

  const root = path.resolve(rendererDir);
  const file = path.resolve(root, ...segments);
  const relative = path.relative(root, file);
  if (relative === '' || relative.startsWith('..') || path.isAbsolute(relative)) {
    return { ok: false, status: 400 };
  }
  return { ok: true, file, contentType };
}
