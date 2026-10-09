import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_RECORD_OPTIONS, MAX_CHUNK_BYTES } from '../../src/shared/recorder-ipc';
import { IpcError } from '../../src/main/ipc-core';
import {
  MANIFEST_EVERY_CHUNKS,
  MANIFEST_EVERY_MS,
  SessionService,
  writeErrorCode,
  type SessionConfig,
  type SessionFileHandle,
  type SessionFs,
  type SessionManifest,
} from '../../src/main/recording/session-service';
import { nodeSessionFs } from '../../src/main/recording/session-fs';
import { fakeTools, PLAYABLE } from './fake-tools';

const CONFIG: SessionConfig = {
  mime: 'video/webm;codecs=vp9,opus',
  source: { kind: 'screen', name: 'Screen 1' },
  options: DEFAULT_RECORD_OPTIONS,
  width: 1920,
  height: 804,
};
const ID = '0f0e0d0c-0b0a-4908-8706-050403020100';
const ID2 = '1f1e1d1c-1b1a-4918-8716-151413121110';

/** Remembers every service so the files they hold open are closed after each test. */
const created: SessionService[] = [];
class TrackedService extends SessionService {
  constructor(...args: ConstructorParameters<typeof SessionService>) {
    super(...args);
    created.push(this);
  }
}

let root: string;
let out: string;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'framecapt-sessions-'));
  out = fs.mkdtempSync(path.join(os.tmpdir(), 'framecapt-out-'));
});
afterEach(async () => {
  await Promise.all(created.splice(0).map((service) => service.closeAll()));
  fs.rmSync(root, { recursive: true, force: true });
  fs.rmSync(out, { recursive: true, force: true });
});

/** The real filesystem behind the SessionFs interface; tests override single operations. */
function realFs(overrides: Partial<SessionFs> = {}): SessionFs {
  return { ...nodeSessionFs, ...overrides };
}

function errno(code: string): NodeJS.ErrnoException {
  const error: NodeJS.ErrnoException = new Error(code);
  error.code = code;
  return error;
}

function readManifest(sessionId = ID): SessionManifest {
  return JSON.parse(
    fs.readFileSync(path.join(root, sessionId, 'manifest.json'), 'utf8'),
  ) as SessionManifest;
}

const chunk = (size: number, fill: number): Uint8Array => new Uint8Array(size).fill(fill);

async function expectCode(promise: Promise<unknown>, code: string): Promise<void> {
  const error = await promise.then(
    () => null,
    (caught: unknown) => caught,
  );
  expect(error).toBeInstanceOf(IpcError);
  expect((error as IpcError).code).toBe(code);
}

describe('SessionService: creating a session', () => {
  it('creates the directory, an empty stream file and a manifest', async () => {
    const service = new TrackedService(root, { now: () => 5000 });
    await service.create(CONFIG, ID);
    expect(fs.existsSync(path.join(root, ID, 'stream.webm'))).toBe(true);
    expect(fs.statSync(path.join(root, ID, 'stream.webm')).size).toBe(0);
    expect(readManifest()).toMatchObject({
      version: 1,
      sessionId: ID,
      createdAt: 5000,
      state: 'recording',
      mime: CONFIG.mime,
      source: CONFIG.source,
      width: 1920,
      height: 804,
      chunksWritten: 0,
      bytesWritten: 0,
      lastSeq: -1,
      pausedIntervals: [],
    });
    expect(fs.readdirSync(path.join(root, ID)).sort()).toEqual(['manifest.json', 'stream.webm']);
  });

  it('generates a uuid when none is given and refuses ids that are not plain uuids', async () => {
    const service = new TrackedService(root);
    const id = await service.create(CONFIG);
    expect(id).toMatch(/^[0-9a-f-]{36}$/);
    await expectCode(service.create(CONFIG, '../evil'), 'INVALID_PAYLOAD');
    await expectCode(service.create(CONFIG, 'C:\\Windows'), 'INVALID_PAYLOAD');
    await expectCode(service.create(CONFIG, id), 'BUSY');
    expect(service.dirFor('..')).toBeNull();
    expect(service.dirFor(ID)).toBe(path.join(root, ID));
  });

  it('cleans up when the directory cannot be created', async () => {
    const service = new TrackedService(root, {
      fs: realFs({ open: () => Promise.reject(errno('EACCES')) }),
    });
    await expectCode(service.create(CONFIG, ID), 'WRITE_FAILED');
    expect(fs.existsSync(path.join(root, ID))).toBe(false);
    expect(service.has(ID)).toBe(false);
  });
});

