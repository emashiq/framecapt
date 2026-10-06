/**
 * `.fcap` with the REAL vendored ffmpeg/ffprobe (`npm run fetch:ffmpeg`): an fcap is built from a
 * generated WebM, then probed, seeked (`-ss`, decoding one frame from the middle), thumbnailed and
 * extracted (cropped and trimmed to MP4 and WebM) all through `mediaInputArgs`, and a live
 * MediaRecorder-like stream goes through the real session service and recovery into an fcap.
 * Skipped, with a message, when the binaries are not fetched.
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DEFAULT_RECORD_OPTIONS } from '../../src/shared/recorder-ipc';
import { layoutSourceRect, type RecordingLayout } from '../../src/shared/recording-layout';
import { applyCommand, createProject } from '../../src/shared/video-edit';
import { exportEdit } from '../../src/main/media/edit-export';
import { extractFromFcap } from '../../src/main/media/extract';
import {
  createMediaTools,
  FfmpegError,
  mediaInputArgs,
  resolveFfmpeg,
  thumbnailArgs,
} from '../../src/main/media/ffmpeg';
import { readFcapHeader, writeFcap } from '../../src/main/recording/fcap';
import { RecoveryService } from '../../src/main/recording/recovery';
import { nodeSessionFs } from '../../src/main/recording/session-fs';
import { SessionService, type SessionConfig } from '../../src/main/recording/session-service';

const repoRoot = path.resolve(__dirname, '..', '..');
const location = { isPackaged: false, resourcesPath: '', appPath: repoRoot };
let paths: ReturnType<typeof resolveFfmpeg> | null = null;
try {
  paths = resolveFfmpeg(location);
} catch (error) {
  if (!(error instanceof FfmpegError)) throw error;
  console.warn(`SKIPPING fcap integration tests: ${error.message}`);
}

/** A 640 x 360 picture made of two 320 x 360 "sources". */
const LAYOUT: RecordingLayout = {
  width: 640,
  height: 360,
  sources: [
    { name: 'Screen 1', kind: 'screen', rect: { x: 0, y: 0, width: 320, height: 360 } },
    { name: 'Window 2', kind: 'window', rect: { x: 320, y: 0, width: 320, height: 360 } },
  ],
};

const ID = '0f0e0d0c-0b0a-4908-8706-050403020101';
const CONFIG: SessionConfig = {
  mime: 'video/webm;codecs=vp9,opus',
  source: { kind: 'multi', name: 'Multiple sources' },
  layout: LAYOUT,
  options: DEFAULT_RECORD_OPTIONS,
  width: 640,
  height: 360,
};

function ffmpeg(args: string[], maxBuffer = 256 << 20) {
  return spawnSync(paths?.ffmpeg ?? '', args, { shell: false, maxBuffer, windowsHide: true });
}

