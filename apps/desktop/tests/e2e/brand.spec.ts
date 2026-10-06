/**
 * Brand and boot screen. The main window covers the app with the boot screen until its first data
 * has loaded and then fades it out. The hold hook (localStorage key + release event) exists in E2E
 * builds only and makes the otherwise sub-second screen observable. Overlay and toolbar windows
 * never show it: that is asserted in screenshot.spec.ts and recording.spec.ts where those windows
 * are opened. With FRAMECAPT_WRITE_EVIDENCE=1 the pictures go to docs/evidence/brand (mock content).
 */
import fs from 'node:fs';
import path from 'node:path';
import {
  _electron as electron,
  expect,
  test,
  type ElectronApplication,
  type Page,
} from '@playwright/test';
import { exitApp } from './app-exit';
import { makeWebm, mockScreenshotPng, newId, seedHistory } from './history-fixtures';
import { evidenceDirFor } from '../native/evidence';

const projectRoot = path.resolve(__dirname, '..', '..');
const evidenceDir = evidenceDirFor(projectRoot, 'brand');

let app: ElectronApplication;
let page: Page;
let dir: string;

test.describe.configure({ mode: 'serial' });

async function setTheme(theme: 'light' | 'dark' | null): Promise<void> {
  await page.emulateMedia({ colorScheme: theme });
  await page.waitForTimeout(300);
}

async function hold(): Promise<void> {
  await page.evaluate(() => window.localStorage.setItem('framecapt-boot-hold', '1'));
  await page.reload();
}

async function release(): Promise<void> {
  await page.evaluate(() => {
    window.localStorage.removeItem('framecapt-boot-hold');
    window.dispatchEvent(new Event('framecapt:boot-release'));
  });
}

test.beforeAll(async () => {
  test.setTimeout(120_000);
  fs.mkdirSync(evidenceDir, { recursive: true });
  const scratch = path.join(projectRoot, 'test-results');
  fs.mkdirSync(scratch, { recursive: true });
  dir = fs.mkdtempSync(path.join(scratch, 'mock-brand-'));
  const files = path.join(dir, 'files');
  fs.mkdirSync(files, { recursive: true });
  const now = Date.now();
  const items = [] as Parameters<typeof seedHistory>[1];
  for (let i = 0; i < 4; i += 1) {
    const file = path.join(files, `FrameCapt 2026-10-02 at 09.${10 + i}.00.png`);
    fs.writeFileSync(file, mockScreenshotPng(1280, 720, i));
    items.push({
      id: newId(),
      type: 'screenshot',
      path: file,
      createdAt: now - (i + 1) * 17 * 60_000,
      width: 1280,
      height: 720,
      durationMs: null,
      sizeBytes: fs.statSync(file).size,
      format: 'png',
      hasAudio: null,
      source: 'screen',
    });
  }
  const clip = path.join(files, 'FrameCapt 2026-10-02 at 09.05.00.webm');
  makeWebm(clip, 2, { audio: false });
  items.push({
    id: newId(),
    type: 'recording',
    path: clip,
    createdAt: now - 5 * 60_000,
    width: 640,
    height: 360,
    durationMs: 2000,
    sizeBytes: fs.statSync(clip).size,
    format: 'webm',
    hasAudio: false,
    source: 'screen',
  });
  seedHistory(dir, items);
  app = await electron.launch({
    args: ['.'],
    cwd: projectRoot,
    env: {
      ...process.env,
      FRAMECAPT_USER_DATA_DIR: dir,
      FRAMECAPT_E2E_MOCK_CAPTURE: '1',
      FRAMECAPT_E2E_MOCK_DISPLAYS: '1',
      FRAMECAPT_E2E_FAKE_SHORTCUTS: '1',
    },
  });
  page = await app.firstWindow();
  await page.waitForLoadState('domcontentloaded');
});

test.afterAll(async () => {
  if (app) await exitApp(app);
  if (dir) fs.rmSync(dir, { recursive: true, force: true });
});

test('start-up: the app is usable and the boot screen is gone without any action', async () => {
  await expect(page.getByTestId('shot-region')).toBeVisible();
  await expect(page.getByTestId('boot-screen')).toHaveCount(0, { timeout: 10_000 });
  await expect(page.locator('[inert]')).toHaveCount(0);
  // The title bar shows the logo image (1x and 2x sources), not the old inline SVG mark.
  const logo = page.getByTestId('title-bar').locator('img').first();
  await expect(logo).toBeVisible();
  expect(await logo.evaluate((img: HTMLImageElement) => img.naturalWidth > 0)).toBe(true);
  expect(await logo.getAttribute('srcset')).toContain('2x');
});

