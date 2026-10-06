import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { HistoryService } from '../../src/main/history/service';
import { rescanLibrary } from '../../src/main/history/rescan';
import { createdAtFromName } from '../../src/shared/capture-names';
import { defaultRecordingFileName } from '../../src/shared/recording';
import { defaultShotFileName } from '../../src/shared/shots';
import { fakeTools, PLAYABLE, type FakeToolsOptions } from './fake-tools';

let root: string;
let shots: string;
let videos: string;
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'framecapt-rescan-'));
  shots = path.join(root, 'shots');
  videos = path.join(root, 'videos');
  fs.mkdirSync(shots);
  fs.mkdirSync(videos);
});
afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

/** Signature + IHDR only: what the header readers look at. */
function fakePng(width: number, height: number): Buffer {
  const bytes = Buffer.alloc(64);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(bytes, 0);
  bytes.writeUInt32BE(13, 8);
  bytes.write('IHDR', 12, 'latin1');
  bytes.writeUInt32BE(width, 16);
  bytes.writeUInt32BE(height, 20);
  return bytes;
}

const at = (second: number): Date => new Date(2026, 9, 2, 14, 5, second);

function setup(probe?: NonNullable<FakeToolsOptions['probe']>, maxItems?: number) {
  const tools = fakeTools(probe ? { probe } : {});
  const history = new HistoryService({
    dir: path.join(root, 'history'),
    tools,
    trashItem: () => Promise.resolve(),
    ...(maxItems !== undefined && { maxItems }),
  });
  const thumbnails: Array<[string, number]> = [];
  const run = () =>
    rescanLibrary({
      dirs: [shots, videos],
      history,
      tools,
      ...(maxItems !== undefined && { maxItems }),
      thumbnail: (file, width) => {
        thumbnails.push([file, width]);
        return Promise.resolve(undefined);
      },
    });
  return { history, tools, thumbnails, run };
}

describe('createdAtFromName', () => {
  it('reads the local time out of the names the app makes', () => {
    expect(createdAtFromName(defaultShotFileName(at(9), 'png'))).toBe(at(9).getTime());
    expect(createdAtFromName(defaultRecordingFileName(at(9), 'webm', ' (recovered)'))).toBe(
      at(9).getTime(),
    );
    expect(createdAtFromName('FrameCapt 2026-10-02 at 14.05.09 (3).mp4')).toBe(at(9).getTime());
  });

  it('rejects other names', () => {
    for (const name of [
      'holiday.png',
      'FrameCapt 2026-10-02.png',
      'FrameCapt 2026-10-02 at 14.05.09 x.png',
    ]) {
      expect(createdAtFromName(name)).toBeNull();
    }
  });
});

describe('rescanLibrary', () => {
  it('adds screenshots and recordings that history does not list, newest first', async () => {
    fs.writeFileSync(path.join(shots, defaultShotFileName(at(1), 'png')), fakePng(1920, 1080));
    fs.writeFileSync(path.join(shots, defaultShotFileName(at(3), 'png')), fakePng(300, 200));
    fs.writeFileSync(path.join(videos, defaultRecordingFileName(at(2))), 'video');
    const { history, thumbnails, run } = setup();

    expect(await run()).toBe(3);
    await history.idle();
    const { items } = await history.list();
    expect(items.map((item) => item.createdAt)).toEqual([at(3), at(2), at(1)].map(Number));
    const small = items[0];
    expect(small).toMatchObject({ type: 'screenshot', width: 300, height: 200, source: 'unknown' });
    expect(items[1]).toMatchObject({
      type: 'recording',
      format: 'webm',
      durationMs: 5000,
      width: 1920,
      hasAudio: true,
    });
    // The thumbnail is at most 480 px wide, and never wider than the image.
    expect(thumbnails.map(([, width]) => width).sort((a, b) => a - b)).toEqual([300, 480]);
    expect(items.every((item) => item.exists)).toBe(true);
  });

  it('skips what is already listed, so a second run adds nothing', async () => {
    fs.writeFileSync(path.join(shots, defaultShotFileName(at(1), 'png')), fakePng(10, 10));
    const { run } = setup();
    expect(await run()).toBe(1);
    expect(await run()).toBe(0);
  });

  it('ignores foreign names, other types, folders and unreadable files', async () => {
    fs.writeFileSync(path.join(shots, 'holiday.png'), fakePng(10, 10));
    fs.writeFileSync(path.join(shots, 'FrameCapt 2026-10-02 at 14.05.01.txt'), 'x');
    fs.mkdirSync(path.join(shots, 'FrameCapt 2026-10-02 at 14.05.02.png'));
    fs.writeFileSync(path.join(shots, defaultShotFileName(at(3), 'png')), 'not an image');
    fs.writeFileSync(path.join(videos, defaultRecordingFileName(at(4))), 'broken');
    const { history, run } = setup((file) =>
      file.includes('14.05.04') ? new Error('probe failed') : PLAYABLE,
    );
    expect(await run()).toBe(0);
    expect((await history.list()).total).toBe(0);
  });

  it('adds an animated GIF as a recording of format gif', async () => {
    fs.writeFileSync(path.join(videos, defaultRecordingFileName(at(6), 'gif')), 'gif');
    const { history, run } = setup();
    expect(await run()).toBe(1);
    const { items } = await history.list();
    expect(items[0]).toMatchObject({ type: 'recording', format: 'gif' });
  });

  it('links an MP4 to the WebM of the same name', async () => {
    fs.writeFileSync(path.join(videos, defaultRecordingFileName(at(5))), 'webm');
    fs.writeFileSync(path.join(videos, defaultRecordingFileName(at(5), 'mp4')), 'mp4');
    const { history, run } = setup();
    expect(await run()).toBe(2);
    const { items } = await history.list();
    const webm = items.find((item) => item.format === 'webm');
    const mp4 = items.find((item) => item.format === 'mp4');
    expect(mp4?.derivedFrom).toBe(webm?.id);
    expect(webm?.derivedFrom).toBeNull();
  });

  it('adds only up to the free room', async () => {
    for (let second = 1; second <= 4; second += 1) {
      fs.writeFileSync(path.join(shots, defaultShotFileName(at(second), 'png')), fakePng(10, 10));
    }
    const { history, run } = setup(undefined, 3);
    expect(await run()).toBe(3);
    const { items } = await history.list();
    expect(items.map((item) => item.createdAt)).toEqual([at(4), at(3), at(2)].map(Number));
  });

  it('never changes the files it reads', async () => {
    const file = path.join(shots, defaultShotFileName(at(1), 'png'));
    fs.writeFileSync(file, fakePng(10, 10));
    const before = fs.readFileSync(file);
    await setup().run();
    expect(fs.readFileSync(file).equals(before)).toBe(true);
    expect(fs.readdirSync(shots)).toHaveLength(1);
  });
});
