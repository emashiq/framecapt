/**
 * Video editing with the REAL vendored ffmpeg/ffprobe (`npm run fetch:ffmpeg`): a small WebM with a
 * test picture and a tone is trimmed, cut, redacted, blurred, pixelated, spotlighted, cropped and
 * scaled; the output is probed (container, codecs, size, length) and sampled (the redaction box is
 * black in the frames it covers and only there). A GIF, a WebM and a source without audio are
 * exported too, and a cancelled export leaves no partial file and no temporary folder. Skipped,
 * with a message, when the binaries are not fetched.
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { exportEdit } from '../../src/main/media/edit-export';
import { createMediaTools, FfmpegError, resolveFfmpeg } from '../../src/main/media/ffmpeg';
import {
  applyCommand,
  createProject,
  newItem,
  type VideoCommand,
  type VideoProject,
} from '../../src/shared/video-edit';

const repoRoot = path.resolve(__dirname, '..', '..');
const location = { isPackaged: false, resourcesPath: '', appPath: repoRoot };
let paths: ReturnType<typeof resolveFfmpeg> | null = null;
try {
  paths = resolveFfmpeg(location);
} catch (error) {
  if (!(error instanceof FfmpegError)) throw error;
  console.warn(`SKIPPING edit integration tests: ${error.message}`);
}

const ID = '11111111-1111-4111-8111-111111111111';

describe.skipIf(paths === null)('real ffmpeg: video editing', () => {
  const tools = createMediaTools(() => resolveFfmpeg(location));
  let work: string;
  let tempRoot: string;
  let source: string; // 6 s, 640x360, VP8 + Opus
  let silent: string; // 3 s, 640x360, no audio

  const ffmpeg = (args: string[]): void => {
    const run = spawnSync(paths?.ffmpeg ?? '', ['-hide_banner', '-v', 'error', '-y', ...args], {
      shell: false,
      encoding: 'utf8',
      windowsHide: true,
    });
    if (run.status !== 0) throw new Error(`ffmpeg failed: ${run.stderr}`);
  };

  /** Grey values (0..255) of a `w`x`h` window at (x, y) of the frame at `seconds` of a video. */
  const sample = (file: string, seconds: number, x: number, y: number, w: number, h: number) => {
    const run = spawnSync(
      paths?.ffmpeg ?? '',
      [
        '-v',
        'error',
        '-ss',
        String(seconds),
        '-i',
        file,
        '-frames:v',
        '1',
        '-vf',
        `crop=${w}:${h}:${x}:${y},format=gray`,
        '-f',
        'rawvideo',
        '-',
      ],
      { shell: false, windowsHide: true, maxBuffer: 16 * 1024 * 1024 },
    );
    if (run.status !== 0) throw new Error(`sampling failed: ${String(run.stderr)}`);
    const bytes = [...run.stdout];
    return {
      max: Math.max(...bytes),
      mean: bytes.reduce((sum, value) => sum + value, 0) / bytes.length,
    };
  };

  const edit = (project: VideoProject, ...commands: VideoCommand[]): VideoProject =>
    commands.reduce((current, command) => applyCommand(current, command), project);

  const SOURCE_FACTS = { durationMs: 6000, width: 640, height: 360, hasAudio: true };
  const run = (
    project: VideoProject,
    format: 'mp4' | 'webm' | 'gif',
    input = source,
    extra: { signal?: AbortSignal; onProgress?: (percent: number | null) => void } = {},
  ) =>
    exportEdit({
      tools,
      sourcePath: input,
      destPath: path.join(work, `out-${Math.random().toString(36).slice(2, 8)}.${format}`),
      project,
      format,
      tempRoot,
      ...extra,
    });

  beforeAll(() => {
    work = fs.mkdtempSync(path.join(os.tmpdir(), 'framecapt-edit-int-'));
    tempRoot = path.join(work, 'tmp');
    fs.mkdirSync(tempRoot);
    source = path.join(work, 'source.webm');
    silent = path.join(work, 'silent.webm');
    ffmpeg([
      '-f',
      'lavfi',
      '-i',
      'testsrc=size=640x360:rate=30:duration=6',
      '-f',
      'lavfi',
      '-i',
      'sine=frequency=440:duration=6',
      '-c:v',
      'libvpx',
      '-b:v',
      '1M',
      '-c:a',
      'libopus',
      '-f',
      'webm',
      source,
    ]);
    ffmpeg([
      '-f',
      'lavfi',
      '-i',
      'testsrc=size=640x360:rate=30:duration=3',
      '-c:v',
      'libvpx',
      '-f',
      'webm',
      silent,
    ]);
  }, 60_000);

  afterAll(() => {
    if (work) fs.rmSync(work, { recursive: true, force: true });
  });

  it('trim + cut + redact: right length and streams, the box is black while it is on and only then', async () => {
    const project = edit(
      createProject(ID, SOURCE_FACTS),
      { type: 'setTrim', startMs: 500, endMs: 5500 },
      { type: 'addCut', id: 'c1', startMs: 2000, endMs: 3000 },
      {
        type: 'addItem',
        item: newItem('redact', 'r1', { x: 0, y: 0, width: 200, height: 100 }, 3500, 5000),
      },
    );
    const result = await run(project, 'mp4');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.probe.formatName).toContain('mp4');
    expect(result.probe.video).toMatchObject({ codec: 'h264', width: 640, height: 360 });
    expect(result.probe.audioCodec).toBe('aac');
    // 5 s trim - 1 s cut
    expect(result.probe.durationSec).toBeGreaterThan(3.8);
    expect(result.probe.durationSec).toBeLessThan(4.2);

    // Source 1.0 s -> output 0.5 s: before the box. Source 4.0 s -> output 2.5 s: inside it.
    const before = sample(result.path, 0.5, 50, 25, 100, 50);
    const during = sample(result.path, 2.5, 50, 25, 100, 50);
    const elsewhere = sample(result.path, 2.5, 300, 5, 100, 50);
    expect(before.mean).toBeGreaterThan(40);
    expect(during.max).toBeLessThan(24);
    expect(elsewhere.mean).toBeGreaterThan(40);
    // Output 3.8 s = source 5.3 s: the box ended at 5.0 s.
    expect(sample(result.path, 3.8, 50, 25, 100, 50).mean).toBeGreaterThan(40);
  }, 120_000);

  it('renders every kind of item with a crop, a scale, fades and a volume', async () => {
    const rect = { x: 100, y: 80, width: 200, height: 120 };
    const project = edit(
      createProject(ID, SOURCE_FACTS),
      { type: 'addItem', item: newItem('blur', 'b', rect, 500, 2500) },
      { type: 'addItem', item: newItem('pixelate', 'p', { ...rect, x: 300 }, 1000, 3000) },
      { type: 'addItem', item: newItem('highlight', 'h', rect, 3000, 5000) },
      { type: 'setCrop', crop: { x: 41, y: 21, width: 481, height: 271 } },
      { type: 'setExport', patch: { scale: 320 } },
      { type: 'setFades', fadeInMs: 300, fadeOutMs: 300 },
      { type: 'setAudio', patch: { volume: 0.5 } },
      { type: 'addCut', id: 'c', startMs: 5000, endMs: 5400 },
    );
    const result = await run(project, 'mp4');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // 480x270 after the even-aligned crop, scaled to 320 wide.
    expect(result.probe.video).toMatchObject({ width: 320, height: 180 });
    expect(result.probe.durationSec).toBeGreaterThan(5.3);
    expect(result.probe.durationSec).toBeLessThan(5.9);
    // The spotlight dims everything outside its box: a frame corner at 4 s (box not at the corner).
    const corner = sample(result.path, 3.2, 0, 0, 20, 20);
    expect(corner.max).toBeLessThan(120);
  }, 120_000);

  it('exports WebM (VP9 + Opus)', async () => {
    const project = edit(createProject(ID, SOURCE_FACTS), {
      type: 'setTrim',
      startMs: 0,
      endMs: 2000,
    });
    const result = await run(project, 'webm');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.probe.formatName).toContain('webm');
    expect(result.probe.video?.codec).toBe('vp9');
    expect(result.probe.audioCodec).toBe('opus');
    expect(result.probe.durationSec).toBeGreaterThan(1.7);
  }, 120_000);

  it('exports a valid GIF: no audio, limited width, about the right length', async () => {
    const project = edit(
      createProject(ID, SOURCE_FACTS),
      { type: 'setTrim', startMs: 0, endMs: 3000 },
      { type: 'setExport', patch: { gifFps: 10, scale: 320 } },
    );
    const result = await run(project, 'gif');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.probe.formatName).toBe('gif');
    expect(result.probe.hasAudio).toBe(false);
    expect(result.probe.video).toMatchObject({ codec: 'gif', width: 320, height: 180 });
    expect(Math.abs((result.probe.durationSec ?? 0) - 3)).toBeLessThan(0.6);
    const head = fs.readFileSync(result.path).subarray(0, 6).toString('latin1');
    expect(head).toBe('GIF89a');
  }, 120_000);

  it('gives a source without audio a silent track of the output length', async () => {
    const project = edit(
      createProject(ID, { ...SOURCE_FACTS, durationMs: 3000, hasAudio: false }),
      { type: 'addCut', id: 'c', startMs: 1000, endMs: 2000 },
    );
    const result = await run(project, 'mp4', silent);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.probe.audioCodec).toBe('aac');
    expect(Math.abs((result.probe.durationSec ?? 0) - 2)).toBeLessThan(0.3);
  }, 120_000);

  it('uses the facts of the file, not the saved ones', async () => {
    // The project thinks the source has audio and is 20 s long; the real file is 3 s without audio.
    const project = createProject(ID, {
      durationMs: 20_000,
      width: 1920,
      height: 1080,
      hasAudio: true,
    });
    const result = await run(project, 'mp4', silent);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.probe.video).toMatchObject({ width: 640, height: 360 });
    expect(Math.abs((result.probe.durationSec ?? 0) - 3)).toBeLessThan(0.3);
  }, 120_000);

  it('cancelling removes the partial file and the temporary folder, and leaves the source alone', async () => {
    const long = path.join(work, 'long.webm');
    ffmpeg([
      '-f',
      'lavfi',
      '-i',
      'testsrc2=size=1280x720:rate=30:duration=30',
      '-c:v',
      'libvpx',
      '-b:v',
      '2M',
      '-f',
      'webm',
      long,
    ]);
    const before = fs.statSync(long).size;
    const controller = new AbortController();
    const project = createProject(ID, {
      durationMs: 30_000,
      width: 1280,
      height: 720,
      hasAudio: false,
    });
    const files = new Set(fs.readdirSync(work));
    const result = await run(project, 'mp4', long, {
      signal: controller.signal,
      onProgress: () => controller.abort(),
    });
    expect(result).toMatchObject({ ok: false, code: 'CANCELLED' });
    expect(fs.readdirSync(work).filter((name) => !files.has(name))).toEqual([]);
    expect(fs.readdirSync(tempRoot)).toEqual([]);
    expect(fs.statSync(long).size).toBe(before);
  }, 120_000);
});
