import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { HistoryService, validThumbnail } from '../../src/main/history/service';
import { IpcError } from '../../src/main/ipc-core';
import { FfmpegError } from '../../src/main/media/ffmpeg';
import { fakeTools, PLAYABLE } from './fake-tools';

let dir: string;
let files: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'framecapt-hsvc-'));
  files = path.join(dir, 'files');
  fs.mkdirSync(files);
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

/** Signature + IHDR only: what the magic-byte and width checks read. */
function fakePng(width: number, extra = 100): Buffer {
  const header = Buffer.alloc(33 + extra);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(header, 0);
  header.writeUInt32BE(13, 8);
  header.write('IHDR', 12, 'latin1');
  header.writeUInt32BE(width, 16);
  header.writeUInt32BE(40, 20);
  return header;
}

function makeService(
  options: {
    tools?: ReturnType<typeof fakeTools>;
    videoProjects?: NonNullable<ConstructorParameters<typeof HistoryService>[0]['videoProjects']>;
  } = {},
) {
  const trashed: string[] = [];
  const changes = { count: 0 };
  const tools = options.tools ?? fakeTools();
  const service = new HistoryService({
    dir: path.join(dir, 'history'),
    tools,
    ...(options.videoProjects && { videoProjects: options.videoProjects }),
    trashItem: (file) => {
      trashed.push(file);
      fs.rmSync(file);
      return Promise.resolve();
    },
    onChange: () => {
      changes.count += 1;
    },
    undoWindowMs: 60,
  });
  return { service, trashed, tools, changes };
}

function writeFile(name: string, content: string | Buffer = 'data'): string {
  const file = path.join(files, name);
  fs.writeFileSync(file, content);
  return file;
}

const thumbDir = (): string => path.join(dir, 'history', 'thumbs');
const thumbs = (): string[] => (fs.existsSync(thumbDir()) ? fs.readdirSync(thumbDir()) : []);

async function addShot(
  service: HistoryService,
  name: string,
  extra: Partial<Parameters<HistoryService['addScreenshot']>[0]> = {},
) {
  const file = writeFile(name, fakePng(100));
  return service.addScreenshot({
    path: file,
    width: 800,
    height: 600,
    sizeBytes: 133,
    format: 'png',
    source: 'region',
    ...extra,
  });
}

async function addVideo(
  service: HistoryService,
  name: string,
  extra: Partial<Parameters<HistoryService['addVideo']>[0]> = {},
) {
  const file = writeFile(name, 'video-bytes');
  return service.addVideo({
    path: file,
    format: 'webm',
    durationMs: 4000,
    width: 1280,
    height: 720,
    sizeBytes: 11,
    hasAudio: true,
    source: 'screen',
    ...extra,
  });
}

describe('screenshots', () => {
  it('stores the thumbnail the editor sent and never runs ffmpeg for a screenshot', async () => {
    const { service, tools } = makeService();
    const thumbnail = fakePng(480);
    const { id } = await addShot(service, 'a.png', { thumbnail });
    const { items } = await service.list();
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ id, type: 'screenshot', hasThumb: true, exists: true });
    expect(fs.readFileSync(path.join(thumbDir(), `${id}.png`))).toEqual(thumbnail);
    expect(tools.runs).toEqual([]);
    expect(tools.probes).toEqual([]);
  });

  it('has no thumbnail when none was sent (main never derives one from the original)', async () => {
    const { service, tools } = makeService();
    await addShot(service, 'a.png');
    expect((await service.list()).items[0]?.hasThumb).toBe(false);
    expect(thumbs()).toEqual([]);
    expect(tools.runs).toEqual([]);
  });

  it('refuses thumbnails that are not a small PNG', async () => {
    expect(validThumbnail(fakePng(480))).toBe(true);
    expect(validThumbnail(fakePng(481))).toBe(false);
    expect(validThumbnail(Buffer.from('GIF89a-not-a-png-at-all-padding-padding'))).toBe(false);
    expect(validThumbnail(fakePng(100, 2 * 1024 * 1024))).toBe(false);
    expect(validThumbnail(new Uint8Array(0))).toBe(false);

    const { service } = makeService();
    await addShot(service, 'wide.png', { thumbnail: fakePng(4000) });
    expect((await service.list()).items[0]?.hasThumb).toBe(false);
  });

  it('saving the same file again refreshes its entry instead of adding another', async () => {
    const { service } = makeService();
    const first = await addShot(service, 'same.png', { thumbnail: fakePng(300) });
    const second = await addShot(service, 'same.png', { thumbnail: fakePng(200), sizeBytes: 5 });
    expect(second.id).toBe(first.id);
    const { items, total } = await service.list();
    expect(total).toBe(1);
    expect(items[0]?.hasThumb).toBe(true);
  });
});

