/**
 * Native verification of the experimental Linux x64 build on a real X server (docs/building-on-linux.md):
 * real desktopCapturer/getDisplayMedia, no mock provider. Needs a display (WSLg, an X11 session or
 * XWayland), a window manager is not required. Run with `npm run test:native:linux` (inside Linux).
 * It does a real screen screenshot, a real 4 s screen recording (no audio) and an MP4 export, and
 * checks the outputs with the bundled linux ffprobe/ffmpeg.
 *
 * A solid magenta always-on-top window is put at a known place on the display, so "it captured the
 * screen" is a pixel fact, not a hope: a desktop without windows (WSLg) is plain black.
 * Evidence (redacted JSON) is written under docs/evidence/linux only with FRAMECAPT_WRITE_EVIDENCE=1.
 */
import { spawnSync } from 'node:child_process';
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
import { exitApp } from '../e2e/app-exit';
import { evidenceDirFor, writeEvidenceJson } from './evidence';

test.skip(process.platform !== 'linux', 'Linux-only native checks');

const projectRoot = path.resolve(__dirname, '..', '..');
const vendor = path.join(projectRoot, 'vendor', 'ffmpeg', 'linux-x64');
const FFMPEG = path.join(vendor, 'ffmpeg');
const FFPROBE = path.join(vendor, 'ffprobe');

interface Display {
  id: string;
  bounds: { x: number; y: number; width: number; height: number };
  physicalSize: { width: number; height: number };
  isPrimary: boolean;
}
interface Region {
  x: number;
  y: number;
  width: number;
  height: number;
}

let app: ElectronApplication;
let page: Page;
let userDataDir: string;
let outDir: string;
let display: Display;
let displayCount = 0;
const evidence: Record<string, unknown> = {};
/** FRAMECAPT_LINUX_PIXELS=0: record the pixel facts but do not fail on them (WSLg/XWayland captures black). */
const assertPixels = process.env.FRAMECAPT_LINUX_PIXELS !== '0';

test.describe.configure({ mode: 'serial' });

test.beforeAll(async () => {
  expect(
    fs.existsSync(path.join(projectRoot, '.vite', 'build', 'main.cjs')),
    'Run `electron-forge package` first (npm run make does this).',
  ).toBe(true);
  expect(fs.existsSync(FFPROBE), 'Run `npm run fetch:ffmpeg` first.').toBe(true);
  userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'framecapt-linux-native-'));
  outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'framecapt-linux-native-out-'));
  app = await electron.launch({
    args: ['.'],
    cwd: projectRoot,
    env: { ...process.env, FRAMECAPT_USER_DATA_DIR: userDataDir },
  });
  page = await app.firstWindow();
  await page.waitForLoadState('domcontentloaded');
  await expect(page.getByTestId('shot-screen')).toBeVisible();
  const listed = await page.evaluate(() => window.framecapt.invoke('capture:listDisplays'));
  if (!listed.ok) throw new Error('capture:listDisplays failed');
  displayCount = listed.data.length;
  display = listed.data.find((d) => d.isPrimary) ?? (listed.data[0] as Display);
  expect(display).toBeDefined();
});

test.afterAll(async () => {
  if (evidence.platform) {
    writeEvidenceJson(evidenceDirFor(projectRoot, 'linux'), 'native-linux.json', evidence);
  }
  if (app) await exitApp(app);
  const log = path.join(userDataDir, 'logs', 'main.log');
  if (fs.existsSync(log)) keep(log);
  for (const dir of [userDataDir, outDir]) {
    if (dir) fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 });
  }
});

// --- helpers ---------------------------------------------------------------------------------

function run(
  file: string,
  args: string[],
): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync(file, args, { shell: false, encoding: 'utf8', maxBuffer: 64 << 20 });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

