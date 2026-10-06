import fs from 'node:fs/promises';
import { protocol } from 'electron';
import { PROD_CSP } from '../shared/csp';
import { APP_SCHEME, resolveAppAsset } from './app-asset';
import { log } from './logger';
import { MEDIA_SCHEME_PRIVILEGES } from './recording/media-protocol';

/**
 * Registers every privileged scheme in one call (Electron allows it once, and only before
 * `app.whenReady()`): `app` (the production renderer) and `framecapt-media` (history media).
 */
export function registerPrivilegedSchemes(): void {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: APP_SCHEME,
      // standard + secure: a real origin (app://framecapt) with the secure-context APIs the capture
      // code needs (getDisplayMedia, MediaRecorder, clipboard). Nothing else: no CORS, no
      // fetch-API privilege (the renderer never fetches its own files), never bypassCSP.
      privileges: { standard: true, secure: true },
    },
    MEDIA_SCHEME_PRIVILEGES,
  ]);
}

const NOT_FOUND = (status: number): Response =>
  new Response(status === 400 ? 'Bad request' : 'Not found', {
    status,
    headers: { 'Content-Type': 'text/plain; charset=utf-8' },
  });

/**
 * Serves the built renderer at `app://framecapt/`. Only files inside `rendererDir` (in the asar of a
 * packaged build) with a known extension are ever returned; everything else is a 404 and never
 * reaches the filesystem (see resolveAppAsset). Call after `app.whenReady()`.
 */
export function registerAppProtocol(rendererDir: string): void {
  protocol.handle(APP_SCHEME, async (request) => {
    const resolved = resolveAppAsset(request.url, rendererDir);
    if (!resolved.ok) {
      log.warn(`app: request refused (${resolved.status})`);
      return NOT_FOUND(resolved.status);
    }
    try {
      const body = await fs.readFile(resolved.file);
      return new Response(new Uint8Array(body), {
        status: 200,
        headers: {
          'Content-Type': resolved.contentType,
          'Content-Security-Policy': PROD_CSP,
          'X-Content-Type-Options': 'nosniff',
          'Cache-Control': 'no-store',
        },
      });
    } catch {
      return NOT_FOUND(404);
    }
  });
}