describe('recordings', () => {
  it('adds the entry at once and the ffmpeg thumbnail afterwards', async () => {
    const { service, tools, changes } = makeService();
    const { id } = await addVideo(service, 'r.webm', { durationMs: 4000 });
    expect((await service.list()).items[0]).toMatchObject({ id, type: 'recording' });
    await service.idle();
    expect((await service.list()).items[0]?.hasThumb).toBe(true);
    expect(fs.existsSync(path.join(thumbDir(), `${id}.png`))).toBe(true);
    expect(changes.count).toBeGreaterThanOrEqual(2);

    const args = tools.runs[0] as string[];
    // One frame, at min(1 s, duration / 2), at most 480 px wide, from the recording only.
    expect(args[args.indexOf('-ss') + 1]).toBe('1.000');
    expect(args[args.indexOf('-frames:v') + 1]).toBe('1');
    expect(args[args.indexOf('-vf') + 1]).toBe('scale=min(480\\,iw):-2');
    expect(args[args.indexOf('-i') + 1]).toBe((await service.list()).items[0]?.path);
    expect(thumbs()).toEqual([`${id}.png`]);
  });

  it('replaceVideoFile points the item at the MP4 and keeps id, thumbnail and date', async () => {
    const { service } = makeService();
    const { id } = await addVideo(service, 'r.webm', { createdAt: 5 });
    await service.idle();
    const mp4 = writeFile('r.mp4', 'mp4');
    const before = (await service.list()).items[0];
    expect(
      await service.replaceVideoFile(id, {
        path: mp4,
        format: 'mp4',
        sizeBytes: 3,
        durationMs: 4100,
        width: 1280,
        height: 720,
        hasAudio: true,
      }),
    ).toBe(true);
    const items = (await service.list()).items;
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      id,
      path: mp4,
      format: 'mp4',
      sizeBytes: 3,
      durationMs: 4100,
      hasThumb: true,
      createdAt: before?.createdAt,
    });
    expect(
      await service.replaceVideoFile('11111111-1111-4111-8111-111111111111', {
        path: mp4,
        format: 'mp4',
        sizeBytes: 3,
        durationMs: 1,
        width: 1,
        height: 1,
        hasAudio: false,
      }),
    ).toBe(false);
  });

  it('seeks to half of a very short recording', async () => {
    const { service, tools } = makeService();
    await addVideo(service, 'short.webm', { durationMs: 600 });
    await service.idle();
    const args = tools.runs[0] as string[];
    expect(args[args.indexOf('-ss') + 1]).toBe('0.300');
  });

  it('keeps the entry without a thumbnail when ffmpeg fails', async () => {
    const { service } = makeService({ tools: fakeTools({ code: 1 }) });
    await addVideo(service, 'r.webm');
    await service.idle();
    expect((await service.list()).items[0]?.hasThumb).toBe(false);
    expect(thumbs()).toEqual([]);
  });

  it('links an MP4 to the recording it was made from', async () => {
    const { service } = makeService();
    const source = await addVideo(service, 'r.webm');
    const mp4 = await addVideo(service, 'r.mp4', { format: 'mp4', derivedFrom: source.id });
    await service.idle();
    const { items } = await service.list();
    expect(items.find((entry) => entry.id === mp4.id)).toMatchObject({
      format: 'mp4',
      derivedFrom: source.id,
    });
  });
});

