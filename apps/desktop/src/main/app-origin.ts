import type { Role } from '../shared/types';
import { APP_HOST, APP_SCHEME } from './app-asset';

export interface AppOriginConfig {
  /** Dev only: MAIN_WINDOW_VITE_DEV_SERVER_URL. Undefined in packaged / production-like builds. */
  devServerUrl?: string | undefined;
}

/**
 * True when `url` belongs to the app's own UI: the Vite dev server origin in development, or the
 * `app://framecapt` origin (the built renderer, served by app-protocol.ts) otherwise. Everything
 * else (file://, http(s), about:blank, data:, other hosts of the app scheme, ...) is rejected.
 * Pure: no Electron imports, unit-testable.
 */
export function isAppUrl(url: string | undefined | null, config: AppOriginConfig): boolean {
  if (!url) return false;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }

  if (config.devServerUrl) {
    try {
      return parsed.origin !== 'null' && parsed.origin === new URL(config.devServerUrl).origin;
    } catch {
      return false;
    }
  }

  return (
    parsed.protocol === `${APP_SCHEME}:` &&
    parsed.hostname.toLowerCase() === APP_HOST &&
    parsed.port === '' &&
    parsed.username === '' &&
    parsed.password === ''
  );
}

/**
 * The only network-scheme requests the app may ever make: its own dev server (development builds)
 * and nothing else. FrameCapt has no telemetry, uploads or remote content; anything with an
 * http(s), ws(s) or ftp scheme is cancelled in the session (defence in depth behind the CSP).
 */
export function isNetworkRequestAllowed(url: string, config: AppOriginConfig): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (!config.devServerUrl) return false;
  try {
    const dev = new URL(config.devServerUrl);
    const sameHost = parsed.host === dev.host;
    const schemes = dev.protocol === 'https:' ? ['https:', 'wss:'] : ['http:', 'ws:'];
    return sameHost && schemes.includes(parsed.protocol);
  } catch {
    return false;
  }
}

const ALLOWED_PERMISSIONS = new Set(['media', 'clipboard-sanitized-write', 'fullscreen']);

/**
 * Windows whose pages may go fullscreen (the History video player's fullscreen button). Add the
 * editor role here when it exists; the capture overlays, toolbar and camera never need it.
 */
const FULLSCREEN_ROLES: readonly Role[] = ['main', 'editor'];

/** Windows that may ask for the camera (getUserMedia video): the recorder and the camera bubble. */
const CAMERA_REQUEST_ROLES: readonly Role[] = ['recorder', 'camera'];
/** Windows that may see camera device labels (a permission check): those above, and the main window's Settings. */
const CAMERA_CHECK_ROLES: readonly Role[] = ['main', 'recorder', 'camera'];

/**
 * Permission policy: only `media`, `clipboard-sanitized-write` and `fullscreen` (main window only),
 * only for the app's own pages.
 * `media` is the microphone for every app page. Video (the camera) depends on the window: a
 * request (getUserMedia) only from the recorder and camera windows, a check (device labels in
 * enumerateDevices) also from the main window. Display capture is not a permission request; it is
 * granted by session.setDisplayMediaRequestHandler (capture/display-media.ts).
 */
export function isPermissionAllowed(
  permission: string,
  requestingUrl: string | undefined | null,
  config: AppOriginConfig,
  mediaTypes?: readonly string[],
  role?: Role,
  mode: 'request' | 'check' = 'request',
): boolean {
  if (!ALLOWED_PERMISSIONS.has(permission) || !isAppUrl(requestingUrl, config)) return false;
  if (permission === 'fullscreen') return role !== undefined && FULLSCREEN_ROLES.includes(role);
  if (permission === 'media' && mediaTypes?.includes('video')) {
    const roles = mode === 'request' ? CAMERA_REQUEST_ROLES : CAMERA_CHECK_ROLES;
    return role !== undefined && roles.includes(role);
  }
  return true;
}
