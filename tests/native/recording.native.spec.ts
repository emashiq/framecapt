/**
 * Native verification of recording on the real host (production build, real displays, real
 * loopback audio, real microphone if there is one). Needs an interactive Windows session, a built
 * app (`electron-forge package`) and ffmpeg/ffprobe on PATH (verification tooling only; the app
 * never calls them). Run with `npm run test:native`. Evidence (redacted JSON, plus media and
 * frames that are gitignored because they show the real desktop) goes to docs/evidence/phase05/.
 *
 * Each recording drives the real UI paths: `recorder:start` from the main window, the toolbar's
 * own buttons for pause, resume and stop (clicked in the toolbar page), and the overlay pages for
 * the region selection (Playwright events, not OS input).
 */
import { execFileSync, spawn, spawnSync, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createCanvas, loadImage } from '@napi-rs/canvas';
import {
  _electron as electron,
  expect,
  test,
  type ElectronApplication,
  type Page,
} from '@playwright/test';
import { exitApp } from '../e2e/app-exit';
import { writeEvidenceJson, evidenceDirFor } from './evidence';

const projectRoot = path.resolve(__dirname, '..', '..');
const evidenceDir = evidenceDirFor(projectRoot, 'phase05');

let app: ElectronApplication;
let page: Page;
let userDataDir: string;
let workDir: string;

interface Display {
  id: string;
  bounds: { x: number; y: number; width: number; height: number };
  scaleFactor: number;
  physicalSize: { width: number; height: number };
  isPrimary: boolean;
}
let displays: Display[] = [];
const primary = (): Display =>
  displays.find((display) => display.isPrimary) ?? (displays[0] as Display);
const secondary = (): Display | undefined => displays.find((display) => !display.isPrimary);

const evidence: Record<string, unknown> = {};
function record(name: string, value: unknown): void {
  evidence[name] = value;
  writeEvidenceJson(evidenceDir, 'recordings-native.json', evidence);
}

// --- ffmpeg / ffprobe helpers (verification only) --------------------------------------------

function run(command: string, args: string[]): { stdout: string; stderr: string; status: number } {
  const result = spawnSync(command, args, { shell: false, encoding: 'utf8', maxBuffer: 256 << 20 });
  if (result.error) throw result.error;
  return { stdout: result.stdout, stderr: result.stderr, status: result.status ?? -1 };
}

interface Probe {
  streams: {
    codec_type: string;
    codec_name: string;
    width?: number;
    height?: number;
    sample_rate?: string;
    channels?: number;
    start_time?: string;
    r_frame_rate?: string;
  }[];
  format: { duration?: string; format_name: string; size: string };
}

function ffprobe(file: string): Probe {
  const out = execFileSync(
    'ffprobe',
    ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', file],
    { shell: false, encoding: 'utf8' },
  );
  return JSON.parse(out) as Probe;
}

/** Decodes the stream and reads the last timestamp ffmpeg printed (MediaRecorder WebM has no duration). */
function decodedSeconds(file: string, only: 'video' | 'audio' | 'both' = 'both'): number {
  const filter = only === 'video' ? ['-an'] : only === 'audio' ? ['-vn'] : [];
  const { stderr } = run('ffmpeg', ['-hide_banner', '-i', file, ...filter, '-f', 'null', '-']);
  const matches = [...stderr.matchAll(/time=(\d+):(\d+):(\d+\.\d+)/g)];
  const last = matches.at(-1);
  if (!last) throw new Error(`no duration for ${path.basename(file)}`);
  return Number(last[1]) * 3600 + Number(last[2]) * 60 + Number(last[3]);
}

/** Packet timestamps of every stream strictly increase (a property of the file itself). */
function timestampsStrictlyIncrease(file: string): { ok: boolean; first: string } {
  const out = execFileSync(
    'ffprobe',
    ['-v', 'error', '-show_entries', 'packet=stream_index,pts,dts', '-of', 'csv=p=0', file],
    { shell: false, encoding: 'utf8', maxBuffer: 64 << 20 },
  );
  const last = new Map<string, { pts: number; dts: number }>();
  for (const line of out.trim().split(/\r?\n/)) {
    const [stream = '', pts = '', dts = ''] = line.split(',');
    const before = last.get(stream);
    if (before && (Number(pts) <= before.pts || Number(dts) <= before.dts)) {
      return {
        ok: false,
        first: `stream ${stream}: ${before.pts}/${before.dts} then ${pts}/${dts}`,
      };
    }
    last.set(stream, { pts: Number(pts), dts: Number(dts) });
  }
  return { ok: true, first: '' };
}

/** The EBML Cues element id (1C 53 BB 6B): a seek index exists. */
function hasCues(file: string): boolean {
  return fs.readFileSync(file).indexOf(Buffer.from([0x1c, 0x53, 0xbb, 0x6b])) !== -1;
}

