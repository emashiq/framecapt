import { describe, expect, it } from 'vitest';
import { MediaRegistry, resolveMediaUrl } from '../../src/main/recording/media-protocol';
import { mediaContentType } from '../../src/main/recording/range';
import { readImageSize } from '../../src/shared/shots';
import { formatExact, formatRelative } from '../../src/renderer/lib/time';

const ID = '44444444-4444-4444-8444-444444444444';
const history = {
  thumbPathOf: (id: string) => (id === ID ? 'C:/data/thumbs/t.png' : undefined),
  filePathOf: (id: string) => (id === ID ? 'C:/caps/shot.png' : undefined),
};

describe('framecapt-media routes', () => {
  const registry = new MediaRegistry();
  const rec = registry.register('C:/Videos/FrameCapt/a.webm');
  const resolve = (url: string, withHistory = true) =>
    resolveMediaUrl(new URL(url), registry, withHistory ? history : undefined);

  it('serves the three known shapes', () => {
    expect(resolve(`framecapt-media://${rec}`)).toBe('C:/Videos/FrameCapt/a.webm');
    expect(resolve(`framecapt-media://${rec}/`)).toBe('C:/Videos/FrameCapt/a.webm');
    expect(resolve(`framecapt-media://thumb/${ID}`)).toBe('C:/data/thumbs/t.png');
    expect(resolve(`framecapt-media://file/${ID}`)).toBe('C:/caps/shot.png');
  });

  it('accepts one lowercase alphanumeric nonce segment on the history routes (cache busting only)', () => {
    expect(resolve(`framecapt-media://file/${ID}/k3j9x0ab`)).toBe('C:/caps/shot.png');
    expect(resolve(`framecapt-media://thumb/${ID}/a`)).toBe('C:/data/thumbs/t.png');
    for (const bad of ['/UPPER', '/a-b', '/a.b', '/..', '/a/b', '/', `/${'a'.repeat(25)}`]) {
      expect(resolve(`framecapt-media://file/${ID}${bad}`), bad).toBeUndefined();
    }
  });

  it('serves nothing else: unknown ids, extra segments, queries, traversal, other hosts', () => {
    const unknown = '55555555-5555-4555-8555-555555555555';
    for (const url of [
      `framecapt-media://thumb/${unknown}`,
      `framecapt-media://file/${unknown}`,
      `framecapt-media://thumb/${ID}/extra/more`,
      `framecapt-media://thumb/${ID}/`,
      `framecapt-media://thumb/${ID}?x=1`,
      `framecapt-media://thumb/${ID}#frag`,
      'framecapt-media://thumb/',
      'framecapt-media://thumb',
      'framecapt-media://file/..%2F..%2Fsecret',
      'framecapt-media://file/C:/Windows/win.ini',
      `framecapt-media://${rec}/more`,
      `framecapt-media://${rec}?x=1`,
      'framecapt-media://nope',
      `framecapt-media://user@file/${ID}`,
      `framecapt-media://file:99/${ID}`,
    ]) {
      expect(resolve(url), url).toBeUndefined();
    }
  });

  it('has no history routes without history', () => {
    expect(resolve(`framecapt-media://thumb/${ID}`, false)).toBeUndefined();
    expect(resolve(`framecapt-media://${rec}`, false)).toBe('C:/Videos/FrameCapt/a.webm');
  });

  it('knows the content types it may serve', () => {
    expect(mediaContentType('a.PNG')).toBe('image/png');
    expect(mediaContentType('a.jpeg')).toBe('image/jpeg');
    expect(mediaContentType('a.mp4')).toBe('video/mp4');
    expect(mediaContentType('a.exe')).toBe('application/octet-stream');
  });
});

describe('readImageSize', () => {
  it('reads a PNG header', () => {
    const png = Buffer.alloc(40);
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(png);
    png.writeUInt32BE(1920, 16);
    png.writeUInt32BE(1080, 20);
    expect(readImageSize(png)).toEqual({ width: 1920, height: 1080 });
    expect(readImageSize(png.subarray(0, 20))).toBeNull();
  });

  it('finds the start-of-frame of a JPEG after other segments', () => {
    const jpeg = Buffer.concat([
      Buffer.from([0xff, 0xd8]),
      // APP0 with a 16-byte payload
      Buffer.from([0xff, 0xe0, 0x00, 0x10]),
      Buffer.alloc(14),
      // SOF0: length 17, precision 8, height 600, width 800
      Buffer.from([0xff, 0xc0, 0x00, 0x11, 0x08, 0x02, 0x58, 0x03, 0x20, 0x03]),
      Buffer.alloc(12),
    ]);
    expect(readImageSize(jpeg)).toEqual({ width: 800, height: 600 });
  });

  it('returns null for anything else', () => {
    expect(readImageSize(Buffer.from('GIF89a'))).toBeNull();
    expect(readImageSize(new Uint8Array(0))).toBeNull();
    expect(readImageSize(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 2]))).toBeNull();
  });
});

describe('relative time', () => {
  const now = new Date(2026, 9, 2, 12, 0, 0).getTime();
  const ago = (ms: number) => formatRelative(now - ms, now);

  it('reads naturally from seconds to days', () => {
    expect(ago(5_000)).toBe('just now');
    expect(ago(60_000)).toBe('1 min ago');
    expect(ago(2 * 60_000 + 10_000)).toBe('2 min ago');
    expect(ago(59 * 60_000)).toBe('59 min ago');
    expect(ago(3 * 3_600_000)).toBe('3 h ago');
    expect(ago(30 * 3_600_000)).toBe('yesterday');
    expect(ago(4 * 86_400_000)).toBe('4 days ago');
    expect(ago(30 * 86_400_000)).toMatch(/2026/);
    expect(formatRelative(now + 10_000, now)).toBe('just now'); // clock skew never goes negative
  });

  it('gives an exact timestamp for tooltips', () => {
    expect(formatExact(now)).toMatch(/2026/);
  });
});
