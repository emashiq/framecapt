import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import { Readable } from 'node:stream';
import { protocol } from 'electron';
import { log } from '../logger';
import { mediaContentType, parseRange } from './range';

export const MEDIA_SCHEME = 'framelet-media';

/** Files Framelet itself produced, by an unguessable id. The protocol serves nothing else. */
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

/** Must run before `app.whenReady()`. */
export function registerMediaScheme(): void {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: MEDIA_SCHEME,
      // standard + secure: media elements and the CSP treat it like a normal origin.
      // stream: media playback may stream the response. supportFetchAPI: fetch() can read it.
      privileges: { standard: true, secure: true, stream: true, supportFetchAPI: true },
    },
  ]);
}

/**
 * `framelet-media://<id>` serves a finished recording with Range support, so <video> can seek
 * (net.fetch(file://) was not relied on for ranges: they are answered here from the file).
 */
export function installMediaProtocol(registry: MediaRegistry): void {
  protocol.handle(MEDIA_SCHEME, async (request) => {
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      return new Response(null, { status: 405 });
    }
    let id: string;
    try {
      id = new URL(request.url).hostname;
    } catch {
      return new Response(null, { status: 400 });
    }
    const file = registry.resolve(id);
    if (!file) return new Response(null, { status: 404 });

    let size: number;
    try {
      size = (await fs.promises.stat(file)).size;
    } catch {
      log.warn('Media file is gone');
      return new Response(null, { status: 404 });
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