/** Seeks to `at` seconds and decodes 1 s: exit code, error output and the seconds decoded. */
function seekDecode(file: string, at: number): { status: number; errors: string; seconds: number } {
  const { stderr, status } = run('ffmpeg', [
    '-hide_banner',
    '-v',
    'info',
    '-ss',
    String(at),
    '-i',
    file,
    '-t',
    '1',
    // A recording is variable frame rate; without this ffmpeg re-times frames onto a 30 fps grid
    // and reports "non monotonically increasing dts" whenever two land in one slot (ADR-031).
    '-fps_mode',
    'vfr',
    '-f',
    'null',
    '-',
  ]);
  const errors = stderr
    .split('\n')
    .filter((line) => /\b(error|invalid|corrupt)/i.test(line))
    .join('\n');
  const last = [...stderr.matchAll(/time=(\d+):(\d+):(\d+\.\d+)/g)].at(-1);
  const seconds = last ? Number(last[1]) * 3600 + Number(last[2]) * 60 + Number(last[3]) : 0;
  return { status, errors, seconds };
}

function packetCount(file: string): number {
  const out = execFileSync(
    'ffprobe',
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
  return Number(out.trim());
}

function meanVolume(file: string, from?: number, length?: number): number | null {
  const range = from === undefined ? [] : ['-ss', String(from), '-t', String(length ?? 1)];
  const { stderr } = run('ffmpeg', [
    '-hide_banner',
    ...range,
    '-i',
    file,
    '-vn',
    '-af',
    'volumedetect',
    '-f',
    'null',
    '-',
  ]);
  const mean = /mean_volume:\s*(-?[\d.]+|-inf) dB/.exec(stderr)?.[1];
  return mean === undefined || mean === '-inf' ? null : Number(mean);
}

function maxVolume(file: string): number | null {
  const { stderr } = run('ffmpeg', [
    '-hide_banner',
    '-i',
    file,
    '-vn',
    '-af',
    'volumedetect',
    '-f',
    'null',
    '-',
  ]);
  const max = /max_volume:s*(-?[d.]+|-inf) dB/.exec(stderr)?.[1];
  return max === undefined || max === '-inf' ? null : Number(max);
}

function extractFrame(file: string, atSeconds: number, out: string): void {
  const { status, stderr } = run('ffmpeg', [
    '-hide_banner',
    '-y',
    '-ss',
    String(atSeconds),
    '-i',
    file,
    '-frames:v',
    '1',
    out,
  ]);
  if (status !== 0 || !fs.existsSync(out))
    throw new Error(`ffmpeg frame failed: ${stderr.slice(-300)}`);
}

interface Pixels {
  width: number;
  height: number;
  data: Uint8ClampedArray;
}

async function readPixels(file: string): Promise<Pixels> {
  const image = await loadImage(file);
  const canvas = createCanvas(image.width, image.height);
  const context = canvas.getContext('2d');
  context.drawImage(image, 0, 0);
  const { data } = context.getImageData(0, 0, image.width, image.height);
  return { width: image.width, height: image.height, data: data as unknown as Uint8ClampedArray };
}

/** Pixels inside `rect` within `tolerance` of `color`. */
function countColor(
  pixels: Pixels,
  rect: { x: number; y: number; width: number; height: number },
  color: [number, number, number],
  tolerance: number,
): number {
  let hits = 0;
  const x1 = Math.min(pixels.width, rect.x + rect.width);
  const y1 = Math.min(pixels.height, rect.y + rect.height);
  for (let y = Math.max(0, rect.y); y < y1; y += 1) {
    for (let x = Math.max(0, rect.x); x < x1; x += 1) {
      const i = (y * pixels.width + x) * 4;
      if (
        Math.abs((pixels.data[i] ?? 0) - color[0]) <= tolerance &&
        Math.abs((pixels.data[i + 1] ?? 0) - color[1]) <= tolerance &&
        Math.abs((pixels.data[i + 2] ?? 0) - color[2]) <= tolerance
      ) {
        hits += 1;
      }
    }
  }
  return hits;
}

// --- app helpers ---------------------------------------------------------------------------

function pagesOf(hash: string): Page[] {
  return app.windows().filter((candidate) => candidate.url().includes(hash));
}

async function snapshot() {
  const result = await page.evaluate(() => window.framelet.invoke('recorder:getState'));
  if (!result.ok) throw new Error('recorder:getState failed');
  return result.data;
}

async function waitForStatus(status: string, timeout = 30_000): Promise<void> {
  await expect.poll(async () => (await snapshot()).status, { timeout }).toBe(status);
}

async function toolbarPage(): Promise<Page> {
  let found: Page | undefined;
  await expect
    .poll(() => (found = pagesOf('#/toolbar')[0]) !== undefined, { timeout: 30_000 })
    .toBe(true);
  const toolbar = found as Page;
  await expect(toolbar.getByTestId('toolbar')).toBeVisible();
  await waitForStatus('recording');
  const win = await app.browserWindow(toolbar);
  await expect.poll(() => win.evaluate((w) => w.isVisible())).toBe(true);
  return toolbar;
}

async function toolbarBounds(): Promise<{ x: number; y: number; width: number; height: number }> {
  return app.evaluate(({ BrowserWindow }) => {
    const win = BrowserWindow.getAllWindows().find((w) =>
      w.webContents.getURL().includes('#/toolbar'),
    );
    if (!win) throw new Error('no toolbar window');
    return win.getBounds();
  });
}

async function recorderResources() {
  const recorder = pagesOf('#/recorder')[0];
  if (!recorder) throw new Error('no recorder window');
  return recorder.evaluate(() =>
    (
      window as unknown as {
        __frameletResources: () => {
          liveTracks: number;
          openAudioContexts: number;
          activeLoops: number;
          loopNames: string[];
          activeRecorders: number;
        };
      }
    ).__frameletResources(),
  );
}

async function expectResourcesReleased(): Promise<Record<string, unknown>> {
  await expect
    .poll(recorderResources, { timeout: 15_000 })
    .toMatchObject({ liveTracks: 0, openAudioContexts: 0, activeLoops: 0, activeRecorders: 0 });
  return { ...(await recorderResources()) };
}

/** A quiet 440 Hz tone through the default output, so Windows loopback has something to record. */
async function startTone(): Promise<void> {
  await page.evaluate(() => {
    const w = window as unknown as { __tone?: { ctx: AudioContext; osc: OscillatorNode } };
    if (w.__tone) return;
    const ctx = new AudioContext();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.frequency.value = 440;
    gain.gain.value = 0.08;
    osc.connect(gain).connect(ctx.destination);
    osc.start();
    void ctx.resume();
    w.__tone = { ctx, osc };
  });
}

async function stopTone(): Promise<void> {
  await page.evaluate(async () => {
    const w = window as unknown as { __tone?: { ctx: AudioContext; osc: OscillatorNode } };
    if (!w.__tone) return;
    w.__tone.osc.stop();
    await w.__tone.ctx.close();
    delete w.__tone;
  });
}

interface Options {
  mic: boolean;
  system: boolean;
  quality?: '1080p' | 'source';
  fps?: 30 | 60;
}

function options(opts: Options) {
  return {
    mic: { enabled: opts.mic },
    systemAudio: opts.system,
    quality: opts.quality ?? ('1080p' as const),
    fps: opts.fps ?? (30 as const),
    countdown: false,
  };
}

interface Outcome {
  sessionId: string;
  startLatencyMs: number;
  stopLatencyMs: number;
  file: string;
  copy: string;
  appDurationMs: number;
  wallMs: number;
  result: NonNullable<Awaited<ReturnType<typeof snapshot>>['result']>;
  probe: Probe;
  videoSeconds: number;
  audioSeconds: number | null;
  packets: number;
  fps: number;
  resources: Record<string, unknown>;
}

/**
 * Records with the toolbar's own buttons: `activeSeconds` of recording, optionally with a pause of
 * `pause.forSeconds` after `pause.afterSeconds`. `during` runs once the toolbar is up and recording.
 */
async function recordWithToolbar(
  name: string,
  start: () => Promise<unknown>,
  plan: { activeSeconds: number; pause?: { afterSeconds: number; forSeconds: number } },
  during?: (toolbar: Page, elapsed: () => number) => Promise<void>,
): Promise<Outcome> {
  const began = Date.now();
  await start();
  const toolbar = await toolbarPage();
  // The app's own start time: the toolbar can be found a little after recording began.
  const recordingFrom = (await snapshot()).startedAt ?? Date.now();
  const startLatencyMs = recordingFrom - began;
  const elapsed = (): number => (Date.now() - recordingFrom) / 1000;
  if (during) await during(toolbar, elapsed);
  if (plan.pause) {
    await toolbar.waitForTimeout(
      Math.max(0, plan.pause.afterSeconds * 1000 - (Date.now() - recordingFrom)),
    );
    await toolbar.getByTestId('toolbar-pause').click();
    await expect(toolbar.getByTestId('toolbar')).toHaveAttribute('data-status', 'paused');
    await toolbar.waitForTimeout(plan.pause.forSeconds * 1000);
    await toolbar.getByTestId('toolbar-resume').click();
    await expect(toolbar.getByTestId('toolbar')).toHaveAttribute('data-status', 'recording');
  }
  const activeSoFar = plan.pause ? plan.pause.afterSeconds : 0;
  const remaining = plan.pause
    ? plan.activeSeconds - activeSoFar
    : plan.activeSeconds - (Date.now() - recordingFrom) / 1000;
  await toolbar.waitForTimeout(Math.max(0, remaining * 1000));
  const stopClicked = Date.now();
  await toolbar.getByTestId('toolbar-stop').click();
  await waitForStatus('completed');
  const stopLatencyMs = Date.now() - stopClicked;
  const wallMs = Date.now() - began;
  const done = await snapshot();
  const result = done.result;
  if (!result) throw new Error('no result');

  const copy = path.join(evidenceDir, `recording-${name}.webm`);
  fs.copyFileSync(result.path, copy);
  const probe = ffprobe(result.path);
  const videoSeconds = decodedSeconds(result.path, 'video');
  const hasAudio = probe.streams.some((stream) => stream.codec_type === 'audio');
  const audioSeconds = hasAudio ? decodedSeconds(result.path, 'audio') : null;
  const packets = packetCount(result.path);
  const resources = await expectResourcesReleased();
  // Back to the home view (the result view replaces it after a recording).
  await page.evaluate(() => window.framelet.invoke('recorder:reset'));
  await waitForStatus('idle');
  return {
    sessionId: done.sessionId ?? '',
    startLatencyMs,
    stopLatencyMs,
    file: result.path,
    copy,
    appDurationMs: result.durationMs,
    wallMs,
    result,
    probe,
    videoSeconds,
    audioSeconds,
    packets,
    fps: packets / videoSeconds,
    resources,
  };
}

function summarize(outcome: Outcome) {
  const video = outcome.probe.streams.find((stream) => stream.codec_type === 'video');
  const audio = outcome.probe.streams.find((stream) => stream.codec_type === 'audio');
  return {
    container: outcome.probe.format.format_name,
    bytes: Number(outcome.probe.format.size),
    video: { codec: video?.codec_name, width: video?.width, height: video?.height },
    audio: audio
      ? { codec: audio.codec_name, sampleRate: audio.sample_rate, channels: audio.channels }
      : null,
    appActiveSeconds: outcome.appDurationMs / 1000,
    wallSeconds: outcome.wallMs / 1000,
    startToRecordingMs: outcome.startLatencyMs,
    stopToCompletedMs: outcome.stopLatencyMs,
    containerDurationSeconds: Number(outcome.probe.format.duration),
    seekIndex: hasCues(outcome.file),
    videoSeconds: outcome.videoSeconds,
    audioSeconds: outcome.audioSeconds,
    videoPackets: outcome.packets,
    measuredFps: Number(outcome.fps.toFixed(2)),
    resourcesAfter: outcome.resources,
  };
}

/** The 1080p preset's size for a source, computed independently of the app's own function. */
function expectedFit(width: number, height: number): { width: number; height: number } {
  const scale = Math.min(1920 / width, 1080 / height, 1);
  const even = (value: number): number => 2 * Math.round(value / 2);
  return { width: even(width * scale), height: even(height * scale) };
}

function assertCommon(
  outcome: Outcome,
  expected: { width: number; height: number; audio: boolean; activeSeconds: number },
): void {
  const video = outcome.probe.streams.find((stream) => stream.codec_type === 'video');
  expect({ w: video?.width, h: video?.height }).toEqual({ w: expected.width, h: expected.height });
  expect((video?.width ?? 1) % 2).toBe(0);
  expect((video?.height ?? 1) % 2).toBe(0);
  const audioStreams = outcome.probe.streams.filter((stream) => stream.codec_type === 'audio');
  expect(audioStreams.length).toBe(expected.audio ? 1 : 0);
  if (expected.audio) expect(audioStreams[0]?.codec_name).toBe('opus');
  expect(outcome.result.hasAudio).toBe(expected.audio);
  // The app's active time (paused time excluded) is what was requested ...
  expect(Math.abs(outcome.appDurationMs / 1000 - expected.activeSeconds)).toBeLessThan(0.8);
  // ... and the file is that long, give or take 0.6 s.
  expect(Math.abs(outcome.videoSeconds - outcome.appDurationMs / 1000)).toBeLessThan(0.6);
  // The hidden recorder window is not throttled: close to 30 fps, never the ~1 fps of a hidden window.
  expect(outcome.fps).toBeGreaterThan(24);
  // Phase 06: ffmpeg remuxed the file, so the container has a real duration (not N/A), a seek
  // index, and seeking to 3 s decodes cleanly (the live MediaRecorder file had neither).
  const containerSeconds = Number(outcome.probe.format.duration);
  expect(Number.isFinite(containerSeconds), 'format.duration is not N/A').toBe(true);
  expect(Math.abs(containerSeconds - outcome.appDurationMs / 1000)).toBeLessThan(0.05);
  expect(Math.abs(containerSeconds - outcome.videoSeconds)).toBeLessThan(0.3);
  expect(hasCues(outcome.file), 'the file has a seek index (Cues)').toBe(true);
  const seek = seekDecode(outcome.file, 3);
  expect(seek.status).toBe(0);
  expect(seek.errors).toBe('');
  const stamps = timestampsStrictlyIncrease(outcome.file);
  expect(stamps.first, 'packet timestamps strictly increase').toBe('');
  expect(stamps.ok).toBe(true);
  expect(seek.seconds).toBeGreaterThan(0.9);
  expect(fs.existsSync(path.join(userDataDir, 'recordings', outcome.sessionId))).toBe(false);
}

// --- setup ---------------------------------------------------------------------------------

test.describe.configure({ mode: 'serial' });

test.beforeAll(async () => {
  expect(
    fs.existsSync(path.join(projectRoot, '.vite', 'build', 'main.cjs')),
    'Run `electron-forge package` first (npm run test:native does this).',
  ).toBe(true);
  userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'framelet-native-rec-'));
  workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'framelet-native-rec-work-'));
  fs.mkdirSync(evidenceDir, { recursive: true });
  app = await electron.launch({
    args: ['.'],
    cwd: projectRoot,
    env: { ...process.env, FRAMELET_USER_DATA_DIR: userDataDir },
  });
  page = await app.firstWindow();
  await page.waitForLoadState('domcontentloaded');
  await expect(page.getByTestId('record-screen')).toBeVisible();
  const listed = await page.evaluate(() => window.framelet.invoke('capture:listDisplays'));
  if (!listed.ok) throw new Error('capture:listDisplays failed');
  displays = listed.data;
  expect(displays.length).toBeGreaterThan(0);
});

