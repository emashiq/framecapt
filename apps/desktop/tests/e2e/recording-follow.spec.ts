/**
 * A follow-mouse recording of a screen, against the E2E build (mock capture, synthetic display).
 * Mock display A is 2560 x 1440: at 2x the follow window is 1280 x 720, which the 1080p preset keeps
 * unchanged.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { _electron as electron, expect, test } from '@playwright/test';
import { exitApp } from './app-exit';
import { probeFile } from './media-fixtures';

const projectRoot = path.resolve(__dirname, '..', '..');

test('a screen recording with follow 2x is the crop size fitted to the preset', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'framecapt-e2e-follow-'));
  const app = await electron.launch({
    args: ['.'],
    cwd: projectRoot,
    env: {
      ...process.env,
      FRAMECAPT_USER_DATA_DIR: dir,
      FRAMECAPT_E2E_MOCK_CAPTURE: '1',
      FRAMECAPT_E2E_MOCK_DISPLAYS: '1',
    },
  });
  try {
    const page = await app.firstWindow();
    await page.waitForLoadState('domcontentloaded');
    await expect(page.getByTestId('record-screen')).toBeVisible();

    const countdown = page.getByTestId('opt-countdown');
    if ((await countdown.getAttribute('aria-checked')) === 'true') await countdown.click();
    await expect(countdown).toHaveAttribute('aria-checked', 'false');
    await page.getByTestId('opt-follow').getByRole('radio', { name: '2×' }).click();
    await expect(page.getByTestId('opt-follow').getByRole('radio', { name: '2×' })).toHaveAttribute(
      'aria-checked',
      'true',
    );

    await page.getByTestId('record-screen').click();
    await expect
      .poll(
        async () => {
          const result = await page.evaluate(() => window.framecapt.invoke('recorder:getState'));
          return result.ok ? result.data.status : 'error';
        },
        { timeout: 30_000 },
      )
      .toBe('recording');
    await page.waitForTimeout(2000);
    await page.evaluate(() => window.framecapt.invoke('recorder:stop'));
    await expect(page.getByTestId('recording-result')).toBeVisible({ timeout: 30_000 });
    await expect(page.getByTestId('badge-dimensions')).toHaveText('1280 × 720');

    const videos = path.join(dir, 'videos', 'FrameCapt');
    const files = fs.readdirSync(videos).filter((name) => name.endsWith('.webm'));
    expect(files).toHaveLength(1);
    const probed = probeFile(path.join(videos, files[0] ?? ''));
    const video = probed.streams?.find((stream) => stream.codec_type === 'video');
    expect(video).toMatchObject({ width: 1280, height: 720 });
  } finally {
    await exitApp(app);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
