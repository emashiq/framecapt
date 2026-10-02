/**
 * UI evidence for phase 07 (docs/evidence/phase07/ui-*.png), light and dark, from MOCK content
 * only: made-up screenshots and a test-pattern video, seeded into a fresh history. It also drives
 * the inline MP4 export from the UI against a long file, so the progress bar, Cancel (original
 * byte-identical, no partial file) and a completed retry are exercised for real.
 */
import { createHash } from 'node:crypto';
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
import { exitApp } from './app-exit';
import { makeWebm, mockScreenshotPng, newId, seedHistory, type SeedFile } from './history-fixtures';
import { probeFile } from './media-fixtures';
import { evidenceDirFor } from '../native/evidence';

const projectRoot = path.resolve(__dirname, '..', '..');
const evidenceDir = evidenceDirFor(projectRoot, 'phase07');
const THEMES = ['light', 'dark'] as const;

let app: ElectronApplication;
let page: Page;
let userDataDir: string;
let filesDir: string;
let outDir: string;
let longFile: string;
let clipFile: string;
let longId: string;
let clipId: string;
let missingId: string;

test.describe.configure({ mode: 'serial' });

const sha = (file: string): string =>
  createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const two = (value: number): string => String(value).padStart(2, '0');

function captureName(at: number, extension: string): string {
  const d = new Date(at);
  return `Framelet ${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())} at ${two(d.getHours())}.${two(d.getMinutes())}.${two(d.getSeconds())}.${extension}`;
}

async function launch(dir: string): Promise<void> {
  app = await electron.launch({
    args: ['.'],
    cwd: projectRoot,
    env: {
      ...process.env,
      FRAMELET_USER_DATA_DIR: dir,
      FRAMELET_E2E_MOCK_CAPTURE: '1',
      FRAMELET_E2E_MOCK_DISPLAYS: '1',
    },
  });
  page = await app.firstWindow();
  await page.waitForLoadState('domcontentloaded');
  await expect(page.getByTestId('shot-screen')).toBeVisible();
}

async function goTo(name: 'Capture' | 'History'): Promise<void> {
  await page.getByRole('navigation', { name: 'Primary' }).getByRole('button', { name }).click();
  await expect(page.getByTestId(name === 'History' ? 'history-view' : 'shot-screen')).toBeVisible();
}

async function stubSaveDialog(filePath: string) {
  await app.evaluate(({ dialog }, target) => {
    dialog.showSaveDialog = (() =>
      Promise.resolve({ canceled: false, filePath: target })) as typeof dialog.showSaveDialog;
  }, filePath);
}

/** Waits until no toast is on screen, so a picture shows the view and not a leftover message. */
async function toastsGone(): Promise<void> {
  await expect(page.locator('[data-sonner-toast]')).toHaveCount(0, { timeout: 12_000 });
}

async function shoot(name: string): Promise<void> {
  await toastsGone();
  // Let tooltips and image decoding settle.
  await page.waitForTimeout(300);
  await page.screenshot({ path: path.join(evidenceDir, name) });
}

async function eachTheme(fn: (theme: (typeof THEMES)[number]) => Promise<void>): Promise<void> {
  for (const theme of THEMES) {
    await page.emulateMedia({ colorScheme: theme });
    await fn(theme);
  }
  await page.emulateMedia({ colorScheme: null });
}