describe('edited videos and GIFs', () => {
  it('lists a GIF as a recording of format gif, linked to its source, with a thumbnail', async () => {
    const { service, tools } = makeService();
    const source = await addVideo(service, 'r.webm');
    const gif = await addVideo(service, 'r (edited).gif', {
      format: 'gif',
      hasAudio: false,
      derivedFrom: source.id,
    });
    await service.idle();
    const { items } = await service.list();
    expect(items.find((entry) => entry.id === gif.id)).toMatchObject({
      type: 'recording',
      format: 'gif',
      derivedFrom: source.id,
      hasThumb: true,
    });
    // The thumbnail of a GIF comes from ffmpeg like the one of any recording.
    expect(tools.runs.some((args) => args.some((arg) => arg.endsWith('r (edited).gif')))).toBe(
      true,
    );
  });

  it('relinks a GIF only to a GIF file', async () => {
    const tools = fakeTools({ probe: () => ({ ...PLAYABLE, formatName: 'gif' }) });
    const { service } = makeService({ tools });
    const { id } = await addVideo(service, 'a.gif', { format: 'gif' });
    await service.idle();
    await expect(service.relink(id, writeFile('b.webm'))).rejects.toMatchObject({
      code: 'INVALID_PAYLOAD',
    });
    await service.relink(id, writeFile('b.gif'));
    expect((await service.list()).items[0]?.path).toBe(path.join(files, 'b.gif'));
  });

  it('removes the video project with the file, and after the undo window with the entry', async () => {
    const removed: string[] = [];
    const swept: ReadonlySet<string>[] = [];
    const { service } = makeService({
      videoProjects: {
        remove: (id) => {
          removed.push(id);
          return Promise.resolve();
        },
        sweep: (known) => {
          swept.push(known);
          return Promise.resolve({ scanned: 0, removed: 0 });
        },
      },
    });
    const first = await addVideo(service, 'one.webm');
    const second = await addVideo(service, 'two.webm');
    await service.deleteFile(first.id);
    expect(removed).toEqual([first.id]);
    await service.remove(second.id);
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(removed).toEqual([first.id, second.id]);
    // The startup sweep is given the ids that exist.
    expect(swept).toHaveLength(1);
  });
});

describe('list', () => {
  it('marks files that were moved or deleted, and reports the current size', async () => {
    const { service } = makeService();
    const a = await addShot(service, 'a.png', { createdAt: 3 });
    const b = await addShot(service, 'b.png', { createdAt: 2 });
    await addShot(service, 'c.png', { createdAt: 1 });
    fs.rmSync(path.join(files, 'a.png'));
    fs.writeFileSync(path.join(files, 'b.png'), fakePng(100, 5000));
    const { items } = await service.list();
    const byId = new Map(items.map((entry) => [entry.id, entry]));
    expect(byId.get(a.id)?.exists).toBe(false);
    expect(byId.get(b.id)).toMatchObject({ exists: true, sizeBytes: 33 + 5000 });
    // A directory with the file's name is not the file.
    fs.rmSync(path.join(files, 'c.png'));
    fs.mkdirSync(path.join(files, 'c.png'));
    expect((await service.list()).items.map((entry) => entry.exists)).toEqual([false, true, false]);
  });

  it('filters by type, searches and limits', async () => {
    const { service } = makeService();
    await addShot(service, 'Login page.png', { createdAt: 5 });
    await addVideo(service, 'Demo run.webm', { createdAt: 4 });
    await addShot(service, 'Settings.png', { createdAt: 3 });
    const names = async (request: Parameters<HistoryService['list']>[0]) =>
      (await service.list(request)).items.map((entry) => entry.fileName);
    expect(await names({})).toEqual(['Login page.png', 'Demo run.webm', 'Settings.png']);
    expect(await names({ filter: 'recording' })).toEqual(['Demo run.webm']);
    expect(await names({ filter: 'screenshot' })).toEqual(['Login page.png', 'Settings.png']);
    expect(await names({ query: 'LOGIN' })).toEqual(['Login page.png']);
    expect(await names({ query: 'video demo' })).toEqual(['Demo run.webm']);
    expect(await names({ limit: 2 })).toEqual(['Login page.png', 'Demo run.webm']);
    expect((await service.list({ filter: 'recording', limit: 1 })).total).toBe(3);
  });
});