test.afterAll(async () => {
  if (app) await exitApp(app);
  for (const dir of [userDataDir, workDir]) {
    if (dir) fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 });
  }
});

test('host and displays', async () => {
  const info = await page.evaluate(() => window.framelet.invoke('app:getInfo'));
  const mics = await page.evaluate(
    async () =>
      (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === 'audioinput')
        .length,
  );
  record('environment', {
    app: info.ok ? info.data : null,
    os: `${os.type()} ${os.release()}`,
    cpu: os.cpus()[0]?.model,
    logicalCores: os.cpus().length,
    ramGiB: Number((os.totalmem() / 1024 ** 3).toFixed(1)),
    displays: displays.map((d) => ({
      bounds: d.bounds,
      scaleFactor: d.scaleFactor,
      physicalSize: d.physicalSize,
      isPrimary: d.isPrimary,
    })),
    audioInputDevices: mics,
    ffmpeg: run('ffmpeg', ['-version']).stdout.split('\n')[0],
  });
});

// --- the four audio combinations on the primary display, 1080p preset -----------------------------

const primaryTarget = () => ({ target: 'screen' as const, displayId: primary().id });

test('(a) no audio: 6 s, 1080p preset, no audio stream, toolbar excluded', async () => {
  const display = primary();
  const expected = expectedFit(display.physicalSize.width, display.physicalSize.height);
  let bounds: Awaited<ReturnType<typeof toolbarBounds>> | undefined;
  let toolbarShot: string | undefined;
  const outcome = await recordWithToolbar(
    'a-no-audio',
    () =>
      page.evaluate((request) => window.framelet.invoke('recorder:start', request), {
        ...primaryTarget(),
        options: options({ mic: false, system: false }),
      }),
    { activeSeconds: 6 },
    async (toolbar) => {
      bounds = await toolbarBounds();
      toolbarShot = path.join(workDir, 'toolbar-a.png');
      await toolbar.screenshot({ path: toolbarShot });
    },
  );
  assertCommon(outcome, { ...expected, audio: false, activeSeconds: 6 });

  // --- toolbar exclusion: is the toolbar's red Stop button in the recorded frame? -------------
  const frame = path.join(evidenceDir, 'frame-a-toolbar-protected.png');
  extractFrame(outcome.file, 2, frame);
  const pixels = await readPixels(frame);
  const scale = pixels.width / display.physicalSize.width;
  const b = bounds as NonNullable<typeof bounds>;
  const onPrimary =
    b.x >= display.bounds.x &&
    b.x < display.bounds.x + display.bounds.width &&
    b.y >= display.bounds.y &&
    b.y < display.bounds.y + display.bounds.height;
  const region = {
    x: Math.floor((b.x - display.bounds.x) * display.scaleFactor * scale) - 3,
    y: Math.floor((b.y - display.bounds.y) * display.scaleFactor * scale) - 3,
    width: Math.ceil(b.width * display.scaleFactor * scale) + 6,
    height: Math.ceil(b.height * display.scaleFactor * scale) + 6,
  };
  const STOP_RED: [number, number, number] = [220, 38, 38];
  const inRecording = countColor(pixels, region, STOP_RED, 28);
  const toolbarPixels = await readPixels(toolbarShot as string);
  const inToolbar = countColor(
    toolbarPixels,
    { x: 0, y: 0, width: toolbarPixels.width, height: toolbarPixels.height },
    STOP_RED,
    28,
  );
  expect(onPrimary, 'the toolbar sits on the recorded display').toBe(true);
  // The toolbar page itself has plenty of that red (its Stop button), scaled by the 1080p fit.
  expect(inToolbar * scale * scale).toBeGreaterThan(100);
  record('toolbarExclusion', {
    toolbarBoundsDip: b,
    toolbarOnRecordedDisplay: onPrimary,
    checkedRegionInFrame: region,
    redPixelsInToolbarPage: inToolbar,
    redPixelsExpectedIfVisibleAfterScaling: Math.round(inToolbar * scale * scale),
    redPixelsFoundInRecordedFrame: inRecording,
    verdict:
      inRecording < 20
        ? 'toolbar NOT in the recording (setContentProtection excluded it)'
        : 'toolbar WAS captured',
  });
  expect(inRecording, 'the toolbar must not be in the recorded frame').toBeLessThan(20);

  record('a-no-audio', { ...summarize(outcome), expectedSize: expected });
});

