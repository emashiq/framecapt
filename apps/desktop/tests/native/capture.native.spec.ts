/**
 * Native capture verification. Needs an interactive Windows session with at least one display,
 * a built app (.vite/build, produced by `electron-forge package`) and ffmpeg/ffprobe on PATH
 * (verification tooling only; the app itself never calls them). Run with `npm run test:native`.
 *
 * It drives the "Capture diagnostics" UI in Settings, saves evidence to docs/evidence/phase02/ and
 * asserts on the real output files. Nothing here is mocked.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  _electron as electron,
  expect,
  test,
  type ElectronApplication,
  type Page,
} from '@playwright/test';
import { writeEvidenceJson, evidenceDirFor } from './evidence';

const projectRoot = path.resolve(__dirname, '..', '..');
const evidenceDir = evidenceDirFor(projectRoot, 'phase02');

let app: ElectronApplication;
let page: Page;
let userDataDir: string;

interface DisplayRow {
  id: string;
  physicalWidth: number;
  physicalHeight: number;
  primary: boolean;
  screenSourceId: string;
}

/** Evidence never contains window titles or absolute user paths (see evidence.ts). */
function writeJson(name: string, value: unknown): void {
  writeEvidenceJson(evidenceDir, name, value);
}

/** Runs a command without a shell. Returns stdout and stderr (ffmpeg writes its report to stderr). */
function run(command: string, args: string[]): { stdout: string; stderr: string; status: number } {
  const result = spawnSync(command, args, { shell: false, encoding: 'utf8', maxBuffer: 64 << 20 });
  if (result.error) throw result.error;
  return { stdout: result.stdout, stderr: result.stderr, status: result.status ?? -1 };
}