describe('SessionService: appending chunks', () => {
  it('writes chunks in order and the file is exactly their concatenation', async () => {
    const service = new TrackedService(root);
    await service.create(CONFIG, ID);
    const parts = [chunk(1000, 1), chunk(2500, 2), chunk(7, 3)];
    for (const [seq, part] of parts.entries()) {
      expect(await service.append(ID, seq, part)).toEqual({ duplicate: false, lastSeq: seq });
    }
    const written = fs.readFileSync(path.join(root, ID, 'stream.webm'));
    expect(Buffer.compare(written, Buffer.concat(parts))).toBe(0);
    expect(service.manifestOf(ID)).toMatchObject({
      lastSeq: 2,
      chunksWritten: 3,
      bytesWritten: 3507,
    });
  });

  it('acknowledges the same chunk sent again (same seq, same length) without writing it twice', async () => {
    const service = new TrackedService(root);
    await service.create(CONFIG, ID);
    await service.append(ID, 0, chunk(100, 9));
    expect(await service.append(ID, 0, chunk(100, 9))).toEqual({ duplicate: true, lastSeq: 0 });
    expect(fs.statSync(path.join(root, ID, 'stream.webm')).size).toBe(100);
    expect(service.manifestOf(ID)?.chunksWritten).toBe(1);
  });

  it('rejects a conflicting duplicate (same seq, different length) and an old seq', async () => {
    const service = new TrackedService(root);
    await service.create(CONFIG, ID);
    await service.append(ID, 0, chunk(100, 1));
    await service.append(ID, 1, chunk(50, 2));
    await expectCode(service.append(ID, 1, chunk(51, 2)), 'DUPLICATE_MISMATCH');
    await expectCode(service.append(ID, 0, chunk(100, 1)), 'DUPLICATE_MISMATCH');
    expect(fs.statSync(path.join(root, ID, 'stream.webm')).size).toBe(150);
  });

  it('rejects a gap and leaves the file untouched; the right chunk is then accepted', async () => {
    const service = new TrackedService(root);
    await service.create(CONFIG, ID);
    await service.append(ID, 0, chunk(10, 1));
    await expectCode(service.append(ID, 2, chunk(10, 3)), 'SEQ_GAP');
    expect(fs.statSync(path.join(root, ID, 'stream.webm')).size).toBe(10);
    expect(await service.append(ID, 1, chunk(10, 2))).toEqual({ duplicate: false, lastSeq: 1 });
  });

  it('the first chunk must be seq 0', async () => {
    const service = new TrackedService(root);
    await service.create(CONFIG, ID);
    await expectCode(service.append(ID, 1, chunk(10, 1)), 'SEQ_GAP');
  });

  it('rejects an oversize chunk (over 16 MB) and an empty one', async () => {
    const service = new TrackedService(root);
    await service.create(CONFIG, ID);
    await expectCode(service.append(ID, 0, new Uint8Array(MAX_CHUNK_BYTES + 1)), 'CHUNK_TOO_LARGE');
    await expectCode(service.append(ID, 0, new Uint8Array(0)), 'INVALID_PAYLOAD');
    // Exactly 16 MB is fine.
    expect((await service.append(ID, 0, new Uint8Array(MAX_CHUNK_BYTES))).duplicate).toBe(false);
  });

  it('rejects unknown sessions', async () => {
    const service = new TrackedService(root);
    await expectCode(service.append(ID2, 0, chunk(1, 1)), 'NOT_FOUND');
    await expectCode(service.finish(ID2, 0), 'NOT_FOUND');
  });

  it('keeps simultaneous appends in order', async () => {
    const service = new TrackedService(root);
    await service.create(CONFIG, ID);
    const results = await Promise.all(
      Array.from({ length: 12 }, (_, seq) => service.append(ID, seq, chunk(20, seq))),
    );
    expect(results.every((result) => !result.duplicate)).toBe(true);
    const written = fs.readFileSync(path.join(root, ID, 'stream.webm'));
    for (let seq = 0; seq < 12; seq += 1) expect(written[seq * 20]).toBe(seq);
  });

  it('writes everything even when the file system accepts only a few bytes at a time', async () => {
    const opened: string[] = [];
    const service = new TrackedService(root, {
      fs: realFs({
        open: async (file, flags) => {
          opened.push(file);
          const real = (await fs.promises.open(file, flags)) as unknown as SessionFileHandle;
          return {
            write: (buffer, offset, length) => real.write(buffer, offset, Math.min(length, 7)),
            sync: () => real.sync(),
            close: () => real.close(),
          };
        },
      }),
    });
    await service.create(CONFIG, ID);
    const data = Uint8Array.from({ length: 100 }, (_, i) => i);
    await service.append(ID, 0, data);
    expect(
      Buffer.compare(fs.readFileSync(path.join(root, ID, 'stream.webm')), Buffer.from(data)),
    ).toBe(0);
  });
});