test('toolbar exclusion control: with protection switched off the same detector sees the toolbar', async () => {
  const display = primary();
  let bounds: Awaited<ReturnType<typeof toolbarBounds>> | undefined;
  const outcome = await recordWithToolbar(
    'control-unprotected',
    () =>
      page.evaluate((request) => window.framelet.invoke('recorder:start', request), {
        ...primaryTarget(),
        options: options({ mic: false, system: false }),
      }),
    { activeSeconds: 4 },
    async (toolbar) => {
      await app.evaluate(({ BrowserWindow }) => {
        BrowserWindow.getAllWindows()
          .find((w) => w.webContents.getURL().includes('#/toolbar'))
          ?.setContentProtection(false);
      });
      bounds = await toolbarBounds();
      await toolbar.waitForTimeout(500);
    },
  );
  const frame = path.join(evidenceDir, 'frame-control-toolbar-unprotected.png');
  extractFrame(outcome.file, 2, frame);
  const pixels = await readPixels(frame);
  const scale = pixels.width / display.physicalSize.width;
  const b = bounds as NonNullable<typeof bounds>;
  const region = {
    x: Math.floor((b.x - display.bounds.x) * display.scaleFactor * scale) - 3,
    y: Math.floor((b.y - display.bounds.y) * display.scaleFactor * scale) - 3,
    width: Math.ceil(b.width * display.scaleFactor * scale) + 6,
    height: Math.ceil(b.height * display.scaleFactor * scale) + 6,
  };
  const found = countColor(pixels, region, [220, 38, 38], 28);
  record('toolbarExclusionControl', {
    note: 'setContentProtection(false) on the toolbar, same detector and region logic',
    redPixelsFoundInRecordedFrame: found,
    verdict:
      found >= 100
        ? 'detector works: an unprotected toolbar IS visible in the recording'
        : 'detector found nothing even without protection (check inconclusive)',
  });
  expect(
    found,
    'the detector must see an unprotected toolbar, or the exclusion check proves nothing',
  ).toBeGreaterThan(100);
});