interface Probe {
  streams: { codec_type: string; codec_name: string; width?: number; height?: number }[];
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

/** MediaRecorder WebM often has no duration header: fall back to decoding with ffmpeg. */
function durationSeconds(file: string, probe: Probe): number {
  if (probe.format.duration && Number.isFinite(Number(probe.format.duration))) {
    return Number(probe.format.duration);
  }
  const { stderr } = run('ffmpeg', ['-hide_banner', '-i', file, '-f', 'null', '-']);
  const matches = [...stderr.matchAll(/time=(\d+):(\d+):(\d+\.\d+)/g)];
  const last = matches.at(-1);
  if (!last) throw new Error(`Could not determine the duration of ${file}`);
  return Number(last[1]) * 3600 + Number(last[2]) * 60 + Number(last[3]);
}

function meanVolume(file: string): { mean: number | null; max: number | null; raw: string } {
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
  const mean = /mean_volume:\s*(-?[\d.]+|-inf) dB/.exec(stderr)?.[1];
  const max = /max_volume:\s*(-?[\d.]+|-inf) dB/.exec(stderr)?.[1];
  const parse = (value: string | undefined): number | null =>
    value === undefined || value === '-inf' ? null : Number(value);
  return { mean: parse(mean), max: parse(max), raw: stderr.split('\n').slice(-14).join('\n') };
}

function videoPacketCount(file: string): number {
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

function pngSize(file: string): { width: number; height: number } {
  const header = fs.readFileSync(file).subarray(0, 24);
  expect(header.subarray(1, 4).toString('ascii')).toBe('PNG');
  return { width: header.readUInt32BE(16), height: header.readUInt32BE(20) };
}

async function readDisplays(): Promise<DisplayRow[]> {
  const rows = page.locator('[data-testid^="display-row-"]');
  await expect(rows.first()).toBeVisible();
  const result: DisplayRow[] = [];
  for (const row of await rows.all()) {
    const testId = (await row.getAttribute('data-testid')) ?? '';
    const id = testId.replace('display-row-', '');
    const source = page.locator(`[data-testid="source-item"][data-display-id="${id}"]`);
    result.push({
      id,
      physicalWidth: Number(await row.getAttribute('data-physical-width')),
      physicalHeight: Number(await row.getAttribute('data-physical-height')),
      primary: (await row.getAttribute('data-primary')) === 'true',
      screenSourceId: (await source.first().getAttribute('data-id')) ?? '',
    });
  }
  return result;
}

async function expectNoLiveResources(): Promise<void> {
  const resources = page.getByTestId('diag-resources');
  await expect(resources).toHaveAttribute('data-live-tracks', '0', { timeout: 10_000 });
  await expect(resources).toHaveAttribute('data-audio-contexts', '0', { timeout: 10_000 });
  await expect(resources).toHaveAttribute('data-loops', '0', { timeout: 10_000 });
}

interface ShotResult {
  method: string;
  width: number;
  height: number;
  path: string;
  acquireMs: number;
  firstFrameMs: number;
  totalMs: number;
  settingsBefore: { width?: number; height?: number };
  settingsAfter: { width?: number; height?: number };
}

/** Clicks "Test screenshot" and waits for a NEW result (or an error) for that display. */
async function runShot(displayId: string): Promise<{ shot?: ShotResult; error?: string }> {
  const result = page.getByTestId(`shot-result-${displayId}`);
  const error = page.getByTestId(`shot-error-${displayId}`);
  const previous = (await result.count()) ? await result.getAttribute('data-result') : null;
  await page.getByTestId(`shot-btn-${displayId}`).click();
  await expect
    .poll(
      async () => {
        if (await error.count()) return 'error';
        if ((await result.count()) && (await result.getAttribute('data-result')) !== previous) {
          return 'result';
        }
        return 'waiting';
      },
      { timeout: 30_000 },
    )
    .not.toBe('waiting');
  if (await error.count()) return { error: (await error.textContent()) ?? '' };
  return { shot: JSON.parse((await result.getAttribute('data-result')) ?? '{}') as ShotResult };
}

interface RecResult {
  mimeType: string;
  bytes: number;
  path: string;
  wallMs: number;
  framesDelivered: number;
  measuredFps: number;
  videoWidth?: number;
  videoHeight?: number;
  hasAudio: boolean;
  audioSources: string[];
  peakLevels: Record<string, number>;
  tracksAtStop: { where: string; kind: string; readyState: string }[];
  tracksAfterRelease: { where: string; kind: string; readyState: string }[];
  endedEarly: string[];
  cropMethod: string;
  cropFramesOut?: number;
}

interface RecOptions {
  sourceId: string;
  systemAudio?: boolean;
  tone?: boolean;
  mic?: string;
  seconds?: number;
  region?: { x: number; y: number; width: number; height: number };
  cropMethod?: 'canvas' | 'track-processor';
  driver?: 'rvfc' | 'timer';
}

/** Configures the recording form, clicks "Test recording" and returns the result or the error. */
async function record(
  options: RecOptions,
): Promise<{ result?: RecResult; error?: { code: string; message: string } }> {
  await page.getByTestId('rec-source').selectOption(options.sourceId);
  await page.getByTestId('rec-mic').selectOption(options.mic ?? 'off');
  await setChecked('rec-system-audio', options.systemAudio ?? false);
  await setChecked('rec-tone', options.tone ?? false);
  await page.getByTestId('rec-duration').fill(String(options.seconds ?? 4));
  await setChecked('rec-use-region', options.region !== undefined);
  if (options.region) {
    for (const key of ['x', 'y', 'width', 'height'] as const) {
      await page.getByTestId(`rec-region-${key}`).fill(String(options.region[key]));
    }
    await page.getByTestId('rec-crop-method').selectOption(options.cropMethod ?? 'canvas');
    await page.getByTestId('rec-driver').selectOption(options.driver ?? 'rvfc');
  }
  await page.getByTestId('rec-start').click();

  const result = page.getByTestId('rec-result');
  const error = page.getByTestId('rec-error');
  await expect(result.or(error)).toBeVisible({ timeout: 60_000 });
  if (await error.isVisible()) {
    return {
      error: {
        code: (await error.getAttribute('data-code')) ?? '',
        message: (await error.textContent()) ?? '',
      },
    };
  }
  return { result: JSON.parse((await result.getAttribute('data-result')) ?? '{}') as RecResult };
}

async function setChecked(testId: string, checked: boolean): Promise<void> {
  const box = page.getByTestId(testId);
  if ((await box.isChecked()) !== checked) await box.setChecked(checked);
}

function copyEvidence(from: string, name: string): string {
  fs.mkdirSync(evidenceDir, { recursive: true });
  const target = path.join(evidenceDir, name);
  fs.copyFileSync(from, target);
  return target;
}

test.beforeAll(async () => {
  expect(
    fs.existsSync(path.join(projectRoot, '.vite', 'build', 'main.cjs')),
    'Run `electron-forge package` first (npm run test:native does this).',
  ).toBe(true);
  userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'framecapt-native-'));
  app = await electron.launch({
    args: ['.'],
    cwd: projectRoot,
    env: { ...process.env, FRAMECAPT_USER_DATA_DIR: userDataDir },
  });
  page = await app.firstWindow();
  await page.waitForLoadState('domcontentloaded');
  await page
    .getByRole('navigation', { name: 'Primary' })
    .getByRole('button', { name: 'Settings' })
    .click();
  await page.getByTestId('settings-nav-advanced').click();
  await expect(page.getByTestId('diagnostics-section')).toBeVisible();
  await expect(page.getByTestId('diag-displays').locator('li').first()).toBeVisible();
});

