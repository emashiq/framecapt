import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { IpcError } from '../../src/main/ipc-core';
import type { exportEdit } from '../../src/main/media/edit-export';
import { FfmpegError, type ProbeResult } from '../../src/main/media/ffmpeg';
import { JobRunner } from '../../src/main/media/job-runner';
import { VideoEditService, editedDestination } from '../../src/main/video-projects/service';
import { freeFileName } from '../../src/main/shots/free-name';
import { applyCommand, createProject, newItem, rectOf } from '../../src/shared/video-edit';
import { buildFcapHeaderBlock } from '../../src/main/recording/fcap';
import { fakeTools, PLAYABLE } from './fake-tools';

const ID = '11111111-1111-4111-8111-111111111111';
const NEW_ID = '33333333-3333-4333-8333-333333333333';
const PROBE: ProbeResult = {
  ...PLAYABLE,
  durationSec: 12,
  video: { ...PLAYABLE.video!, width: 1280, height: 720 },
};

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'framecapt-video-edit-'));
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

function setup(
  options: {
    format?: string;
    type?: string;
    missingFile?: boolean;
    /** An fcap source file made from this header (the tests do not need a payload). */
    fcap?: boolean;
    stored?: ReturnType<typeof createProject> | null;
    probe?: ProbeResult | Error;
    export?: typeof exportEdit;
  } = {},
) {
  const source = path.join(dir, options.fcap ? 'Clip.fcap' : 'Clip.webm');
  if (options.missingFile) fs.rmSync(source, { force: true });
  else if (options.fcap) {
    fs.writeFileSync(
      source,
      Buffer.concat([
        buildFcapHeaderBlock(
          {
            width: 1280,
            height: 720,
            durationMs: 12_000,
            hasAudio: true,
            createdAt: 0,
            sources: [
              { name: 'Screen 1', kind: 'screen', rect: { x: 0, y: 0, width: 640, height: 720 } },
              { name: 'Window 2', kind: 'window', rect: { x: 640, y: 0, width: 640, height: 720 } },
            ],
          },
          4,
        ),
        Buffer.from('webm'),
      ]),
    );
  } else fs.writeFileSync(source, 'webm');
  const events: string[] = [];
  const probedAs: (string | undefined)[] = [];
  const written: unknown[] = [];
  const added: unknown[] = [];
  const runner = new JobRunner();
  const service = new VideoEditService({
    history: {
      get: (id) =>
        id === ID
          ? ({
              id: ID,
              type: options.type ?? 'recording',
              path: source,
              format: options.fcap ? 'fcap' : (options.format ?? 'webm'),
              width: 1280,
              height: 720,
              durationMs: 12_000,
              source: 'screen',
            } as never)
          : undefined,
      addVideo: (input) => {
        added.push(input);
        return Promise.resolve({ id: NEW_ID });
      },
    },
    store: {
      read: () =>
        Promise.resolve(
          options.stored
            ? { ok: true as const, project: options.stored }
            : { ok: false as const, reason: 'missing' as const },
        ),
      write: (_id, project) => {
        written.push(project);
        return Promise.resolve();
      },
      writePicture: () => Promise.resolve('0'.repeat(64)),
      importAudio: () => Promise.reject(new Error('not in this test')),
      removeAsset: () => Promise.resolve(),
      pruneAssets: () => Promise.resolve(0),
      assetPath: () => null,
    },
    pickAudioFile: () => Promise.resolve(null),
    tools: fakeTools({
      probe: (_file, format) => {
        probedAs.push(format);
        return options.probe ?? PROBE;
      },
    }),
    runner,
    destination: (src, extension) => editedDestination(src, extension, freeFileName),
    emit: {
      progress: (event) => events.push(`progress:${event.percent}`),
      done: (event) =>
        events.push(`done:${event.format}:${event.itemId}:${path.basename(event.path)}`),
      failed: (event) => events.push(`failed:${event.code}:${event.cancelled}`),
    },
    ...(options.export && { exportEdit: options.export }),
  });
  return { service, runner, events, written, added, source, probedAs };
}

