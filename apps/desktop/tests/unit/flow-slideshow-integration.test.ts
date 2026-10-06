/**
 * Integration with the REAL vendored ffmpeg/ffprobe (`npm run fetch:ffmpeg`): three generated PNGs
 * of different sizes become a guide, and the MP4 and GIF slideshows are made through the service
 * (the same job the app runs). Skipped, with a message, when the binaries are not fetched.
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FlowService } from '../../src/main/flows/service';
import { HistoryService } from '../../src/main/history/service';
import { detectMp4Capability, mp4TopLevelBoxes } from '../../src/main/media/export';
import { createMediaTools, FfmpegError, resolveFfmpeg } from '../../src/main/media/ffmpeg';
import { JobRunner } from '../../src/main/media/job-runner';
import type { ExportDoneEvent, ExportFailedEvent } from '../../src/shared/history-ipc';

const repoRoot = path.resolve(__dirname, '..', '..');
let paths: ReturnType<typeof resolveFfmpeg> | null = null;
try {
  paths = resolveFfmpeg({ isPackaged: false, resourcesPath: '', appPath: repoRoot });
} catch (error) {
  if (!(error instanceof FfmpegError)) throw error;
  console.warn(`SKIPPING slideshow integration tests: ${error.message}`);
}
const run = paths ? describe : describe.skip;

let root: string;
beforeAll(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'framecapt-slides-'));
});
afterAll(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

/** A real PNG made by ffmpeg itself: a flat colour of the given size. */
function makePng(name: string, color: string, size: string): Buffer {
  const file = path.join(root, name);
  const result = spawnSync(
    paths?.ffmpeg ?? '',
    [
      '-hide_banner',
      '-loglevel',
      'error',
      '-y',
      '-f',
      'lavfi',
      '-i',
      `color=c=${color}:s=${size}`,
      '-frames:v',
      '1',
      file,
    ],
    { shell: false },
  );
  if (result.status !== 0) throw new Error(`could not make ${name}: ${result.stderr.toString()}`);
  return fs.readFileSync(file);
}
const ab = (buffer: Buffer): ArrayBuffer =>
  buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength) as ArrayBuffer;

/** Sizes of the generated steps: a screen, a small window, an odd-sized one (a second monitor). */
const SIZES = [
  [640, 360],
  [320, 240],
  [641, 361],
] as const;
const COLORS = ['red', 'green', 'blue', 'yellow', 'cyan', 'magenta'];

