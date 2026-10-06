import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_RECORD_OPTIONS } from '../../src/shared/recorder-ipc';
import { IpcError } from '../../src/main/ipc-core';
import { RecoveryService } from '../../src/main/recording/recovery';
import { nodeSessionFs } from '../../src/main/recording/session-fs';
import type { SessionManifest } from '../../src/main/recording/manifest';
import { fakeTools, PLAYABLE, type FakeToolsOptions } from './fake-tools';

const ID_A = '0f0e0d0c-0b0a-4908-8706-050403020100';
const ID_B = '1f1e1d1c-1b1a-4918-8716-151413121110';
const ID_C = '2f2e2d2c-2b2a-4928-8726-252423222120';

let root: string;
let out: string;
let userExports: string;

beforeEach(() => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'framecapt-recovery-'));
  root = path.join(base, 'recordings');
  out = path.join(base, 'Videos', 'FrameCapt');
  userExports = out;
  fs.mkdirSync(root, { recursive: true });
  fs.mkdirSync(out, { recursive: true });
});
afterEach(() => {
  fs.rmSync(path.dirname(path.dirname(out)), { recursive: true, force: true });
});

function manifestFor(id: string, patch: Partial<SessionManifest> = {}): SessionManifest {
  return {
    version: 1,
    sessionId: id,
    createdAt: Date.UTC(2026, 9, 2, 10, 0, 0),
    updatedAt: Date.UTC(2026, 9, 2, 10, 0, 5),
    state: 'recording',
    mime: 'video/webm;codecs=vp9,opus',
    source: { kind: 'screen', name: 'Screen 1' },
    options: DEFAULT_RECORD_OPTIONS,
    width: 1920,
    height: 1080,
    chunksWritten: 7,
    bytesWritten: 700,
    lastSeq: 6,
    pausedIntervals: [],
    stats: {
      queueHighWaterChunks: 0,
      queueHighWaterBytes: 0,
      mainQueueHighWater: 0,
      maxWriteMs: 0,
    },
    appVersion: '0.1.0',
    ...patch,
  };
}

/** Writes a session directory the way an earlier run would have left it. */
function seed(id: string, patch: Partial<SessionManifest> = {}, streamBytes = 700): string {
  const dir = path.join(root, id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(manifestFor(id, patch)));
  if (streamBytes > 0)
    fs.writeFileSync(path.join(dir, 'stream.webm'), Buffer.alloc(streamBytes, 9));
  return dir;
}

function service(options: FakeToolsOptions = {}, active: string[] = []) {
  const tools = fakeTools(options);
  const recovery = new RecoveryService({
    rootDir: root,
    fs: nodeSessionFs,
    tools,
    outputDir: () => out,
    isActive: (id) => active.includes(id),
    now: () => Date.UTC(2026, 9, 2, 12, 0, 0),
  });
  return { recovery, tools };
}

async function expectCode(promise: Promise<unknown>, code: string): Promise<void> {
  const error = await promise.then(
    () => null,
    (caught: unknown) => caught,
  );
  expect(error).toBeInstanceOf(IpcError);
  expect((error as IpcError).code).toBe(code);
}