const okExport =
  (format = 'mp4'): typeof exportEdit =>
  (request) => {
    request.onProgress?.(50);
    return Promise.resolve({
      ok: true,
      path: request.destPath,
      bytes: 99,
      durationMs: 7000,
      probe: {
        ...PROBE,
        video: { ...PROBE.video!, width: 640, height: 360 },
        hasAudio: format !== 'gif',
      },
    });
  };

describe('VideoEditService.open', () => {
  it('makes a new project from the file when none was saved', async () => {
    const { service } = setup();
    const { project, restored } = await service.open(ID);
    expect(restored).toBe(false);
    expect(project.sourceId).toBe(ID);
    expect(project.source).toEqual({
      durationMs: 12_000,
      width: 1280,
      height: 720,
      hasAudio: true,
    });
    expect(project.trim).toEqual({ startMs: 0, endMs: 12_000 });
  });

  it('restores a saved project and refreshes its source facts from the file', async () => {
    const stored = applyCommand(
      createProject(ID, { durationMs: 20_000, width: 1920, height: 1080, hasAudio: false }),
      {
        type: 'addItem',
        item: newItem('redact', 'r', { x: 1500, y: 900, width: 200, height: 100 }, 0, 18_000),
      },
    );
    const { service } = setup({ stored });
    const { project, restored } = await service.open(ID);
    expect(restored).toBe(true);
    expect(project.source).toMatchObject({
      durationMs: 12_000,
      width: 1280,
      height: 720,
      hasAudio: true,
    });
    // The box now has to fit the smaller frame.
    expect(rectOf(project.items[0])?.x).toBeLessThanOrEqual(1080);
    expect(project.items[0]?.endMs).toBeLessThanOrEqual(12_000);
  });

  it('opens a multi-source recording: probed from its payload, with its sources as the layout', async () => {
    const { service, probedAs } = setup({ fcap: true });
    const { project, layout } = await service.open(ID);
    expect(probedAs).toEqual(['fcap']);
    expect(layout?.sources.map((s) => s.name)).toEqual(['Screen 1', 'Window 2']);
    expect(layout).toMatchObject({ width: 1280, height: 720 });
    expect(project.source).toMatchObject({ width: 1280, height: 720 });
    expect((await setup().service.open(ID)).layout).toBeNull();
  });

  it('refuses what it cannot edit', async () => {
    await expect(setup({ type: 'screenshot' }).service.open(ID)).rejects.toMatchObject({
      code: 'INVALID_PAYLOAD',
    });
    await expect(setup({ format: 'gif' }).service.open(ID)).rejects.toMatchObject({
      code: 'INVALID_PAYLOAD',
    });
    await expect(setup().service.open(NEW_ID)).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(setup({ missingFile: true }).service.open(ID)).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
    await expect(
      setup({ probe: new FfmpegError('PROBE_FAILED', 'x') }).service.open(ID),
    ).rejects.toBeInstanceOf(IpcError);
    await expect(
      setup({ probe: { ...PROBE, hasVideo: false, video: null } }).service.open(ID),
    ).rejects.toMatchObject({ code: 'INVALID_PAYLOAD' });
  });
});

describe('VideoEditService.save', () => {
  it('stores a normalized project for its own history item only', async () => {
    const { service, written } = setup();
    const project = createProject(ID, {
      durationMs: 12_000,
      width: 1280,
      height: 720,
      hasAudio: true,
    });
    await service.save(ID, project);
    expect(written).toEqual([project]);
    await expect(service.save(ID, { ...project, sourceId: NEW_ID })).rejects.toBeInstanceOf(
      IpcError,
    );
    await expect(service.save(NEW_ID, { ...project, sourceId: NEW_ID })).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
  });
});

