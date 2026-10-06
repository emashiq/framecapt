/** The `.fcap` container: writer and reader, and every way a file can be wrong. */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  buildFcapHeaderBlock,
  clearFcapHeaderCache,
  FCAP_MAX_JSON_BYTES,
  FCAP_PAYLOAD_OFFSET,
  FcapError,
  isFcapPath,
  parseFcapHeader,
  readFcapHeader,
  readFcapHeaderCached,
  writeFcap,
  type FcapMeta,
} from '../../src/main/recording/fcap';
import { layoutSourceRect } from '../../src/shared/recording-layout';

const META: FcapMeta = {
  width: 3840,
  height: 1080,
  durationMs: 12_345,
  hasAudio: true,
  createdAt: 1_760_000_000_000,
  sources: [
    { name: 'Screen 1', kind: 'screen', rect: { x: 0, y: 0, width: 1920, height: 1080 } },
    { name: 'Window 2', kind: 'window', rect: { x: 1920, y: 0, width: 1920, height: 1080 } },
  ],
};

let dir: string;
beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'framecapt-fcap-'));
});
afterAll(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

/** A "WebM" payload of recognizable bytes. */
function payload(length: number): Buffer {
  return Buffer.from(Array.from({ length }, (_, i) => (i * 7 + 3) % 251));
}

function build(length = 5000, meta: FcapMeta = META): Buffer {
  return Buffer.concat([buildFcapHeaderBlock(meta, length), payload(length)]);
}

function expectCode(action: () => unknown, code: string): void {
  try {
    action();
  } catch (error) {
    expect(error).toBeInstanceOf(FcapError);
    expect((error as FcapError).code).toBe(code);
    return;
  }
  throw new Error('expected an FcapError');
}

describe('header block layout', () => {
  it('starts with "FCAP", 0, version 1, two reserved zero bytes and the JSON length (LE)', () => {
    const block = buildFcapHeaderBlock(META, 5000);
    expect(block.length).toBe(FCAP_PAYLOAD_OFFSET);
    expect([...block.subarray(0, 8)]).toEqual([0x46, 0x43, 0x41, 0x50, 0, 1, 0, 0]);
    const jsonLength = block.readUInt32LE(8);
    const json = JSON.parse(block.toString('utf8', 12, 12 + jsonLength));
    expect(json).toMatchObject({
      version: 1,
      width: 3840,
      height: 1080,
      durationMs: 12_345,
      hasAudio: true,
      payloadOffset: 4096,
      payloadLength: 5000,
      payloadType: 'video/webm',
    });
    // Zero padding up to the payload.
    expect(block.subarray(12 + jsonLength).every((byte) => byte === 0)).toBe(true);
  });

  it('round trips through the reader, with the file size checked', () => {
    const file = build(5000);
    const header = parseFcapHeader(file.subarray(0, FCAP_PAYLOAD_OFFSET), file.length);
    expect(header).toEqual({
      version: 1,
      ...META,
      payloadOffset: 4096,
      payloadLength: 5000,
      payloadType: 'video/webm',
    });
  });

  it('never carries more than generic source names (no titles field exists)', () => {
    const block = buildFcapHeaderBlock(META, 10);
    const json = block.toString('utf8', 12, 12 + block.readUInt32LE(8));
    expect(Object.keys(JSON.parse(json).sources[0]).sort()).toEqual(['kind', 'name', 'rect']);
  });
});

describe('the reader refuses what is not a valid file', () => {
  it('a wrong magic, an empty file and a text file are not FCAP', () => {
    const good = build(100);
    const bad = Buffer.from(good);
    bad[0] = 0x66;
    expectCode(() => parseFcapHeader(bad, bad.length), 'NOT_FCAP');
    expectCode(() => parseFcapHeader(Buffer.alloc(0), 0), 'NOT_FCAP');
    expectCode(() => parseFcapHeader(Buffer.from('hello there, world'), 18), 'NOT_FCAP');
    const noNul = Buffer.from(good);
    noNul[4] = 0x31;
    expectCode(() => parseFcapHeader(noNul, noNul.length), 'NOT_FCAP');
  });

  it('a newer version and non-zero reserved bytes', () => {
    const newer = build(100);
    newer[5] = 2;
    expectCode(() => parseFcapHeader(newer, newer.length), 'UNSUPPORTED_VERSION');
    const reserved = build(100);
    reserved[6] = 1;
    expectCode(() => parseFcapHeader(reserved, reserved.length), 'CORRUPT');
  });

  it('a truncated file: payload past the end, and a header cut short', () => {
    const file = build(5000);
    expectCode(() => parseFcapHeader(file, file.length - 1), 'TRUNCATED');
    expectCode(() => parseFcapHeader(file.subarray(0, 20), 20), 'TRUNCATED');
    // Only the header, no payload at all.
    expectCode(() => parseFcapHeader(file.subarray(0, 4096), 4096), 'TRUNCATED');
  });

  it('an oversized or empty JSON length', () => {
    const big = build(100);
    big.writeUInt32LE(FCAP_MAX_JSON_BYTES + 1, 8);
    expectCode(() => parseFcapHeader(big, big.length), 'CORRUPT');
    const huge = build(100);
    huge.writeUInt32LE(0xffffffff, 8);
    expectCode(() => parseFcapHeader(huge, huge.length), 'CORRUPT');
    const zero = build(100);
    zero.writeUInt32LE(0, 8);
    expectCode(() => parseFcapHeader(zero, zero.length), 'CORRUPT');
    // Within 64 KB but not before the payload.
    const late = build(100);
    late.writeUInt32LE(5000, 8);
    expectCode(() => parseFcapHeader(late, late.length), 'CORRUPT');
  });

  it('damaged JSON, wrong types, extra keys and a source outside the picture', () => {
    const withJson = (patch: (json: Record<string, unknown>) => void): Buffer => {
      const file = build(100);
      const length = file.readUInt32LE(8);
      const json = JSON.parse(file.toString('utf8', 12, 12 + length));
      patch(json);
      const text = Buffer.from(JSON.stringify(json));
      const out = Buffer.from(file);
      out.fill(0, 12, FCAP_PAYLOAD_OFFSET);
      out.writeUInt32LE(text.length, 8);
      text.copy(out, 12);
      return out;
    };
    const garbled = build(100);
    garbled.fill(0x7b, 12, 40);
    expectCode(() => parseFcapHeader(garbled, garbled.length), 'CORRUPT');
    for (const patch of [
      (json: Record<string, unknown>) => (json.width = 'wide'),
      (json: Record<string, unknown>) => (json.extra = true),
      (json: Record<string, unknown>) => (json.payloadOffset = 8192),
      (json: Record<string, unknown>) => (json.payloadType = 'video/mp4'),
      (json: Record<string, unknown>) => (json.sources = []),
      (json: Record<string, unknown>) => (json.version = 2),
      (json: Record<string, unknown>) =>
        (json.sources = [
          { name: 'Screen 1', kind: 'screen', rect: { x: 3000, y: 0, width: 1920, height: 1080 } },
        ]),
    ]) {
      const file = withJson(patch);
      expectCode(() => parseFcapHeader(file, file.length), 'CORRUPT');
    }
  });

  it('the writer refuses an invalid picture, too many sources and an overlong name', () => {
    expect(() => buildFcapHeaderBlock({ ...META, width: 0 }, 10)).toThrow();
    expect(() =>
      buildFcapHeaderBlock(
        { ...META, sources: [...META.sources, ...META.sources, META.sources[0]!] },
        10,
      ),
    ).toThrow();
    expect(() =>
      buildFcapHeaderBlock(
        { ...META, sources: [{ ...META.sources[0]!, name: 'x'.repeat(41) }] },
        10,
      ),
    ).toThrow();
    expect(() => buildFcapHeaderBlock(META, 0)).toThrow();
  });
});

describe('files', () => {
  it('writeFcap copies the whole payload after the header and the reader finds it', async () => {
    const source = path.join(dir, 'in.webm');
    const bytes = payload(3 * 1024 * 1024 + 123); // more than one copy buffer
    fs.writeFileSync(source, bytes);
    const target = path.join(dir, 'out.fcap');
    const header = await writeFcap(source, target, META);
    expect(header.payloadLength).toBe(bytes.length);
    const written = fs.readFileSync(target);
    expect(written.length).toBe(FCAP_PAYLOAD_OFFSET + bytes.length);
    expect(Buffer.compare(written.subarray(FCAP_PAYLOAD_OFFSET), bytes)).toBe(0);
    expect(await readFcapHeader(target)).toEqual(header);
  });

  it('writeFcap never overwrites a file and removes what it started on failure', async () => {
    const source = path.join(dir, 'in2.webm');
    fs.writeFileSync(source, payload(100));
    const target = path.join(dir, 'exists.fcap');
    fs.writeFileSync(target, 'mine');
    await expect(writeFcap(source, target, META)).rejects.toThrow();
    expect(fs.readFileSync(target, 'utf8')).toBe('mine');

    // An empty payload and an invalid picture leave nothing behind.
    const empty = path.join(dir, 'empty.webm');
    fs.writeFileSync(empty, '');
    const out = path.join(dir, 'never.fcap');
    await expect(writeFcap(empty, out, META)).rejects.toThrow(FcapError);
    await expect(writeFcap(source, out, { ...META, width: 1 })).rejects.toThrow();
    expect(fs.existsSync(out)).toBe(false);

    const controller = new AbortController();
    controller.abort();
    await expect(writeFcap(source, out, META, controller.signal)).rejects.toThrow(FcapError);
    expect(fs.existsSync(out)).toBe(false);
  });

  it('readFcapHeader fails with a typed error on short, foreign and truncated files', async () => {
    const short = path.join(dir, 'short.fcap');
    fs.writeFileSync(short, 'FCAP');
    await expect(readFcapHeader(short)).rejects.toMatchObject({ code: 'NOT_FCAP' });
    const cut = path.join(dir, 'cut.fcap');
    fs.writeFileSync(cut, build(5000).subarray(0, 4096 + 4999));
    await expect(readFcapHeader(cut)).rejects.toMatchObject({ code: 'TRUNCATED' });
  });

  it('the cached reader follows the file (path, size and modification time) and never caches errors', async () => {
    clearFcapHeaderCache();
    const file = path.join(dir, 'cache.fcap');
    fs.writeFileSync(file, build(1000));
    const first = await readFcapHeaderCached(file);
    expect(await readFcapHeaderCached(file)).toBe(first); // the same object: a cache hit
    fs.writeFileSync(file, build(2000, { ...META, durationMs: 1 }));
    const changed = await readFcapHeaderCached(file);
    expect(changed).not.toBe(first);
    expect(changed.payloadLength).toBe(2000);
    fs.writeFileSync(file, 'garbage');
    await expect(readFcapHeaderCached(file)).rejects.toBeInstanceOf(FcapError);
  });
});

describe('helpers', () => {
  it('isFcapPath looks at the extension, in any case', () => {
    expect(isFcapPath('C:\\a\\FrameCapt 2026.fcap')).toBe(true);
    expect(isFcapPath('/a/b.FCAP')).toBe(true);
    expect(isFcapPath('/a/b.fcap.webm')).toBe(false);
    expect(isFcapPath('/a/b.webm')).toBe(false);
  });

  it('layoutSourceRect is the crop of a source, or null out of range (the editor hook)', () => {
    expect(layoutSourceRect(META, 1)).toEqual({ x: 1920, y: 0, width: 1920, height: 1080 });
    expect(layoutSourceRect(META, 2)).toBeNull();
    // A copy: changing it does not change the layout.
    const rect = layoutSourceRect(META, 0)!;
    rect.x = 99;
    expect(META.sources[0]!.rect.x).toBe(0);
  });
});