describe('SessionService: manifest updates', () => {
  it('rewrites the manifest every 10 chunks, not on each chunk', async () => {
    let manifestWrites = 0;
    const service = new TrackedService(root, {
      now: () => 1000,
      fs: realFs({
        writeFile: (file, data) => {
          if (file.endsWith('manifest.json.tmp')) manifestWrites += 1;
          return fs.promises.writeFile(file, data);
        },
      }),
    });
    await service.create(CONFIG, ID);
    const afterCreate = manifestWrites;
    for (let seq = 0; seq < MANIFEST_EVERY_CHUNKS - 1; seq += 1)
      await service.append(ID, seq, chunk(10, 1));
    expect(manifestWrites).toBe(afterCreate);
    expect(readManifest().lastSeq).toBe(-1); // not yet on disk
    await service.append(ID, MANIFEST_EVERY_CHUNKS - 1, chunk(10, 1));
    expect(manifestWrites).toBe(afterCreate + 1);
    expect(readManifest().lastSeq).toBe(MANIFEST_EVERY_CHUNKS - 1);
  });

  it('also rewrites it after 5 seconds', async () => {
    let clock = 0;
    const service = new TrackedService(root, { now: () => clock });
    await service.create(CONFIG, ID);
    await service.append(ID, 0, chunk(10, 1));
    expect(readManifest().lastSeq).toBe(-1);
    clock = MANIFEST_EVERY_MS;
    await service.append(ID, 1, chunk(10, 1));
    expect(readManifest()).toMatchObject({
      lastSeq: 1,
      bytesWritten: 20,
      updatedAt: MANIFEST_EVERY_MS,
    });
  });

  it('writes the manifest atomically (temp file, then rename; no temp file is left)', async () => {
    const renames: [string, string][] = [];
    const service = new TrackedService(root, {
      fs: realFs({
        rename: (from, to) => {
          renames.push([path.basename(from), path.basename(to)]);
          return fs.promises.rename(from, to);
        },
      }),
    });
    await service.create(CONFIG, ID);
    expect(renames).toContainEqual(['manifest.json.tmp', 'manifest.json']);
    expect(fs.readdirSync(path.join(root, ID))).not.toContain('manifest.json.tmp');
  });

  it('a failing manifest update does not lose or fail the chunk that was just written', async () => {
    let failManifest = false;
    const service = new TrackedService(root, {
      fs: realFs({
        writeFile: (file, data) =>
          failManifest && file.endsWith('.tmp')
            ? Promise.reject(errno('EIO'))
            : fs.promises.writeFile(file, data),
      }),
    });
    await service.create(CONFIG, ID);
    failManifest = true;
    for (let seq = 0; seq < MANIFEST_EVERY_CHUNKS; seq += 1) {
      expect((await service.append(ID, seq, chunk(5, 1))).duplicate).toBe(false);
    }
    expect(service.manifestOf(ID)?.chunksWritten).toBe(MANIFEST_EVERY_CHUNKS);
  });
});

describe('SessionService: write errors', () => {
  function failingFs(code: string, failOnWrite: number): SessionFs {
    return realFs({
      open: async (file, flags) => {
        const real = (await fs.promises.open(file, flags)) as unknown as SessionFileHandle;
        let writes = 0;
        return {
          write: (buffer, offset, length) => {
            writes += 1;
            return writes === failOnWrite
              ? Promise.reject(errno(code))
              : real.write(buffer, offset, length);
          },
          sync: () => real.sync(),
          close: () => real.close(),
        };
      },
    });
  }

  it('maps ENOSPC to DISK_FULL, ends the session and keeps what was written', async () => {
    const service = new TrackedService(root, { fs: failingFs('ENOSPC', 3) });
    await service.create(CONFIG, ID);
    await service.append(ID, 0, chunk(100, 1));
    await service.append(ID, 1, chunk(100, 2));
    await expectCode(service.append(ID, 2, chunk(100, 3)), 'DISK_FULL');
    await expectCode(service.append(ID, 2, chunk(100, 3)), 'SESSION_INACTIVE');
    expect(readManifest()).toMatchObject({
      state: 'failed',
      error: { code: 'DISK_FULL' },
      truncated: true,
      lastSeq: 1,
    });
    expect(fs.statSync(path.join(root, ID, 'stream.webm')).size).toBe(200);
  });

  it('maps EACCES and EIO to WRITE_FAILED', async () => {
    for (const code of ['EACCES', 'EIO', 'EPERM']) {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'framecapt-w-'));
      try {
        const service = new TrackedService(dir, { fs: failingFs(code, 1) });
        await service.create(CONFIG, ID);
        await expectCode(service.append(ID, 0, chunk(10, 1)), 'WRITE_FAILED');
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    }
    expect(writeErrorCode(errno('ENOSPC'))).toBe('DISK_FULL');
    expect(writeErrorCode(errno('EDQUOT'))).toBe('DISK_FULL');
    expect(writeErrorCode(new Error('x'))).toBe('WRITE_FAILED');
    expect(writeErrorCode(undefined)).toBe('WRITE_FAILED');
  });

  it('a failed session can still be finalized (the recorded part is kept and published)', async () => {
    const service = new TrackedService(root, { fs: failingFs('ENOSPC', 2) });
    await service.create(CONFIG, ID);
    await service.append(ID, 0, chunk(64, 7));
    await expectCode(service.append(ID, 1, chunk(64, 8)), 'DISK_FULL');
    const done = await service.finalize(ID, {
      outputDir: out,
      tools: fakeTools(),
      date: new Date(2026, 9, 2, 14, 5, 9),
    });
    expect(done.bytes).toBe(64);
    expect(fs.readFileSync(done.outputPath).length).toBe(64);
  });
});