describe.skipIf(paths === null)('real ffmpeg: .fcap', () => {
  const tools = createMediaTools(() => resolveFfmpeg(location));
  let work: string;
  let webm: string;
  let fcap: string;

  beforeAll(async () => {
    work = fs.mkdtempSync(path.join(os.tmpdir(), 'framecapt-fcapint-'));
    webm = path.join(work, 'source.webm');
    // testsrc2 has a running counter, so frames at different times differ.
    const run = ffmpeg([
      '-hide_banner',
      '-v',
      'error',
      '-f',
      'lavfi',
      '-i',
      'testsrc2=size=640x360:rate=15',
      '-f',
      'lavfi',
      '-i',
      'sine=frequency=440:sample_rate=48000',
      '-t',
      '4',
      '-c:v',
      'libvpx-vp9',
      '-deadline',
      'realtime',
      '-cpu-used',
      '8',
      '-g',
      '15',
      '-c:a',
      'libopus',
      '-shortest',
      '-y',
      webm,
    ]);
    if (run.status !== 0) throw new Error(`could not generate the test video: ${run.stderr}`);
    fcap = path.join(work, 'FrameCapt 2026-10-07 at 10.00.00.fcap');
    await writeFcap(webm, fcap, {
      width: 640,
      height: 360,
      durationMs: 4000,
      hasAudio: true,
      createdAt: Date.now(),
      sources: LAYOUT.sources,
    });
  });
  afterAll(() => {
    fs.rmSync(work, { recursive: true, force: true });
  });

  it('the header reads back and the payload is the original WebM, byte for byte', async () => {
    const header = await readFcapHeader(fcap);
    expect(header).toMatchObject({ width: 640, height: 360, hasAudio: true });
    const bytes = fs.readFileSync(fcap);
    expect(bytes.subarray(header.payloadOffset).equals(fs.readFileSync(webm))).toBe(true);
  });

  it('probes the duration, size and audio through mediaInputArgs (ffprobe skips the header)', async () => {
    const probe = await tools.probe(fcap, { format: 'fcap', timeoutMs: 30_000 });
    expect(probe.hasVideo).toBe(true);
    expect(probe.hasAudio).toBe(true);
    expect(probe.video).toMatchObject({ width: 640, height: 360 });
    expect(probe.durationSec).toBeGreaterThan(3.5);
    expect(probe.durationSec).toBeLessThan(4.6);
    expect(probe.formatName.split(',')).toContain('matroska');
    // Without the helper the same file is not readable: it is not a media file as such.
    await expect(tools.probe(fcap, { timeoutMs: 30_000 })).rejects.toThrow();
  });

  it('seeks (-ss) into the middle and decodes one frame, a different one from the start', async () => {
    const frame = (second: number): Buffer => {
      const run = ffmpeg([
        '-hide_banner',
        '-v',
        'error',
        '-ss',
        String(second),
        ...mediaInputArgs({ path: fcap, format: 'fcap' }),
        '-frames:v',
        '1',
        '-f',
        'image2pipe',
        '-vcodec',
        'png',
        'pipe:1',
      ]);
      expect(run.status, String(run.stderr)).toBe(0);
      expect(run.stderr.toString().trim()).toBe('');
      return run.stdout;
    };
    const start = frame(0);
    const middle = frame(2);
    expect(start.length).toBeGreaterThan(1000);
    expect(middle.length).toBeGreaterThan(1000);
    expect(middle.equals(start)).toBe(false);
    // Seeking is also accurate: the same second twice is the same picture.
    expect(frame(2).equals(middle)).toBe(true);
  });

  it('decodes the whole payload without errors', () => {
    const run = ffmpeg([
      '-hide_banner',
      '-v',
      'error',
      ...mediaInputArgs({ path: fcap, format: 'fcap' }),
      '-f',
      'null',
      '-',
    ]);
    expect(run.status).toBe(0);
    expect(run.stderr.toString().trim()).toBe('');
  });

  it('makes a thumbnail from the fcap', async () => {
    const png = path.join(work, 'thumb.png');
    const result = await tools.run(thumbnailArgs(fcap, png, 1, 320, 'fcap'), { timeoutMs: 30_000 });
    expect(result.code).toBe(0);
    expect(fs.statSync(png).size).toBeGreaterThan(500);
  });

  it('extracts one source, trimmed, as MP4 with the crop size and the requested length', async () => {
    const dest = path.join(work, 'FrameCapt 2026-10-07 at 10.00.00 - Window 2.mp4');
    const result = await extractFromFcap({
      tools,
      spec: {
        input: { path: fcap, format: 'fcap' },
        startMs: 1000,
        endMs: 3000,
        crop: LAYOUT.sources[1]!.rect,
        format: 'mp4',
      },
      picture: LAYOUT,
      destPath: dest,
    });
    expect(result, JSON.stringify(result)).toMatchObject({ ok: true });
    if (!result.ok) return;
    expect(result.probe.video).toMatchObject({ width: 320, height: 360, codec: 'h264' });
    expect(result.probe.audioCodec).toBe('aac');
    expect(result.probe.durationSec).toBeGreaterThan(1.7);
    expect(result.probe.durationSec).toBeLessThan(2.4);
    // The right half of the picture: its content differs from the left half's.
    const half = (rect: string): Buffer => {
      const run = ffmpeg([
        '-hide_banner',
        '-v',
        'error',
        '-ss',
        '1',
        ...mediaInputArgs({ path: fcap, format: 'fcap' }),
        '-frames:v',
        '1',
        '-vf',
        `crop=${rect}`,
        '-f',
        'image2pipe',
        '-vcodec',
        'png',
        'pipe:1',
      ]);
      return run.stdout;
    };
    expect(half('320:360:0:0').equals(half('320:360:320:0'))).toBe(false);
    // The fcap is untouched and no partial file is left.
    expect(fs.readdirSync(work).filter((name) => name.includes('.partial'))).toEqual([]);
  });

  it('edits an fcap in the video editor: crop to one source, exported as a normal MP4', async () => {
    const probe = await tools.probe(fcap, { format: 'fcap', timeoutMs: 30_000 });
    const project = applyCommand(
      createProject('11111111-1111-4111-8111-111111111111', {
        durationMs: Math.round((probe.durationSec ?? 0) * 1000),
        width: 640,
        height: 360,
        hasAudio: true,
      }),
      { type: 'setCrop', crop: layoutSourceRect(LAYOUT, 1) },
    );
    const dest = path.join(work, 'FrameCapt 2026-10-07 at 10.00.00 (edited).mp4');
    const result = await exportEdit({
      tools,
      sourcePath: fcap,
      sourceFormat: 'fcap',
      destPath: dest,
      project,
      format: 'mp4',
    });
    expect(result, JSON.stringify(result)).toMatchObject({ ok: true });
    if (!result.ok) return;
    expect(result.probe.video).toMatchObject({ width: 320, height: 360, codec: 'h264' });
    expect(result.probe.audioCodec).toBe('aac');
    expect(result.probe.durationSec).toBeGreaterThan(3.4);
    expect(result.probe.durationSec).toBeLessThan(4.6);
    // A normal MP4: it reads without any helper.
    expect((await tools.probe(dest, { timeoutMs: 30_000 })).video?.width).toBe(320);
  });

  it('extracts the whole picture as WebM, and refuses a wrong destination extension', async () => {
    const dest = path.join(work, 'all.webm');
    const result = await extractFromFcap({
      tools,
      spec: {
        input: { path: fcap, format: 'fcap' },
        startMs: 0,
        endMs: 1500,
        crop: null,
        format: 'webm',
      },
      picture: LAYOUT,
      destPath: dest,
    });
    expect(result, JSON.stringify(result)).toMatchObject({ ok: true });
    if (!result.ok) return;
    expect(result.probe.video).toMatchObject({ width: 640, height: 360, codec: 'vp9' });
    const wrong = await extractFromFcap({
      tools,
      spec: {
        input: { path: fcap, format: 'fcap' },
        startMs: 0,
        endMs: 1000,
        crop: null,
        format: 'mp4',
      },
      picture: LAYOUT,
      destPath: path.join(work, 'x.webm'),
    });
    expect(wrong).toMatchObject({ ok: false, code: 'INVALID_DESTINATION' });
  });

  it('a cancelled extract leaves no partial file and no output', async () => {
    const dest = path.join(work, 'cancelled.mp4');
    const controller = new AbortController();
    controller.abort();
    const result = await extractFromFcap({
      tools,
      spec: {
        input: { path: fcap, format: 'fcap' },
        startMs: 0,
        endMs: 2000,
        crop: null,
        format: 'mp4',
      },
      picture: LAYOUT,
      destPath: dest,
      signal: controller.signal,
    });
    expect(result).toMatchObject({ ok: false, code: 'CANCELLED' });
    expect(fs.existsSync(dest)).toBe(false);
  });
});

