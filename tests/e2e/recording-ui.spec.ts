/**
 * Takes the Phase 05 UI screenshots (docs/evidence/phase05/ui-*.png) from the E2E build, in light
 * and dark. They show only Framelet's own UI over the mock/synthetic content, never a real
 * desktop, so they are safe to keep in the repository. The toolbar and the countdown are separate
 * transparent windows; they are captured as their own pages.
 */
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
import { evidenceDirFor } from '../native/evidence';

const projectRoot = path.resolve(__dirname, '..', '..');
const evidenceDir = evidenceDirFor(projectRoot, 'phase05');

let app: ElectronApplication;
let page: Page;
let userDataDir: string;

function pagesOf(hash: string): Page[] {
  return app.windows().filter((candidate) => candidate.url().includes(hash));
}

async function setTheme(theme: 'light' | 'dark'): Promise<void> {
  // Every window follows the emulated color scheme (the system theme is not touched).
  for (const candidate of app.windows()) {
    await candidate.emulateMedia({ colorScheme: theme }).catch(() => undefined);
  }
  await page.waitForTimeout(350);
}

/** Runs `shoot` once in light and once in dark, with the file names ui-<name>-light|dark.png. */
async function both(name: string, shoot: (file: string) => Promise<unknown>): Promise<void> {
  for (const theme of ['light', 'dark'] as const) {
    await setTheme(theme);
    await shoot(path.join(evidenceDir, `ui-${name}-${theme}.png`));
  }
}

async function state() {
  const result = await page.evaluate(() => window.framelet.invoke('recorder:getState'));
  if (!result.ok) throw new Error('getState failed');
  return result.data;
}

async function toolbarPage(): Promise<Page> {
  let found: Page | undefined;
  await expect
    .poll(() => (found = pagesOf('#/toolbar')[0]) !== undefined, { timeout: 20_000 })
    .toBe(true);
  await expect.poll(async () => (await state()).status, { timeout: 20_000 }).toBe('recording');
  return found as Page;
}

test.describe.configure({ mode: 'serial' });

test.beforeAll(async () => {
  expect(
    fs.existsSync(path.join(projectRoot, '.vite', 'build', 'main.cjs')),
    'Run `npm run package:e2e` first (npm run test:e2e does this).',
  ).toBe(true);
  fs.mkdirSync(evidenceDir, { recursive: true });
  userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'framelet-e2e-ui-'));
  app = await electron.launch({
    args: ['.', '--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'],
    cwd: projectRoot,
    env: {
      ...process.env,
      FRAMELET_USER_DATA_DIR: userDataDir,
      FRAMELET_E2E_MOCK_CAPTURE: '1',
      FRAMELET_E2E_MOCK_DISPLAYS: '1',
    },
  });
  page = await app.firstWindow();
  await page.waitForLoadState('domcontentloaded');
  await expect(page.getByTestId('record-screen')).toBeVisible();
  await expect(page.getByTestId('opt-mic')).toBeEnabled({ timeout: 10_000 });
});

test.afterAll(async () => {
  if (app) await exitApp(app);
  if (userDataDir) fs.rmSync(userDataDir, { recursive: true, force: true });
});

test('record options row', async () => {
  await page.getByTestId('opt-mic').click();
  await page.getByTestId('opt-countdown').click(); // off: the recordings below start at once
  await both('record-options', (file) => page.screenshot({ path: file }));
});

test('toolbar while recording, paused, and with a lost microphone', async () => {
  await page.getByTestId('record-screen').click();
  const toolbar = await toolbarPage();
  const win = await app.browserWindow(toolbar);
  // Let the timer and the meter move a little.
  await toolbar.waitForTimeout(2200);
  const shootToolbar = (file: string) =>
    toolbar.getByTestId('toolbar').screenshot({ path: file, omitBackground: true });
  void win;

  await both('toolbar-recording', shootToolbar);

  await toolbar.getByTestId('mute-mic').click();
  await both('toolbar-muted', shootToolbar);
  await toolbar.getByTestId('mute-mic').click();

  await toolbar.getByTestId('toolbar-pause').click();
  await expect(toolbar.getByTestId('toolbar')).toHaveAttribute('data-status', 'paused');
  await both('toolbar-paused', shootToolbar);
  await toolbar.getByTestId('toolbar-resume').click();

  await pagesOf('#/recorder')[0]?.evaluate(() =>
    window.framelet.invoke('recorder:engineEvent', { type: 'trackEnded', source: 'mic' }),
  );
  await expect(toolbar.getByTestId('badge-lost-mic')).toBeVisible();
  // The toolbar grows to make room for the warning; give the window a moment.
  await toolbar.waitForTimeout(400);
  await both('toolbar-mic-lost', shootToolbar);

  await toolbar.getByTestId('toolbar-stop').click();
  await expect(page.getByTestId('recording-result')).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId('result-video')).toBeVisible();
  // Wait for the duration to be known (the view finds it by a seek) and the player to be idle.
  await expect
    .poll(
      () =>
        page
          .getByTestId('result-video')
          .evaluate(
            (v: HTMLVideoElement) => Number.isFinite(v.duration) && !v.seeking && v.readyState >= 2,
          ),
      { timeout: 15_000 },
    )
    .toBe(true);
  await page.waitForTimeout(300);
  await both('result', (file) => page.screenshot({ path: file }));
  await page.getByTestId('result-new').click();
  await expect(page.getByTestId('record-screen')).toBeVisible();
});

test('countdown window', async () => {
  await page.getByTestId('opt-countdown').click(); // on
  await page.getByTestId('record-screen').click();
  await expect.poll(() => pagesOf('#/countdown').length, { timeout: 15_000 }).toBe(1);
  const countdown = pagesOf('#/countdown')[0] as Page;
  await expect(countdown.getByTestId('countdown-number')).toBeVisible();
  await countdown.waitForTimeout(450); // after the pop animation
  await both('countdown', (file) =>
    countdown.getByTestId('countdown').screenshot({ path: file, omitBackground: true }),
  );
  await page.evaluate(() => window.framelet.invoke('recorder:cancel'));
  await expect.poll(async () => (await state()).status).toBe('idle');
});

test('the "system audio is not available" choice', async () => {
  await page.getByTestId('opt-system').click();
  await page.getByTestId('record-screen').click();
  await expect(page.getByTestId('choice-dialog')).toBeVisible({ timeout: 20_000 });
  await both('choice', (file) => page.screenshot({ path: file }));
  await page.getByTestId('choice-cancel').click();
  await expect.poll(async () => (await state()).status).toBe('idle');
  await page.getByTestId('opt-system').click();
});