describe('SessionService: finishing', () => {
  it('verifies the last sequence number, flushes and marks the session stopped', async () => {
    const service = new TrackedService(root);
    await service.create(CONFIG, ID);
    await service.append(ID, 0, chunk(10, 1));
    await service.append(ID, 1, chunk(10, 2));
    await expectCode(service.finish(ID, 5), 'SEQ_GAP');
    await expectCode(service.finish(ID, 0), 'SEQ_GAP');
    expect(await service.finish(ID, 1)).toEqual({ chunks: 2, bytes: 20 });
    expect(readManifest()).toMatchObject({
      state: 'stopped',
      lastSeq: 1,
      chunksWritten: 2,
      bytesWritten: 20,
    });
  });

  it('is idempotent and closes the session to further data', async () => {
    const service = new TrackedService(root);
    await service.create(CONFIG, ID);
    await service.append(ID, 0, chunk(10, 1));
    await service.finish(ID, 0);
    expect(await service.finish(ID, 0)).toEqual({ chunks: 1, bytes: 10 });
    await expectCode(service.append(ID, 1, chunk(10, 2)), 'SESSION_INACTIVE');
  });

  it('an empty session can be finished with lastSeq -1', async () => {
    const service = new TrackedService(root);
    await service.create(CONFIG, ID);
    expect(await service.finish(ID, -1)).toEqual({ chunks: 0, bytes: 0 });
  });

  it('markStopped (main-side) keeps the data and marks the file as possibly truncated', async () => {
    const service = new TrackedService(root);
    await service.create(CONFIG, ID);
    await service.append(ID, 0, chunk(10, 1));
    await service.markStopped(ID, { truncated: true, reason: 'engine-closed' });
    expect(readManifest()).toMatchObject({
      state: 'stopped',
      truncated: true,
      endReason: 'engine-closed',
    });
    await service.markStopped(ID); // again: no change, no error
    expect(readManifest().state).toBe('stopped');
  });

  it('surfaces a failing flush as WRITE_FAILED', async () => {
    const service = new TrackedService(root, {
      fs: realFs({
        open: async (file, flags) => {
          const real = (await fs.promises.open(file, flags)) as unknown as SessionFileHandle;
          return {
            write: (buffer, offset, length) => real.write(buffer, offset, length),
            sync: () => Promise.reject(errno('EIO')),
            close: () => real.close(),
          };
        },
      }),
    });
    await service.create(CONFIG, ID);
    await service.append(ID, 0, chunk(10, 1));
    await expectCode(service.finish(ID, 0), 'WRITE_FAILED');
    expect(readManifest().state).toBe('failed');
  });
});

describe('SessionService: pauses', () => {
  it('records pause intervals in the manifest', async () => {
    let clock = 1000;
    const service = new TrackedService(root, { now: () => clock });
    await service.create(CONFIG, ID);
    await service.recordPause(ID, true);
    clock = 3000;
    await service.recordPause(ID, false);
    clock = 4000;
    await service.recordPause(ID, true);
    expect(readManifest().pausedIntervals).toEqual([
      { from: 1000, to: 3000 },
      { from: 4000, to: null },
    ]);
    await service.recordPause('not-a-session', true); // ignored
  });
});