describe('removing', () => {
  it('removes the entry only: the file stays and the entry can come back', async () => {
    const { service } = makeService();
    const { id } = await addShot(service, 'keep.png', { thumbnail: fakePng(100) });
    await service.remove(id);
    expect((await service.list()).total).toBe(0);
    expect(fs.existsSync(path.join(files, 'keep.png'))).toBe(true);
    // The thumbnail survives the undo window, so Undo restores the full entry.
    expect(thumbs()).toEqual([`${id}.png`]);
    await service.undoRemove(id);
    expect((await service.list()).items[0]).toMatchObject({ id, hasThumb: true });
  });

  it('collects the thumbnail once the undo window has passed', async () => {
    const { service } = makeService();
    const { id } = await addShot(service, 'gone.png', { thumbnail: fakePng(100) });
    await service.remove(id);
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(thumbs()).toEqual([]);
    await expect(service.undoRemove(id)).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(fs.existsSync(path.join(files, 'gone.png'))).toBe(true);
  });

  it('refuses ids it does not know', async () => {
    const { service } = makeService();
    const unknown = '11111111-1111-4111-8111-111111111111';
    await expect(service.remove(unknown)).rejects.toBeInstanceOf(IpcError);
    await expect(service.undoRemove(unknown)).rejects.toBeInstanceOf(IpcError);
  });
});

describe('deleting a file', () => {
  it('moves it to the Recycle Bin (never unlink) and removes the entry', async () => {
    const { service, trashed } = makeService();
    const { id } = await addShot(service, 'bye.png', { thumbnail: fakePng(100) });
    const other = await addShot(service, 'other.png');
    await service.deleteFile(id);
    expect(trashed).toEqual([path.join(files, 'bye.png')]);
    expect(fs.existsSync(path.join(files, 'other.png'))).toBe(true);
    expect((await service.list()).items.map((entry) => entry.id)).toEqual([other.id]);
    expect(thumbs()).toEqual([]);
  });

  it('refuses an unknown id and trashes nothing', async () => {
    const { service, trashed } = makeService();
    await addShot(service, 'a.png');
    await expect(service.deleteFile('11111111-1111-4111-8111-111111111111')).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
    expect(trashed).toEqual([]);
    expect(fs.existsSync(path.join(files, 'a.png'))).toBe(true);
  });

  it('keeps the entry when the Recycle Bin refuses', async () => {
    const service = new HistoryService({
      dir: path.join(dir, 'history'),
      tools: fakeTools(),
      trashItem: () => Promise.reject(new Error('locked')),
    });
    const { id } = await addShot(service, 'locked.png');
    await expect(service.deleteFile(id)).rejects.toMatchObject({ code: 'INTERNAL' });
    expect((await service.list()).total).toBe(1);
    expect(fs.existsSync(path.join(files, 'locked.png'))).toBe(true);
  });

  it('a file that is already gone only removes the entry', async () => {
    const { service, trashed } = makeService();
    const { id } = await addShot(service, 'gone.png');
    fs.rmSync(path.join(files, 'gone.png'));
    await service.deleteFile(id);
    expect(trashed).toEqual([]);
    expect((await service.list()).total).toBe(0);
  });
});

