/**
 * Text and image overlays, audio clips and the frame rate with the REAL vendored ffmpeg: a text
 * picture and an image are overlaid only while their item is on (sampled frames), an audio clip is
 * mixed in at its place on the source timeline and survives a cut (sampled loudness), a 60 fps
 * source stays at 60 fps. Skipped, with a message, when the binaries are not fetched.
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { exportEdit, type EditExportRequest } from '../../src/main/media/edit-export';
import { createMediaTools, FfmpegError, resolveFfmpeg } from '../../src/main/media/ffmpeg';
import {
  applyCommand,
  createProject,
  newAudio,
  newImage,
  newText,
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
  console.warn(`SKIPPING overlay integration tests: ${error.message}`);
}

const ID = '11111111-1111-4111-8111-111111111111';
const ASSET = 'a'.repeat(64);

describe.skipIf(paths === null)('real ffmpeg: overlays, audio clips, frame rate', () => {
  const tools = createMediaTools(() => resolveFfmpeg(location));
  let work: string;
  let tempRoot: string;
  let silent: string; // 6 s, 640x360, 30 fps, no audio
  let fast: string; // 2 s, 320x180, 60 fps
  let blackPng: string; // 200x80 black picture
  let clipWav: string; // 3 s of 880 Hz

  const ffmpeg = (args: string[]): void => {
    const run = spawnSync(paths?.ffmpeg ?? '', ['-hide_banner', '-v', 'error', '-y', ...args], {
      shell: false,
      encoding: 'utf8',
      windowsHide: true,
    });
    if (run.status !== 0) throw new Error(`ffmpeg failed: ${run.stderr}`);
  };

  /** Grey values of a window of the frame at `seconds`. */
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

  /** The loudest sample (dB) in `seconds` seconds of the output's audio from `from`. */
  const loudness = (file: string, from: number, seconds: number): number => {
    const run = spawnSync(
      paths?.ffmpeg ?? '',
      [
        '-hide_banner',
        '-ss',
        String(from),
        '-t',
        String(seconds),
        '-i',
        file,
        '-vn',
        '-af',
        'volumedetect',
        '-f',
        'null',
        '-',
      ],
      { shell: false, encoding: 'utf8', windowsHide: true },
    );
    const match = /max_volume: (-?[\d.]+|-inf) dB/.exec(run.stderr);
    if (!match) throw new Error(`no volume: ${run.stderr.slice(-300)}`);
    return match[1] === '-inf' ? -Infinity : Number(match[1]);
  };

  const edit = (project: VideoProject, ...commands: VideoCommand[]): VideoProject =>
    commands.reduce((current, command) => applyCommand(current, command), project);

  const SILENT = { durationMs: 6000, width: 640, height: 360, hasAudio: false };
  const run = (
    project: VideoProject,
    format: 'mp4' | 'webm' | 'gif',
    input: string,
    extra: Pick<EditExportRequest, 'textPngs' | 'assetPath'> = {},
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
    work = fs.mkdtempSync(path.join(os.tmpdir(), 'framecapt-overlay-int-'));
    tempRoot = path.join(work, 'tmp');
    fs.mkdirSync(tempRoot);
    silent = path.join(work, 'silent.webm');
    fast = path.join(work, 'fast.webm');
    blackPng = path.join(work, 'black.png');
    clipWav = path.join(work, 'clip.wav');
    ffmpeg([
      '-f',
      'lavfi',
      '-i',
      'testsrc=size=640x360:rate=30:duration=6',
      '-c:v',
      'libvpx',
      silent,
    ]);
    ffmpeg([
      '-f',
      'lavfi',
      '-i',
      'testsrc=size=320x180:rate=60:duration=2',
      '-c:v',
      'libvpx',
      fast,
    ]);
    ffmpeg(['-f', 'lavfi', '-i', 'color=c=black:s=200x80', '-frames:v', '1', blackPng]);
    ffmpeg(['-f', 'lavfi', '-i', 'sine=frequency=880:duration=3', clipWav]);
  }, 60_000);

  afterAll(() => {
    if (work) fs.rmSync(work, { recursive: true, force: true });
  });

  it('a text picture is overlaid at its box only while the item is on', async () => {
    const item = newText('t1', { x: 0, y: 0, width: 200, height: 80 }, 1000, 3000);
    const project = edit(createProject(ID, SILENT), { type: 'addItem', item });
    const result = await run(project, 'mp4', silent, {
      textPngs: { t1: fs.readFileSync(blackPng) },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const inside = (seconds: number) => sample(result.path, seconds, 50, 20, 100, 40);
    expect(inside(0.5).mean).toBeGreaterThan(40); // before
    expect(inside(2).max).toBeLessThan(24); // while on: black
    expect(inside(4).mean).toBeGreaterThan(40); // after
    // Elsewhere in the frame the picture is the recording's.
    expect(sample(result.path, 2, 300, 5, 100, 40).mean).toBeGreaterThan(40);
  }, 120_000);

  it('a text item with a fade in appears gradually', async () => {
    const item = {
      ...newText('t1', { x: 0, y: 0, width: 200, height: 80 }, 1000, 5000),
      fadeInMs: 2000,
    };
    const project = edit(createProject(ID, SILENT), { type: 'addItem', item });
    const result = await run(project, 'mp4', silent, {
      textPngs: { t1: fs.readFileSync(blackPng) },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const early = sample(result.path, 1.2, 50, 20, 100, 40).mean;
    const late = sample(result.path, 4, 50, 20, 100, 40).mean;
    expect(late).toBeLessThan(24);
    expect(early).toBeGreaterThan(late + 20); // still mostly the recording
  }, 120_000);

  it('an image item is scaled to its box and honours its opacity', async () => {
    const solid = newImage('i1', ASSET, { x: 300, y: 200, width: 100, height: 50 }, 1000, 3000);
    const half = { ...solid, id: 'i2', opacity: 0.5 };
    const assetPath = (assetId: string, ext: string) =>
      assetId === ASSET && ext === 'png' ? blackPng : null;
    const a = await run(
      edit(createProject(ID, SILENT), { type: 'addItem', item: solid }),
      'mp4',
      silent,
      { assetPath },
    );
    const b = await run(
      edit(createProject(ID, SILENT), { type: 'addItem', item: half }),
      'mp4',
      silent,
      { assetPath },
    );
    expect(a.ok && b.ok).toBe(true);
    if (!a.ok || !b.ok) return;
    const window = (file: string, seconds: number) => sample(file, seconds, 310, 210, 80, 30);
    expect(window(a.path, 2).max).toBeLessThan(24);
    expect(window(a.path, 0.5).mean).toBeGreaterThan(window(a.path, 2).mean + 10);
    const faded = window(b.path, 2);
    expect(faded.mean).toBeLessThan(window(b.path, 0.5).mean);
    expect(faded.max).toBeGreaterThan(24);
  }, 120_000);

  it('an audio clip is mixed in at its place on the source timeline, and a cut keeps its timing', async () => {
    const clip = newAudio(
      'a1',
      { assetId: ASSET, ext: 'wav', name: 'clip.wav', clipMs: 3000 },
      1000,
    );
    const project = edit(
      createProject(ID, SILENT),
      { type: 'addItem', item: clip },
      // Output 0..0.5 is source 0..0.5; output 0.5.. is source 1.5.. (the clip's first half is cut away).
      { type: 'addCut', id: 'c', startMs: 500, endMs: 1500 },
    );
    const result = await run(project, 'mp4', silent, {
      assetPath: (assetId, ext) => (assetId === ASSET && ext === 'wav' ? clipWav : null),
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.probe.audioCodec).toBe('aac');
    expect(Math.abs((result.probe.durationSec ?? 0) - 5)).toBeLessThan(0.3);
    // The clip plays source 1.0 - 4.0 s = output 0.5 - 3.0 s.
    expect(loudness(result.path, 1.0, 0.5)).toBeGreaterThan(-30);
    expect(loudness(result.path, 0.0, 0.3)).toBeLessThan(-60);
    expect(loudness(result.path, 3.5, 0.5)).toBeLessThan(-60);
  }, 120_000);

  it('a clip trimmed inside its file, with volume and fades, still plays', async () => {
    const clip = {
      ...newAudio('a1', { assetId: ASSET, ext: 'wav', name: 'clip.wav', clipMs: 3000 }, 2000),
      inMs: 1000,
      endMs: 4000,
      volume: 0.5,
      fadeInMs: 200,
      fadeOutMs: 200,
    };
    const loud = { ...clip, id: 'a2', volume: 1, startMs: 2000 };
    const quiet = edit(createProject(ID, SILENT), { type: 'addItem', item: clip });
    const full = edit(createProject(ID, SILENT), { type: 'addItem', item: loud });
    const resolve = (assetId: string, ext: string) =>
      assetId === ASSET && ext === 'wav' ? clipWav : null;
    const a = await run(quiet, 'mp4', silent, { assetPath: resolve });
    const b = await run(full, 'mp4', silent, { assetPath: resolve });
    expect(a.ok && b.ok).toBe(true);
    if (!a.ok || !b.ok) return;
    // Half the volume is about 6 dB lower.
    expect(loudness(b.path, 2.6, 0.5) - loudness(a.path, 2.6, 0.5)).toBeGreaterThan(4);
    expect(loudness(a.path, 2.6, 0.5)).toBeGreaterThan(-40);
    // Only 2 s of the file remain after the in-offset: the clip ends by 4 s.
    expect(loudness(a.path, 4.5, 0.5)).toBeLessThan(-60);
  }, 120_000);

  it('a muted clip adds nothing and a GIF ignores clips', async () => {
    const clip = {
      ...newAudio('a1', { assetId: ASSET, ext: 'wav', name: 'clip.wav', clipMs: 3000 }, 1000),
      muted: true,
    };
    const resolve = (assetId: string, ext: string) =>
      assetId === ASSET && ext === 'wav' ? clipWav : null;
    const project = edit(createProject(ID, SILENT), { type: 'addItem', item: clip });
    const muted = await run(project, 'mp4', silent, { assetPath: resolve });
    expect(muted.ok).toBe(true);
    if (muted.ok) expect(loudness(muted.path, 1.5, 0.5)).toBeLessThan(-60);
    const gifProject = edit(
      createProject(ID, SILENT),
      { type: 'addItem', item: { ...clip, muted: false } },
      { type: 'setExport', patch: { format: 'gif', scale: 320 } },
      { type: 'setTrim', startMs: 0, endMs: 2000 },
    );
    const gif = await run(gifProject, 'gif', silent, { assetPath: resolve });
    expect(gif.ok).toBe(true);
    if (gif.ok) expect(gif.probe.hasAudio).toBe(false);
  }, 120_000);

  it('a missing asset fails the export cleanly', async () => {
    const clip = newAudio(
      'a1',
      { assetId: ASSET, ext: 'wav', name: 'clip.wav', clipMs: 3000 },
      1000,
    );
    const result = await run(
      edit(createProject(ID, SILENT), { type: 'addItem', item: clip }),
      'mp4',
      silent,
      {
        assetPath: () => null,
      },
    );
    expect(result).toMatchObject({ ok: false, code: 'FAILED' });
    expect(fs.readdirSync(tempRoot)).toEqual([]);
  }, 60_000);

  it('a 60 fps recording is exported at 60 fps, from the project or from the file', async () => {
    const facts = { durationMs: 2000, width: 320, height: 180, hasAudio: false };
    const known = await run(createProject(ID, { ...facts, fps: 60 }), 'mp4', fast);
    expect(known.ok).toBe(true);
    if (known.ok) expect(known.probe.frameRate).toBe(60);
    // The project says nothing: the file's own rate (believable here) is used.
    const guessed = await run(createProject(ID, facts), 'mp4', fast);
    expect(guessed.ok).toBe(true);
    if (guessed.ok) expect(guessed.probe.frameRate).toBe(60);
    // A 30 fps source stays at 30.
    const slow = await run(createProject(ID, SILENT), 'mp4', silent);
    if (slow.ok) expect(slow.probe.frameRate).toBe(30);
  }, 120_000);
});