describe('VideoEditService.export', () => {
  const project = () =>
    createProject(ID, { durationMs: 12_000, width: 1280, height: 720, hasAudio: true });

  it('queues a job, reports progress and adds the new file to history as derived from the source', async () => {
    const { service, runner, events, added, written } = setup({ export: okExport() });
    const { jobId } = await service.export(ID, project(), 'mp4');
    expect(jobId).toBeTruthy();
    await runner.idle();
    expect(events).toEqual(['progress:50', `done:mp4:${NEW_ID}:Clip (edited).mp4`]);
    expect(added).toEqual([
      expect.objectContaining({
        format: 'mp4',
        derivedFrom: ID,
        durationMs: 7000,
        width: 640,
        source: 'screen',
      }),
    ]);
    expect(written).toHaveLength(1); // the project is saved with the export
  });

  it('exports a multi-source recording as a normal derived MP4 (the source is read as an fcap)', async () => {
    let request: Parameters<typeof exportEdit>[0] | undefined;
    const exporter: typeof exportEdit = (r) => {
      request = r;
      return okExport()(r);
    };
    const { service, runner, events, added } = setup({ fcap: true, export: exporter });
    await service.export(ID, project(), 'mp4');
    await runner.idle();
    expect(request).toMatchObject({ sourceFormat: 'fcap' });
    expect(events.at(-1)).toBe(`done:mp4:${NEW_ID}:Clip (edited).mp4`);
    expect(added[0]).toMatchObject({ format: 'mp4', derivedFrom: ID });
  });

  it('adds a GIF as a recording of format gif and picks a free name', async () => {
    const { service, runner, events, added, source } = setup({ export: okExport('gif') });
    fs.writeFileSync(path.join(path.dirname(source), 'Clip (edited).gif'), 'x');
    await service.export(ID, project(), 'gif');
    await runner.idle();
    expect(events.at(-1)).toBe(`done:gif:${NEW_ID}:Clip (edited) (2).gif`);
    expect(added[0]).toMatchObject({ format: 'gif', hasAudio: false });
  });

  it('reports a failed export and a cancelled one', async () => {
    const failing = setup({
      export: () => Promise.resolve({ ok: false, code: 'FAILED', message: 'no', stderrTail: '' }),
    });
    await failing.service.export(ID, project(), 'webm');
    await failing.runner.idle();
    expect(failing.events).toEqual(['failed:FAILED:false']);

    const cancelled = setup({
      export: () => Promise.resolve({ ok: false, code: 'CANCELLED', message: 'c', stderrTail: '' }),
    });
    await cancelled.service.export(ID, project(), 'webm');
    await cancelled.runner.idle();
    expect(cancelled.events).toEqual(['failed:CANCELLED:true']);
  });

  it('refuses a second export of the same recording until the first one ended', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const { service, runner } = setup({
      export: async (request) => {
        await gate;
        return okExport()(request);
      },
    });
    const first = await service.export(ID, project(), 'mp4');
    await expect(service.export(ID, project(), 'mp4')).rejects.toMatchObject({ code: 'BUSY' });
    release();
    await runner.idle();
    await new Promise((resolve) => setTimeout(resolve, 0));
    await expect(service.export(ID, project(), 'mp4')).resolves.toHaveProperty('jobId');
    expect(first.jobId).not.toBe('');
    await runner.idle();
  });

  it('can be cancelled through the queue before it starts', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const { service, runner, events } = setup({
      export: async (request) => {
        await gate;
        return okExport()(request);
      },
    });
    // Occupy the queue so the export has to wait.
    runner.enqueue({ id: 'busy', label: 'busy', run: () => gate });
    const { jobId } = await service.export(ID, project(), 'mp4');
    expect(runner.cancel(jobId)).toBe(true);
    release();
    await runner.idle();
    expect(events).toEqual([]);
  });

  it('refuses a project of another recording', async () => {
    const { service } = setup();
    await expect(
      service.export(ID, { ...project(), sourceId: NEW_ID }, 'mp4'),
    ).rejects.toMatchObject({
      code: 'INVALID_PAYLOAD',
    });
  });
});
