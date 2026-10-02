/**
 * UI evidence for phase 08 (docs/evidence/phase08/ui-*.png), light and dark, from MOCK content only
 * (the E2E build's synthetic displays, made-up screenshots, a test-pattern video): never a real
 * desktop. Also asserts the lead-review fixes that are visible: the recording toolbar fits its
 * content on both sides (mic only, and mic plus system audio) and the home layout is balanced.
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
const evidenceDir = evidenceDirFor(projectRoot, 'phase08');

let app: ElectronApplication;
let page: Page;
let dir: string;

test.describe.configure({ mode: 'serial' });

function pagesOf(hash: string): Page[] {
  return app.windows().filter((candidate) => candidate.url().includes(hash));
}

async function setTheme(theme: 'light' | 'dark'): Promise<void> {
  for (const candidate of app.windows()) {
    await candidate.emulateMedia({ colorScheme: theme }).catch(() => undefined);
  }
  await page.waitForTimeout(350);
}

async function both(name: string, shoot: (file: string) => Promise<unknown>): Promise<void> {
  for (const theme of ['light', 'dark'] as const) {
    await setTheme(theme);
    await shoot(path.join(evidenceDir, `ui-${name}-${theme}.png`));
  }
}

async function toastsGone(): Promise<void> {
  await expect(page.locator('[data-sonner-toast]')).toHaveCount(0, { timeout: 12_000 });
}

async function shootPage(name: string): Promise<void> {
  await toastsGone();
  await both(name, (file) => page.screenshot({ path: file }));
}

async function go(name: 'Capture' | 'History' | 'Settings'): Promise<void> {
  await page.getByRole('navigation', { name: 'Primary' }).getByRole('button', { name }).click();
}

async function section(name: string): Promise<void> {
  await go('Settings');
  await page.getByTestId(`settings-nav-${name}`).click();
  await expect(
    page.getByTestId(name === 'about' ? 'about-section' : `settings-${name}`),
  ).toBeVisible();
}

async function status(): Promise<string> {
  const result = await page.evaluate(() => window.framelet.invoke('recorder:getState'));
  return result.ok ? result.data.status : 'unknown';
}

test.beforeAll(async () => {
  test.setTimeout(240_000);
  fs.mkdirSync(evidenceDir, { recursive: true });
  // Under the repository, not %TEMP%: the pictures show file paths and must not show a user name.
  const scratch = path.join(projectRoot, 'test-results');
  fs.mkdirSync(scratch, { recursive: true });
  dir = fs.mkdtempSync(path.join(scratch, 'mock-ui-p8-'));
  const files = path.join(dir, 'files');
  fs.mkdirSync(files, { recursive: true });
  const now = Date.now();
  const items = [] as Parameters<typeof seedHistory>[1];
  for (let i = 0; i < 6; i += 1) {
    const at = now - (i + 1) * 17 * 60_000;
    const file = path.join(
      files,
      `Framelet 2026-10-02 at 09.${String(10 + i).padStart(2, '0')}.00.png`,
    );
    fs.writeFileSync(file, mockScreenshotPng(1280, 720, i));
    items.push({
      id: newId(),
      type: 'screenshot',
      path: file,
      createdAt: at,
      width: 1280,
      height: 720,
      durationMs: null,
      sizeBytes: fs.statSync(file).size,
      format: 'png',
      hasAudio: null,
      source: i % 3 === 0 ? 'region' : i % 3 === 1 ? 'window' : 'screen',
    });
  }
  const clip = path.join(files, 'Framelet 2026-10-02 at 09.05.00.webm');
  makeWebm(clip, 3, { audio: false });
  items.push({
    id: newId(),
    type: 'recording',
    path: clip,
    createdAt: now - 5 * 60_000,
    width: 640,
    height: 360,
    durationMs: 3000,
    sizeBytes: fs.statSync(clip).size,
    format: 'webm',
    hasAudio: false,
    source: 'screen',
  });
  seedHistory(dir, items);
  app = await electron.launch({
    args: ['.', '--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'],
    cwd: projectRoot,
    env: {
      ...process.env,
      FRAMELET_USER_DATA_DIR: dir,
      FRAMELET_E2E_MOCK_CAPTURE: '1',
      FRAMELET_E2E_MOCK_DISPLAYS: '1',
      FRAMELET_E2E_FAKE_SHORTCUTS: '1',
      FRAMELET_E2E_TAKEN_SHORTCUTS: 'Ctrl+Shift+2',
    },
  });
  page = await app.firstWindow();
  await page.waitForLoadState('domcontentloaded');
  await expect(page.getByTestId('shot-region')).toBeVisible();
  await expect(page.getByTestId('opt-mic')).toBeEnabled({ timeout: 10_000 });
  // Tall enough that the whole home view (cards, options, recent captures) is in the picture.
  const win = await app.browserWindow(page);
  await win.evaluate((w) => w.setSize(1180, 1040));
  await page.waitForTimeout(400);
});

test.afterAll(async () => {
  if (app) await exitApp(app);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('home: balanced cards, shortcut hints (one in conflict), options strip, tip, recent captures', async () => {
  await expect(page.getByTestId('shortcut-problems')).toBeVisible();
  await expect(page.getByTestId('home-tip')).toHaveCount(0); // one banner at a time
  await expect(page.getByTestId('recent-item').first()).toBeVisible();
  // Balanced: both mode cards have the same height and sit on one row; the options strip spans both.
  const [shot, record, options] = await Promise.all([
    page.getByTestId('mode-screenshot').boundingBox(),
    page.getByTestId('mode-record').boundingBox(),
    page.getByTestId('record-options').boundingBox(),
  ]);
  expect(Math.abs((shot?.height ?? 0) - (record?.height ?? 1))).toBeLessThan(1);
  expect(Math.abs((shot?.y ?? 0) - (record?.y ?? 1))).toBeLessThan(1);
  expect(options?.x ?? 0).toBeLessThanOrEqual((shot?.x ?? 0) + 1);
  expect((options?.x ?? 0) + (options?.width ?? 0)).toBeGreaterThanOrEqual(
    (record?.x ?? 0) + (record?.width ?? 0) - 1,
  );
  await page.waitForTimeout(600); // thumbnails
  await shootPage('home-conflict');
  // Fix the conflict: the first-run tip comes back.
  await page.evaluate(() =>
    window.framelet.invoke('settings:update', {
      patch: { shortcuts: { screenshotWindow: 'Ctrl+Alt+2' } },
    }),
  );
  await expect(page.getByTestId('home-tip')).toBeVisible();
  await expect(page.getByTestId('shortcut-problems')).toHaveCount(0);
  await shootPage('home');
});

test('settings: every section', async () => {
  for (const name of [
    'general',
    'screenshots',
    'recording',
    'shortcuts',
    'storage',
    'advanced',
    'about',
  ]) {
    await section(name);
    await page.waitForTimeout(250);
    await shootPage(`settings-${name}`);
  }
  // The shortcut recorder while listening, with a modifier held.
  await section('shortcuts');
  await page.getByTestId('shortcut-change-recordRegion').click();
  await page.keyboard.down('Control');
  await page.keyboard.down('Alt');
  await expect(page.getByTestId('shortcut-recorder-recordRegion')).toContainText('Alt');
  await shootPage('settings-shortcut-recording');
  await page.keyboard.up('Alt');
  await page.keyboard.up('Control');
  await page.keyboard.press('Escape');
});

test('history', async () => {
  await go('History');
  await expect(page.getByTestId('history-grid').locator('li').first()).toBeVisible();
  await page.waitForTimeout(600);
  await shootPage('history');
  await go('Capture');
});

test('keyboard selection overlay and the editor', async () => {
  await page.getByTestId('shot-region').click();
  let overlay: Page | undefined;
  await expect
    .poll(async () => {
      for (const candidate of pagesOf('#/overlay')) {
        const root = candidate.locator('[data-testid="overlay-region"]');
        if ((await root.count()) && (await root.getAttribute('data-ready')) === 'true') {
          overlay = candidate;
          return true;
        }
      }
      return false;
    })
    .toBe(true);
  const o = overlay as Page;
  await o.keyboard.press('ArrowRight');
  await o.keyboard.press('Alt+Shift+ArrowLeft');
  await o.waitForTimeout(500);
  await both('overlay-keyboard', (file) => o.screenshot({ path: file }));
  await o.keyboard.press('Enter').catch(() => undefined);
  await expect(page.getByTestId('editor-view')).toBeVisible();
  await expect(page.getByTestId('editor-canvas')).toBeFocused();
  await page.waitForTimeout(500);
  await shootPage('editor');
  await page.getByTestId('editor-discard').click();
  await both('discard-dialog', (file) => page.screenshot({ path: file }));
  await page.getByTestId('confirm-yes').click();
  await expect(page.getByTestId('shot-region')).toBeVisible();
});

test('help, window picker', async () => {
  await page.keyboard.press('?');
  await expect(page.getByTestId('keyboard-help')).toBeVisible();
  await shootPage('help');
  await page.keyboard.press('Escape');
  await page.getByTestId('shot-window').click();
  await expect(page.getByTestId('window-grid')).toBeVisible();
  await page.waitForTimeout(500);
  await shootPage('window-picker');
  await page.keyboard.press('Escape');
});

test('recording: the toolbar fits its content in every state, quit question, result', async () => {
  await go('Capture');
  const toggle = async (id: string, on: boolean): Promise<void> => {
    const control = page.getByTestId(id);
    if ((await control.getAttribute('aria-checked')) !== String(on)) await control.click();
  };
  await toggle('opt-countdown', false);
  await toggle('opt-mic', true);
  await toggle('opt-system', false);

  const fit = async (toolbar: Page): Promise<{ window: number; pill: number }> => {
    const win = await app.browserWindow(toolbar);
    const bounds = await win.evaluate((w) => w.getContentBounds());
    const pill = await toolbar.getByTestId('toolbar').boundingBox();
    return { window: bounds.width, pill: Math.ceil(pill?.width ?? 0) };
  };
  /** The window is exactly as wide as the pill (no clipping, no slack), within a pixel. */
  const expectFits = async (
    toolbar: Page,
    label: string,
  ): Promise<{ window: number; pill: number }> => {
    await expect
      .poll(
        async () => {
          const measured = await fit(toolbar);
          return Math.abs(measured.window - measured.pill);
        },
        { message: label, timeout: 5000 },
      )
      .toBeLessThanOrEqual(1);
    return fit(toolbar);
  };
  const shootToolbar = (toolbar: Page, name: string) =>
    both(name, (file) =>
      toolbar.getByTestId('toolbar').screenshot({ path: file, omitBackground: true }),
    );

  await page.getByTestId('record-screen').click();
  await expect.poll(() => pagesOf('#/toolbar').length, { timeout: 20_000 }).toBe(1);
  await expect.poll(status, { timeout: 20_000 }).toBe('recording');
  const toolbar = pagesOf('#/toolbar')[0] as Page;
  await toolbar.waitForTimeout(1800);
  const measured: Record<string, { window: number; pill: number }> = {};

  // Microphone only: the layout the lead review found clipped at the right edge.
  measured.recording = await expectFits(toolbar, 'recording, mic only');
  await shootToolbar(toolbar, 'toolbar-mic');

  await toolbar.getByTestId('toolbar-pause').click();
  await expect(toolbar.getByTestId('toolbar')).toHaveAttribute('data-status', 'paused');
  measured.paused = await expectFits(toolbar, 'paused');
  await shootToolbar(toolbar, 'toolbar-paused');
  await toolbar.getByTestId('toolbar-resume').click();

  await pagesOf('#/recorder')[0]?.evaluate(() =>
    window.framelet.invoke('recorder:engineEvent', { type: 'trackEnded', source: 'mic' }),
  );
  await expect(toolbar.getByTestId('badge-lost-mic')).toBeVisible();
  measured.micLost = await expectFits(toolbar, 'microphone lost');
  await shootToolbar(toolbar, 'toolbar-mic-lost');

  // The quit question while recording.
  await app.evaluate(() => {
    (
      globalThis as unknown as { __frameletTest: { requestQuit(): void } }
    ).__frameletTest.requestQuit();
  });
  await expect(page.getByTestId('confirm-dialog')).toBeVisible();
  await both('quit-while-recording', (file) => page.screenshot({ path: file }));
  await page.getByRole('button', { name: 'Keep recording' }).click();

  await toolbar.getByTestId('toolbar-stop').click();
  await expect(page.getByTestId('recording-result')).toBeVisible({ timeout: 30_000 });
  await expect
    .poll(() =>
      page
        .getByTestId('result-video')
        .evaluate(
          (v: HTMLVideoElement) => Number.isFinite(v.duration) && !v.seeking && v.readyState >= 2,
        ),
    )
    .toBe(true);
  await page.waitForTimeout(300);
  await shootPage('result');
  await page.getByTestId('result-new').click();
  fs.writeFileSync(
    path.join(evidenceDir, 'toolbar-fit.json'),
    JSON.stringify(measured, null, 2) + String.fromCharCode(10),
  );
});