describe.skipIf(paths === null)('real ffmpeg: a multi-source session becomes an .fcap', () => {
  const tools = createMediaTools(() => resolveFfmpeg(location));
  let work: string;
  let live: Buffer;

  beforeAll(() => {
    work = fs.mkdtempSync(path.join(os.tmpdir(), 'framecapt-fcapsess-'));
    // Like MediaRecorder: a live WebM without Duration or Cues.
    const run = ffmpeg([
      '-hide_banner',
      '-v',
      'error',
      '-f',
      'lavfi',
      '-i',
      'testsrc=size=640x360:rate=30',
      '-t',
      '3',
      '-c:v',
      'libvpx-vp9',
      '-deadline',
      'realtime',
      '-cpu-used',
      '8',
      '-f',
      'webm',
      '-live',
      '1',
      'pipe:1',
    ]);
    if (run.status !== 0) throw new Error(`could not generate the test stream: ${run.stderr}`);
    live = run.stdout;
  });
  afterAll(() => {
    fs.rmSync(work, { recursive: true, force: true });
  });

  async function feed(service: SessionService, finish: boolean): Promise<void> {
    await service.create(CONFIG, ID, 1);
    const part = Math.ceil(live.length / 6);
    const chunks = Array.from({ length: 6 }, (_, i) => live.subarray(i * part, (i + 1) * part));
    await Promise.all(chunks.map((chunk, seq) => service.append(ID, seq, chunk, 1)));
    if (finish) await service.finish(ID, chunks.length - 1, 1);
  }

  it('finalize: remux in the session directory, then ONE .fcap in the output folder', async () => {
    const root = path.join(work, 'root1');
    const out = path.join(work, 'out1');
    fs.mkdirSync(root, { recursive: true });
    const service = new SessionService(root, { diskCheckEveryMs: 0 });
    await feed(service, true);
    const result = await service.finalize(ID, {
      outputDir: out,
      tools,
      date: new Date(2026, 9, 7, 10, 0, 0),
    });
    expect(path.basename(result.outputPath)).toBe('FrameCapt 2026-10-07 at 10.00.00.fcap');
    expect(result.unindexed).toBe(false);
    expect(result.durationMs).toBeGreaterThan(2500);
    // Only the .fcap is in the output folder: no temporary WebM, no partial.
    expect(fs.readdirSync(out)).toEqual(['FrameCapt 2026-10-07 at 10.00.00.fcap']);
    const header = await readFcapHeader(result.outputPath);
    expect(header).toMatchObject({ width: 640, height: 360, hasAudio: false });
    expect(header.sources.map((source) => source.name)).toEqual(['Screen 1', 'Window 2']);
    expect(Math.abs(header.durationMs - (result.durationMs ?? 0))).toBeLessThan(5);
    const probe = await tools.probe(result.outputPath, { format: 'fcap', timeoutMs: 30_000 });
    expect(probe.durationSec).toBeGreaterThan(2.5);
    // The session directory is gone; its completion record names the fcap and the multi source.
    expect(fs.existsSync(path.join(root, ID))).toBe(false);
    const record = JSON.parse(fs.readFileSync(path.join(root, 'completed', `${ID}.json`), 'utf8'));
    expect(record.source.kind).toBe('multi');
    expect(record.outputPath).toBe(result.outputPath);
    await service.closeAll();
  });

  it('recovery wraps an interrupted multi-source session the same way', async () => {
    const root = path.join(work, 'root2');
    const out = path.join(work, 'out2');
    fs.mkdirSync(root, { recursive: true });
    const service = new SessionService(root, { diskCheckEveryMs: 0 });
    await feed(service, false); // the app "died": no finish, no finalize
    await service.closeAll();
    const recovery = new RecoveryService({
      rootDir: root,
      fs: nodeSessionFs,
      tools,
      outputDir: () => out,
      isActive: () => false,
    });
    const outcome = await recovery.recover(ID);
    expect(outcome.outcome).toBe('recovered');
    if (outcome.outcome !== 'recovered') return;
    expect(outcome.fileName).toMatch(/^FrameCapt .* \(recovered\)\.fcap$/);
    expect(fs.readdirSync(out)).toEqual([outcome.fileName]);
    const header = await readFcapHeader(outcome.outputPath);
    expect(header.sources).toHaveLength(2);
    expect(header.durationMs).toBeGreaterThan(1000);
  });
});