test.afterAll(async () => {
  await app?.close();
  if (userDataDir) fs.rmSync(userDataDir, { recursive: true, force: true });
});

test.afterEach(async () => {
  // Every test must leave no live track, audio context, timer or frame loop behind.
  await expectNoLiveResources();
});

test('environment and capability report', async () => {
  const displays = await readDisplays();
  expect(displays.length).toBeGreaterThan(0);
  const primary = displays.find((d) => d.primary);
  expect(primary).toBeDefined();

  const capabilities = await page.evaluate(() => ({
    userAgent: navigator.userAgent,
    mediaStreamTrackProcessor: 'MediaStreamTrackProcessor' in window,
    mediaStreamTrackGenerator: 'MediaStreamTrackGenerator' in window,
    imageCapture: 'ImageCapture' in window,
    videoFrameCallback: 'requestVideoFrameCallback' in HTMLVideoElement.prototype,
    offscreenCanvas: typeof OffscreenCanvas !== 'undefined',
  }));
  const displayRows = await page.locator('[data-testid^="display-row-"]').allTextContents();
  const formatItems = await page.getByTestId('diag-formats').locator('li').all();
  const formats: Record<string, boolean> = {};
  for (const item of formatItems) {
    const text = ((await item.textContent()) ?? '').replace(' (default)', '');
    const supported = (await item.getAttribute('data-supported')) === 'true';
    formats[text.replace(/^(yes|no)/, '')] = supported;
  }
  const defaultText = (await page.getByTestId('format-default').textContent()) ?? '';
  const sources = await page.getByTestId('source-item').evaluateAll((items) =>
    items.map((item) => ({
      kind: item.getAttribute('data-kind'),
      id: item.getAttribute('data-id'),
      displayId: item.getAttribute('data-display-id'),
      label: item.textContent,
      hasThumbnail: item.querySelector('img') !== null,
      thumbWidth: item.querySelector('img')?.naturalWidth ?? 0,
    })),
  );
  const thumbs = sources.filter((s) => s.hasThumbnail);
  expect(thumbs.length).toBeGreaterThan(0);
  for (const thumb of thumbs) expect(thumb.thumbWidth).toBeLessThanOrEqual(320);

  const cpus = os.cpus();
  writeJson('environment.json', {
    date: new Date().toISOString(),
    os: `${os.type()} ${os.release()} ${os.arch()}`,
    cpu: cpus[0]?.model,
    logicalCores: cpus.length,
    ramGiB: Math.round((os.totalmem() / 2 ** 30) * 10) / 10,
    electron: await app.evaluate(() => process.versions.electron),
    chrome: await app.evaluate(() => process.versions.chrome),
    capabilities,
    displays: displayRows,
    recorderFormats: formats,
    defaultFormat: defaultText,
    sources,
  });
});