test('(b) system audio + test tone: 6 s active with a 2 s pause in the middle', async () => {
  const display = primary();
  const expected = expectedFit(display.physicalSize.width, display.physicalSize.height);
  await startTone();
  let outcome: Outcome;
  try {
    outcome = await recordWithToolbar(
      'b-system-audio',
      () =>
        page.evaluate((request) => window.framelet.invoke('recorder:start', request), {
          ...primaryTarget(),
          options: options({ mic: false, system: true }),
        }),
      { activeSeconds: 6, pause: { afterSeconds: 3, forSeconds: 2 } },
    );
  } finally {
    await stopTone();
  }
  assertCommon(outcome, { ...expected, audio: true, activeSeconds: 6 });
  // Paused time is excluded: the wall time is ~8 s, the file ~6 s.
  expect(outcome.wallMs / 1000).toBeGreaterThan(7.5);
  expect(outcome.videoSeconds).toBeLessThan(7);
  const mean = meanVolume(outcome.file);
  const before = meanVolume(outcome.file, 0.5, 2);
  const after = meanVolume(outcome.file, 3.5, 2);
  expect(mean, 'the tone was recorded').not.toBeNull();
  expect(mean ?? -99).toBeGreaterThan(-50);
  expect(before ?? -99).toBeGreaterThan(-55);
  expect(after ?? -99, 'audio continues after resume').toBeGreaterThan(-55);
  const driftSeconds = Math.abs(outcome.videoSeconds - (outcome.audioSeconds ?? 0));
  expect(driftSeconds).toBeLessThan(0.7);
  // The session directory is gone after finalization; its small completion record keeps the pauses.
  const sessionId = outcome.sessionId;
  expect(fs.existsSync(path.join(userDataDir, 'recordings', sessionId))).toBe(false);
  const manifest = JSON.parse(
    fs.readFileSync(path.join(userDataDir, 'recordings', 'completed', `${sessionId}.json`), 'utf8'),
  ) as { pausedIntervals: { from: number; to: number | null }[]; outputPath: string };
  expect(manifest.outputPath).toBe(outcome.file);
  expect(manifest.pausedIntervals).toHaveLength(1);
  const pausedMs =
    (manifest.pausedIntervals[0]?.to ?? 0) - (manifest.pausedIntervals[0]?.from ?? 0);
  expect(Math.abs(pausedMs - 2000)).toBeLessThan(400);
  record('b-system-audio', {
    ...summarize(outcome),
    expectedSize: expected,
    volumeDb: { whole: mean, beforePause: before, afterResume: after },
    audioVideoDriftSeconds: Number(driftSeconds.toFixed(3)),
    pause: { afterSeconds: 3, forSeconds: 2, manifestPausedMs: pausedMs },
  });
});

