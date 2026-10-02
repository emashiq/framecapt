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
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'framelet-sessions-'));
  out = fs.mkdtempSync(path.join(os.tmpdir(), 'framelet-out-'));
});
afterEach(async () => {
  await Promise.all(created.splice(0).map((service) => service.closeAll()));
  fs.rmSync(root, { recursive: true, force: true });
  fs.rmSync(out, { recursive: true, force: true });
});

/** The real filesystem behind the SessionFs interface; tests override single operations. */
function realFs(overrides: Partial<SessionFs> = {}): SessionFs {
  return {
    mkdir: (dir, options) => fs.promises.mkdir(dir, options),
    open: (file, flags) => fs.promises.open(file, flags) as unknown as Promise<SessionFileHandle>,
    writeFile: (file, data) => fs.promises.writeFile(file, data),
    rename: (from, to) => fs.promises.rename(from, to),
    rm: (target, options) => fs.promises.rm(target, options),
    copyFile: (from, to, mode) => fs.promises.copyFile(from, to, mode),
    stat: (file) => fs.promises.stat(file),
    ...overrides,
  };
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
    await expectCode(service.append(ID, 1, chunk(51, 2)), 'SEQ_CONFLICT');
    await expectCode(service.append(ID, 0, chunk(100, 1)), 'SEQ_CONFLICT');
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
      failureCode: 'DISK_FULL',
      truncated: true,
      lastSeq: 1,
    });
    expect(fs.statSync(path.join(root, ID, 'stream.webm')).size).toBe(200);
  });

  it('maps EACCES and EIO to WRITE_FAILED', async () => {
    for (const code of ['EACCES', 'EIO', 'EPERM']) {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'framelet-w-'));
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

  it('a failed session can still be stopped and published (the recorded part is kept)', async () => {
    const service = new TrackedService(root, { fs: failingFs('ENOSPC', 2) });
    await service.create(CONFIG, ID);
    await service.append(ID, 0, chunk(64, 7));
    await expectCode(service.append(ID, 1, chunk(64, 8)), 'DISK_FULL');
    const published = await service.publish(ID, out, new Date(2026, 9, 2, 14, 5, 9));
    expect(published.bytes).toBe(64);
    expect(fs.readFileSync(published.outputPath).length).toBe(64);
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

describe('SessionService: publishing', () => {
  async function recorded(
    service: SessionService,
    id = ID,
    parts = [chunk(300, 1), chunk(200, 2)],
  ) {
    await service.create(CONFIG, id);
    for (const [seq, part] of parts.entries()) await service.append(id, seq, part);
    await service.finish(id, parts.length - 1);
    return parts;
  }

  it('copies the stream to "Framelet YYYY-MM-DD at HH.mm.ss.webm" and records the output', async () => {
    const service = new TrackedService(root);
    const parts = await recorded(service);
    const published = await service.publish(ID, out, new Date(2026, 9, 2, 14, 5, 9));
    expect(path.basename(published.outputPath)).toBe('Framelet 2026-10-02 at 14.05.09.webm');
    expect(path.dirname(published.outputPath)).toBe(out);
    expect(published.bytes).toBe(500);
    expect(Buffer.compare(fs.readFileSync(published.outputPath), Buffer.concat(parts))).toBe(0);
    expect(readManifest()).toMatchObject({ state: 'completed', outputPath: published.outputPath });
    // The session directory is kept (phase 06 decides about cleanup) and no temp file is left.
    expect(fs.existsSync(path.join(root, ID, 'stream.webm'))).toBe(true);
    expect(fs.readdirSync(out)).toEqual(['Framelet 2026-10-02 at 14.05.09.webm']);
  });

  it('never overwrites an existing file: a number is added', async () => {
    const service = new TrackedService(root);
    await recorded(service);
    fs.writeFileSync(path.join(out, 'Framelet 2026-10-02 at 14.05.09.webm'), 'precious');
    fs.writeFileSync(path.join(out, 'Framelet 2026-10-02 at 14.05.09 (2).webm'), 'also precious');
    const published = await service.publish(ID, out, new Date(2026, 9, 2, 14, 5, 9));
    expect(path.basename(published.outputPath)).toBe('Framelet 2026-10-02 at 14.05.09 (3).webm');
    expect(fs.readFileSync(path.join(out, 'Framelet 2026-10-02 at 14.05.09.webm'), 'utf8')).toBe(
      'precious',
    );
  });

  it('creates the output folder and is idempotent', async () => {
    const service = new TrackedService(root);
    await recorded(service);
    const nested = path.join(out, 'Videos', 'Framelet');
    const first = await service.publish(ID, nested, new Date(2026, 0, 1, 1, 1, 1));
    const second = await service.publish(ID, nested, new Date(2030, 0, 1, 1, 1, 1));
    expect(second).toEqual(first);
    expect(fs.readdirSync(nested)).toHaveLength(1);
  });

  it('refuses to publish a recording that is still running, or one with no data', async () => {
    const service = new TrackedService(root);
    await service.create(CONFIG, ID);
    await service.append(ID, 0, chunk(10, 1));
    await expectCode(service.publish(ID, out), 'SESSION_INACTIVE');
    const empty = new TrackedService(fs.mkdtempSync(path.join(os.tmpdir(), 'framelet-e-')));
    await empty.create(CONFIG, ID2);
    await empty.finish(ID2, -1);
    await expectCode(empty.publish(ID2, out), 'NOT_FOUND');
    fs.rmSync(empty.rootDir, { recursive: true, force: true });
  });

  it('leaves no final file and no temp file when the copy fails', async () => {
    const service = new TrackedService(root, {
      fs: realFs({
        copyFile: async (from, to) => {
          await fs.promises.writeFile(to, 'partial'); // a partial temp file exists when it fails
          throw errno('ENOSPC');
        },
      }),
    });
    await recorded(service);
    await expectCode(service.publish(ID, out, new Date(2026, 9, 2, 14, 5, 9)), 'DISK_FULL');
    expect(fs.readdirSync(out)).toEqual([]);
    expect(readManifest().state).toBe('stopped'); // still publishable later
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