test('screenshots are full resolution on every display', async () => {
  const displays = await readDisplays();
  const summary: unknown[] = [];

  for (const display of displays) {
    const { shot: found, error } = await runShot(display.id);
    expect(error, `screenshot error: ${error}`).toBeUndefined();
    const shot = found as ShotResult;
    const result = page.getByTestId(`shot-result-${display.id}`);

    // The UI verdict, the real PNG header and the reported physical size must all agree.
    expect(await result.getAttribute('data-pass')).toBe('true');
    expect({ width: shot.width, height: shot.height }).toEqual({
      width: display.physicalWidth,
      height: display.physicalHeight,
    });
    expect(pngSize(shot.path)).toEqual({
      width: display.physicalWidth,
      height: display.physicalHeight,
    });

    const copy = copyEvidence(shot.path, `screenshot-display-${display.id}.png`);
    summary.push({
      displayId: display.id,
      primary: display.primary,
      expected: `${display.physicalWidth}x${display.physicalHeight}`,
      actual: `${shot.width}x${shot.height}`,
      trackSettingsBefore: `${shot.settingsBefore.width}x${shot.settingsBefore.height}`,
      trackSettingsAfter: `${shot.settingsAfter.width}x${shot.settingsAfter.height}`,
      method: shot.method,
      acquireMs: Math.round(shot.acquireMs),
      firstFrameMs: Math.round(shot.firstFrameMs),
      totalMs: Math.round(shot.totalMs),
      pngBytes: fs.statSync(shot.path).size,
      evidence: path.relative(projectRoot, copy).replaceAll('\\', '/'),
    });
    await expectNoLiveResources();
  }
  writeJson('screenshots.json', summary);
});

test('frame grab methods: reliability and time to first frame', async () => {
  const [first] = await readDisplays();
  expect(first).toBeDefined();
  if (!first) return;
  const report: Record<string, unknown> = {};
  for (const method of ['auto', 'video-element', 'track-processor', 'image-capture']) {
    await page.getByTestId('shot-method').selectOption(method);
    const runs: {
      ok: boolean;
      firstFrameMs?: number;
      totalMs?: number;
      size?: string;
      settingsAfter?: string;
      error?: string;
    }[] = [];
    for (let i = 0; i < 3; i += 1) {
      const { shot, error } = await runShot(first.id);
      if (error || !shot) {
        runs.push({ ok: false, error });
        continue;
      }
      runs.push({
        ok:
          (method === 'auto' ? shot.method === 'track-processor' : shot.method === method) &&
          shot.width === first.physicalWidth &&
          shot.height === first.physicalHeight,
        firstFrameMs: Math.round(shot.firstFrameMs),
        totalMs: Math.round(shot.totalMs),
        size: `${shot.width}x${shot.height}`,
        settingsAfter: `${shot.settingsAfter.width}x${shot.settingsAfter.height}`,
      });
    }
    report[method] = runs;
  }
  await page.getByTestId('shot-method').selectOption('auto');
  writeJson('frame-methods.json', { displayId: first.id, report });
  // The default method must work.
  const defaultRuns = report['auto'] as { ok: boolean }[];
  expect(defaultRuns.every((run) => run.ok)).toBe(true);
});