describe('missing files', () => {
  it('clearMissing removes entries whose file is gone and touches no file', async () => {
    const { service } = makeService();
    await addShot(service, 'a.png');
    const b = await addShot(service, 'b.png');
    await addShot(service, 'c.png');
    fs.rmSync(path.join(files, 'a.png'));
    fs.rmSync(path.join(files, 'c.png'));
    expect(await service.clearMissing()).toBe(2);
    expect((await service.list()).items.map((entry) => entry.id)).toEqual([b.id]);
    expect(fs.readdirSync(files)).toEqual(['b.png']);
  });
});

describe('relinking', () => {
  it('points an image entry at a moved file of the same kind', async () => {
    const { service } = makeService();
    const { id } = await addShot(service, 'old.png');
    fs.rmSync(path.join(files, 'old.png'));
    const moved = writeFile('moved.png', fakePng(100, 400));
    await service.relink(id, moved);
    expect((await service.list()).items[0]).toMatchObject({
      exists: true,
      path: moved,
      sizeBytes: 33 + 400,
    });
  });

  it('rejects a wrong extension, wrong content, a missing file and a file of another entry', async () => {
    const { service } = makeService();
    const { id } = await addShot(service, 'old.png');
    await addShot(service, 'taken.png');
    const text = writeFile('notes.txt', fakePng(100));
    const fakeImage = writeFile('fake.png', 'this is not a png');
    const jpeg = writeFile('photo.jpg', Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0]));
    const expectRejected = async (file: string, code: string) =>
      expect(service.relink(id, file)).rejects.toMatchObject({ code });
    await expectRejected(text, 'INVALID_PAYLOAD');
    await expectRejected(fakeImage, 'INVALID_PAYLOAD');
    await expectRejected(jpeg, 'INVALID_PAYLOAD'); // a JPEG cannot stand in for a PNG entry
    await expectRejected(path.join(files, 'nope.png'), 'NOT_FOUND');
    await expectRejected(path.join(files, 'taken.png'), 'INVALID_PAYLOAD');
    await expect(
      service.relink('11111111-1111-4111-8111-111111111111', jpeg),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect((await service.list({ query: 'old' })).items[0]?.path).toBe(path.join(files, 'old.png'));
  });

  it('checks a video with ffprobe and takes its facts from the probe', async () => {
    const tools = fakeTools({
      probe: (file) =>
        file.endsWith('audio-only.webm')
          ? { ...PLAYABLE, hasVideo: false, video: null }
          : file.endsWith('is-mkv.webm')
            ? { ...PLAYABLE, formatName: 'matroska' }
            : { ...PLAYABLE, durationSec: 7.5, video: { ...PLAYABLE.video!, width: 640 } },
    });
    const { service } = makeService({ tools });
    const { id } = await addVideo(service, 'r.webm');
    await service.idle();
    await expect(service.relink(id, writeFile('x.mp4'))).rejects.toMatchObject({
      code: 'INVALID_PAYLOAD',
    });
    await expect(service.relink(id, writeFile('audio-only.webm'))).rejects.toMatchObject({
      code: 'INVALID_PAYLOAD',
    });
    await expect(service.relink(id, writeFile('is-mkv.webm'))).rejects.toMatchObject({
      code: 'INVALID_PAYLOAD',
    });
    await service.relink(id, writeFile('good.webm'));
    expect((await service.list()).items[0]).toMatchObject({
      durationMs: 7500,
      width: 640,
      path: path.join(files, 'good.webm'),
    });
  });

  it('an MKV recording is a history format: added, listed with its extension, relinked as Matroska, replaced in place', async () => {
    const tools = fakeTools({
      probe: (file) =>
        file.endsWith('.mkv') ? { ...PLAYABLE, formatName: 'matroska,webm' } : PLAYABLE,
    });
    const { service } = makeService({ tools });
    const mkv = writeFile('clip.mkv', 'mkv');
    const { id } = await service.addVideo({
      path: mkv,
      format: 'mkv',
      durationMs: 5000,
      width: 640,
      height: 360,
      sizeBytes: 3,
      hasAudio: true,
      source: 'screen',
    });
    await service.idle();
    expect((await service.list()).items[0]).toMatchObject({
      id,
      format: 'mkv',
      fileName: 'clip.mkv',
    });
    // Relinking checks the container (Matroska) and the extension.
    await expect(service.relink(id, writeFile('x.webm'))).rejects.toMatchObject({
      code: 'INVALID_PAYLOAD',
    });
    await service.relink(id, writeFile('moved.mkv'));
    expect((await service.list()).items[0]?.path).toBe(path.join(files, 'moved.mkv'));
    // A conversion points the item at another format and keeps the id.
    const mp4 = writeFile('clip.mp4', 'mp4');
    expect(
      await service.replaceVideoFile(id, {
        path: mp4,
        format: 'mp4',
        sizeBytes: 3,
        durationMs: 5000,
        width: 640,
        height: 360,
        hasAudio: true,
      }),
    ).toBe(true);
    expect((await service.list()).items[0]).toMatchObject({ id, format: 'mp4', path: mp4 });
  });

  it('a probe that throws is a rejection, not a crash', async () => {
    const tools = fakeTools({
      probe: (file) =>
        file.endsWith('bad.webm') ? new FfmpegError('PROBE_FAILED', 'x') : PLAYABLE,
    });
    const { service } = makeService({ tools });
    const { id } = await addVideo(service, 'r.webm');
    await expect(service.relink(id, writeFile('bad.webm'))).rejects.toMatchObject({
      code: 'INVALID_PAYLOAD',
    });
  });
});