describe('SessionService: ownership and validation', () => {
  it('only the recorder window that created the session may write to it or finish it', async () => {
    const service = new TrackedService(root);
    await service.create(CONFIG, ID, 7);
    await expectCode(service.append(ID, 0, chunk(10, 1), 8), 'FORBIDDEN');
    await expectCode(service.finish(ID, -1, 8), 'FORBIDDEN');
    expect((await service.append(ID, 0, chunk(10, 1), 7)).duplicate).toBe(false);
    expect(await service.finish(ID, 0, 7)).toEqual({ chunks: 1, bytes: 10 });
    expect(fs.statSync(path.join(root, ID, 'stream.webm')).size).toBe(10);
  });

  it('a retry of the last chunk with identical bytes is acknowledged once, never written twice', async () => {
    const service = new TrackedService(root);
    await service.create(CONFIG, ID, 1);
    await service.append(ID, 0, chunk(10, 1), 1);
    await service.append(ID, 1, chunk(10, 2), 1);
    expect(await service.append(ID, 1, chunk(10, 2), 1)).toEqual({ duplicate: true, lastSeq: 1 });
    expect(fs.statSync(path.join(root, ID, 'stream.webm')).size).toBe(20);
  });

  it('same seq with the same length but different content is DUPLICATE_MISMATCH', async () => {
    const service = new TrackedService(root);
    await service.create(CONFIG, ID, 1);
    await service.append(ID, 0, chunk(10, 1), 1);
    await expectCode(service.append(ID, 0, chunk(10, 2), 1), 'DUPLICATE_MISMATCH');
    expect(fs.readFileSync(path.join(root, ID, 'stream.webm'))[0]).toBe(1);
  });

  it('refuses data that is not binary', async () => {
    const service = new TrackedService(root);
    await service.create(CONFIG, ID, 1);
    await expectCode(service.append(ID, 0, 'text' as unknown as Uint8Array, 1), 'INVALID_PAYLOAD');
  });

  it('writes stay in order when invokes overlap and the disk is slow (random delays)', async () => {
    const service = new TrackedService(root, {
      fs: realFs({
        open: async (file, flags) => {
          const real = (await fs.promises.open(file, flags)) as unknown as SessionFileHandle;
          return {
            write: async (buffer, offset, length) => {
              await new Promise((resolve) => setTimeout(resolve, Math.random() * 8));
              return real.write(buffer, offset, length);
            },
            sync: () => real.sync(),
            close: () => real.close(),
          };
        },
      }),
    });
    await service.create(CONFIG, ID, 1);
    const results = await Promise.all(
      Array.from({ length: 25 }, (_, seq) => service.append(ID, seq, chunk(30, seq), 1)),
    );
    expect(results.map((r) => r.lastSeq)).toEqual(Array.from({ length: 25 }, (_, i) => i));
    const written = fs.readFileSync(path.join(root, ID, 'stream.webm'));
    expect(written.length).toBe(750);
    for (let seq = 0; seq < 25; seq += 1) expect(written[seq * 30]).toBe(seq);
  });
});

describe('SessionService: backpressure statistics', () => {
  it('keeps the renderer queue high-water mark and the slowest write in the manifest', async () => {
    const service = new TrackedService(root, {
      fs: realFs({
        open: async (file, flags) => {
          const real = (await fs.promises.open(file, flags)) as unknown as SessionFileHandle;
          return {
            write: async (buffer, offset, length) => {
              await new Promise((resolve) => setTimeout(resolve, 15));
              return real.write(buffer, offset, length);
            },
            sync: () => real.sync(),
            close: () => real.close(),
          };
        },
      }),
    });
    await service.create(CONFIG, ID, 1);
    await service.append(ID, 0, chunk(10, 1), 1, { chunks: 1, bytes: 10 });
    await service.append(ID, 1, chunk(10, 1), 1, { chunks: 5, bytes: 5000 });
    await service.append(ID, 2, chunk(10, 1), 1, { chunks: 2, bytes: 20 });
    const stats = service.manifestOf(ID)?.stats;
    expect(stats?.queueHighWaterChunks).toBe(5);
    expect(stats?.queueHighWaterBytes).toBe(5000);
    expect(stats?.maxWriteMs).toBeGreaterThanOrEqual(10);
  });

  it('counts how many operations waited in main for one session', async () => {
    const service = new TrackedService(root);
    await service.create(CONFIG, ID, 1);
    await Promise.all([0, 1, 2, 3].map((seq) => service.append(ID, seq, chunk(10, 1), 1)));
    expect(service.manifestOf(ID)?.stats.mainQueueHighWater).toBeGreaterThanOrEqual(4);
  });
});

