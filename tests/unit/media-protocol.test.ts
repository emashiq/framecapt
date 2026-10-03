/**
 * The `framecapt-media:` protocol handler end to end (Electron's `protocol` replaced by a capture of
 * the handler): what it serves, what it refuses, and that no URL shape can name a path.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

type Handler = (request: Request) => Promise<Response>;
const captured: { handler?: Handler } = {};
vi.mock('electron', () => ({
  protocol: {
    handle: (_scheme: string, handler: Handler) => {
      captured.handler = handler;
    },
    registerSchemesAsPrivileged: () => undefined,
  },
}));

import { installMediaProtocol, MediaRegistry } from '../../src/main/recording/media-protocol';

const ID = '4a4b4c4d-4e4f-4a4b-8c4d-4e4f4a4b4c4d';
let dir: string;
let webm: string;
let secret: string;
let notes: string;
const thumbCalls: string[] = [];
const fileCalls: string[] = [];

beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'framecapt-media-'));
  webm = path.join(dir, 'clip.webm');
  fs.writeFileSync(webm, Buffer.from(Array.from({ length: 1000 }, (_, i) => i % 251)));
  secret = path.join(dir, 'secret.txt');
  fs.writeFileSync(secret, 'top secret');
  notes = path.join(dir, 'folder.webm'); // a directory with a media-looking name
  fs.mkdirSync(notes);
});
afterAll(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

const registry = new MediaRegistry();
let recId = '';
let secretId = '';
let folderId = '';

function handler(): Handler {
  if (!captured.handler) {
    recId = registry.register(webm);
    secretId = registry.register(secret);
    folderId = registry.register(notes);
    installMediaProtocol(registry, {
      thumbPathOf: (id) => {
        thumbCalls.push(id);
        return id === ID ? webm : undefined;
      },
      filePathOf: (id) => {
        fileCalls.push(id);
        return id === ID ? webm : undefined;
      },
    });
  }
  return captured.handler as Handler;
}

const get = (url: string, headers: Record<string, string> = {}, method = 'GET') =>
  handler()(new Request(url, { method, headers }));

describe('framecapt-media: what is served', () => {
  it('a registered recording: 200, the right type, ranges advertised, never cached', async () => {
    const response = await get(`framecapt-media://${(handler(), recId)}`);
    expect(response.status).toBe(200);
    expect(response.headers.get('Content-Type')).toBe('video/webm');
    expect(response.headers.get('Accept-Ranges')).toBe('bytes');
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    expect(Number(response.headers.get('Content-Length'))).toBe(1000);
    expect(Buffer.compare(Buffer.from(await response.arrayBuffer()), fs.readFileSync(webm))).toBe(
      0,
    );
  });

  it('ranges: partial content, open end, suffix, clamped end; an unsatisfiable start is 416', async () => {
    const url = `framecapt-media://${(handler(), recId)}`;
    const whole = fs.readFileSync(webm);
    const part = await get(url, { Range: 'bytes=10-19' });
    expect(part.status).toBe(206);
    expect(part.headers.get('Content-Range')).toBe('bytes 10-19/1000');
    expect(Buffer.compare(Buffer.from(await part.arrayBuffer()), whole.subarray(10, 20))).toBe(0);
    const tail = await get(url, { Range: 'bytes=-5' });
    expect(tail.headers.get('Content-Range')).toBe('bytes 995-999/1000');
    const clamped = await get(url, { Range: 'bytes=990-99999999999' });
    expect(clamped.headers.get('Content-Range')).toBe('bytes 990-999/1000');
    for (const range of ['bytes=1000-', 'bytes=5000-6000', 'bytes=-0']) {
      const refused = await get(url, { Range: range });
      expect(refused.status, range).toBe(416);
      expect(refused.headers.get('Content-Range')).toBe('bytes */1000');
    }
    // Not a single plain byte range: ignored, the whole file is served (never an error, never more).
    for (const range of ['bytes=0-1,5-6', 'items=0-1', 'bytes=a-b', 'bytes=0-1 ; x']) {
      expect((await get(url, { Range: range })).status, range).toBe(200);
    }
  });

  it('HEAD has headers and no body; other methods are 405', async () => {
    const url = `framecapt-media://${(handler(), recId)}`;
    const head = await get(url, {}, 'HEAD');
    expect(head.status).toBe(200);
    expect(head.headers.get('Content-Length')).toBe('1000');
    expect(await head.text()).toBe('');
    for (const method of ['POST', 'PUT', 'DELETE', 'PATCH']) {
      const response = await handler()(
        new Request(url, { method, body: method === 'DELETE' ? null : 'x' }),
      );
      expect(response.status, method).toBe(405);
    }
  });

  it('history routes serve their file; the cache-busting nonce changes nothing', async () => {
    expect((await get(`framecapt-media://file/${ID}`)).status).toBe(200);
    expect((await get(`framecapt-media://thumb/${ID}/k3j9x0ab`)).status).toBe(200);
  });
});

