import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FfmpegError, type ProbeResult } from '../../src/main/media/ffmpeg';
import { JobRunner, partialPathFor, runFileJob } from '../../src/main/media/job-runner';
import { fakeTools, PLAYABLE } from './fake-tools';

/** A job that finishes when `release()` is called (or fails when aborted). */
function gate() {
  let release!: () => void;
  const opened = new Promise<void>((resolve) => (release = resolve));
  return { opened, release };
}

describe('JobRunner', () => {
  it('runs one job at a time, in order', async () => {
    const runner = new JobRunner();
    const log: string[] = [];
    const first = gate();
    const a = runner.enqueue({
      id: 'a',
      label: 'a',
      run: async () => {
        log.push('a:start');
        await first.opened;
        log.push('a:end');
        return 1;
      },
    });
    const b = runner.enqueue({
      id: 'b',
      label: 'b',
      run: () => {
        log.push('b:start');
        return Promise.resolve(2);
      },
    });
    await Promise.resolve();
    expect(log).toEqual(['a:start']);
    expect(runner.busy).toBe(true);
    first.release();
    expect(await a.done).toEqual({ ok: true, value: 1 });
    expect(await b.done).toEqual({ ok: true, value: 2 });
    expect(log).toEqual(['a:start', 'a:end', 'b:start']);
    await runner.idle();
    expect(runner.busy).toBe(false);
  });

  it('cancel aborts the running job and removes a queued one before it starts', async () => {
    const runner = new JobRunner();
    let startedB = false;
    const a = runner.enqueue({
      id: 'a',
      label: 'a',
      run: ({ signal }) =>
        new Promise<void>((_, reject) =>
          signal.addEventListener('abort', () => reject(new Error('aborted'))),
        ),
    });
    const b = runner.enqueue({
      id: 'b',
      label: 'b',
      run: () => {
        startedB = true;
        return Promise.resolve();
      },
    });
    expect(runner.cancel('b')).toBe(true);
    expect(runner.cancel('a')).toBe(true);
    expect(await a.done).toMatchObject({ ok: false, cancelled: true });
    expect(await b.done).toEqual({ ok: false, cancelled: true });
    expect(startedB).toBe(false);
    expect(runner.cancel('a')).toBe(false);
    expect(runner.busy).toBe(false);
  });

  it('cancelAll aborts the running job, drops the queue and waits for the cleanup', async () => {
    const runner = new JobRunner();
    let cleaned = false;
    runner.enqueue({
      id: 'a',
      label: 'a',
      run: ({ signal }) =>
        new Promise<void>((resolve) =>
          signal.addEventListener('abort', () => {
            setTimeout(() => {
              cleaned = true;
              resolve();
            }, 20);
          }),
        ),
    });
    const queued = runner.enqueue({ id: 'b', label: 'b', run: () => Promise.resolve() });
    await runner.cancelAll();
    expect(cleaned).toBe(true);
    expect(await queued.done).toMatchObject({ ok: false, cancelled: true });
    expect(runner.busy).toBe(false);
  });

  it('a throwing job is a failed outcome and the next job still runs', async () => {
    const runner = new JobRunner();
    const a = runner.enqueue({ id: 'a', label: 'a', run: () => Promise.reject(new Error('x')) });
    const b = runner.enqueue({ id: 'b', label: 'b', run: () => Promise.resolve('ok') });
    expect(await a.done).toMatchObject({ ok: false, cancelled: false });
    expect(await b.done).toEqual({ ok: true, value: 'ok' });
  });

  it('forwards progress and drops repeated values', async () => {
    const runner = new JobRunner();
    const seen: (number | null)[] = [];
    const job = runner.enqueue({
      id: 'a',
      label: 'a',
      onProgress: (percent) => seen.push(percent),
      run: ({ onProgress }) => {
        for (const value of [null, 10, 10, 50, 50, 99]) onProgress(value);
        return Promise.resolve();
      },
    });
    await job.done;
    expect(seen).toEqual([null, 10, 50, 99]);
  });

  it('rejects a duplicate id', () => {
    const runner = new JobRunner();
    runner.enqueue({ id: 'a', label: 'a', run: () => new Promise<void>(() => undefined) });
    expect(() => runner.enqueue({ id: 'a', label: 'a', run: () => Promise.resolve() })).toThrow(
      /already exists/,
    );
  });
});

describe('runFileJob', () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'framecapt-job-'));
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const OUT: ProbeResult = { ...PLAYABLE, formatName: 'mp4', durationSec: 5 };
  const partials = (): string[] => fs.readdirSync(dir).filter((name) => name.includes('.partial.'));
  function request(overrides: Partial<Parameters<typeof runFileJob>[0]> = {}) {
    const source = path.join(dir, 'in.webm');
    fs.writeFileSync(source, 'webm');
    return {
      tools: fakeTools({ probe: (file) => (file.endsWith('.mp4') ? OUT : PLAYABLE) }),
      sourcePath: source,
      destPath: path.join(dir, 'out.mp4'),
      args: (partial: string) => ['-i', source, partial],
      verify: () => null,
      noun: 'test',
      ...overrides,
    };
  }

  it('names the partial next to the destination with the same extension', () => {
    const partial = partialPathFor(path.join(dir, 'out.mp4'));
    expect(path.dirname(partial)).toBe(dir);
    expect(partial).toMatch(/\.partial\.mp4$/);
  });

  it('writes through a partial, verifies, then renames', async () => {
    const result = await runFileJob(request());
    expect(result).toMatchObject({ ok: true, path: path.join(dir, 'out.mp4') });
    expect(fs.existsSync(path.join(dir, 'out.mp4'))).toBe(true);
    expect(partials()).toEqual([]);
  });

  it('a failed verification leaves no output and no partial', async () => {
    const result = await runFileJob(request({ verify: () => 'bad output' }));
    expect(result).toMatchObject({ ok: false, code: 'VERIFY_FAILED', message: 'bad output' });
    expect(fs.existsSync(path.join(dir, 'out.mp4'))).toBe(false);
    expect(partials()).toEqual([]);
  });

  it('an ffmpeg failure cleans up the partial', async () => {
    const result = await runFileJob(
      request({ tools: fakeTools({ code: 1, stderr: 'boom', probe: () => PLAYABLE }) }),
    );
    expect(result).toMatchObject({ ok: false, code: 'FAILED' });
    expect(partials()).toEqual([]);
  });

  it('cancel while encoding is CANCELLED and cleans up', async () => {
    const controller = new AbortController();
    const tools = fakeTools({
      probe: () => PLAYABLE,
      beforeRun: () => {
        controller.abort();
      },
    });
    const result = await runFileJob(request({ tools, signal: controller.signal }));
    expect(result).toMatchObject({
      ok: false,
      code: 'CANCELLED',
      message: 'The test was cancelled.',
    });
    expect(partials()).toEqual([]);
    expect(fs.existsSync(path.join(dir, 'out.mp4'))).toBe(false);
  });

  it('an unreadable source is reported before any encoding', async () => {
    const tools = fakeTools({ probe: () => new FfmpegError('FFMPEG_FAILED', 'nope') });
    const result = await runFileJob(request({ tools }));
    expect(result).toMatchObject({ ok: false, code: 'SOURCE_UNREADABLE' });
    expect(tools.runs).toEqual([]);
  });
});
