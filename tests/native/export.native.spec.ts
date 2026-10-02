/**
 * Native verification of MP4 export and history on the real host (production build, real display
 * capture, real Windows loopback audio, real ffmpeg). Needs an interactive Windows session and a
 * built app (`npm run test:native` packages first). Evidence (redacted JSON) goes to
 * docs/evidence/phase07/export-native.json.
 *
 * A real 6 s screen recording with system audio is finished, then exported from the recording
 * result view through the UI (the save dialog is stubbed in main; nothing else is). The MP4 is
 * probed (H.264 + AAC, duration within 0.5 s of the WebM, fast start) and fully decoded with
 * `ffmpeg -v error -i out.mp4 -f null -`. The original WebM must be byte-identical afterwards, and
 * History must list both files with real thumbnails.
 */
import { createHash } from 'node:crypto';
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
import { exitApp } from '../e2e/app-exit';
import { mp4TopLevelBoxes } from '../../src/main/media/export';
import { writeEvidenceJson, evidenceDirFor } from './evidence';

const projectRoot = path.resolve(__dirname, '..', '..');
const evidenceDir = evidenceDirFor(projectRoot, 'phase07');
const vendor = path.join(projectRoot, 'vendor', 'ffmpeg', 'win32-x64');
const FFMPEG = path.join(vendor, 'ffmpeg.exe');
const FFPROBE = path.join(vendor, 'ffprobe.exe');

let userDataDir: string;
let outDir: string;
let app: ElectronApplication | undefined;
let page: Page;

const evidence: Record<string, unknown> = {};
function record(name: string, value: unknown): void {
  evidence[name] = value;
  writeEvidenceJson(evidenceDir, 'export-native.json', evidence);
}

const sha = (file: string): string =>
  createHash('sha256').update(fs.readFileSync(file)).digest('hex');

interface Probe {
  streams: {
    codec_type: string;
    codec_name: string;
    width?: number;
    height?: number;
    pix_fmt?: string;
  }[];
  format: { duration?: string; size: string; format_name: string };
}

function ffprobe(file: string): Probe {
  return JSON.parse(
    execFileSync(FFPROBE, ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', file], {
      shell: false,
      encoding: 'utf8',
    }),
  ) as Probe;
}

/** `ffmpeg -v error -i out.mp4 -f null -`: exit 0 and nothing on stderr. */
function decodeAll(file: string): { status: number; stderr: string } {
  const run = spawnSync(FFMPEG, ['-v', 'error', '-i', file, '-f', 'null', '-'], {
    shell: false,
    encoding: 'utf8',
  });
  return { status: run.status ?? -1, stderr: run.stderr.trim() };
}

function meanVolume(file: string): number | null {
  const run = spawnSync(
    FFMPEG,
    ['-hide_banner', '-i', file, '-vn', '-af', 'volumedetect', '-f', 'null', '-'],
    { shell: false, encoding: 'utf8' },
  );
  const mean = /mean_volume:\s*(-?[\d.]+|-inf) dB/.exec(run.stderr)?.[1];
  return mean === undefined || mean === '-inf' ? null : Number(mean);
}

async function snapshot() {
  const result = await page.evaluate(() => window.framelet.invoke('recorder:getState'));
  if (!result.ok) throw new Error('recorder:getState failed');
  return result.data;
}

async function stubSaveDialog(filePath: string) {
  await (app as ElectronApplication).evaluate(({ dialog }, target) => {
    dialog.showSaveDialog = (() =>
      Promise.resolve({ canceled: false, filePath: target })) as typeof dialog.showSaveDialog;
  }, filePath);
}

test.describe.configure({ mode: 'serial' });

test.beforeAll(() => {
  expect(
    fs.existsSync(path.join(projectRoot, '.vite', 'build', 'main.cjs')),
    'Run `npm run package` first (npm run test:native does this).',
  ).toBe(true);
  expect(fs.existsSync(FFMPEG), 'Run `npm run fetch:ffmpeg` first.').toBe(true);
  userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'framelet-native-export-'));
  outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'framelet-native-export-out-'));
  fs.mkdirSync(evidenceDir, { recursive: true });
});