describe('SessionService: disk pressure', () => {
  const GB = 1024 * 1024 * 1024;
  const MB = 1024 * 1024;
  const free = (bytes: number) =>
    realFs({ statfs: () => Promise.resolve({ bavail: bytes, bsize: 1 }) });

  it('refuses to start with less than 1 GB free (LOW_DISK) and creates nothing', async () => {
    const service = new TrackedService(root, { fs: free(GB - 1) });
    await expectCode(service.create(CONFIG, ID, 1), 'LOW_DISK');
    await expectCode(service.ensureSpaceToStart(), 'LOW_DISK');
    expect(fs.existsSync(path.join(root, ID))).toBe(false);
  });

  it('with recordings already running the headroom grows with each of them', async () => {
    const service = new TrackedService(root, { fs: free(2 * GB) });
    await service.ensureSpaceToStart(0);
    await service.ensureSpaceToStart(1); // 2 GB for the second recording
    await expectCode(service.ensureSpaceToStart(2), 'LOW_DISK'); // the third needs 3 GB
    await new TrackedService(root, { fs: free(3 * GB) }).ensureSpaceToStart(2);
  });

  it('starts with exactly 1 GB free, and when free space cannot be determined', async () => {
    await new TrackedService(root, { fs: free(GB) }).create(CONFIG, ID, 1);
    const unknown = realFs({ statfs: () => Promise.reject(new Error('unsupported')) });
    await new TrackedService(root, { fs: unknown }).create(CONFIG, ID2, 1);
    expect(fs.existsSync(path.join(root, ID2))).toBe(true);
  });

  it('while recording, below 500 MB reports the session once and records DISK_LOW', async () => {
    let space = 10 * GB;
    const low: [string, number][] = [];
    const service = new TrackedService(root, {
      diskCheckEveryMs: 0,
      onDiskLow: (id, bytes) => low.push([id, bytes]),
      fs: realFs({ statfs: () => Promise.resolve({ bavail: space, bsize: 1 }) }),
    });
    await service.create(CONFIG, ID, 1);
    expect(await service.checkDisk()).toBe(10 * GB);
    expect(low).toEqual([]);
    space = 500 * MB; // exactly the minimum is still fine
    await service.checkDisk();
    expect(low).toEqual([]);
    space = 500 * MB - 1;
    await service.checkDisk();
    await service.checkDisk();
    expect(low).toEqual([[ID, 500 * MB - 1]]);
    expect(service.manifestOf(ID)?.error?.code).toBe('DISK_LOW');
  });

  it('does not report sessions that are no longer recording', async () => {
    let space = 10 * GB;
    const low: string[] = [];
    const service = new TrackedService(root, {
      diskCheckEveryMs: 0,
      onDiskLow: (id) => low.push(id),
      fs: realFs({ statfs: () => Promise.resolve({ bavail: space, bsize: 1 }) }),
    });
    await service.create(CONFIG, ID, 1);
    await service.append(ID, 0, chunk(10, 1), 1);
    await service.finish(ID, 0, 1);
    space = MB;
    expect(await service.checkDisk()).toBe(MB);
    expect(low).toEqual([]);
  });
});

describe('SessionService: stopping', () => {
  it('stopping still accepts the last chunks; the manifest says so', async () => {
    const service = new TrackedService(root);
    await service.create(CONFIG, ID, 1);
    await service.append(ID, 0, chunk(10, 1), 1);
    await service.markStopping(ID);
    expect(readManifest().state).toBe('stopping');
    await service.markStopping(ID); // again: no change
    expect((await service.append(ID, 1, chunk(10, 2), 1)).duplicate).toBe(false);
    await service.finish(ID, 1, 1);
    expect(readManifest()).toMatchObject({ state: 'stopped', lastSeq: 1 });
    await service.markStopping(ID); // too late: stays stopped
    expect(readManifest().state).toBe('stopped');
  });
});

