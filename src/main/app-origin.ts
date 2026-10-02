import path from 'node:path';
import { fileURLToPath } from 'node:url';

export interface AppOriginConfig {
  /** Dev only: MAIN_WINDOW_VITE_DEV_SERVER_URL. Undefined in packaged / production-like builds. */
  devServerUrl?: string | undefined;
  /** Absolute path of the directory holding the built renderer (index.html and assets). */
  rendererDir: string;
}

/**
 * True when `url` belongs to the app's own UI: the Vite dev server origin in development, or a
 * file inside the built renderer directory otherwise. Everything else (other file paths, http(s),
 * about:blank, data:, ...) is rejected. Pure: no Electron imports, unit-testable.
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

  if (parsed.protocol !== 'file:') return false;
  let filePath: string;
  try {
    filePath = fileURLToPath(parsed);
  } catch {
    return false;
  }
  const relative = path.relative(path.resolve(config.rendererDir), path.resolve(filePath));
  return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative);
}

/**
 * The only network-scheme requests the app may ever make: its own dev server (development builds)
 * and nothing else. Framelet has no telemetry, uploads or remote content; anything with an
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

const ALLOWED_PERMISSIONS = new Set(['media', 'clipboard-sanitized-write']);

/**
 * Permission policy: only `media` and `clipboard-sanitized-write`, only for the app's own pages.
 * `media` is for the microphone: a request that includes `video` (camera) is denied, because the
 * MVP has no camera feature. Display capture is not a permission request; it is authorized by
 * session.setDisplayMediaRequestHandler (capture/authorization.ts).
 */
export function isPermissionAllowed(
  permission: string,
  requestingUrl: string | undefined | null,
  config: AppOriginConfig,
  mediaTypes?: readonly string[],
): boolean {
  if (!ALLOWED_PERMISSIONS.has(permission) || !isAppUrl(requestingUrl, config)) return false;
  if (permission === 'media' && mediaTypes?.includes('video')) return false;
  return true;
}