test('records the primary display with system audio and a test tone', async () => {
  const displays = await readDisplays();
  const primary = displays.find((d) => d.primary) ?? displays[0]!;
  const { result, error } = await record({
    sourceId: primary.screenSourceId,
    systemAudio: true,
    tone: true,
    seconds: 4,
  });
  expect(error, `recording failed: ${error?.code} ${error?.message}`).toBeUndefined();
  expect(result).toBeDefined();
  const rec = result!;
  expect(rec.hasAudio).toBe(true);
  expect(rec.audioSources).toEqual(['system']);

  const probe = ffprobe(rec.path);
  const video = probe.streams.filter((s) => s.codec_type === 'video');
  const audio = probe.streams.filter((s) => s.codec_type === 'audio');
  expect(video).toHaveLength(1);
  expect(audio).toHaveLength(1);
  expect({ width: video[0]?.width, height: video[0]?.height }).toEqual({
    width: primary.physicalWidth,
    height: primary.physicalHeight,
  });
  const duration = durationSeconds(rec.path, probe);
  expect(duration).toBeGreaterThanOrEqual(3);
  expect(duration).toBeLessThanOrEqual(6);

  const volume = meanVolume(rec.path);
  const copy = copyEvidence(rec.path, 'recording-system-audio.webm');
  writeJson('recording-system-audio.probe.json', {
    ui: rec,
    probe,
    durationSeconds: duration,
    videoPackets: videoPacketCount(rec.path),
    volume,
    evidence: path.relative(projectRoot, copy).replaceAll('\\', '/'),
  });
  // The 440 Hz tone is audible through loopback: anything above -50 dB means real signal.
  expect(volume.mean, `volumedetect: ${volume.raw}`).not.toBeNull();
  expect(volume.mean as number).toBeGreaterThan(-50);

  expect(rec.tracksAtStop.length).toBeGreaterThan(0);
  expect(rec.tracksAfterRelease.every((t) => t.readyState === 'ended')).toBe(true);
});

interface RegionRun {
  label: string;
  options: Partial<RecOptions>;
}

const REGION = { x: 100, y: 100, width: 1280, height: 720 };