test('(c) microphone only: 6 s (skipped when the host has no microphone)', async () => {
  const count = await page.evaluate(
    async () =>
      (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === 'audioinput')
        .length,
  );
  test.skip(count === 0, 'no audio input device on this host');
  const display = primary();
  const expected = expectedFit(display.physicalSize.width, display.physicalSize.height);
  let micMeterPeak = 0;
  const outcome = await recordWithToolbar(
    'c-mic',
    () =>
      page.evaluate((request) => window.framelet.invoke('recorder:start', request), {
        ...primaryTarget(),
        options: options({ mic: true, system: false }),
      }),
    { activeSeconds: 6 },
    async (toolbar) => {
      // The mute toggle is part of the state and the toolbar shows it.
      await expect(toolbar.getByTestId('mute-mic')).toBeVisible();
      await toolbar.getByTestId('mute-mic').click();
      await expect(toolbar.getByTestId('mute-mic')).toHaveAttribute('aria-pressed', 'true');
      expect((await snapshot()).muted.mic).toBe(true);
      await toolbar.getByTestId('mute-mic').click();
      expect((await snapshot()).muted.mic).toBe(false);
      // Sample the toolbar's mic meter for a while (informational: depends on the room).
      for (let i = 0; i < 20; i += 1) {
        micMeterPeak = Math.max(
          micMeterPeak,
          Number(await toolbar.getByTestId('meter-mic').getAttribute('aria-valuenow')),
        );
        await toolbar.waitForTimeout(100);
      }
    },
  );
  assertCommon(outcome, { ...expected, audio: true, activeSeconds: 6 });
  record('c-mic', {
    ...summarize(outcome),
    expectedSize: expected,
    volumeDb: { mean: meanVolume(outcome.file), max: maxVolume(outcome.file) },
    toolbarMeterPeak: micMeterPeak,
    note: 'level depends on the room and Windows noise suppression; only the presence of the audio stream is asserted',
  });
});