test.afterAll(async () => {
  if (app) await exitApp(app);
  for (const dir of [userDataDir, outDir]) {
    if (dir) fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 });
  }
});

test('a real recording exported to MP4 from the UI: H.264 + AAC, same length, fast start, decodes clean', async () => {
  app = await electron.launch({
    args: ['.'],
    cwd: projectRoot,
    env: { ...process.env, FRAMELET_USER_DATA_DIR: userDataDir },
  });
  page = await app.firstWindow();
  await page.waitForLoadState('domcontentloaded');
  await expect(page.getByTestId('record-screen')).toBeVisible();

  // A quiet tone through the default output gives Windows loopback something to record.
  await page.evaluate(() => {
    const ctx = new AudioContext();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.frequency.value = 440;
    gain.gain.value = 0.08;
    osc.connect(gain).connect(ctx.destination);
    osc.start();
    void ctx.resume();
    (window as unknown as { __tone: unknown }).__tone = { ctx, osc };
  });
  const listed = await page.evaluate(() => window.framelet.invoke('capture:listDisplays'));
  if (!listed.ok) throw new Error('capture:listDisplays failed');
  const display = listed.data.find((d) => d.isPrimary) ?? listed.data[0];
  if (!display) throw new Error('no display');
  const started = await page.evaluate(
    (id) =>
      window.framelet.invoke('recorder:start', {
        target: 'screen',
        displayId: id,
        options: {
          mic: { enabled: false },
          systemAudio: true,
          quality: '1080p',
          fps: 30,
          countdown: false,
        },
      }),
    display.id,
  );
  expect(started.ok).toBe(true);
  await expect.poll(async () => (await snapshot()).status, { timeout: 30_000 }).toBe('recording');
  const startedAt = (await snapshot()).startedAt ?? Date.now();
  await page.waitForTimeout(Math.max(0, 6000 - (Date.now() - startedAt)));
  await page.evaluate(() => window.framelet.invoke('recorder:stop'));
  await expect(page.getByTestId('recording-result')).toBeVisible({ timeout: 60_000 });
  await page.evaluate(async () => {
    const tone = (window as unknown as { __tone?: { ctx: AudioContext; osc: OscillatorNode } })
      .__tone;
    tone?.osc.stop();
    await tone?.ctx.close();
  });
  const result = (await snapshot()).result;
  if (!result) throw new Error('no result');
  const source = result.path;
  const sourceSha = sha(source);
  const sourceProbe = ffprobe(source);
  const sourceDuration = Number(sourceProbe.format.duration);

  // Export from the result view, through the real UI. Only the save dialog is replaced.
  const dest = path.join(outDir, 'Native export.mp4');
  await stubSaveDialog(dest);
  const clicked = Date.now();
  await page.getByTestId('mp4-export').click();
  await expect(page.getByTestId('mp4-done')).toBeVisible({ timeout: 120_000 });
  const exportMs = Date.now() - clicked;

  expect(fs.existsSync(dest)).toBe(true);
  expect(fs.readdirSync(outDir).filter((name) => name.includes('.partial'))).toEqual([]);
  const probe = ffprobe(dest);
  const video = probe.streams.find((s) => s.codec_type === 'video');
  const audio = probe.streams.find((s) => s.codec_type === 'audio');
  expect(video?.codec_name).toBe('h264');
  expect(video?.pix_fmt).toBe('yuv420p');
  expect(audio?.codec_name).toBe('aac');
  expect((video?.width ?? 1) % 2).toBe(0);
  expect((video?.height ?? 1) % 2).toBe(0);
  expect(probe.format.format_name).toContain('mp4');
  const duration = Number(probe.format.duration);
  expect(Math.abs(duration - sourceDuration)).toBeLessThanOrEqual(0.5);
  const boxes = await mp4TopLevelBoxes(dest);
  expect(boxes.indexOf('moov')).toBeGreaterThan(-1);
  expect(boxes.indexOf('moov')).toBeLessThan(boxes.indexOf('mdat'));
  const decode = decodeAll(dest);
  expect(decode).toEqual({ status: 0, stderr: '' });
  expect(sha(source)).toBe(sourceSha); // the original is untouched
  const mp4Volume = meanVolume(dest);
  const webmVolume = meanVolume(source);
  expect(mp4Volume, 'the loopback tone survived the AAC encode').not.toBeNull();

  record('export', {
    source: {
      format: sourceProbe.format.format_name,
      durationSeconds: sourceDuration,
      bytes: Number(sourceProbe.format.size),
      streams: sourceProbe.streams.map((s) => ({
        type: s.codec_type,
        codec: s.codec_name,
        width: s.width,
        height: s.height,
      })),
      meanVolumeDb: webmVolume,
    },
    output: {
      format: probe.format.format_name,
      durationSeconds: duration,
      bytes: Number(probe.format.size),
      streams: probe.streams.map((s) => ({
        type: s.codec_type,
        codec: s.codec_name,
        width: s.width,
        height: s.height,
        pixFmt: s.pix_fmt,
      })),
      topLevelBoxes: boxes,
      fastStart: boxes.indexOf('moov') < boxes.indexOf('mdat'),
      meanVolumeDb: mp4Volume,
    },
    durationDifferenceSeconds: Math.abs(duration - sourceDuration),
    fullDecode: { command: 'ffmpeg -v error -i out.mp4 -f null -', ...decode },
    originalSha256Unchanged: true,
    exportWallClockMs: exportMs,
    realTimeFactor: sourceDuration / (exportMs / 1000),
  });
});