interface Probed {
  format: { duration?: string; format_name?: string };
  streams: {
    codec_type: string;
    codec_name?: string;
    width?: number;
    height?: number;
    pix_fmt?: string;
  }[];
}
const probe = (file: string): Probed =>
  JSON.parse(
    run(FFPROBE, ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', file]).stdout,
  ) as Probed;

/**
 * Decodes every video frame (`ffmpeg -v error -i file -map 0:v:0 -f rawvideo /dev/null`): exit 0 and
 * nothing on stderr. Not `-f null`: these are variable frame rate files and the null muxer picks a
 * 1/avg-fps time base, then reports frames in the same tick as "non monotonically increasing dts"
 * (a checking artifact, the files are fine). Recordings here have no audio track.
 */
function decodesClean(file: string): { ok: boolean; stderr: string } {
  const result = run(FFMPEG, [
    '-v',
    'error',
    '-i',
    file,
    '-map',
    '0:v:0',
    '-f',
    'rawvideo',
    '-y',
    '/dev/null',
  ]);
  return { ok: result.status === 0 && result.stderr.trim() === '', stderr: result.stderr.trim() };
}

/** FRAMECAPT_LINUX_KEEP=<dir> keeps the captured files (they show the real desktop: not committed). */
function keep(file: string): void {
  const dir = process.env.FRAMECAPT_LINUX_KEEP;
  if (!dir) return;
  fs.mkdirSync(dir, { recursive: true });
  fs.copyFileSync(file, path.join(dir, path.basename(file)));
}

const sha256 = (file: string): string =>
  createHash('sha256').update(fs.readFileSync(file)).digest('hex');

const expectedFit = (width: number, height: number): { width: number; height: number } => {
  const scale = Math.min(1920 / width, 1080 / height, 1);
  const even = (value: number): number => 2 * Math.round(value / 2);
  return { width: even(width * scale), height: even(height * scale) };
};

function pngSize(file: string): { width: number; height: number } {
  const header = fs.readFileSync(file).subarray(0, 24);
  expect(header.subarray(1, 4).toString('ascii')).toBe('PNG');
  return { width: header.readUInt32BE(16), height: header.readUInt32BE(20) };
}

/** Fraction of the pixels in `region` of a PNG that are near magenta (decoded in the renderer). */
async function magentaFraction(file: string, region: Region): Promise<number> {
  const data = fs.readFileSync(file).toString('base64');
  return page.evaluate(
    async ({ base64, area }) => {
      const bytes = Uint8Array.from(atob(base64), (char) => char.charCodeAt(0));
      const bitmap = await createImageBitmap(new Blob([bytes], { type: 'image/png' }));
      const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
      const context = canvas.getContext('2d', {
        willReadFrequently: true,
      }) as OffscreenCanvasRenderingContext2D;
      context.drawImage(bitmap, 0, 0);
      const pixels = context.getImageData(area.x, area.y, area.width, area.height).data;
      let hits = 0;
      for (let i = 0; i < pixels.length; i += 4) {
        if ((pixels[i] ?? 0) > 235 && (pixels[i + 1] ?? 255) < 25 && (pixels[i + 2] ?? 0) > 235) {
          hits += 1;
        }
      }
      return hits / (pixels.length / 4);
    },
    { base64: data, area: region },
  );
}

/** A frameless always-on-top magenta window at an exact rectangle of the display; returns its id. */
async function openMagentaWindow(rect: Region): Promise<number> {
  return app.evaluate(async ({ BrowserWindow }, r) => {
    const win = new BrowserWindow({
      x: r.x,
      y: r.y,
      width: r.width,
      height: r.height,
      frame: false,
      resizable: false,
      show: false,
      skipTaskbar: true,
      hasShadow: false,
      backgroundColor: '#FF00FF',
      webPreferences: {},
    });
    win.setAlwaysOnTop(true, 'screen-saver');
    await win.loadURL('about:blank');
    await win.webContents.executeJavaScript(
      "document.documentElement.style.background = '#FF00FF'; document.body.style.cssText = 'margin:0;background:#FF00FF'",
    );
    win.setBounds(r);
    win.show();
    await new Promise((resolve) => setTimeout(resolve, 1000));
    return win.id;
  }, rect);
}

const closeWindow = (id: number): Promise<void> =>
  app.evaluate(({ BrowserWindow }, windowId) => BrowserWindow.fromId(windowId)?.destroy(), id);

async function stubSaveDialog(filePath: string): Promise<void> {
  await app.evaluate(({ dialog }, target) => {
    dialog.showSaveDialog = (() =>
      Promise.resolve({ canceled: false, filePath: target })) as typeof dialog.showSaveDialog;
  }, filePath);
}

async function snapshot() {
  const result = await page.evaluate(() => window.framecapt.invoke('recorder:getState'));
  if (!result.ok) throw new Error('recorder:getState failed');
  return result.data;
}

// --- tests -----------------------------------------------------------------------------------

test('platform: linux x64, X11 forced, system audio reported unavailable in the UI', async () => {
  const info = await page.evaluate(() => window.framecapt.invoke('app:getInfo'));
  expect(info).toMatchObject({ ok: true, data: { platform: 'linux', isPackaged: false } });
  const ozone = await app.evaluate(({ app: electronApp }) =>
    electronApp.commandLine.getSwitchValue('ozone-platform'),
  );
  expect(ozone).toBe('x11');
  await expect(page.getByTestId('opt-system')).toBeDisabled();
  await expect(page.getByTestId('record-toolbar-note')).toBeVisible();
  evidence.platform = {
    app: info.ok ? info.data : null,
    os: `${os.type()} ${os.release()} ${os.arch()}`,
    session: {
      DISPLAY: process.env.DISPLAY ?? null,
      WAYLAND_DISPLAY: process.env.WAYLAND_DISPLAY ?? null,
    },
    ozonePlatformSwitch: ozone,
    displays: displayCount,
    display: { bounds: display.bounds, physicalSize: display.physicalSize },
  };
});

test('real screen screenshot: exact display size and the magenta window is in it', async () => {
  const local: Region = { x: 200, y: 150, width: 400, height: 300 };
  const id = await openMagentaWindow({
    x: display.bounds.x + local.x,
    y: display.bounds.y + local.y,
    width: local.width,
    height: local.height,
  });
  try {
    await page.getByTestId('shot-screen').click();
    // With several displays the user picks one in an overlay; with one the screen is taken at once.
    let overlay: Page | undefined;
    if (displayCount > 1)
      await expect
        .poll(
          async () => {
            for (const candidate of app.windows().filter((w) => w.url().includes('#/overlay'))) {
              const root = candidate.locator('[data-testid="overlay-pick"]');
              if (
                (await root.count()) &&
                (await root.getAttribute('data-display-id')) === display.id &&
                (await root.getAttribute('data-ready')) === 'true'
              ) {
                overlay = candidate;
                return true;
              }
            }
            return false;
          },
          { timeout: 30_000 },
        )
        .toBe(true);
    if (overlay) {
      await overlay.mouse.move(900, 500);
      await overlay.mouse.click(900, 500);
    }
    await expect(page.getByTestId('editor-dimensions')).toHaveText(
      `${display.physicalSize.width} × ${display.physicalSize.height}`,
      { timeout: 30_000 },
    );
    const target = path.join(outDir, 'screen.png');
    await stubSaveDialog(target);
    await page.getByTestId('editor-save').click();
    await expect.poll(() => fs.existsSync(target), { timeout: 15_000 }).toBe(true);
    keep(target);
    const size = pngSize(target);
    expect(size).toEqual(display.physicalSize);
    const scale = display.physicalSize.width / display.bounds.width;
    const inner: Region = {
      x: Math.round((local.x + 20) * scale),
      y: Math.round((local.y + 20) * scale),
      width: Math.round((local.width - 40) * scale),
      height: Math.round((local.height - 40) * scale),
    };
    const fraction = await magentaFraction(target, inner);
    if (assertPixels) {
      expect(fraction, 'the magenta window is in the screenshot').toBeGreaterThan(0.95);
    }
    evidence.screenshot = { png: size, expected: display.physicalSize, magentaFraction: fraction };
    // Leave the editor.
    await page.getByTestId('editor-done').click();
    const confirm = page.getByTestId('confirm-yes');
    if (await confirm.isVisible().catch(() => false)) await confirm.click();
    await expect(page.getByTestId('editor-view')).toHaveCount(0);
  } finally {
    await closeWindow(id);
  }
});

let recorded = '';
let recordedSha = '';

test('real 4 s screen recording, no audio: VP9 WebM at the 1080p fit, clean decode', async () => {
  const local: Region = { x: 200, y: 150, width: 400, height: 300 };
  const id = await openMagentaWindow({
    x: display.bounds.x + local.x,
    y: display.bounds.y + local.y,
    width: local.width,
    height: local.height,
  });
  try {
    const started = await page.evaluate(
      (displayId) =>
        window.framecapt.invoke('recorder:start', {
          target: 'screen',
          displayId,
          // system audio is asked for on purpose: Linux must drop it up front, not fail
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
    await page.waitForTimeout(Math.max(0, 4000 - (Date.now() - startedAt)));
    await page.evaluate(() => window.framecapt.invoke('recorder:stop'));
    await expect(page.getByTestId('recording-result')).toBeVisible({ timeout: 60_000 });
    const result = (await snapshot()).result;
    if (!result) throw new Error('no result');
    recorded = result.path;
    keep(recorded);
    recordedSha = sha256(recorded);
    expect(recorded.endsWith('.webm')).toBe(true);

    const info = probe(recorded);
    const video = info.streams.find((s) => s.codec_type === 'video');
    const fit = expectedFit(display.physicalSize.width, display.physicalSize.height);
    expect({ w: video?.width, h: video?.height }).toEqual({ w: fit.width, h: fit.height });
    expect(video?.codec_name).toBe('vp9');
    expect(info.format.format_name).toContain('webm');
    expect(
      info.streams.some((s) => s.codec_type === 'audio'),
      'no (silent) audio track',
    ).toBe(false);
    const duration = Number(info.format.duration);
    expect(duration).toBeGreaterThan(3.2);
    expect(duration).toBeLessThan(5.5);
    const decode = decodesClean(recorded);
    expect(decode.ok, decode.stderr).toBe(true);

    // A frame 2 s in: the magenta window is there, scaled by the 1080p fit.
    const frame = path.join(outDir, 'frame.png');
    const extract = run(FFMPEG, [
      '-v',
      'error',
      '-y',
      '-ss',
      '2',
      '-i',
      recorded,
      '-frames:v',
      '1',
      frame,
    ]);
    expect(extract.status).toBe(0);
    keep(frame);
    const k = fit.width / display.bounds.width;
    const inner: Region = {
      x: Math.round((local.x + 30) * k),
      y: Math.round((local.y + 30) * k),
      width: Math.round((local.width - 60) * k),
      height: Math.round((local.height - 60) * k),
    };
    const fraction = await magentaFraction(frame, inner);
    if (assertPixels) {
      expect(fraction, 'the magenta window is in the recorded frame').toBeGreaterThan(0.9);
    }
    evidence.recording = {
      codec: video?.codec_name,
      size: { width: video?.width, height: video?.height },
      expected: fit,
      durationSec: duration,
      container: info.format.format_name,
      audioStreams: 0,
      decodeClean: decode.ok,
      magentaFractionAtTwoSeconds: fraction,
    };
  } finally {
    await closeWindow(id);
  }
});

test('MP4 export of that recording: H.264 + yuv420p, clean decode, original untouched', async () => {
  expect(recorded).not.toBe('');
  const dest = path.join(outDir, 'Linux export.mp4');
  await stubSaveDialog(dest);
  await page.getByTestId('mp4-export').click();
  await expect(page.getByTestId('mp4-done')).toBeVisible({ timeout: 120_000 });
  expect(fs.existsSync(dest)).toBe(true);
  expect(fs.readdirSync(outDir).filter((name) => name.includes('.partial'))).toEqual([]);
  const info = probe(dest);
  const video = info.streams.find((s) => s.codec_type === 'video');
  expect(video?.codec_name).toBe('h264');
  expect(video?.pix_fmt).toBe('yuv420p');
  expect(info.format.format_name).toContain('mp4');
  expect(info.streams.some((s) => s.codec_type === 'audio')).toBe(false);
  const decode = decodesClean(dest);
  expect(decode.ok, decode.stderr).toBe(true);
  expect(sha256(recorded), 'the original WebM is byte-identical').toBe(recordedSha);
  evidence.mp4Export = {
    codec: video?.codec_name,
    pixFmt: video?.pix_fmt,
    durationSec: Number(info.format.duration),
    decodeClean: decode.ok,
    originalUnchanged: true,
  };
});