test('records a 1280x720 region of the primary display (canvas crop vs track processor)', async () => {
  const displays = await readDisplays();
  const primary = displays.find((d) => d.primary) ?? displays[0]!;
  // Put the app window at a known place inside the region so the picture is deterministic, then
  // take a fresh screenshot as the reference for the visual check.
  await app.evaluate(({ BrowserWindow, screen }) => {
    const win = BrowserWindow.getAllWindows()[0];
    const area = screen.getPrimaryDisplay().bounds;
    win?.setBounds({ x: area.x + 300, y: area.y + 200, width: 1000, height: 700 });
    win?.show();
    win?.moveTop();
    win?.focus();
  });
  await page.waitForTimeout(1000);
  const { shot: reference, error: referenceError } = await runShot(primary.id);
  expect(referenceError).toBeUndefined();
  const shotPath = reference!.path;

  const runs: RegionRun[] = [
    { label: 'canvas-rvfc', options: { cropMethod: 'canvas', driver: 'rvfc' } },
    { label: 'canvas-timer', options: { cropMethod: 'canvas', driver: 'timer' } },
    { label: 'track-processor', options: { cropMethod: 'track-processor' } },
  ];
  const report: Record<string, unknown> = {};

  for (const variant of runs) {
    const { result, error } = await record({
      sourceId: primary.screenSourceId,
      seconds: 4,
      region: REGION,
      ...variant.options,
    });
    if (error || !result) {
      report[variant.label] = { ok: false, error };
      // Canvas crop is the shipping candidate and must work; the processor path is a prototype.
      expect(variant.label, `${variant.label} failed: ${error?.code} ${error?.message}`).toBe(
        'track-processor',
      );
      await expectNoLiveResources();
      continue;
    }
    const probe = ffprobe(result.path);
    const video = probe.streams.filter((s) => s.codec_type === 'video');
    const audio = probe.streams.filter((s) => s.codec_type === 'audio');
    const duration = durationSeconds(result.path, probe);
    const packets = videoPacketCount(result.path);

    // Visual check: the recorded frame at ~2 s versus the same region of the screenshot.
    const framePng = path.join(userDataDir, `${variant.label}-frame.png`);
    run_('ffmpeg', [
      '-y',
      '-v',
      'error',
      '-ss',
      '2',
      '-i',
      result.path,
      '-frames:v',
      '1',
      framePng,
    ]);
    const ssim = (crop: string): number => {
      const { stderr } = run('ffmpeg', [
        '-hide_banner',
        '-i',
        shotPath,
        '-i',
        framePng,
        '-filter_complex',
        `[0:v]crop=${crop}[a];[1:v]format=rgb24[b];[a]format=rgb24[a2];[a2][b]ssim`,
        '-f',
        'null',
        '-',
      ]);
      const match = /All:([\d.]+)/.exec(stderr);
      return match ? Number(match[1]) : Number.NaN;
    };
    const matching = ssim(`${REGION.width}:${REGION.height}:${REGION.x}:${REGION.y}`);
    const shifted = ssim(`${REGION.width}:${REGION.height}:${REGION.x + 600}:${REGION.y + 300}`);

    const copy = copyEvidence(result.path, `recording-region-${variant.label}.webm`);
    copyEvidence(framePng, `recording-region-${variant.label}-frame.png`);
    report[variant.label] = {
      ok: true,
      ui: result,
      ffprobeSize: `${video[0]?.width}x${video[0]?.height}`,
      audioStreams: audio.length,
      durationSeconds: duration,
      videoPackets: packets,
      packetFps: Math.round((packets / duration) * 10) / 10,
      ssimSameRegion: matching,
      ssimWrongRegion: shifted,
      evidence: path.relative(projectRoot, copy).replaceAll('\\', '/'),
    };

    expect(video).toHaveLength(1);
    expect({ width: video[0]?.width, height: video[0]?.height }).toEqual({
      width: 1280,
      height: 720,
    });
    expect(audio).toHaveLength(0);
    expect(duration).toBeGreaterThanOrEqual(3);
    expect(duration).toBeLessThanOrEqual(6);
    expect(matching).toBeGreaterThan(shifted);
    expect(result.tracksAfterRelease.every((t) => t.readyState === 'ended')).toBe(true);
    await expectNoLiveResources();
  }
  writeJson('region-benchmark.json', report);
});

function run_(command: string, args: string[]): void {
  const result = run(command, args);
  expect(result.status, `${command} ${args.join(' ')}\n${result.stderr}`).toBe(0);
}

test('microphone recording (skipped when no input device exists)', async () => {
  const devices = await page.evaluate(async () =>
    (await navigator.mediaDevices.enumerateDevices())
      .filter((d) => d.kind === 'audioinput')
      .map((d) => ({ id: d.deviceId, label: d.label })),
  );
  if (devices.length === 0) {
    writeJson('microphone.json', { status: 'skipped', reason: 'No audioinput device enumerated.' });
    test.skip(true, 'No microphone on this host');
    return;
  }
  const displays = await readDisplays();
  const primary = displays.find((d) => d.primary) ?? displays[0]!;
  const { result, error } = await record({
    sourceId: primary.screenSourceId,
    mic: 'default',
    seconds: 3,
  });
  if (error) {
    // Reported, not faked: a denied microphone (Windows privacy settings) is an environment result.
    writeJson('microphone.json', { status: 'error', devices: devices.length, error });
    expect(['denied', 'source-gone']).toContain(error.code);
    return;
  }
  const rec = result!;
  const probe = ffprobe(rec.path);
  expect(probe.streams.filter((s) => s.codec_type === 'audio')).toHaveLength(1);
  expect(rec.audioSources).toEqual(['mic']);
  const volume = meanVolume(rec.path);
  const copy = copyEvidence(rec.path, 'recording-microphone.webm');
  writeJson('microphone.json', {
    status: 'recorded',
    devices,
    ui: rec,
    volume,
    evidence: path.relative(projectRoot, copy).replaceAll('\\', '/'),
  });
});