describe('limits and persistence', () => {
  it('enforces the item cap and removes the thumbnails of the entries that fell off', async () => {
    const service = new HistoryService({
      dir: path.join(dir, 'history'),
      tools: fakeTools(),
      trashItem: () => Promise.resolve(),
      maxItems: 2,
    });
    const first = await addShot(service, 'a.png', { createdAt: 1, thumbnail: fakePng(100) });
    await addShot(service, 'b.png', { createdAt: 2, thumbnail: fakePng(100) });
    await addShot(service, 'c.png', { createdAt: 3, thumbnail: fakePng(100) });
    const { items, total } = await service.list();
    expect(total).toBe(2);
    expect(items.map((entry) => entry.fileName)).toEqual(['c.png', 'b.png']);
    expect(thumbs()).not.toContain(`${first.id}.png`);
    expect(thumbs()).toHaveLength(2);
    expect(fs.existsSync(path.join(files, 'a.png'))).toBe(true); // the file itself is untouched
  });

  it('drops the thumbnails of the oldest entries when the folder exceeds its cap', async () => {
    const service = new HistoryService({
      dir: path.join(dir, 'history'),
      tools: fakeTools(),
      trashItem: () => Promise.resolve(),
      thumbCapBytes: 350,
    });
    await addShot(service, 'old.png', { createdAt: 1, thumbnail: fakePng(100) }); // 133 bytes
    await addShot(service, 'mid.png', { createdAt: 2, thumbnail: fakePng(100) });
    await addShot(service, 'new.png', { createdAt: 3, thumbnail: fakePng(100) });
    const { items } = await service.list();
    expect(items.map((entry) => [entry.fileName, entry.hasThumb])).toEqual([
      ['new.png', true],
      ['mid.png', true],
      ['old.png', false],
    ]);
  });

  it('survives a restart and resets (once) after damage without touching files', async () => {
    const first = makeService();
    await addShot(first.service, 'a.png');
    await first.service.idle();

    const second = makeService();
    expect((await second.service.list()).total).toBe(1);
    expect(await second.service.consumeResetNotice()).toBe(false);

    fs.writeFileSync(path.join(dir, 'history', 'history.json'), 'not json');
    const third = makeService();
    expect((await third.service.list()).total).toBe(0);
    expect(await third.service.consumeResetNotice()).toBe(true);
    expect(await third.service.consumeResetNotice()).toBe(false);
    expect(fs.existsSync(path.join(files, 'a.png'))).toBe(true);
    expect(fs.readdirSync(path.join(dir, 'history')).some((n) => n.includes('.corrupt-'))).toBe(
      true,
    );
  });
});