describe('recovery scan: classification', () => {
  it('unfinished sessions with data are candidates; finished, discarded and empty ones are not', async () => {
    seed(ID_A, { state: 'recording' });
    seed(ID_B, { state: 'stopped', createdAt: Date.UTC(2026, 9, 1) });
    seed(ID_C, { state: 'completed' });
    seed('3f3e3d3c-3b3a-4938-8736-353433323130', { state: 'discarded' });
    seed('4f4e4d4c-4b4a-4948-8746-454443424140', { state: 'failed' }, 0); // no data
    seed('5f5e5d5c-5b5a-4958-8756-555453525150', { state: 'recovered' });
    fs.mkdirSync(path.join(root, 'completed'));
    fs.mkdirSync(path.join(root, 'not-a-session'));
    fs.writeFileSync(path.join(root, 'stray.txt'), 'x');

    const { recovery } = service();
    const list = await recovery.list();
    expect(list.map((c) => c.sessionId)).toEqual([ID_B, ID_A]); // oldest first
    expect(list[1]).toMatchObject({
      sessionId: ID_A,
      bytes: 700,
      sourceKind: 'screen',
      chunks: 7,
      state: 'recording',
      errorCode: null,
    });
  });

  it('every unfinished state is offered: recording, stopping, stopped, failed (with its error)', async () => {
    seed(ID_A, { state: 'stopping' });
    seed(ID_B, { state: 'failed', error: { code: 'DISK_FULL', message: 'full' }, truncated: true });
    const { recovery } = service();
    const list = await recovery.list();
    expect(list.map((c) => [c.state, c.errorCode])).toEqual([
      ['stopping', null],
      ['failed', 'DISK_FULL'],
    ]);
  });

  it('sessions that main is writing right now are never listed', async () => {
    seed(ID_A);
    seed(ID_B);
    const { recovery } = service({}, [ID_A]);
    expect((await recovery.list()).map((c) => c.sessionId)).toEqual([ID_B]);
  });

  it.each([
    ['garbage', 'this is not json {'],
    ['wrong shape', JSON.stringify({ version: 1, sessionId: ID_A })],
    ['empty file', ''],
    ['another session id', JSON.stringify(manifestFor(ID_B))],
  ])(
    'a corrupt manifest (%s) makes the session "unknown", keeps the evidence and does not throw',
    async (_name, text) => {
      const dir = seed(ID_A);
      fs.writeFileSync(path.join(dir, 'manifest.json'), text);
      const { recovery } = service();
      const [candidate] = await recovery.list();
      expect(candidate).toMatchObject({
        sessionId: ID_A,
        state: 'unknown',
        sourceKind: 'unknown',
        bytes: 700,
        errorCode: 'MANIFEST_CORRUPT',
      });
      expect(fs.readFileSync(path.join(dir, 'manifest.corrupt.json'), 'utf8')).toBe(text);
      // and it is now handled like any other session (a valid manifest exists)
      expect(JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8'))).toMatchObject({
        sessionId: ID_A,
        state: 'failed',
      });
    },
  );

  it('a missing manifest is unknown as well (and the scan does not crash)', async () => {
    const dir = seed(ID_A);
    fs.rmSync(path.join(dir, 'manifest.json'));
    const { recovery } = service();
    expect((await recovery.list())[0]).toMatchObject({ sessionId: ID_A, state: 'unknown' });
  });

  it('an unreadable root is an empty list', async () => {
    fs.rmSync(root, { recursive: true, force: true });
    const { recovery } = service();
    expect(await recovery.list()).toEqual([]);
  });
});