test('system audio request that yields no audio is reported, not hidden (UI path)', async () => {
  // Covered by unit-level logic in stream.ts; here we only assert the success path never lies:
  // when system audio is requested and the recording succeeds, an audio track must exist.
  const displays = await readDisplays();
  const primary = displays.find((d) => d.primary) ?? displays[0]!;
  const { result, error } = await record({
    sourceId: primary.screenSourceId,
    systemAudio: true,
    seconds: 3,
  });
  if (error) {
    expect(error.code).toBe('system-audio-unavailable');
  } else {
    expect(result?.hasAudio).toBe(true);
    expect(probeAudioStreams(result!.path)).toBe(1);
  }
});

function probeAudioStreams(file: string): number {
  return ffprobe(file).streams.filter((s) => s.codec_type === 'audio').length;
}

test('cancelling a recording releases everything', async () => {
  const displays = await readDisplays();
  const primary = displays.find((d) => d.primary) ?? displays[0]!;
  await page.getByTestId('rec-source').selectOption(primary.screenSourceId);
  await page.getByTestId('rec-mic').selectOption('off');
  await setChecked('rec-system-audio', true);
  await setChecked('rec-tone', true);
  await setChecked('rec-use-region', true);
  await page.getByTestId('rec-crop-method').selectOption('canvas');
  await page.getByTestId('rec-duration').fill('10');
  await page.getByTestId('rec-start').click();
  await expect(page.getByTestId('rec-cancel')).toBeVisible();
  await page.waitForTimeout(1500);
  await page.getByTestId('rec-cancel').click();
  await expect(page.getByTestId('rec-error')).toHaveAttribute('data-code', 'cancelled', {
    timeout: 20_000,
  });
  await expect(page.getByTestId('rec-start')).toBeVisible();
});

test('denial paths: bogus source, no grant, one-shot grants', async () => {
  await page.getByTestId('probe-run').click();
  for (const id of ['bogus-grant', 'no-grant', 'one-shot']) {
    const item = page.getByTestId(`probe-result-${id}`);
    await expect(item).toBeVisible({ timeout: 30_000 });
    expect(await item.getAttribute('data-pass'), (await item.textContent()) ?? '').toBe('true');
  }
  const details = await page.getByTestId('probe-results').textContent();

  // The rejection must come from main's handler, not from a missing user gesture.
  const log = fs.readFileSync(path.join(userDataDir, 'logs', 'main.log'), 'utf8');
  const denials = log.split('\n').filter((line) => line.includes('Display capture denied'));
  expect(denials.length).toBeGreaterThanOrEqual(2);
  expect(denials.every((line) => line.includes('no active grant'))).toBe(true);
  writeJson('denial-paths.json', { details, mainLogDenials: denials });
});

// Role-aware: the main window (this page) may not open the camera; the recorder and camera windows may
// (covered by tests/e2e/recording-camera.spec.ts with Chromium's fake camera and by unit tests).
test('camera (video getUserMedia) is denied to the main window by the permission handler', async () => {
  const outcome = await page.evaluate(async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ video: true });
      stream.getTracks().forEach((track) => track.stop());
      return 'granted';
    } catch (error) {
      return error instanceof Error ? error.name : String(error);
    }
  });
  expect(outcome).toBe('NotAllowedError');
  const log = fs.readFileSync(path.join(userDataDir, 'logs', 'main.log'), 'utf8');
  expect(log).toContain('Denied permission request: media video');
  writeJson('camera-denied.json', { outcome });
});

test('main log never contains capture content', async () => {
  const log = fs.readFileSync(path.join(userDataDir, 'logs', 'main.log'), 'utf8');
  expect(log).not.toContain('data:image');
});