test('boot screen covers the app until ready, then fades out', async () => {
  await hold();
  const boot = page.getByTestId('boot-screen');
  await expect(boot).toBeVisible();
  await expect(boot).toHaveAttribute('role', 'status');
  await expect(boot).toHaveAttribute('aria-label', 'Starting FrameCapt');
  await expect(boot.getByText('FrameCapt')).toBeVisible();
  // The app mounted underneath cannot be reached while the boot screen shows.
  await expect(page.locator('[inert]')).toHaveCount(1);
  // Even once its data has loaded the hold keeps it up.
  await page.waitForTimeout(1200);
  await expect(boot).toBeVisible();
  await expect(boot).toHaveAttribute('data-leaving', 'false');
  for (const theme of ['light', 'dark'] as const) {
    await setTheme(theme);
    await page.screenshot({ path: path.join(evidenceDir, `boot-screen-${theme}.png`) });
  }

  await release();
  await expect(boot).toHaveAttribute('data-leaving', 'true');
  await expect(boot).toHaveCount(0, { timeout: 2000 });
  await expect(page.locator('[inert]')).toHaveCount(0);
  await expect(page.getByTestId('shot-region')).toBeEnabled();
  await setTheme(null);
});

test('reduced motion: the boot screen is still, not animated', async () => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await hold();
  await expect(page.getByTestId('boot-screen')).toBeVisible();
  const names = await page.evaluate(() =>
    ['.boot-glow', '.boot-bar-segment'].map(
      (selector) => getComputedStyle(document.querySelector(selector) as Element).animationName,
    ),
  );
  expect(names).toEqual(['none', 'none']);
  await release();
  await expect(page.getByTestId('boot-screen')).toHaveCount(0, { timeout: 2000 });
  await page.emulateMedia({ reducedMotion: null });
});

test('sidebar and About show the logo', async () => {
  const win = await app.browserWindow(page);
  expect(await win.evaluate((w) => w.getTitle())).toBe('FrameCapt');
  for (const theme of ['light', 'dark'] as const) {
    await setTheme(theme);
    await page.screenshot({ path: path.join(evidenceDir, `home-${theme}.png`) });
    await page
      .getByRole('complementary')
      .screenshot({ path: path.join(evidenceDir, `sidebar-${theme}.png`) });
  }
  await page
    .getByRole('navigation', { name: 'Primary' })
    .getByRole('button', { name: 'Settings' })
    .click();
  await page.getByTestId('settings-nav-about').click();
  const about = page.getByTestId('about-brand');
  await expect(about).toBeVisible();
  await expect(about.locator('img')).toHaveAttribute('width', '112');
  await expect(about).toContainText('Version');
  for (const theme of ['light', 'dark'] as const) {
    await setTheme(theme);
    await page
      .getByTestId('about-section')
      .screenshot({ path: path.join(evidenceDir, `about-${theme}.png`) });
  }
  await setTheme(null);
});

test('the brand loader shows while MP4 export waits for the save dialog', async () => {
  // The save dialog is stubbed to never answer, which holds the export in its "starting" state.
  await app.evaluate(({ dialog }) => {
    dialog.showSaveDialog = (() => new Promise(() => undefined)) as typeof dialog.showSaveDialog;
  });
  await page
    .getByRole('navigation', { name: 'Primary' })
    .getByRole('button', { name: 'History' })
    .click();
  await page
    .getByTestId('history-grid')
    .locator('li', { hasText: 'webm' })
    .first()
    .locator('[data-card-main]')
    .click();
  await page.getByTestId('mp4-export').click();
  const progress = page.getByTestId('mp4-progress');
  await expect(progress).toContainText('Choose where to save');
  const loader = progress.getByTestId('loader');
  await expect(loader).toHaveAttribute('data-size', 'sm');
  for (const theme of ['light', 'dark'] as const) {
    await setTheme(theme);
    await progress.screenshot({ path: path.join(evidenceDir, `loader-mp4-${theme}.png`) });
  }
  await setTheme(null);
});