test('History lists the recording and its MP4 with real thumbnails, and both open in the details', async () => {
  await page.getByTestId('result-new').click();
  await page
    .getByRole('navigation', { name: 'Primary' })
    .getByRole('button', { name: 'History' })
    .click();
  const cards = page.getByTestId('history-item');
  await expect(cards).toHaveCount(2);
  await expect(cards.filter({ hasText: 'Native export' })).toHaveCount(1);
  await expect(
    cards.filter({ has: page.locator('[data-type="recording"]') }).getByTestId('history-duration'),
  ).toHaveCount(2);
  await expect
    .poll(
      () =>
        cards
          .locator('img')
          .evaluateAll(
            (imgs) => imgs.filter((img) => (img as HTMLImageElement).naturalWidth > 0).length,
          ),
      { timeout: 20_000 },
    )
    .toBe(2);
  const thumbsDir = path.join(userDataDir, 'history', 'thumbs');
  const thumbs = fs.readdirSync(thumbsDir).filter((name) => name.endsWith('.png'));
  expect(thumbs).toHaveLength(2);
  const thumbSizes = thumbs.map((name) => fs.statSync(path.join(thumbsDir, name)).size);
  expect(thumbSizes.every((size) => size > 2000)).toBe(true); // a real frame, not a blank file

  // The MP4 plays in the app's own video element (H.264 decoding is available in this build).
  await cards.filter({ hasText: 'Native export' }).locator('[data-card-main]').click();
  const video = page.getByTestId('history-video');
  await expect
    .poll(() => video.evaluate((v: HTMLVideoElement) => v.readyState), { timeout: 20_000 })
    .toBeGreaterThanOrEqual(2);
  const playback = await video.evaluate((v: HTMLVideoElement) => ({
    width: v.videoWidth,
    height: v.videoHeight,
    duration: v.duration,
    error: v.error === null ? null : v.error.code,
  }));
  expect(playback.error).toBeNull();
  expect(playback.width).toBeGreaterThan(0);

  const logFile = path.join(userDataDir, 'logs', 'main.log');
  const log = fs.readFileSync(logFile, 'utf8');
  expect(log).toContain('MP4 export available (libx264 + aac)');
  record('history', {
    items: 2,
    thumbnails: thumbs.length,
    thumbnailBytes: thumbSizes,
    mp4PlaysInApp: {
      videoWidth: playback.width,
      videoHeight: playback.height,
      durationSeconds: playback.duration,
    },
    capabilityLogged: true,
  });
});
