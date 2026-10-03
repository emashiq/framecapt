/**
 * Recordings carry valid timestamps. Six short recordings through the real pipeline (the E2E
 * build's synthetic display, real MediaRecorder, real chunk upload, real FFmpeg remux), half of them
 * paused once: every stream's packet timestamps strictly increase, and the file decodes without a
 * single message when ffmpeg is told not to re-time it onto a constant frame rate grid (see
 * decodesClean and decisions ADR-031 for why that grid is not the file's business).
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { _electron as electron, expect, test } from '@playwright/test';
import { exitApp } from './app-exit';
import { decodesClean } from './media-fixtures';

const projectRoot = path.resolve(__dirname, '..', '..');

for (let index = 0; index < 6; index += 1) {
  const pause = index % 2 === 1;
  test(`recording ${index + 1}${pause ? ' (paused once)' : ''}: strictly increasing timestamps, clean decode`, async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'framecapt-e2e-stamps-'));
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
      const status = async (): Promise<string> => {
        const state = await page.evaluate(() => window.framecapt.invoke('recorder:getState'));
        return state.ok ? state.data.status : 'unknown';
      };
      await page.evaluate(() =>
        window.framecapt.invoke('recorder:start', {
          target: 'screen',
          options: {
            mic: { enabled: false },
            systemAudio: false,
            quality: '1080p',
            fps: 30,
            countdown: false,
          },
        }),
      );
      await expect.poll(status, { timeout: 30_000 }).toBe('recording');
      await page.waitForTimeout(1500);
      if (pause) {
        await page.evaluate(() => window.framecapt.invoke('recorder:pause'));
        await page.waitForTimeout(700);
        await page.evaluate(() => window.framecapt.invoke('recorder:resume'));
      }
      await page.waitForTimeout(1500);
      await page.evaluate(() => window.framecapt.invoke('recorder:stop'));
      await expect.poll(status, { timeout: 30_000 }).toBe('completed');

      const videos = path.join(dir, 'videos', 'FrameCapt');
      const files = fs.readdirSync(videos).filter((name) => name.endsWith('.webm'));
      expect(files).toHaveLength(1);
      const result = decodesClean(path.join(videos, files[0] ?? ''));
      expect(result.errors).toBe('');
      expect(result).toMatchObject({ clean: true, seekClean: true, monotonic: true });
    } finally {
      await exitApp(app);
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
}
