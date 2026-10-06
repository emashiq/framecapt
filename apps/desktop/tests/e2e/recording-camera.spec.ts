/**
 * A screen recording with the camera, against the E2E build (mock capture, synthetic display) and
 * Chromium's fake camera (`--use-fake-device-for-media-stream`, a launch argument of the test: no
 * product code is involved, and a real camera is never touched). The camera bubble is a window of its
 * own: content protected, always on top, hidden by the toolbar's camera button, moved by dragging; the
 * recorder composites the camera into the video where the bubble sits.
 */
import { execFileSync } from 'node:child_process';
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
import { FFMPEG, probeFile } from './media-fixtures';

const projectRoot = path.resolve(__dirname, '..', '..');

/** The window of a role (they are told apart by their hash). */
async function windowOf(app: ElectronApplication, role: string): Promise<Page> {
  let found: Page | undefined;
  await expect
    .poll(
      () => {
        found = app.windows().find((candidate) => candidate.url().endsWith(`#/${role}`));
        return found !== undefined;
      },
      { timeout: 30_000 },
    )
    .toBe(true);
  return found as Page;
}

interface BubbleInfo {
  contentProtected: boolean;
  alwaysOnTop: boolean;
  visible: boolean;
  bounds: { x: number; y: number; width: number; height: number };
  display: { x: number; y: number; width: number; height: number };
}

function bubbleInfo(app: ElectronApplication): Promise<BubbleInfo | null> {
  return app.evaluate(({ BrowserWindow, screen }) => {
    const win = BrowserWindow.getAllWindows().find((candidate) =>
      candidate.webContents.getURL().endsWith('#/camera'),
    );
    if (!win) return null;
    return {
      contentProtected: win.isContentProtected(),
      alwaysOnTop: win.isAlwaysOnTop(),
      visible: win.isVisible(),
      bounds: win.getBounds(),
      display: screen.getPrimaryDisplay().bounds,
    };
  });
}

/** The last frame of the file as raw RGB. */
function lastFrame(file: string, width: number, height: number): Buffer {
  return execFileSync(
    FFMPEG,
    [
      '-v',
      'error',
      '-sseof',
      '-0.5',
      '-i',
      file,
      '-frames:v',
      '1',
      '-f',
      'rawvideo',
      '-pix_fmt',
      'rgb24',
      '-',
    ],
    { shell: false, maxBuffer: width * height * 3 * 2 },
  );
}

/** The synthetic display (synthetic-stream.ts): a diagonal gradient over 2560 x 1440 from hsl(220 70% 45%) to hsl(340 70% 25%). */
const GRADIENT = { from: [34, 88, 195], to: [108, 19, 49], width: 2560, height: 1440 } as const;

/**
 * How far a square of the frame is from the synthetic picture: about 0 where the picture is
 * untouched, large where the camera covers it.
 */
function distanceFromSynthetic(
  frame: Buffer,
  size: { width: number; height: number },
  center: { x: number; y: number },
  half: number,
): number {
  let total = 0;
  let count = 0;
  for (let y = Math.round(center.y) - half; y < Math.round(center.y) + half; y += 1) {
    for (let x = Math.round(center.x) - half; x < Math.round(center.x) + half; x += 1) {
      const offset = (y * size.width + x) * 3;
      const { width, height, from, to } = GRADIENT;
      const u = x / size.width;
      const v = y / size.height;
      const t = (u * width * width + v * height * height) / (width * width + height * height);
      for (let channel = 0; channel < 3; channel += 1) {
        const expected = (from[channel] ?? 0) + t * ((to[channel] ?? 0) - (from[channel] ?? 0));
        total += Math.abs((frame[offset + channel] ?? 0) - expected) / 3;
      }
      count += 1;
    }
  }
  return total / count;
}

test('screen recording with the camera: a protected bubble, the toolbar toggle, the camera in the video', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'framecapt-e2e-camera-'));
  const app = await electron.launch({
    args: ['.', '--use-fake-device-for-media-stream'],
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
    // The device list reaches the main window (its camera permission check is allowed).
    const camera = page.getByTestId('opt-camera');
    await expect(camera).toBeEnabled({ timeout: 15_000 });
    await camera.click();
    await expect(camera).toHaveAttribute('aria-checked', 'true');
    await expect(page.getByTestId('opt-camera-shape')).toBeVisible();

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

    // The bubble: its own window, protected from capture, on top, bottom right of the screen.
    const bubblePage = await windowOf(app, 'camera');
    const bubble = await bubbleInfo(app);
    expect(bubble).toMatchObject({ contentProtected: true, alwaysOnTop: true, visible: true });
    expect(bubble?.bounds).toMatchObject({ width: 220, height: 220 });
    expect((bubble?.bounds.x ?? 0) + 220).toBe(
      (bubble?.display.x ?? 0) + (bubble?.display.width ?? 0) - 24,
    );
    await expect(bubblePage.getByTestId('camera-bubble')).toHaveAttribute('data-shape', 'circle');
    // ... showing the (fake) camera.
    await expect
      .poll(() => bubblePage.evaluate(() => document.querySelector('video')?.videoWidth ?? 0))
      .toBeGreaterThan(0);

    // The toolbar's camera button hides and shows it again.
    const toolbar = await windowOf(app, 'toolbar');
    await toolbar.getByTestId('toolbar-camera').click();
    await expect.poll(async () => (await bubbleInfo(app))?.visible).toBe(false);
    await toolbar.getByTestId('toolbar-camera').click();
    await expect.poll(async () => (await bubbleInfo(app))?.visible).toBe(true);

    // The bubble's own size button cycles the window M 220 -> L 300 -> S 160 -> M 220.
    for (const width of [300, 160, 220]) {
      await bubblePage.getByTestId('camera-size').click({ force: true });
      await expect.poll(async () => (await bubbleInfo(app))?.bounds.width).toBe(width);
    }

    // Drag the bubble to the top left (a programmatic move sends the same live positions).
    await app.evaluate(({ BrowserWindow, screen }) => {
      const win = BrowserWindow.getAllWindows().find((candidate) =>
        candidate.webContents.getURL().endsWith('#/camera'),
      );
      const area = screen.getPrimaryDisplay().bounds;
      win?.setPosition(area.x + 24, area.y + 24);
    });
    await page.waitForTimeout(1500);
    await page.evaluate(() => window.framecapt.invoke('recorder:stop'));
    await expect(page.getByTestId('recording-result')).toBeVisible({ timeout: 30_000 });

    // The bubble is gone with the recording.
    await expect.poll(async () => await bubbleInfo(app)).toBeNull();

    const videos = path.join(dir, 'videos', 'FrameCapt');
    const files = fs.readdirSync(videos).filter((name) => name.endsWith('.webm'));
    expect(files).toHaveLength(1);
    const file = path.join(videos, files[0] ?? '');
    const video = probeFile(file).streams.find((stream) => stream.codec_type === 'video');
    expect(video).toMatchObject({ width: 1920, height: 1080 });

    // The camera is in the picture at the top left (not at the bottom right any more).
    const size = { width: 1920, height: 1080 };
    const frame = lastFrame(file, size.width, size.height);
    const side = 216; // 20 % of the shorter side
    const margin = 20;
    const topLeft = { x: margin + side / 2, y: margin + side / 2 };
    const bottomRight = { x: size.width - margin - side / 2, y: size.height - margin - side / 2 };
    expect(distanceFromSynthetic(frame, size, topLeft, 40)).toBeGreaterThan(25);
    expect(distanceFromSynthetic(frame, size, bottomRight, 40)).toBeLessThan(12);
  } finally {
    await exitApp(app);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