describe('recordings finished before history existed', () => {
  function record(sessionId: string, output: string, completedAt: number) {
    const completed = path.join(dir, 'recordings', 'completed');
    fs.mkdirSync(completed, { recursive: true });
    fs.writeFileSync(
      path.join(completed, `${sessionId}.json`),
      JSON.stringify({
        sessionId,
        completedAt,
        createdAt: completedAt - 5000,
        outputPath: output,
        durationMs: 5000,
        bytes: 11,
        width: 1280,
        height: 720,
        source: { kind: 'window' },
        hasAudio: false,
        mime: 'video/webm',
        recovered: false,
        unindexed: false,
        pausedIntervals: [],
        stats: {
          queueHighWaterChunks: 0,
          queueHighWaterBytes: 0,
          mainQueueHighWater: 0,
          maxWriteMs: 0,
        },
      }),
    );
  }

  it('adds the ones whose file still exists, once, and only when history is new', async () => {
    record('aaaaaaaa-0000-4000-8000-000000000001', writeFile('one.webm', 'v'), 100);
    record('aaaaaaaa-0000-4000-8000-000000000002', path.join(files, 'gone.webm'), 200);
    record('aaaaaaaa-0000-4000-8000-000000000003', writeFile('three.webm', 'v'), 300);
    fs.writeFileSync(path.join(dir, 'recordings', 'completed', 'junk.json'), '{ nope');

    const { service } = makeService();
    expect(await service.backfillFromCompleted(path.join(dir, 'recordings'))).toBe(2);
    await service.idle();
    const { items } = await service.list();
    expect(items.map((entry) => entry.fileName)).toEqual(['three.webm', 'one.webm']);
    expect(items[0]).toMatchObject({ source: 'window', hasAudio: false, durationMs: 5000 });

    const again = makeService();
    expect(await again.service.backfillFromCompleted(path.join(dir, 'recordings'))).toBe(0);
    await again.service.remove(items[0]?.id ?? '');
    const third = makeService();
    expect(await third.service.backfillFromCompleted(path.join(dir, 'recordings'))).toBe(0);
    expect((await third.service.list()).total).toBe(1);
  });

  it('does not bring entries back after a damaged file was reset', async () => {
    record('aaaaaaaa-0000-4000-8000-000000000001', writeFile('one.webm', 'v'), 100);
    fs.mkdirSync(path.join(dir, 'history'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'history', 'history.json'), '###');
    const { service } = makeService();
    expect(await service.backfillFromCompleted(path.join(dir, 'recordings'))).toBe(0);
    expect((await service.list()).total).toBe(0);
  });
});

describe('thumbnail lookups for the media protocol', () => {
  it('serve only the thumbnail and the file of entries in history', async () => {
    const { service } = makeService();
    const { id } = await addShot(service, 'a.png', { thumbnail: fakePng(100) });
    expect(service.thumbPathOf(id)).toBe(path.join(thumbDir(), `${id}.png`));
    expect(service.filePathOf(id)).toBe(path.join(files, 'a.png'));
    expect(service.thumbPathOf('11111111-1111-4111-8111-111111111111')).toBeUndefined();
    expect(service.filePathOf('../../etc/passwd')).toBeUndefined();
    await service.remove(id);
    expect(service.thumbPathOf(id)).toBeUndefined();
    expect(service.filePathOf(id)).toBeUndefined();
  });
});

vi.setConfig({ testTimeout: 15_000 });
