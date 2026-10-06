/**
 * Linux-only behavior of the experimental Linux x64 build (docs/building-on-linux.md), against the
 * E2E build (mock capture provider): the platform capabilities are reported up front instead of
 * failing later. Skipped on every other OS. Real capture on Linux: tests/native/linux.native.spec.ts.
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

test.skip(process.platform !== 'linux', 'Linux-only behavior');

const projectRoot = path.resolve(__dirname, '..', '..');
let app: ElectronApplication;
let page: Page;
let dir: string;

async function launch(settings?: unknown): Promise<void> {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'framecapt-e2e-linux-'));
  if (settings !== undefined)
    fs.writeFileSync(path.join(dir, 'settings.json'), JSON.stringify(settings));
  app = await electron.launch({
    args: ['.'],
    cwd: projectRoot,
    env: {
      ...process.env,
      FRAMECAPT_USER_DATA_DIR: dir,
      FRAMECAPT_E2E_MOCK_CAPTURE: '1',
      FRAMECAPT_E2E_MOCK_DISPLAYS: '1', // one display: a screen recording starts without a picker
    },
  });
  page = await app.firstWindow();
  await page.waitForLoadState('domcontentloaded');
  await expect(page.getByTestId('record-options')).toBeVisible();
}

test.afterEach(async () => {
  if (app) await exitApp(app);
  if (dir) fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 });
});

test('the app runs on X11 and reports the Linux platform', async () => {
  await launch();
  const info = await page.evaluate(() => window.framecapt.invoke('app:getInfo'));
  expect(info).toMatchObject({ ok: true, data: { platform: 'linux' } });
  // The forced ozone platform (ADR-036): Chromium reports x11 even on a Wayland session.
  const ozone = await app.evaluate(({ app: electronApp }) =>
    electronApp.commandLine.getSwitchValue('ozone-platform'),
  );
  expect(ozone).toBe('x11');
});

test('record options: system audio is disabled with the reason, the toolbar note is shown', async () => {
  await launch();
  const system = page.getByTestId('opt-system');
  await expect(system).toBeDisabled();
  await expect(system).toHaveAttribute('aria-checked', 'false');
  await expect(page.getByTestId('record-options')).toContainText('Not available on Linux yet');
  await expect(page.getByTestId('record-toolbar-note')).toHaveText(
    'The recording toolbar may appear in full-screen recordings on Linux.',
  );
});

test('a saved "system audio on" setting is shown off and disabled in Settings', async () => {
  await launch({ version: 1, recording: { systemAudio: true } });
  await expect(page.getByTestId('opt-system')).toHaveAttribute('aria-checked', 'false');
  await page
    .getByRole('navigation', { name: 'Primary' })
    .getByRole('button', { name: 'Settings' })
    .click();
  await page.getByTestId('settings-nav-recording').click();
  const toggle = page.getByTestId('setting-system-audio');
  await expect(toggle).toBeDisabled();
  await expect(toggle).toHaveAttribute('aria-checked', 'false');
  await expect(page.getByTestId('settings-recording')).toContainText('Not available on Linux yet');
});

test('a recording that asks for system audio starts anyway, without the "unavailable" choice', async () => {
  await launch();
  const started = await page.evaluate(() =>
    window.framecapt.invoke('recorder:start', {
      target: 'screen',
      options: {
        mic: { enabled: false },
        systemAudio: true,
        quality: '1080p',
        fps: 30,
        countdown: false,
      },
    }),
  );
  expect(started.ok).toBe(true);
  await expect
    .poll(async () => {
      const state = await page.evaluate(() => window.framecapt.invoke('recorder:getState'));
      return state.ok ? state.data.status : 'error';
    })
    .toBe('recording');
  await expect(page.getByTestId('choice-dialog')).toHaveCount(0);
  await page.evaluate(() => window.framecapt.invoke('recorder:stop'));
  await expect
    .poll(
      async () => {
        const state = await page.evaluate(() => window.framecapt.invoke('recorder:getState'));
        return state.ok ? state.data.status : 'error';
      },
      { timeout: 30_000 },
    )
    .toBe('completed');
});