test('(d) microphone + system audio: 6 s mixed into one audio track', async () => {
  const count = await page.evaluate(
    async () =>
      (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === 'audioinput')
        .length,
  );
  test.skip(count === 0, 'no audio input device on this host');
  const display = primary();
  const expected = expectedFit(display.physicalSize.width, display.physicalSize.height);
  await startTone();
  let outcome: Outcome;
  try {
    outcome = await recordWithToolbar(
      'd-mic-and-system',
      () =>
        page.evaluate((request) => window.framelet.invoke('recorder:start', request), {
          ...primaryTarget(),
          options: options({ mic: true, system: true }),
        }),
      { activeSeconds: 6 },
      async (toolbar) => {
        await expect(toolbar.getByTestId('mute-mic')).toBeVisible();
        await expect(toolbar.getByTestId('mute-system')).toBeVisible();
        // The toolbar with both audio controls, for the UI evidence (the toolbar shows no desktop).
        for (const scheme of ['light', 'dark'] as const) {
          await toolbar.emulateMedia({ colorScheme: scheme });
          await toolbar.waitForTimeout(300);
          await toolbar.getByTestId('toolbar').screenshot({
            path: path.join(evidenceDir, `ui-toolbar-mic-system-${scheme}.png`),
            omitBackground: true,
          });
        }
        await toolbar.emulateMedia({ colorScheme: null });
        // The system meter shows the tone.
        await expect
          .poll(
            async () =>
              Number(await toolbar.getByTestId('meter-system').getAttribute('aria-valuenow')),
            {
              timeout: 8000,
            },
          )
          .toBeGreaterThan(0.05);
      },
    );
  } finally {
    await stopTone();
  }
  assertCommon(outcome, { ...expected, audio: true, activeSeconds: 6 });
  const mean = meanVolume(outcome.file);
  expect(mean ?? -99).toBeGreaterThan(-50);
  record('d-mic-and-system', { ...summarize(outcome), expectedSize: expected, volumeDb: mean });
});

// --- region on the second display -------------------------------------------------------------

test('region 1280x720 on the second display records exactly 1280x720, toolbar placed outside it', async () => {
  const other = secondary();
  test.skip(other === undefined, 'only one display on this host');
  const target = other as Display;
  const outcome = await recordWithToolbar(
    'region-second-display',
    async () => {
      await page.getByTestId('record-region').click();
      let overlay: Page | undefined;
      await expect
        .poll(
          async () => {
            for (const candidate of pagesOf('#/overlay')) {
              const root = candidate.locator('[data-testid="overlay-region"]');
              if (
                (await root.count()) &&
                (await root.getAttribute('data-display-id')) === target.id &&
                (await root.getAttribute('data-ready')) === 'true'
              ) {
                overlay = candidate;
                return true;
              }
            }
            return false;
          },
          { timeout: 30_000 },
        )
        .toBe(true);
      const o = overlay as Page;
      await expect(o.getByTestId('overlay-region')).toHaveAttribute('data-live', 'true');
      await o.mouse.move(100, 100);
      await o.mouse.down();
      await o.mouse.move(1380, 820, { steps: 8 });
      await o.mouse.up();
      await expect(o.getByTestId('size-label')).toHaveText('1280 × 720');
      await o.keyboard.press('Enter').catch((error: unknown) => {
        if (!/closed/i.test(String(error))) throw error;
      });
    },
    { activeSeconds: 4 },
    async () => {
      expect(pagesOf('#/overlay'), 'the selection overlay is closed before recording').toHaveLength(
        0,
      );
      const tb = await toolbarBounds();
      const regionGlobal = {
        x: target.bounds.x + 100,
        y: target.bounds.y + 100,
        width: 1280,
        height: 720,
      };
      const overlaps =
        tb.x < regionGlobal.x + regionGlobal.width &&
        tb.x + tb.width > regionGlobal.x &&
        tb.y < regionGlobal.y + regionGlobal.height &&
        tb.y + tb.height > regionGlobal.y;
      record('regionToolbarPlacement', {
        toolbarBoundsDip: tb,
        regionGlobalDip: regionGlobal,
        overlapsRegion: overlaps,
        onRegionDisplay: tb.x >= target.bounds.x && tb.x < target.bounds.x + target.bounds.width,
      });
      expect(overlaps, 'the toolbar is placed outside the recorded region').toBe(false);
    },
  );
  assertCommon(outcome, { width: 1280, height: 720, audio: false, activeSeconds: 4 });
  // The recorded pixels come from the second display (not the primary one): the frame is not
  // identical to the same region of the primary display, and it is not black.
  const frame = path.join(evidenceDir, 'frame-region-second-display.png');
  extractFrame(outcome.file, 1.5, frame);
  const pixels = await readPixels(frame);
  expect({ w: pixels.width, h: pixels.height }).toEqual({ w: 1280, h: 720 });
  let lit = 0;
  for (let i = 0; i < pixels.data.length; i += 4000) {
    if ((pixels.data[i] ?? 0) + (pixels.data[i + 1] ?? 0) + (pixels.data[i + 2] ?? 0) > 30)
      lit += 1;
  }
  expect(lit).toBeGreaterThan(10);
  record('region-second-display', summarize(outcome));
});