run('step guide slideshow with the real ffmpeg', () => {
  /** A guide of `count` generated steps exported as `kind`; `mixed` gives the steps different sizes. */
  async function exportAs(kind: 'mp4' | 'gif', count: number, mixed = true) {
    const tools = createMediaTools(() => paths as NonNullable<typeof paths>);
    const tag = `${kind}-${count}-${mixed}`;
    const shots = path.join(root, `shots-${tag}`);
    fs.mkdirSync(shots, { recursive: true });
    const history = new HistoryService({
      dir: path.join(root, `history-${tag}`),
      tools,
      trashItem: () => Promise.resolve(),
    });
    const runner = new JobRunner();
    const done: ExportDoneEvent[] = [];
    const failed: ExportFailedEvent[] = [];
    const out = path.join(root, `out-${tag}`);
    fs.mkdirSync(out, { recursive: true });
    const service = new FlowService({
      history,
      tools,
      runner,
      capability: () => detectMp4Capability(tools),
      screenshotsDir: () => shots,
      scratchDir: path.join(root, 'scratch'),
      thumbnail: () => undefined,
      trashItem: () => Promise.resolve(),
      pickFolder: () => Promise.resolve(null),
      pickSave: ({ defaultName }) => Promise.resolve(path.join(out, defaultName)),
      remember: () => undefined,
      emit: {
        progress: () => undefined,
        done: (event) => done.push(event),
        failed: (event) => failed.push(event),
      },
    });
    const session = path.join(root, `session-${tag}`);
    fs.mkdirSync(session, { recursive: true });
    const sizes = Array.from(
      { length: count },
      (_, index) => SIZES[mixed ? index % 3 : 0] ?? SIZES[0],
    );
    const pictures = sizes.map(([w, h], index) =>
      makePng(`${tag}-${index}.png`, COLORS[index % COLORS.length] ?? 'red', `${w}x${h}`),
    );
    const steps = pictures.map((bytes, index) => {
      const source = path.join(session, `s${index}.png`);
      fs.writeFileSync(source, bytes);
      return {
        source,
        width: sizes[index]?.[0] ?? 1,
        height: sizes[index]?.[1] ?? 1,
        cursor: null,
        at: index,
      };
    });
    const { historyId } = await service.saveSession({ steps, createdAt: Date.now() });
    const answer = await service.export({ historyId, kind, frames: pictures.map(ab) });
    expect(answer).toHaveProperty('jobId');
    await runner.idle();
    expect(failed).toEqual([]);
    expect(done).toHaveLength(1);
    return { tools, file: done[0]?.path ?? '', event: done[0], history };
  }

  it('MP4: three pictures at 2.5 s each make a 7.5 s H.264 file with an even size and the index first', async () => {
    const { tools, file, event, history } = await exportAs('mp4', 3);
    const probe = await tools.probe(file);
    expect(probe.hasVideo).toBe(true);
    expect(probe.hasAudio).toBe(false);
    expect(probe.video?.codec).toBe('h264');
    expect(probe.video?.pixFmt).toBe('yuv420p');
    expect((probe.video?.width ?? 1) % 2).toBe(0);
    expect((probe.video?.height ?? 1) % 2).toBe(0);
    expect(probe.durationSec ?? 0).toBeGreaterThan(7.3);
    expect(probe.durationSec ?? 0).toBeLessThan(7.7);
    const boxes = await mp4TopLevelBoxes(file);
    expect(boxes.indexOf('moov')).toBeLessThan(boxes.indexOf('mdat'));
    // It is in History, derived from the guide.
    const item = history.get(event?.itemId ?? '');
    expect(item).toMatchObject({ type: 'recording', format: 'mp4', hasAudio: false });
    expect(item?.derivedFrom).toBe(event?.historyId);
    // Nothing is left in the scratch folder.
    expect(fs.readdirSync(path.join(root, 'scratch'))).toEqual([]);
  }, 120_000);

  it('MP4: the length is steps x 2.5 s for one, two, five and eight steps, same size or mixed', async () => {
    // Measured with the pinned ffmpeg: the concat demuxer gave a different length for each of these.
    for (const [count, mixed] of [
      [1, false],
      [2, false],
      [2, true],
      [5, true],
      [8, false],
    ] as const) {
      const { tools, file } = await exportAs('mp4', count, mixed);
      const seconds = (await tools.probe(file)).durationSec ?? 0;
      expect(
        Math.abs(seconds - count * 2.5),
        `${count} steps, mixed ${mixed}: ${seconds} s`,
      ).toBeLessThan(0.15);
    }
  }, 180_000);

  it('GIF: a looping animation of every step (10 frames a second), added to History as a GIF', async () => {
    for (const count of [3, 6]) {
      const { file, event } = await exportAs('gif', count);
      expect(fs.readFileSync(file).subarray(0, 6).toString('latin1')).toMatch(/^GIF8[79]a$/);
      // ffprobe's container duration of a GIF is a guess; the frames are the truth.
      const counted = spawnSync(
        paths?.ffprobe ?? '',
        [
          '-v',
          'error',
          '-count_packets',
          '-select_streams',
          'v:0',
          '-show_entries',
          'stream=nb_read_packets',
          '-of',
          'csv=p=0',
          file,
        ],
        { shell: false, encoding: 'utf8' },
      );
      expect(
        Math.abs(Number(counted.stdout.trim()) - count * 25),
        `${count} steps`,
      ).toBeLessThanOrEqual(3);
      expect(event?.itemId).toBeTruthy();
    }
  }, 180_000);
});
