import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { EditExportRequest } from '../../src/main/media/edit-export';
import { FfmpegError, type ProbeResult } from '../../src/main/media/ffmpeg';
import { JobRunner } from '../../src/main/media/job-runner';
import { freeFileName } from '../../src/main/shots/free-name';
import { VideoEditService, editedDestination } from '../../src/main/video-projects/service';
import {
  applyCommand,
  createProject,
  newAudio,
  newText,
  type VideoProject,
} from '../../src/shared/video-edit';
import { fakeTools, PLAYABLE } from './fake-tools';
import { pngBytes } from './project-fixtures';

const ID = '11111111-1111-4111-8111-111111111111';
const NEW_ID = '33333333-3333-4333-8333-333333333333';
const ASSET = 'e'.repeat(64);
const PROBE: ProbeResult = {
  ...PLAYABLE,
  durationSec: 12,
  video: { ...PLAYABLE.video!, width: 1280, height: 720 },
};
const AUDIO_PROBE: ProbeResult = {
  ...PLAYABLE,
  hasVideo: false,
  video: null,
  audioCodec: 'mp3',
  durationSec: 42.5,
  formatName: 'mp3',
};

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'framecapt-video-svc-'));
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

function setup(
  options: {
    item?: Record<string, unknown>;
    probe?: (file: string) => ProbeResult | Error;
    picked?: string | null;
    exporter?: (request: EditExportRequest) => ReturnType<typeof okResult>;
    stored?: VideoProject;
  } = {},
) {
  const source = path.join(dir, 'Clip.webm');
  fs.writeFileSync(source, 'webm');
  const calls = {
    pruned: [] as number[],
    removed: [] as string[],
    imported: [] as string[],
    added: [] as Record<string, unknown>[],
    requests: [] as EditExportRequest[],
  };
  const runner = new JobRunner();
  const service = new VideoEditService({
    history: {
      get: (id) =>
        id === ID
          ? ({
              id: ID,
              type: 'recording',
              path: source,
              format: 'webm',
              width: 1280,
              height: 720,
              durationMs: 12_000,
              source: 'screen',
              ...options.item,
            } as never)
          : undefined,
      addVideo: (input) => {
        calls.added.push(input as unknown as Record<string, unknown>);
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
      write: () => Promise.resolve(),
      writePicture: (_id, png) => {
        if (png.length < 40) return Promise.reject(new Error('bad'));
        return Promise.resolve(ASSET);
      },
      importAudio: (_id, file, ext) => {
        calls.imported.push(file);
        const copy = path.join(dir, `${ASSET}.${ext}`);
        fs.copyFileSync(file, copy);
        return Promise.resolve({ assetId: ASSET, file: copy });
      },
      removeAsset: (_id, assetId, ext) => {
        calls.removed.push(`${assetId}.${ext}`);
        return Promise.resolve();
      },
      pruneAssets: (_id, _project, minAge) => {
        calls.pruned.push(minAge);
        return Promise.resolve(0);
      },
      assetPath: (_id, assetId, ext) => path.join(dir, `${assetId}.${ext}`),
    },
    pickAudioFile: () => Promise.resolve(options.picked === undefined ? null : options.picked),
    tools: fakeTools({
      probe: (file) =>
        options.probe ? options.probe(file) : file.endsWith('.webm') ? PROBE : AUDIO_PROBE,
    }),
    runner,
    destination: (src, extension) => editedDestination(src, extension, freeFileName),
    emit: { progress: () => undefined, done: () => undefined, failed: () => undefined },
    exportEdit: (request) => {
      calls.requests.push(request);
      return (options.exporter ?? (() => okResult(request)))(request);
    },
  });
  return { service, runner, calls, source };
}

function okResult(request: EditExportRequest) {
  return Promise.resolve({
    ok: true as const,
    path: request.destPath,
    bytes: 99,
    durationMs: 7000,
    probe: { ...PROBE, frameRate: 60, video: { ...PROBE.video!, width: 640, height: 360 } },
  });
}

const textProject = (): VideoProject =>
  applyCommand(
    createProject(ID, { durationMs: 12_000, width: 1280, height: 720, hasAudio: true }),
    {
      type: 'addItem',
      item: newText('t1', { x: 10, y: 10, width: 64, height: 32 }, 0, 2000),
    },
  );

describe('frame rate', () => {
  it('uses what the recorder was asked for, else a believable rate from the file, else nothing', async () => {
    const recorded = await setup({ item: { fps: 60 } }).service.open(ID);
    expect(recorded.project.source.fps).toBe(60);
    const guessed = await setup({
      probe: () => ({ ...PROBE, frameRate: 24 }),
    }).service.open(ID);
    expect(guessed.project.source.fps).toBe(24);
    const unknown = await setup().service.open(ID);
    expect(unknown.project.source).not.toHaveProperty('fps');
    // The recorder's rate wins over the file's.
    const both = await setup({
      item: { fps: 30 },
      probe: () => ({ ...PROBE, frameRate: 60 }),
    }).service.open(ID);
    expect(both.project.source.fps).toBe(30);
  });

  it('a saved project gets the rate too, and the new file keeps the rate it was made at', async () => {
    const stored = createProject(ID, {
      durationMs: 12_000,
      width: 1280,
      height: 720,
      hasAudio: true,
    });
    const { service, runner, calls } = setup({ item: { fps: 60 }, stored });
    expect((await service.open(ID)).project.source.fps).toBe(60);
    await service.export(ID, stored, 'mp4');
    await runner.idle();
    expect(calls.added[0]).toMatchObject({ fps: 60 });
  });
});

describe('pictures for image items', () => {
  it('stores a picture of a recording in history and refuses junk', async () => {
    const { service } = setup();
    await expect(service.addImage(ID, pngBytes(40, 40))).resolves.toEqual({ assetId: ASSET });
    await expect(service.addImage(ID, new Uint8Array(4))).rejects.toMatchObject({
      code: 'INVALID_PAYLOAD',
    });
    await expect(service.addImage(NEW_ID, pngBytes(40, 40))).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
  });
});

describe('audio files for clips', () => {
  const song = () => {
    const file = path.join(dir, 'My Song.MP3');
    fs.writeFileSync(file, 'audio');
    return file;
  };

  it('copies the chosen file into the project and reports its length and name', async () => {
    const { service, calls } = setup({ picked: song() });
    const result = await service.pickAudio(ID);
    expect(result).toEqual({ assetId: ASSET, ext: 'mp3', name: 'My Song.MP3', durationMs: 42_500 });
    expect(calls.imported).toHaveLength(1);
    expect(calls.removed).toEqual([]);
  });

  it('a cancelled dialog adds nothing', async () => {
    const { service, calls } = setup({ picked: null });
    expect(await service.pickAudio(ID)).toEqual({ cancelled: true });
    expect(calls.imported).toEqual([]);
  });

  it('refuses another type of file before copying it', async () => {
    const file = path.join(dir, 'movie.mkv');
    fs.writeFileSync(file, 'x');
    const { service, calls } = setup({ picked: file });
    await expect(service.pickAudio(ID)).rejects.toMatchObject({ code: 'INVALID_PAYLOAD' });
    expect(calls.imported).toEqual([]);
  });

  it('a file without audio, without a length, or longer than two hours is refused and removed again', async () => {
    const cases: [string, ProbeResult | Error][] = [
      ['no audio', { ...AUDIO_PROBE, hasAudio: false, audioCodec: null }],
      ['no length', { ...AUDIO_PROBE, durationSec: null }],
      ['too long', { ...AUDIO_PROBE, durationSec: 2 * 3600 + 5 }],
      ['unreadable', new FfmpegError('PROBE_FAILED', 'x')],
    ];
    for (const [label, probe] of cases) {
      const { service, calls } = setup({ picked: song(), probe: () => probe });
      await expect(service.pickAudio(ID), label).rejects.toMatchObject({ code: 'INVALID_PAYLOAD' });
      expect(calls.removed, label).toEqual([`${ASSET}.mp3`]);
    }
  });

  it('refuses a file over the size limit without copying it', async () => {
    const file = path.join(dir, 'big.wav');
    fs.writeFileSync(file, 'x');
    fs.truncateSync(file, 100 * 1024 * 1024 + 1);
    const { service, calls } = setup({ picked: file });
    await expect(service.pickAudio(ID)).rejects.toMatchObject({ code: 'INVALID_PAYLOAD' });
    expect(calls.imported).toEqual([]);
  });

  it('keeps control characters out of the label', async () => {
    const file = path.join(dir, 'a\u0007b.mp3');
    try {
      fs.writeFileSync(file, 'audio');
    } catch {
      return; // the file system refuses such a name: nothing to test here
    }
    const { service } = setup({ picked: file });
    expect(((await service.pickAudio(ID)) as { name: string }).name).toBe('ab.mp3');
  });
});

describe('text pictures in an export', () => {
  const overlay = (png: Uint8Array, itemId = 't1') => ({ itemId, png });

  it('passes each text picture and the asset resolver to the render', async () => {
    const { service, runner, calls } = setup();
    const png = pngBytes(64, 32);
    await service.export(ID, textProject(), 'mp4', [overlay(png)]);
    await runner.idle();
    const [request] = calls.requests;
    expect(request?.textPngs?.['t1']).toBe(png);
    expect(request?.assetPath?.(ASSET, 'png')).toBe(path.join(dir, `${ASSET}.png`));
  });

  it('refuses a missing picture, a wrong size, and bytes that are not a PNG', async () => {
    const { service, calls } = setup();
    const project = textProject();
    await expect(service.export(ID, project, 'mp4', [])).rejects.toMatchObject({
      code: 'INVALID_PAYLOAD',
    });
    await expect(
      service.export(ID, project, 'mp4', [overlay(pngBytes(65, 32))]),
    ).rejects.toMatchObject({
      code: 'INVALID_PAYLOAD',
    });
    await expect(
      service.export(ID, project, 'mp4', [overlay(Buffer.from('GIF89a......................'))]),
    ).rejects.toMatchObject({ code: 'INVALID_PAYLOAD' });
    await expect(
      service.export(ID, project, 'mp4', [overlay(pngBytes(64, 32), 'other')]),
    ).rejects.toMatchObject({ code: 'INVALID_PAYLOAD' });
    expect(calls.requests).toEqual([]);
  });

  it('ignores pictures that belong to no text item and needs none for other kinds', async () => {
    const { service, runner, calls } = setup();
    const clipProject = applyCommand(
      createProject(ID, { durationMs: 12_000, width: 1280, height: 720, hasAudio: true }),
      {
        type: 'addItem',
        item: newAudio('a1', { assetId: ASSET, ext: 'mp3', name: 'x', clipMs: 3000 }, 0),
      },
    );
    await service.export(ID, clipProject, 'mp4', []);
    await runner.idle();
    expect(calls.requests[0]?.textPngs).toEqual({});
  });
});

describe('saving prunes stale assets', () => {
  it('a save prunes with a grace period and an open prunes right away', async () => {
    const stored = createProject(ID, {
      durationMs: 12_000,
      width: 1280,
      height: 720,
      hasAudio: true,
    });
    const { service, calls } = setup({ stored });
    await service.save(ID, stored);
    await service.open(ID);
    expect(calls.pruned).toEqual([10 * 60 * 1000, 0]);
  });
});