describe('startup: interrupted finalization and leftovers', () => {
  const partialOf = (id: string): string => path.join(out, `.framecapt-${id}.partial.webm`);
  const finalizing = (id: string, partialPath = partialOf(id)) =>
    ({
      state: 'finalizing',
      finalize: {
        outputDir: out,
        fileName: 'FrameCapt 2026-10-02 at 10.00.05.webm',
        partialPath,
        startedAt: 1,
      },
    }) satisfies Partial<SessionManifest>;

  it('deletes the matching partial file and runs the remux again; the session is cleaned up', async () => {
    const dir = seed(ID_A, finalizing(ID_A));
    fs.writeFileSync(partialOf(ID_A), 'half a remux');
    const { recovery, tools } = service();
    const report = await recovery.startup();
    expect(report).toMatchObject({ resumed: 1, candidates: 0 });
    expect(tools.runs).toHaveLength(1);
    expect(fs.readdirSync(out)).toEqual(['FrameCapt 2026-10-02 at 10.00.05.webm']);
    expect(fs.existsSync(dir)).toBe(false);
    expect(fs.existsSync(path.join(root, 'completed', `${ID_A}.json`))).toBe(true);
  });

  it('only the partial file of that exact session is deleted: other sessions and user files stay', async () => {
    seed(ID_A, finalizing(ID_A));
    fs.writeFileSync(partialOf(ID_A), 'mine');
    fs.writeFileSync(partialOf(ID_B), 'belongs to another session');
    fs.writeFileSync(path.join(out, 'FrameCapt 2026-10-01 at 09.00.00.webm'), 'user export');
    fs.writeFileSync(path.join(out, 'notes.txt'), 'user file');
    const { recovery } = service();
    await recovery.startup();
    expect(fs.readdirSync(out).sort()).toEqual(
      [
        '.framecapt-1f1e1d1c-1b1a-4918-8716-151413121110.partial.webm',
        'FrameCapt 2026-10-01 at 09.00.00.webm',
        'FrameCapt 2026-10-02 at 10.00.05.webm',
        'notes.txt',
      ].sort(),
    );
    expect(fs.readFileSync(partialOf(ID_B), 'utf8')).toBe('belongs to another session');
  });

  it('a manifest that points the partial path at some other file deletes nothing', async () => {
    const victim = path.join(out, 'important.webm');
    fs.writeFileSync(victim, 'user export');
    seed(ID_A, finalizing(ID_A, victim));
    const { recovery } = service();
    await recovery.startup();
    expect(fs.readFileSync(victim, 'utf8')).toBe('user export');
  });

  it('a manifest naming another session id in the partial name deletes nothing', async () => {
    fs.writeFileSync(partialOf(ID_B), 'other');
    seed(ID_A, finalizing(ID_A, partialOf(ID_B)));
    const { recovery } = service();
    await recovery.startup();
    expect(fs.readFileSync(partialOf(ID_B), 'utf8')).toBe('other');
  });

  it('if the second attempt fails the session stays as a candidate', async () => {
    seed(ID_A, finalizing(ID_A));
    const { recovery } = service({ code: 1 });
    const report = await recovery.startup();
    expect(report.candidates).toBe(1);
    expect((await recovery.list())[0]).toMatchObject({ sessionId: ID_A, state: 'failed' });
    expect(fs.readdirSync(out)).toEqual([]);
  });

  it('removes discarded leftovers and completed ones whose output exists; keeps the rest', async () => {
    const discarded = seed(ID_A, { state: 'discarded' });
    const output = path.join(out, 'FrameCapt done.webm');
    fs.writeFileSync(output, 'video');
    const doneWithOutput = seed(ID_B, { state: 'completed', outputPath: output });
    const doneNoOutput = seed(ID_C, {
      state: 'completed',
      outputPath: path.join(out, 'missing.webm'),
    });
    const { recovery } = service();
    const report = await recovery.startup();
    expect(report.cleaned).toBe(2);
    expect(fs.existsSync(discarded)).toBe(false);
    expect(fs.existsSync(doneWithOutput)).toBe(false);
    expect(fs.existsSync(doneNoOutput)).toBe(true); // output missing: nothing is deleted
    expect(fs.readFileSync(output, 'utf8')).toBe('video'); // exports are never touched
  });

  it('skips active sessions', async () => {
    const dir = seed(ID_A, finalizing(ID_A));
    const { recovery, tools } = service({}, [ID_A]);
    await recovery.startup();
    expect(tools.runs).toHaveLength(0);
    expect(fs.existsSync(dir)).toBe(true);
  });
});