describe('framecapt-media: what is never served', () => {
  it('only the media types FrameCapt produces: a registered .txt (or a folder named like a video) is 404', async () => {
    handler();
    expect((await get(`framecapt-media://${secretId}`)).status).toBe(404);
    expect((await get(`framecapt-media://${folderId}`)).status).toBe(404);
  });

  it('a file that vanished is 404, not a crash', async () => {
    const gone = registry.register(path.join(dir, 'gone.webm'));
    expect((await get(`framecapt-media://${gone}`)).status).toBe(404);
  });

  const nasty = (): string[] => [
    // traversal, raw and encoded in every way a URL parser might normalise
    'framecapt-media://file/..%2F..%2Fsecret.txt',
    'framecapt-media://file/%2e%2e/%2e%2e/secret.txt',
    'framecapt-media://file/%2E%2E%5C%2E%2E%5Csecret.txt',
    'framecapt-media://file/%252e%252e%252fsecret.txt',
    'framecapt-media://file/../secret.txt',
    'framecapt-media://file/..\\..\\secret.txt',
    'framecapt-media://file/..%5c..%5csecret.txt',
    'framecapt-media://thumb/..%2f..%2fsecret.txt',
    'framecapt-media://%2e%2e/secret.txt',
    'framecapt-media://./secret.txt',
    'framecapt-media://../secret.txt',
    // absolute paths and drive letters, several spellings
    'framecapt-media://file/C:/Windows/win.ini',
    'framecapt-media://file/C:%5CWindows%5Cwin.ini',
    'framecapt-media://file//C:/Windows/win.ini',
    'framecapt-media://C:/Windows/win.ini',
    'framecapt-media:///C:/Windows/win.ini',
    'framecapt-media://file/%5C%5Clocalhost%5Cc$%5Cwindows%5Cwin.ini',
    // the real path of a registered file, and its name
    `framecapt-media://file/${encodeURIComponent(webm)}`,
    `framecapt-media://${encodeURIComponent(webm)}`,
    `framecapt-media://file/${path.basename(webm)}`,
    // ids that are almost right
    `framecapt-media://file/${ID.toUpperCase()}`,
    `framecapt-media://file/${ID}%2f..%2f..%2fsecret.txt`,
    `framecapt-media://file/${ID}%00.png`,
    `framecapt-media://file/${ID}.png`,
    `framecapt-media://file/${ID}/`,
    `framecapt-media://file/${ID}/a/b`,
    `framecapt-media://file/${ID}?path=${encodeURIComponent(secret)}`,
    `framecapt-media://file/${ID}#x`,
    'framecapt-media://file/',
    'framecapt-media://file',
    'framecapt-media://thumb',
    'framecapt-media://',
    // other hosts and credentials
    'framecapt-media://list/',
    'framecapt-media://dir/',
    'framecapt-media://*/',
    `framecapt-media://user:pw@file/${ID}`,
    `framecapt-media://file:8080/${ID}`,
  ];

  it('no URL shape resolves to a path: every one is 404 (or 400), none reaches the disk', async () => {
    handler();
    thumbCalls.length = 0;
    fileCalls.length = 0;
    for (const url of nasty()) {
      let response: Response;
      try {
        response = await get(url);
      } catch {
        continue; // a URL the runtime itself refuses to build is just as safe
      }
      expect([400, 404], url).toContain(response.status);
      expect(response.headers.get('Cache-Control'), url).toBe('no-store');
      expect(await response.text(), url).toBe('');
    }
    // History was only ever asked about ids that are canonical (lowercase) uuids.
    for (const id of [...thumbCalls, ...fileCalls]) expect(id).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('there is no directory listing or index: the bare scheme and the history hosts serve nothing', async () => {
    for (const url of [
      'framecapt-media://',
      'framecapt-media://file/',
      'framecapt-media://thumb/',
    ]) {
      const status = await get(url).then(
        (response) => response.status,
        () => 400,
      );
      expect([400, 404], url).toContain(status);
    }
  });
});
