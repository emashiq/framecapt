/**
 * A stop that arrives while the recorder engine is still starting (a slow PC) is a cancel: the
 * recorder goes idle and stays idle, nothing records afterwards, and a new start works. The engine
 * start is delayed by the E2E-only FRAMECAPT_E2E_ENGINE_START_DELAY_MS hook.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { _electron as electron, expect, test } from '@playwright/test';
import { exitApp } from './app-exit';

const projectRoot = path.resolve(__dirname, '..', '..');
const OPTIONS = {
  mic: { enabled: false },
  systemAudio: false,
  quality: '1080p',
  fps: 30,
  countdown: false,
} as const;

test('stop while the engine is still starting cancels; nothing records afterwards; a new start works', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'framecapt-e2e-slowstart-'));
  const app = await electron.launch({
    args: ['.'],
    cwd: projectRoot,
    env: {
      ...process.env,
      FRAMECAPT_USER_DATA_DIR: dir,
      FRAMECAPT_E2E_MOCK_CAPTURE: '1',
      FRAMECAPT_E2E_MOCK_DISPLAYS: '1',
      FRAMECAPT_E2E_ENGINE_START_DELAY_MS: '3000',
    },
  });
  try {
    const page = await app.firstWindow();
    await page.waitForLoadState('domcontentloaded');
    await expect(page.getByTestId('record-screen')).toBeVisible();
    const status = async (): Promise<string> => {
      const state = await page.evaluate(() => window.framecapt.invoke('recorder:getState'));
      return state.ok ? state.data.status : 'unknown';
    };
    const start = (): Promise<unknown> =>
      page.evaluate(
        (options) => window.framecapt.invoke('recorder:start', { target: 'screen', options }),
        OPTIONS,
      );

    await start();
    await expect.poll(status, { timeout: 30_000 }).toBe('starting');
    await page.evaluate(() => window.framecapt.invoke('recorder:stop'));
    await expect.poll(status, { timeout: 10_000 }).toBe('idle');
    // Well past the injected delay: the cancelled start must not turn into a recording.
    await page.waitForTimeout(5000);
    expect(await status()).toBe('idle');
    const recordings = path.join(dir, 'recordings');
    expect(fs.existsSync(recordings) ? fs.readdirSync(recordings) : []).toEqual([]);

    await start();
    await expect.poll(status, { timeout: 30_000 }).toBe('recording');
    await page.waitForTimeout(1500);
    await page.evaluate(() => window.framecapt.invoke('recorder:stop'));
    await expect.poll(status, { timeout: 60_000 }).toBe('completed');
  } finally {
    await exitApp(app);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