describe('recover', () => {
  it('remuxes, probes, publishes "... (recovered).webm" and removes the session', async () => {
    const dir = seed(ID_A, { state: 'recording' });
    const { recovery, tools } = service();
    const outcome = await recovery.recover(ID_A);
    expect(outcome).toMatchObject({
      outcome: 'recovered',
      fileName: 'FrameCapt 2026-10-02 at 10.00.00 (recovered).webm'.replace(
        '10.00.00',
        expectedTime(),
      ),
      durationMs: 5000,
      bytes: 700,
    });
    expect(tools.runs).toHaveLength(1);
    expect(fs.existsSync(dir)).toBe(false);
    const record = JSON.parse(
      fs.readFileSync(path.join(root, 'completed', `${ID_A}.json`), 'utf8'),
    ) as Record<string, unknown>;
    expect(record).toMatchObject({ recovered: true, sessionId: ID_A });
    expect(fs.readdirSync(out)).toHaveLength(1);
  });

  it('never overwrites an existing recovered file', async () => {
    seed(ID_A);
    const { recovery } = service();
    const first = await recovery.recover(ID_A);
    seed(ID_A);
    const second = await recovery.recover(ID_A);
    if (first.outcome !== 'recovered' || second.outcome !== 'recovered') throw new Error('x');
    expect(second.outputPath).not.toBe(first.outputPath);
    expect(fs.readdirSync(out)).toHaveLength(2);
  });

  it('a stream that cannot be repaired is reported truthfully; the raw data and a log are kept', async () => {
    const dir = seed(ID_A, { state: 'recording' });
    const { recovery } = service({
      code: 1,
      stderr: 'Invalid data found',
      probe: () => ({ ...PLAYABLE, hasVideo: false, video: null }),
    });
    const outcome = await recovery.recover(ID_A);
    expect(outcome).toEqual({ outcome: 'unrecoverable', keptAt: path.join(dir, 'stream.webm') });
    expect(fs.statSync(path.join(dir, 'stream.webm')).size).toBe(700);
    expect(fs.readFileSync(path.join(dir, 'finalize.log'), 'utf8')).toContain('Invalid data');
    expect(JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8'))).toMatchObject({
      state: 'failed',
      error: { code: 'UNREPAIRABLE' },
    });
    expect(fs.readdirSync(out)).toEqual([]);
  });

  it('a "repair" without a video stream or duration is not called a success', async () => {
    seed(ID_A);
    const { recovery } = service({ probe: () => ({ ...PLAYABLE, durationSec: null }) });
    expect((await recovery.recover(ID_A)).outcome).toBe('unrecoverable');
    expect(fs.readdirSync(out)).toEqual([]);
  });

  it('refuses sessions that are active, unknown, empty or already finished', async () => {
    seed(ID_A);
    seed(ID_B, { state: 'completed' });
    seed(ID_C, { state: 'failed' }, 0);
    const { recovery } = service({}, [ID_A]);
    await expectCode(recovery.recover(ID_A), 'BUSY');
    await expectCode(recovery.recover(ID_B), 'NOT_FOUND');
    await expectCode(recovery.recover(ID_C), 'NOT_FOUND');
    await expectCode(recovery.recover('4f4e4d4c-4b4a-4948-8746-454443424140'), 'NOT_FOUND');
  });

  it('missing space on the output volume surfaces as LOW_DISK and keeps the data', async () => {
    const dir = seed(ID_A);
    const recovery = new RecoveryService({
      rootDir: root,
      fs: { ...nodeSessionFs, statfs: () => Promise.resolve({ bavail: 10, bsize: 1 }) },
      tools: fakeTools(),
      outputDir: () => out,
      isActive: () => false,
    });
    await expectCode(recovery.recover(ID_A), 'LOW_DISK');
    expect(fs.existsSync(path.join(dir, 'stream.webm'))).toBe(true);
  });
});

/** The local time of the seeded createdAt, as the file name formats it. */
function expectedTime(): string {
  const date = new Date(Date.UTC(2026, 9, 2, 10, 0, 0));
  const two = (n: number): string => String(n).padStart(2, '0');
  return `${two(date.getHours())}.${two(date.getMinutes())}.${two(date.getSeconds())}`;
}

