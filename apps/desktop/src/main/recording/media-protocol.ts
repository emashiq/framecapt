import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import { Readable } from 'node:stream';
import { protocol } from 'electron';
import { HISTORY_ID_PATTERN } from '../../shared/history-ipc';
import { log } from '../logger';
import { mediaContentType, parseRange } from './range';

export const MEDIA_SCHEME = 'framecapt-media';

/** Files FrameCapt itself produced, by an unguessable id. The protocol serves nothing else. */
export class MediaRegistry {
  private readonly files = new Map<string, string>();

  register(file: string): string {
    const id = randomUUID();
    this.files.set(id, file);
    return id;
  }

  resolve(id: string): string | undefined {
    return this.files.get(id);
  }
}

/**
 * Privileges of the `framecapt-media` scheme, registered with the other schemes in one call
 * (registerPrivilegedSchemes in app-protocol.ts, before `app.whenReady()`).
 */
export const MEDIA_SCHEME_PRIVILEGES: Electron.CustomScheme = {
  scheme: MEDIA_SCHEME,
  // standard + secure: media elements and the CSP treat it like a normal origin. stream: media
  // playback may stream the response. Nothing else: no fetch API (pages only load it through
  // <img> and <video>), no CORS, and never bypassCSP.
  privileges: { standard: true, secure: true, stream: true },
};

/** What history lets the protocol serve: its own thumbnails and the files it lists. */
export interface HistoryMedia {
  thumbPathOf(id: string): string | undefined;
  filePathOf(id: string): string | undefined;
  /** The PNG of step `index` of a guide in history; undefined for an unknown guide or step. */
  flowStepPathOf?(id: string, index: number): string | undefined;
}

/**
 * Sent with EVERY response, errors included. A 404 without it can be remembered by the media
 * element's URL cache, and the same URL (a history id keeps its URL when a file is re-linked or an
 * entry is restored) would then keep failing without ever asking main again.
 */
const NO_STORE = { 'Cache-Control': 'no-store' };

/**
 * `/<history id>`, optionally followed by one `/<nonce>` of lowercase letters and digits. The nonce
 * is ignored: it only lets the page give every <video>/<img> load its own URL, because the media
 * stack remembers a failed load per URL (a file that was missing, an entry that was removed and
 * restored) and would otherwise fail again without asking main.
 */
const HISTORY_ROUTE = new RegExp(
  '^/(' + HISTORY_ID_PATTERN.source.slice(1, -1) + ')(?:/[0-9a-z]{1,24})?$',
);

/**
 * `/<history id>/<step index>`, optionally followed by one `/<nonce>` (the same cache-busting
 * segment). The index is one to three digits; main checks it against the guide's own step list.
 */
const FLOW_STEP_ROUTE = new RegExp(
  '^/(' + HISTORY_ID_PATTERN.source.slice(1, -1) + ')/(\\d{1,3})(?:/[0-9a-z]{1,24})?$',
);

/**
 * The file a `framecapt-media:` URL names, or undefined. Exactly four shapes exist and nothing
 * else resolves: `//<registry id>` (a recording of this run), `//thumb/<history id>` (a history
 * thumbnail), `//file/<history id>` (the file of a history item) and
 * `//flowstep/<history id>/<index>` (one step image of a step guide), each history route with an
 * optional cache-busting nonce segment. No query, no other segments, no paths.
 */
export function resolveMediaUrl(
  url: URL,
  registry: MediaRegistry,
  history?: HistoryMedia,
): string | undefined {
  if (url.search !== '' || url.hash !== '' || url.username !== '' || url.port !== '') {
    return undefined;
  }
  if (url.hostname === 'flowstep') {
    const match = FLOW_STEP_ROUTE.exec(url.pathname);
    if (!match?.[1] || !match[2] || !history?.flowStepPathOf) return undefined;
    const file = history.flowStepPathOf(match[1], Number(match[2]));
    // Step images are PNG, nothing else.
    return file?.toLowerCase().endsWith('.png') ? file : undefined;
  }
  if (url.hostname === 'thumb' || url.hostname === 'file') {
    const id = HISTORY_ROUTE.exec(url.pathname)?.[1];
    if (!id || !history) return undefined;
    return url.hostname === 'thumb' ? history.thumbPathOf(id) : history.filePathOf(id);
  }
  if (url.pathname !== '' && url.pathname !== '/') return undefined;
  return registry.resolve(url.hostname);
}

/**
 * `framecapt-media://<id>` serves a finished recording with Range support, so <video> can seek
 * (net.fetch(file://) was not relied on for ranges: they are answered here from the file).
 */
export function installMediaProtocol(registry: MediaRegistry, history?: HistoryMedia): void {
  protocol.handle(MEDIA_SCHEME, async (request) => {
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      return new Response(null, { status: 405, headers: NO_STORE });
    }
    let url: URL;
    try {
      url = new URL(request.url);
    } catch {
      return new Response(null, { status: 400, headers: NO_STORE });
    }
    const file = resolveMediaUrl(url, registry, history);
    if (!file) return new Response(null, { status: 404, headers: NO_STORE });
    // Only types the app itself produces; anything else is never served, whatever the path says.
    if (mediaContentType(file) === 'application/octet-stream') {
      return new Response(null, { status: 404, headers: NO_STORE });
    }

    let size: number;
    try {
      const stat = await fs.promises.stat(file);
      if (!stat.isFile()) return new Response(null, { status: 404, headers: NO_STORE });
      size = stat.size;
    } catch {
      log.warn('Media file is gone');
      return new Response(null, { status: 404, headers: NO_STORE });
    }
    const baseHeaders: Record<string, string> = {
      'Content-Type': mediaContentType(file),
      'Accept-Ranges': 'bytes',
      'Cache-Control': 'no-store',
    };
    const range = parseRange(request.headers.get('range'), size);
    if (range === 'unsatisfiable') {
      return new Response(null, {
        status: 416,
        headers: { ...baseHeaders, 'Content-Range': `bytes */${size}` },
      });
    }
    const start = range?.start ?? 0;
    const end = range?.end ?? size - 1;
    const length = size === 0 ? 0 : end - start + 1;
    const headers = {
      ...baseHeaders,
      'Content-Length': String(length),
      ...(range && { 'Content-Range': `bytes ${start}-${end}/${size}` }),
    };
    const status = range ? 206 : 200;
    if (request.method === 'HEAD' || length === 0) return new Response(null, { status, headers });
    const stream = Readable.toWeb(fs.createReadStream(file, { start, end })) as ReadableStream;
    return new Response(stream, { status, headers });
  });
}