test.beforeAll(async () => {
  test.setTimeout(240_000);
  fs.mkdirSync(evidenceDir, { recursive: true });
  // Under the repository, not %TEMP%: the pictures show file paths and must not show a user name.
  const scratch = path.join(projectRoot, 'test-results');
  fs.mkdirSync(scratch, { recursive: true });
  userDataDir = fs.mkdtempSync(path.join(scratch, 'mock-ui-'));
  filesDir = path.join(userDataDir, 'files');
  outDir = fs.mkdtempSync(path.join(scratch, 'mock-ui-out-'));
  fs.mkdirSync(filesDir, { recursive: true });

  const now = Date.now();
  const minutes = (n: number) => now - n * 60_000;
  const shot = (
    seed: number,
    width: number,
    height: number,
    at: number,
    source: SeedFile['source'],
  ): SeedFile => {
    const file = path.join(filesDir, captureName(at, 'png'));
    const bytes = mockScreenshotPng(width, height, seed);
    fs.writeFileSync(file, bytes);
    return {
      id: newId(),
      type: 'screenshot',
      path: file,
      createdAt: at,
      width,
      height,
      durationMs: null,
      sizeBytes: bytes.length,
      format: 'png',
      hasAudio: null,
      source,
    };
  };

  clipFile = path.join(filesDir, captureName(minutes(12), 'webm'));
  makeWebm(clipFile, 12, { size: '1280x720', audio: true });
  // The long recording only exists to give the export a visible progress bar (VP8 is quick to make).
  longFile = path.join(filesDir, captureName(minutes(150), 'webm'));
  makeWebm(longFile, 75, { size: '1280x720', audio: true, codec: 'vp8' });
  const quiet = path.join(filesDir, captureName(minutes(60 * 30), 'webm'));
  makeWebm(quiet, 6, { size: '960x540', audio: false });

  const recording = (
    file: string,
    at: number,
    durationMs: number,
    width: number,
    height: number,
    audio: boolean,
    source: SeedFile['source'],
  ): SeedFile => ({
    id: newId(),
    type: 'recording',
    path: file,
    createdAt: at,
    width,
    height,
    durationMs,
    sizeBytes: fs.statSync(file).size,
    format: 'webm',
    hasAudio: audio,
    source,
  });

  const missing = shot(3, 1920, 1080, minutes(60 * 24 * 3), 'window');
  fs.rmSync(missing.path); // its file "moved": the entry stays, the file is gone
  missingId = missing.id;
  const items: SeedFile[] = [
    shot(0, 1920, 1080, minutes(2), 'region'),
    recording(clipFile, minutes(12), 12_000, 1280, 720, true, 'screen'),
    shot(1, 2560, 1440, minutes(55), 'screen'),
    recording(longFile, minutes(150), 75_000, 1280, 720, true, 'screen'),
    shot(2, 1366, 768, minutes(60 * 5), 'window'),
    shot(4, 1920, 1200, minutes(60 * 26), 'region'),
    recording(quiet, minutes(60 * 30), 6000, 960, 540, false, 'window'),
    missing,
    shot(5, 1600, 900, minutes(60 * 24 * 9), 'screen'),
  ];
  seedHistory(userDataDir, items);
  clipId = items[1]?.id ?? '';
  longId = items[3]?.id ?? '';
  await launch(userDataDir);
});

test.afterAll(async () => {
  if (app) await exitApp(app);
  for (const dir of [userDataDir, outDir])
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
});

test('UI evidence: the History grid with hover actions, light and dark', async () => {
  await goTo('History');
  await expect(page.getByTestId('history-item')).toHaveCount(9);
  // Every thumbnail has loaded before the picture is taken.
  await expect
    .poll(() =>
      page
        .getByTestId('history-item')
        .locator('img')
        .evaluateAll(
          (imgs) => imgs.filter((img) => (img as HTMLImageElement).naturalWidth > 0).length,
        ),
    )
    .toBe(9); // the missing item keeps its thumbnail (shown muted)
  await eachTheme(async (theme) => {
    const card = page.getByTestId('history-item').nth(1);
    await card.hover();
    await shoot(`ui-history-grid-${theme}.png`);
  });
});

test('UI evidence: the missing-file state, light and dark', async () => {
  const card = page.getByTestId('history-item').filter({ has: page.locator('[data-missing]') });
  await expect(card).toHaveCount(1);
  await eachTheme(async (theme) => {
    await card.hover();
    await shoot(`ui-history-missing-${theme}.png`);
  });
  await expect(page.getByTestId('history-clear-missing')).toBeVisible();
  // Details of a missing item.
  await card.locator('[data-card-main]').click();
  await expect(page.getByTestId('history-missing-details')).toBeVisible();
  await eachTheme(async (theme) => {
    await shoot(`ui-history-missing-details-${theme}.png`);
  });
  await page.getByTestId('history-back').click();
  expect(missingId).not.toBe('');
});

test('UI evidence: details with a playable video, light and dark', async () => {
  await page.getByTestId('history-item').nth(1).locator('[data-card-main]').click();
  const video = page.getByTestId('history-video');
  await expect(video).toBeVisible();
  await expect
    .poll(() => video.evaluate((v: HTMLVideoElement) => v.readyState), { timeout: 15_000 })
    .toBeGreaterThanOrEqual(2);
  await video.evaluate((v: HTMLVideoElement) => {
    v.currentTime = 3.2;
  });
  await expect
    .poll(() => video.evaluate((v: HTMLVideoElement) => !v.seeking && v.readyState >= 2))
    .toBe(true);
  await expect(page.getByTestId('mp4-export')).toBeVisible();
  await eachTheme(async (theme) => {
    await shoot(`ui-history-details-video-${theme}.png`);
  });
  await page.getByTestId('history-back').click();
});