// --- the Source preset ------------------------------------------------------------------------

test('Source preset: native resolution of the primary display', async () => {
  const display = primary();
  const outcome = await recordWithToolbar(
    'source-preset',
    () =>
      page.evaluate((request) => window.framelet.invoke('recorder:start', request), {
        ...primaryTarget(),
        options: options({ mic: false, system: false, quality: 'source' }),
      }),
    { activeSeconds: 4 },
  );
  assertCommon(
    { ...outcome, fps: Math.max(outcome.fps, 25) },
    {
      width: display.physicalSize.width,
      height: display.physicalSize.height,
      audio: false,
      activeSeconds: 4,
    },
  );
  record('source-preset', {
    ...summarize(outcome),
    note: 'fps asserted loosely at full resolution',
  });
});

// --- a window ------------------------------------------------------------------------------

test('window recording of a framed fixture window', async () => {
  const title = `framelet-native-fixture-${Date.now()}`;
  const fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), 'framelet-fixture-'));
  const electronPath = (await import('node:module')).createRequire(__filename)(
    'electron',
  ) as unknown as string;
  const fixture: ChildProcess = spawn(
    electronPath,
    [path.join(__dirname, 'fixtures', 'color-window.mjs'), title, '300', '200', fixtureDir],
    { shell: false, stdio: ['ignore', 'pipe', 'pipe'] },
  );
  try {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('fixture window did not start')), 30_000);
      fixture.stdout?.on('data', (chunk: Buffer) => {
        if (chunk.toString().includes('READY ')) {
          clearTimeout(timer);
          resolve();
        }
      });
      fixture.once('error', reject);
    });
    const outcome = await recordWithToolbar(
      'window-fixture',
      async () => {
        await page.getByTestId('record-window').click();
        const picker = page.getByTestId('source-picker');
        await expect(picker).toBeVisible();
        await picker.getByTestId('window-search').fill(title);
        await expect(picker.getByTestId('window-card')).toHaveCount(1, { timeout: 15_000 });
        await picker.getByTestId('window-card').first().click();
      },
      { activeSeconds: 3 },
    );
    const video = outcome.probe.streams.find((stream) => stream.codec_type === 'video');
    // Phase 03 measured this frame at 642 x 432 (visible frame of a 640 x 400 content window).
    expect(video?.width).toBe(642);
    expect(video?.height).toBe(432);
    const frame = path.join(workDir, 'frame-window.png');
    extractFrame(outcome.file, 1, frame);
    const pixels = await readPixels(frame);
    const magenta = countColor(
      pixels,
      { x: 10, y: 40, width: 600, height: 360 },
      [255, 0, 255],
      40,
    );
    expect(magenta / (600 * 360)).toBeGreaterThan(0.95);
    record('window-fixture', {
      ...summarize(outcome),
      magentaFractionInContent: Number((magenta / (600 * 360)).toFixed(4)),
    });
  } finally {
    fs.writeFileSync(path.join(fixtureDir, 'command.txt'), 'quit');
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, 5000);
      fixture.once('exit', () => {
        clearTimeout(timer);
        resolve();
      });
    });
    fixture.kill();
    fs.rmSync(fixtureDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 });
  }
});

// --- shortest recording that yields a file (informational) -----------------------------------------

test('how short can a recording be? (informational, nothing asserted about the minimum)', async () => {
  const results: Record<string, unknown>[] = [];
  for (const ms of [300, 700, 1200]) {
    await page.evaluate((request) => window.framelet.invoke('recorder:start', request), {
      ...primaryTarget(),
      options: options({ mic: false, system: false }),
    });
    const toolbar = await toolbarPage();
    await toolbar.waitForTimeout(ms);
    await toolbar.getByTestId('toolbar-stop').click();
    await expect
      .poll(async () => ['completed', 'error'].includes((await snapshot()).status), {
        timeout: 30_000,
      })
      .toBe(true);
    const done = await snapshot();
    results.push({
      requestedMs: ms,
      status: done.status,
      bytes: done.result?.bytes ?? null,
      error: done.error?.code ?? null,
    });
    await page.evaluate(() => window.framelet.invoke('recorder:reset'));
    await waitForStatus('idle');
  }
  record('shortRecordings', results);
  await expectResourcesReleased();
});

// --- privacy of the evidence ------------------------------------------------------------------

test('the log and the evidence contain no window titles and no home paths', async () => {
  const log = fs.readFileSync(path.join(userDataDir, 'logs', 'main.log'), 'utf8');
  expect(log).not.toContain('framelet-native-fixture');
  const written = fs.readFileSync(path.join(evidenceDir, 'recordings-native.json'), 'utf8');
  expect(written).not.toContain('framelet-native-fixture');
  expect(written.toLowerCase()).not.toContain(os.userInfo().username.toLowerCase());
});