describe('SessionService: finalization', () => {
  async function recorded(
    service: SessionService,
    id = ID,
    parts = [chunk(300, 1), chunk(200, 2)],
  ) {
    await service.create(CONFIG, id, 1);
    for (const [seq, part] of parts.entries()) await service.append(id, seq, part, 1);
    await service.finish(id, parts.length - 1, 1);
    return parts;
  }
  const DATE = new Date(2026, 9, 2, 14, 5, 9);

  it('remuxes into a partial file in the output folder, publishes it and removes the session', async () => {
    const service = new TrackedService(root);
    const parts = await recorded(service);
    const tools = fakeTools({
      beforeRun: () => {
        // while ffmpeg runs the manifest already says finalizing, with the partial path
        expect(readManifest()).toMatchObject({ state: 'finalizing' });
        expect(readManifest().finalize?.partialPath).toBe(
          path.join(out, `.framecapt-${ID}.partial.webm`),
        );
      },
    });
    const done = await service.finalize(ID, { outputDir: out, tools, date: DATE });

    expect(path.basename(done.outputPath)).toBe('FrameCapt 2026-10-02 at 14.05.09.webm');
    expect(path.dirname(done.outputPath)).toBe(out);
    expect(done).toMatchObject({ bytes: 500, durationMs: 5000, unindexed: false });
    expect(Buffer.compare(fs.readFileSync(done.outputPath), Buffer.concat(parts))).toBe(0);

    const args = tools.runs[0] ?? [];
    expect(args.slice(args.indexOf('-c'), args.indexOf('-c') + 2)).toEqual(['-c', 'copy']);
    expect(args[args.indexOf('-i') + 1]).toBe(path.join(root, ID, 'stream.webm'));
    expect(args.at(-1)).toBe(path.join(out, `.framecapt-${ID}.partial.webm`));

    // No duplicate stream: the session directory is gone, only the small record remains.
    expect(fs.existsSync(path.join(root, ID))).toBe(false);
    const record = JSON.parse(fs.readFileSync(path.join(root, 'completed', `${ID}.json`), 'utf8'));
    expect(record).toMatchObject({ sessionId: ID, outputPath: done.outputPath, durationMs: 5000 });
    expect(record.stats).toMatchObject({
      mainQueueHighWater: expect.any(Number),
      maxWriteMs: expect.any(Number),
    });
    expect(fs.readdirSync(out)).toEqual(['FrameCapt 2026-10-02 at 14.05.09.webm']); // no partial left
  });

  it('never overwrites an existing file: a number is added', async () => {
    const service = new TrackedService(root);
    await recorded(service);
    fs.writeFileSync(path.join(out, 'FrameCapt 2026-10-02 at 14.05.09.webm'), 'precious');
    fs.writeFileSync(path.join(out, 'FrameCapt 2026-10-02 at 14.05.09 (2).webm'), 'also precious');
    const done = await service.finalize(ID, { outputDir: out, tools: fakeTools(), date: DATE });
    expect(path.basename(done.outputPath)).toBe('FrameCapt 2026-10-02 at 14.05.09 (3).webm');
    expect(fs.readFileSync(path.join(out, 'FrameCapt 2026-10-02 at 14.05.09.webm'), 'utf8')).toBe(
      'precious',
    );
  });

  it('creates the output folder and is idempotent', async () => {
    const service = new TrackedService(root);
    await recorded(service);
    const nested = path.join(out, 'Videos', 'FrameCapt');
    const tools = fakeTools();
    const first = await service.finalize(ID, { outputDir: nested, tools, date: DATE });
    const second = await service.finalize(ID, {
      outputDir: nested,
      tools,
      date: new Date(2030, 0, 1),
    });
    expect(second).toEqual(first);
    expect(tools.runs).toHaveLength(1);
    expect(fs.readdirSync(nested)).toHaveLength(1);
  });

  it('refuses to finalize a recording that is still running', async () => {
    const service = new TrackedService(root);
    await service.create(CONFIG, ID, 1);
    await service.append(ID, 0, chunk(10, 1), 1);
    await expectCode(
      service.finalize(ID, { outputDir: out, tools: fakeTools() }),
      'SESSION_INACTIVE',
    );
  });

  it('a session with no data is "too short" and its (empty) directory is removed', async () => {
    const service = new TrackedService(root);
    await service.create(CONFIG, ID, 1);
    await service.finish(ID, -1, 1);
    const tools = fakeTools();
    await expectCode(service.finalize(ID, { outputDir: out, tools }), 'NOT_FOUND');
    expect(tools.runs).toHaveLength(0);
    expect(fs.existsSync(path.join(root, ID))).toBe(false);
  });

  it('race: a stop while a chunk write is in flight still includes every acknowledged chunk', async () => {
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => (release = resolve));
    let writes = 0;
    const service = new TrackedService(root, {
      fs: realFs({
        open: async (file, flags) => {
          const real = (await fs.promises.open(file, flags)) as unknown as SessionFileHandle;
          return {
            write: async (buffer, offset, length) => {
              writes += 1;
              if (writes === 3) await gate; // the third chunk write is held in flight
              return real.write(buffer, offset, length);
            },
            sync: () => real.sync(),
            close: () => real.close(),
          };
        },
      }),
    });
    await service.create(CONFIG, ID, 1);
    const parts = [chunk(40, 1), chunk(40, 2), chunk(40, 3), chunk(40, 4)];
    const appends = parts.map((part, seq) => service.append(ID, seq, part, 1));
    // stop + finalize are requested while chunk 2 is still being written and 3 is queued
    const stopping = service.markStopping(ID);
    const finishing = service.finish(ID, 3, 1);
    const finalizing = service.finalize(ID, { outputDir: out, tools: fakeTools(), date: DATE });
    await new Promise((resolve) => setTimeout(resolve, 20));
    release?.();
    await Promise.all(appends);
    await stopping;
    await finishing;
    const done = await finalizing;
    expect(Buffer.compare(fs.readFileSync(done.outputPath), Buffer.concat(parts))).toBe(0);
  });

  it('a failed remux keeps stream.webm, records REMUX_FAILED and writes finalize.log', async () => {
    const service = new TrackedService(root);
    await recorded(service);
    const tools = fakeTools({
      code: 1,
      stderr: 'moov atom not found',
      probe: () => ({ ...PLAYABLE, hasVideo: false, video: null }),
    });
    await expectCode(
      service.finalize(ID, { outputDir: out, tools, date: DATE }),
      'FINALIZE_FAILED',
    );
    expect(readManifest()).toMatchObject({ state: 'failed', error: { code: 'REMUX_FAILED' } });
    expect(fs.statSync(path.join(root, ID, 'stream.webm')).size).toBe(500);
    expect(fs.readFileSync(path.join(root, ID, 'finalize.log'), 'utf8')).toContain('moov atom');
    expect(fs.readdirSync(out)).toEqual([]);
  });

  it('a failed remux falls back to a raw copy when the raw stream shows video (unindexed), stream kept', async () => {
    const service = new TrackedService(root);
    const parts = await recorded(service);
    const tools = fakeTools({ code: 1, probe: () => ({ ...PLAYABLE, durationSec: null }) });
    const done = await service.finalize(ID, { outputDir: out, tools, date: DATE });
    expect(done).toMatchObject({ unindexed: true, durationMs: null, bytes: 500 });
    expect(Buffer.compare(fs.readFileSync(done.outputPath), Buffer.concat(parts))).toBe(0);
    expect(readManifest()).toMatchObject({
      state: 'failed',
      unindexed: true,
      outputPath: done.outputPath,
    });
    expect(fs.existsSync(path.join(root, ID, 'stream.webm'))).toBe(true);
    expect(fs.readdirSync(out)).toEqual(['FrameCapt 2026-10-02 at 14.05.09.webm']);
  });

  it('a remux that "succeeds" but yields no duration is a failure, not a published file', async () => {
    const service = new TrackedService(root);
    await recorded(service);
    const tools = fakeTools({
      probe: (file) =>
        file.endsWith('.partial.webm')
          ? { ...PLAYABLE, durationSec: null }
          : { ...PLAYABLE, hasVideo: false, video: null },
    });
    await expectCode(
      service.finalize(ID, { outputDir: out, tools, date: DATE }),
      'FINALIZE_FAILED',
    );
    expect(fs.readdirSync(out)).toEqual([]);
    expect(fs.existsSync(path.join(root, ID, 'stream.webm'))).toBe(true);
  });

  it('an aborted finalization (quit past the cap) leaves the manifest finalizing and the stream intact', async () => {
    const service = new TrackedService(root);
    await recorded(service);
    const controller = new AbortController();
    const tools = fakeTools({
      beforeRun: async (_args, options) => {
        fs.writeFileSync(path.join(out, `.framecapt-${ID}.partial.webm`), 'half');
        await new Promise<void>((resolve) => {
          options.signal?.addEventListener('abort', () => resolve());
          setTimeout(() => controller.abort(), 10);
        });
      },
    });
    await expectCode(
      service.finalize(ID, { outputDir: out, tools, signal: controller.signal, date: DATE }),
      'FINALIZE_FAILED',
    );
    expect(readManifest().state).toBe('finalizing');
    expect(fs.existsSync(path.join(root, ID, 'stream.webm'))).toBe(true);
    expect(fs.readdirSync(out)).toEqual([]); // the partial file of this attempt was removed
  });

  it('not enough free space on the output volume: LOW_DISK, nothing deleted', async () => {
    const service = new TrackedService(root, {
      fs: realFs({
        statfs: (dir) =>
          Promise.resolve({ bavail: dir.startsWith(out) ? 1000 : 10 * 1024 ** 3, bsize: 1 }),
      }),
    });
    await recorded(service);
    await expectCode(
      service.finalize(ID, { outputDir: out, tools: fakeTools(), date: DATE }),
      'LOW_DISK',
    );
    expect(fs.existsSync(path.join(root, ID, 'stream.webm'))).toBe(true);
    expect(readManifest()).toMatchObject({ state: 'failed', error: { code: 'LOW_DISK' } });
  });

  it('missing ffmpeg: FFMPEG_MISSING and the data is kept', async () => {
    const service = new TrackedService(root);
    await recorded(service);
    await expectCode(
      service.finalize(ID, { outputDir: out, tools: fakeTools({ missing: true }), date: DATE }),
      'FFMPEG_MISSING',
    );
    expect(fs.existsSync(path.join(root, ID, 'stream.webm'))).toBe(true);
  });

  it('when the completion record cannot be written only the duplicate stream is removed', async () => {
    const service = new TrackedService(root, {
      fs: realFs({
        mkdir: (dir, options) =>
          dir.endsWith('completed')
            ? Promise.reject(errno('EACCES'))
            : fs.promises.mkdir(dir, options),
      }),
    });
    await recorded(service);
    const done = await service.finalize(ID, { outputDir: out, tools: fakeTools(), date: DATE });
    expect(fs.existsSync(done.outputPath)).toBe(true);
    expect(fs.existsSync(path.join(root, ID, 'stream.webm'))).toBe(false);
    expect(readManifest()).toMatchObject({ state: 'completed', outputPath: done.outputPath });
  });
});

describe('SessionService: abort', () => {
  it('deletes only that session directory and forgets it', async () => {
    const service = new TrackedService(root);
    await service.create(CONFIG, ID);
    await service.create(CONFIG, ID2);
    await service.append(ID, 0, chunk(10, 1));
    await service.abort(ID);
    expect(fs.existsSync(path.join(root, ID))).toBe(false);
    expect(fs.existsSync(path.join(root, ID2))).toBe(true);
    expect(service.has(ID)).toBe(false);
    await service.abort(ID); // again: no error
    await service.abort('../..'); // not a session id: nothing happens
    expect(fs.existsSync(root)).toBe(true);
  });
});