test('UI evidence: a screenshot in the details view, light and dark', async () => {
  await page.getByTestId('history-item').first().locator('[data-card-main]').click();
  await expect
    .poll(() =>
      page.getByTestId('history-image').evaluate((el: HTMLImageElement) => el.naturalWidth),
    )
    .toBeGreaterThan(0);
  await eachTheme(async (theme) => {
    await shoot(`ui-history-details-image-${theme}.png`);
  });
  await page.getByTestId('history-back').click();
});

test('MP4 export progress and Cancel from the UI keep the original; a retry finishes; evidence shots', async () => {
  test.setTimeout(240_000);
  const before = sha(longFile);
  await page
    .getByTestId('history-item')
    .filter({ hasText: path.basename(longFile, '.webm') })
    .locator('[data-card-main]')
    .click();
  const target = path.join(outDir, 'Long clip.mp4');
  await stubSaveDialog(target);

  const progress = page.getByTestId('mp4-progress-bar');
  for (const theme of THEMES) {
    await page.emulateMedia({ colorScheme: theme });
    await toastsGone();
    await page.getByTestId('mp4-export').click();
    await expect(page.getByTestId('mp4-progress')).toBeVisible();
    await expect
      .poll(
        async () =>
          Number((await page.getByRole('progressbar').getAttribute('aria-valuenow')) ?? 0),
        {
          timeout: 60_000,
        },
      )
      .toBeGreaterThanOrEqual(25);
    await expect(page.getByTestId('mp4-cancel')).toBeVisible();
    await page.screenshot({
      path: path.join(evidenceDir, `ui-history-export-progress-${theme}.png`),
    });
    expect(
      Number((await page.getByRole('progressbar').getAttribute('aria-valuenow')) ?? 0),
    ).toBeLessThan(100);
    await page.getByTestId('mp4-cancel').click();
    await expect(page.getByTestId('mp4-export')).toBeVisible({ timeout: 15_000 });
    await expect(
      page.getByText('Export cancelled. Your recording was not changed.').first(),
    ).toBeVisible();
    // Original byte-identical, nothing half-written left behind.
    expect(sha(longFile)).toBe(before);
    expect(fs.existsSync(target)).toBe(false);
    expect(fs.readdirSync(outDir).filter((name) => name.includes('.partial'))).toEqual([]);
    await expect(progress).toHaveCount(0);
  }
  await page.emulateMedia({ colorScheme: null });

  // Retry runs to the end.
  await page.getByTestId('mp4-export').click();
  await expect(page.getByTestId('mp4-done')).toBeVisible({ timeout: 120_000 });
  expect(fs.existsSync(target)).toBe(true);
  const probe = probeFile(target);
  expect(probe.streams.find((s) => s.codec_type === 'video')?.codec_name).toBe('h264');
  expect(probe.streams.find((s) => s.codec_type === 'audio')?.codec_name).toBe('aac');
  expect(Math.abs(Number(probe.format?.duration) - 75)).toBeLessThanOrEqual(0.5);
  expect(sha(longFile)).toBe(before);
  await eachTheme(async (theme) => {
    await shoot(`ui-history-export-done-${theme}.png`);
  });
  await page.getByTestId('history-back').click();
  await expect(page.getByTestId('history-item')).toHaveCount(10);
});

test('UI evidence: the home view with Recent captures, light and dark', async () => {
  await goTo('Capture');
  await expect(page.getByTestId('recent-item')).toHaveCount(6);
  await expect
    .poll(() =>
      page
        .getByTestId('recent-item')
        .locator('img')
        .evaluateAll(
          (imgs) => imgs.filter((img) => (img as HTMLImageElement).naturalWidth > 0).length,
        ),
    )
    .toBeGreaterThanOrEqual(5);
  await page.getByTestId('recent-captures').scrollIntoViewIfNeeded();
  await eachTheme(async (theme) => {
    await shoot(`ui-home-recent-${theme}.png`);
  });
  expect(clipId).not.toBe('');
  expect(longId).not.toBe('');
});

test('UI evidence: the empty History, light and dark', async () => {
  await exitApp(app);
  const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'framelet-e2e-hist-empty-'));
  try {
    await launch(empty);
    await goTo('History');
    await expect(page.getByText('Your captures will appear here')).toBeVisible();
    await eachTheme(async (theme) => {
      await shoot(`ui-history-empty-${theme}.png`);
    });
  } finally {
    await exitApp(app);
    fs.rmSync(empty, { recursive: true, force: true });
    await launch(userDataDir);
  }
});