describe('discard: containment', () => {
  it('deletes exactly that session directory and nothing else', async () => {
    const a = seed(ID_A);
    const b = seed(ID_B);
    fs.writeFileSync(path.join(userExports, 'FrameCapt export.webm'), 'export');
    const { recovery } = service();
    await recovery.discard(ID_A);
    expect(fs.existsSync(a)).toBe(false);
    expect(fs.existsSync(b)).toBe(true);
    expect(fs.readFileSync(path.join(userExports, 'FrameCapt export.webm'), 'utf8')).toBe('export');
    expect(fs.existsSync(root)).toBe(true);
  });

  it.each(['../evil', '..', '.', 'C:\\Windows', '', '0f0e0d0c', `${ID_A}/..`, `..\\${ID_A}`])(
    'refuses %j as a session id and deletes nothing',
    async (id) => {
      const dir = seed(ID_A);
      const sentinel = path.join(path.dirname(root), 'sentinel.txt');
      fs.writeFileSync(sentinel, 's');
      const { recovery } = service();
      await expectCode(recovery.discard(id), 'INVALID_PAYLOAD');
      expect(fs.existsSync(dir)).toBe(true);
      expect(fs.existsSync(sentinel)).toBe(true);
    },
  );

  it('refuses a directory without a manifest, and one whose manifest names another session', async () => {
    const bare = path.join(root, ID_A);
    fs.mkdirSync(bare);
    fs.writeFileSync(path.join(bare, 'precious.txt'), 'not ours');
    const foreign = seed(ID_B);
    fs.writeFileSync(path.join(foreign, 'manifest.json'), JSON.stringify(manifestFor(ID_C)));
    const { recovery } = service();
    await expectCode(recovery.discard(ID_A), 'NOT_FOUND');
    await expectCode(recovery.discard(ID_B), 'NOT_FOUND');
    expect(fs.existsSync(path.join(bare, 'precious.txt'))).toBe(true);
    expect(fs.existsSync(foreign)).toBe(true);
  });

  it('refuses a session that main is using', async () => {
    const dir = seed(ID_A);
    const { recovery } = service({}, [ID_A]);
    await expectCode(recovery.discard(ID_A), 'BUSY');
    expect(fs.existsSync(dir)).toBe(true);
  });

  it('also removes the matching partial file of an interrupted finalization, never another one', async () => {
    const partial = path.join(out, `.framecapt-${ID_A}.partial.webm`);
    fs.writeFileSync(partial, 'mine');
    const other = path.join(out, 'my-video.webm');
    fs.writeFileSync(other, 'user');
    seed(ID_A, {
      state: 'finalizing',
      finalize: { outputDir: out, fileName: 'x.webm', partialPath: partial, startedAt: 1 },
    });
    seed(ID_B, {
      state: 'finalizing',
      finalize: { outputDir: out, fileName: 'x.webm', partialPath: other, startedAt: 1 },
    });
    const { recovery } = service();
    await recovery.discard(ID_A);
    await recovery.discard(ID_B);
    expect(fs.existsSync(partial)).toBe(false);
    expect(fs.readFileSync(other, 'utf8')).toBe('user');
  });

  it('streamPathOf verifies like discard', async () => {
    const dir = seed(ID_A);
    const { recovery } = service();
    expect(await recovery.streamPathOf(ID_A)).toBe(path.join(dir, 'stream.webm'));
    await expectCode(recovery.streamPathOf('../x'), 'INVALID_PAYLOAD');
    await expectCode(recovery.streamPathOf(ID_B), 'NOT_FOUND');
  });
});

describe('recovery: links and tampered session files', () => {
  /** A folder outside the recordings root that something named like a session points at. */
  function outsideTarget(): string {
    const target = path.join(path.dirname(root), 'precious');
    fs.mkdirSync(target, { recursive: true });
    fs.writeFileSync(path.join(target, 'important.txt'), 'do not delete');
    fs.writeFileSync(
      path.join(target, 'manifest.json'),
      JSON.stringify(manifestFor(ID_A, { state: 'discarded' })),
    );
    fs.writeFileSync(path.join(target, 'stream.webm'), Buffer.alloc(100, 1));
    return target;
  }

  it('a junction or symlink named like a session is never scanned, listed, cleaned or discarded', async () => {
    const target = outsideTarget();
    fs.symlinkSync(target, path.join(root, ID_A), 'junction');
    const { recovery } = service();

    const report = await recovery.startup(); // a "discarded" manifest behind the link would be rm -rf'd
    expect(report.scanned).toBe(0);
    expect(await recovery.list()).toEqual([]);
    await expectCode(recovery.discard(ID_A), 'NOT_FOUND');
    await expectCode(recovery.recover(ID_A), 'NOT_FOUND');

    expect(fs.readFileSync(path.join(target, 'important.txt'), 'utf8')).toBe('do not delete');
    expect(fs.existsSync(path.join(target, 'stream.webm'))).toBe(true);
  });

  it('a finalization plan with a relative folder or a path as its file name is not honoured', async () => {
    const dir = seed(ID_A, {
      state: 'finalizing',
      finalize: {
        outputDir: 'relative/folder',
        fileName: '../../escape.webm',
        partialPath: path.join('relative', 'folder', `.framecapt-${ID_A}.partial.webm`),
        startedAt: 1,
      },
    });
    const { recovery } = service();
    await recovery.startup();
    // The output went to the app's own output folder under a plain file name.
    const files = fs.readdirSync(out);
    expect(files).toHaveLength(1);
    expect(files[0]).toMatch(/^FrameCapt .*\.webm$/);
    expect(fs.existsSync(path.join(path.dirname(out), '..', 'escape.webm'))).toBe(false);
    expect(fs.existsSync(dir)).toBe(false);
  });
});
