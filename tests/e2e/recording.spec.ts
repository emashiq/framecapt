/**
 * Recording workflow end to end, against the E2E build: the mock capture provider supplies the
 * sources and the recorder window draws a synthetic "display" (a moving canvas), so the real
 * pipeline runs (crop/scale canvas, MediaRecorder, chunk upload to main, session files, publish,
 * the framecapt-media protocol and a <video> element) without touching a screen. Real capture and
 * real audio are covered by tests/native.
 *
 * Mock displays: A (id 1001) 2560 x 1440 scale 1; B (id 1002) 3440 x 1440 frame, scale 1.5. The
 * single-display launch uses FRAMECAPT_E2E_MOCK_DISPLAYS=1 (only A).
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
import { hasCues, probeFile } from './media-fixtures';
import { evidenceDirFor } from '../native/evidence';

const projectRoot = path.resolve(__dirname, '..', '..');
const evidenceDir = evidenceDirFor(projectRoot, 'phase05');

interface Launched {
  app: ElectronApplication;
  page: Page;
  dir: string;
}

async function launch(env: Record<string, string> = {}, args: string[] = []): Promise<Launched> {
  expect(
    fs.existsSync(path.join(projectRoot, '.vite', 'build', 'main.cjs')),
    'Run `npm run package:e2e` first (npm run test:e2e does this).',
  ).toBe(true);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'framecapt-e2e-rec-'));
  const app = await electron.launch({
    args: ['.', ...args],
    cwd: projectRoot,
    env: {
      ...process.env,
      FRAMECAPT_USER_DATA_DIR: dir,
      FRAMECAPT_E2E_MOCK_CAPTURE: '1',
      ...env,
    },
  });
  const page = await app.firstWindow();
  await page.waitForLoadState('domcontentloaded');
  await expect(page.getByTestId('record-screen')).toBeVisible();
  return { app, page, dir };
}

// --- helpers (bound to the current launch) ---------------------------------------------------

let app: ElectronApplication;
let page: Page;
let userDataDir: string;

const recordingsDir = (): string => path.join(userDataDir, 'recordings');
const videosDir = (): string => path.join(userDataDir, 'videos', 'FrameCapt');
/** Live session directories (uuid names); `completed/` holds the small records of finished ones. */
const sessionDirs = (): string[] =>
  fs.existsSync(recordingsDir())
    ? fs.readdirSync(recordingsDir()).filter((name) => name !== 'completed')
    : [];
const outputFiles = (): string[] =>
  fs.existsSync(videosDir()) ? fs.readdirSync(videosDir()).filter((f) => f.endsWith('.webm')) : [];

function pagesOf(hash: string): Page[] {
  return app.windows().filter((candidate) => candidate.url().includes(hash));
}

async function toolbarPage(): Promise<Page> {
  let found: Page | undefined;
  await expect
    .poll(
      () => {
        found = pagesOf('#/toolbar')[0];
        return found !== undefined;
      },
      { timeout: 20_000 },
    )
    .toBe(true);
  const toolbar = found as Page;
  await expect(toolbar.getByTestId('toolbar')).toBeVisible();
  // The toolbar window exists (hidden) from preflight on; it is shown once recording runs.
  await expect.poll(async () => (await state()).status, { timeout: 20_000 }).toBe('recording');
  const win = await app.browserWindow(toolbar);
  await expect.poll(() => win.evaluate((w) => w.isVisible())).toBe(true);
  return toolbar;
}

async function overlayFor(displayId: string, testId: string): Promise<Page> {
  let found: Page | undefined;
  await expect
    .poll(
      async () => {
        for (const candidate of pagesOf('#/overlay')) {
          const root = candidate.locator(`[data-testid="${testId}"]`);
          if (
            (await root.count()) &&
            (await root.getAttribute('data-display-id')) === displayId &&
            (await root.getAttribute('data-ready')) === 'true'
          ) {
            found = candidate;
            return true;
          }
        }
        return false;
      },
      { timeout: 20_000 },
    )
    .toBe(true);
  return found as Page;
}

async function pressClosing(overlay: Page, key: string): Promise<void> {
  await overlay.keyboard.press(key).catch((error: unknown) => {
    if (!/closed/i.test(String(error))) throw error;
  });
}

async function drag(overlay: Page, from: [number, number], to: [number, number]): Promise<void> {
  await overlay.mouse.move(from[0], from[1]);
  await overlay.mouse.down();
  await overlay.mouse.move(to[0], to[1], { steps: 6 });
  await overlay.mouse.up();
}

async function state() {
  const result = await page.evaluate(() => window.framecapt.invoke('recorder:getState'));
  if (!result.ok) throw new Error('recorder:getState failed');
  return result.data;
}

async function waitForStatus(status: string, timeout = 20_000): Promise<void> {
  await expect.poll(async () => (await state()).status, { timeout }).toBe(status);
}

async function mainIsMinimized(): Promise<boolean> {
  const win = await app.browserWindow(page);
  return win.evaluate((w) => w.isMinimized());
}

/** Turns the countdown off in the UI (it is on by default) and waits for the setting to stick. */
async function setCountdown(on: boolean): Promise<void> {
  const toggle = page.getByTestId('opt-countdown');
  if ((await toggle.getAttribute('aria-checked')) !== String(on)) await toggle.click();
  await expect(toggle).toHaveAttribute('aria-checked', String(on));
}

async function startScreen(): Promise<void> {
  await page.getByTestId('record-screen').click();
}

async function recorderResources() {
  const recorder = pagesOf('#/recorder')[0];
  if (!recorder) throw new Error('no recorder window');
  return recorder.evaluate(() =>
    (
      window as unknown as {
        __frameCaptResources: () => {
          liveTracks: number;
          openAudioContexts: number;
          activeLoops: number;
          loopNames: string[];
          activeRecorders: number;
        };
      }
    ).__frameCaptResources(),
  );
}

/** Everything the recorder opened is released: tracks, audio contexts, timers, the recorder. */
async function expectResourcesReleased(): Promise<void> {
  await expect
    .poll(recorderResources, { timeout: 10_000 })
    .toMatchObject({ liveTracks: 0, openAudioContexts: 0, activeLoops: 0, activeRecorders: 0 });
}

async function finishAndWaitForResult(): Promise<void> {
  await expect(page.getByTestId('recording-result')).toBeVisible({ timeout: 30_000 });
}

async function resetToHome(): Promise<void> {
  await page.getByTestId('result-new').click();
  await expect(page.getByTestId('record-screen')).toBeVisible();
  await waitForStatus('idle');
}

/** FRAMECAPT_DEBUG_LOG=1 prints the main log of the current launch (for diagnosing a failure). */
function printDebugLog(): void {
  if (!process.env.FRAMECAPT_DEBUG_LOG || !userDataDir) return;
  const file = path.join(userDataDir, 'logs', 'main.log');
  if (fs.existsSync(file)) console.log(fs.readFileSync(file, 'utf8'));
}

test.describe.configure({ mode: 'serial' });

// --- single display ---------------------------------------------------------------------------

test.describe('one display', () => {
  test.beforeAll(async () => {
    fs.mkdirSync(evidenceDir, { recursive: true });
    ({ app, page, dir: userDataDir } = await launch({ FRAMECAPT_E2E_MOCK_DISPLAYS: '1' }));
  });
  test.afterAll(async () => {
    printDebugLog();
    if (app) await exitApp(app);
    if (userDataDir) fs.rmSync(userDataDir, { recursive: true, force: true });
  });

  test('Record is enabled, the options row is there and its values persist', async () => {
    const record = page.getByTestId('mode-record');
    for (const name of ['Screen', 'Window', 'Region']) {
      await expect(record.getByRole('button', { name })).toBeEnabled();
    }
    const options = page.getByTestId('record-options');
    await expect(options).toBeVisible();
    await expect(
      page.getByTestId('opt-quality').getByRole('radio', { name: '1080p' }),
    ).toHaveAttribute('aria-checked', 'true');
    await expect(page.getByTestId('opt-fps').getByRole('radio', { name: '30' })).toHaveAttribute(
      'aria-checked',
      'true',
    );
    await expect(page.getByTestId('opt-countdown')).toHaveAttribute('aria-checked', 'true');
    await expect(page.getByTestId('opt-system')).toHaveAttribute('aria-checked', 'false');

    await page.getByTestId('opt-quality').getByRole('radio', { name: 'Source' }).click();
    await page.getByTestId('opt-fps').getByRole('radio', { name: '60' }).click();
    await page.getByTestId('opt-countdown').click();
    await page.reload();
    await expect(page.getByTestId('record-options')).toBeVisible();
    await expect(
      page.getByTestId('opt-quality').getByRole('radio', { name: 'Source' }),
    ).toHaveAttribute('aria-checked', 'true');
    await expect(page.getByTestId('opt-fps').getByRole('radio', { name: '60' })).toHaveAttribute(
      'aria-checked',
      'true',
    );
    await expect(page.getByTestId('opt-countdown')).toHaveAttribute('aria-checked', 'false');

    // Back to the defaults for the other tests (countdown stays off to keep them fast).
    await page.getByTestId('opt-quality').getByRole('radio', { name: '1080p' }).click();
    await page.getByTestId('opt-fps').getByRole('radio', { name: '30' }).click();
  });

  test('screen recording: toolbar, pause and resume, stop, result view with a playable file', async () => {
    await startScreen();
    await expect(page.getByTestId('flow-status')).not.toBeEmpty();

    const toolbar = await toolbarPage();
    await expect(toolbar.getByTestId('toolbar')).toHaveAttribute('data-status', 'recording');
    expect(await mainIsMinimized()).toBe(true);
    expect(sessionDirs()).toHaveLength(1);

    // The timer runs while recording.
    const timer = toolbar.getByTestId('toolbar-timer');
    await expect(timer).not.toHaveText('00:00', { timeout: 5000 });

    // Pause: amber state, "Paused", timer frozen.
    await toolbar.getByTestId('toolbar-pause').click();
    await expect(toolbar.getByTestId('toolbar')).toHaveAttribute('data-status', 'paused');
    await expect(toolbar.getByTestId('toolbar-paused-label')).toHaveText('Paused');
    await expect(toolbar.getByTestId('toolbar-resume')).toBeVisible();
    const frozen = await timer.textContent();
    await toolbar.waitForTimeout(1500);
    expect(await timer.textContent()).toBe(frozen);
    expect((await state()).status).toBe('paused');

    await toolbar.getByTestId('toolbar-resume').click();
    await expect(toolbar.getByTestId('toolbar')).toHaveAttribute('data-status', 'recording');
    await toolbar.waitForTimeout(1500);

    await toolbar.getByTestId('toolbar-stop').click();
    await finishAndWaitForResult();

    // The toolbar is gone, the main window is back, the state is completed.
    await expect.poll(() => pagesOf('#/toolbar').length).toBe(0);
    expect(await mainIsMinimized()).toBe(false);
    const done = await state();
    expect(done.status).toBe('completed');
    expect(done.result).not.toBeNull();
    // Mock display A is 2560 x 1440: the 1080p preset fits it to 1920 x 1080.
    await expect(page.getByTestId('badge-dimensions')).toHaveText('1920 × 1080');
    await expect(page.getByTestId('badge-audio')).toHaveText('No audio');
    const durationMs = done.result?.durationMs ?? 0;
    // About 1.5 s + 1.5 s of active recording (the 1.5 s pause is not counted).
    expect(durationMs).toBeGreaterThan(2000);
    expect(durationMs).toBeLessThan(6000);

    // The file exists in Videos/FrameCapt and its manifest says completed.
    expect(outputFiles()).toHaveLength(1);
    const file = path.join(videosDir(), outputFiles()[0] ?? '');
    expect(fs.statSync(file).size).toBe(done.result?.bytes);
    expect(file).toBe(done.result?.path);
    // The session directory (and its stream.webm) is gone after a successful finalize: no
    // duplicate copy. A small completion record stays for history linking.
    expect(sessionDirs()).toHaveLength(0);
    const record = JSON.parse(
      fs.readFileSync(path.join(recordingsDir(), 'completed', `${done.sessionId}.json`), 'utf8'),
    ) as Record<string, unknown>;
    expect(record).toMatchObject({
      outputPath: file,
      width: 1920,
      height: 1080,
      recovered: false,
      unindexed: false,
    });
    expect(record.bytes).toBe(done.result?.bytes);
    // ffmpeg remuxed it: the container now has a duration and a seek index (the probe is the
    // verification tool, the same vendored binary the app used).
    const probed = probeFile(file);
    expect(Number(probed.format?.duration)).toBeGreaterThan(2);
    expect(hasCues(file)).toBe(true);
    expect(done.result?.durationMs).toBe(Math.round(Number(probed.format?.duration) * 1000));
    expect(fs.readdirSync(videosDir()).filter((name) => name.includes('.partial'))).toEqual([]);

    // The player loads it through framecapt-media: and can seek (Range requests work).
    const video = page.getByTestId('result-video');
    await expect
      .poll(() => video.evaluate((v: HTMLVideoElement) => v.readyState), { timeout: 15_000 })
      .toBeGreaterThanOrEqual(1);
    expect(await video.evaluate((v: HTMLVideoElement) => v.videoWidth)).toBe(1920);
    expect(await video.evaluate((v: HTMLVideoElement) => v.error === null)).toBe(true);
    // The duration header is missing in MediaRecorder WebM; the view finds the real duration.
    await expect
      .poll(
        () => video.evaluate((v: HTMLVideoElement) => Number.isFinite(v.duration) && !v.seeking),
        {
          timeout: 15_000,
        },
      )
      .toBe(true);
    const seeked = await video.evaluate(
      (v: HTMLVideoElement) =>
        new Promise<number>((resolve) => {
          v.addEventListener('seeked', () => resolve(v.currentTime), { once: true });
          v.currentTime = 1;
        }),
    );
    expect(seeked).toBeGreaterThan(0.9);
    expect(await video.evaluate((v: HTMLVideoElement) => v.duration)).toBeGreaterThan(2);

    await expectResourcesReleased();
    await resetToHome();
  });

  test('the media protocol serves only files FrameCapt produced, with ranges', async () => {
    await startScreen();
    const toolbar = await toolbarPage();
    await toolbar.waitForTimeout(1500);
    await toolbar.getByTestId('toolbar-stop').click();
    await finishAndWaitForResult();
    const result = (await state()).result;
    expect(result).not.toBeNull();
    const id = result?.id ?? '';

    const probe = await app.evaluate(async ({ net }, mediaId) => {
      const read = async (url: string, range?: string) => {
        const response = await net.fetch(url, range ? { headers: { Range: range } } : {});
        const body = new Uint8Array(await response.arrayBuffer());
        return {
          status: response.status,
          length: body.byteLength,
          contentRange: response.headers.get('content-range'),
          type: response.headers.get('content-type'),
          acceptRanges: response.headers.get('accept-ranges'),
          first: [...body.slice(0, 4)],
        };
      };
      return {
        whole: await read(`framecapt-media://${mediaId}`),
        part: await read(`framecapt-media://${mediaId}`, 'bytes=0-99'),
        tail: await read(`framecapt-media://${mediaId}`, 'bytes=-50'),
        beyond: await read(`framecapt-media://${mediaId}`, 'bytes=999999999-'),
        unknown: await read('framecapt-media://00000000-0000-4000-8000-000000000000'),
      };
    }, id);
    const bytes = result?.bytes ?? 0;
    expect(probe.whole).toMatchObject({
      status: 200,
      length: bytes,
      type: 'video/webm',
      acceptRanges: 'bytes',
    });
    // A WebM starts with the EBML magic 1A 45 DF A3.
    expect(probe.whole.first).toEqual([0x1a, 0x45, 0xdf, 0xa3]);
    expect(probe.part).toMatchObject({
      status: 206,
      length: 100,
      contentRange: `bytes 0-99/${bytes}`,
    });
    expect(probe.tail).toMatchObject({
      status: 206,
      length: 50,
      contentRange: `bytes ${bytes - 50}-${bytes - 1}/${bytes}`,
    });
    expect(probe.beyond.status).toBe(416);
    expect(probe.unknown.status).toBe(404);
    await resetToHome();
  });

  test('duplicate stop from the toolbar and the main window is harmless', async () => {
    const filesBefore = outputFiles().length;
    await startScreen();
    const toolbar = await toolbarPage();
    await toolbar.waitForTimeout(1200);
    await Promise.all([
      toolbar.evaluate(() => window.framecapt.invoke('recorder:stop')),
      page.evaluate(() => window.framecapt.invoke('recorder:stop')),
      toolbar.evaluate(() => window.framecapt.invoke('recorder:stop')),
      page.evaluate(() => window.framecapt.invoke('recorder:stop')),
    ]);
    await finishAndWaitForResult();
    // A late stop after completion changes nothing.
    await page.evaluate(() => window.framecapt.invoke('recorder:stop'));
    expect((await state()).status).toBe('completed');
    expect(outputFiles()).toHaveLength(filesBefore + 1);
    await expectResourcesReleased();
    await resetToHome();
  });

  test('pause and resume commands in the wrong state are ignored', async () => {
    await startScreen();
    const toolbar = await toolbarPage();
    await page.evaluate(() => window.framecapt.invoke('recorder:resume')); // not paused
    expect((await state()).status).toBe('recording');
    await page.evaluate(() => window.framecapt.invoke('recorder:pause'));
    await page.evaluate(() => window.framecapt.invoke('recorder:pause')); // already paused
    await expect(toolbar.getByTestId('toolbar')).toHaveAttribute('data-status', 'paused');
    // A new recording or a screenshot cannot start now.
    const again = await page.evaluate(() =>
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
    expect(again).toMatchObject({ ok: false, error: { code: 'BUSY' } });
    const shot = await page.evaluate(() =>
      window.framecapt.invoke('capture:startScreenshot', { target: 'region' }),
    );
    expect(shot).toMatchObject({ ok: false, error: { code: 'BUSY' } });
    await toolbar.getByTestId('toolbar-resume').click();
    await toolbar.getByTestId('toolbar-stop').click();
    await finishAndWaitForResult();
    await resetToHome();
  });

  test('closing the main window while recording only minimizes it; the recording goes on', async () => {
    await startScreen();
    const toolbar = await toolbarPage();
    const win = await app.browserWindow(page);
    await win.evaluate((w) => w.close());
    expect((await state()).status).toBe('recording');
    expect(await win.evaluate((w) => w.isDestroyed())).toBe(false);
    await toolbar.waitForTimeout(800);
    await toolbar.getByTestId('toolbar-stop').click();
    await finishAndWaitForResult();
    await resetToHome();
  });

  test('closing the toolbar window stops the recording once', async () => {
    const filesBefore = outputFiles().length;
    await startScreen();
    const toolbar = await toolbarPage();
    await toolbar.waitForTimeout(1000);
    await app.evaluate(({ BrowserWindow }) => {
      BrowserWindow.getAllWindows()
        .find((w) => w.webContents.getURL().includes('#/toolbar'))
        ?.close();
    });
    await finishAndWaitForResult();
    expect(outputFiles()).toHaveLength(filesBefore + 1);
    await resetToHome();
  });

  test('source loss ends the recording gracefully and says so', async () => {
    await startScreen();
    const toolbar = await toolbarPage();
    await toolbar.waitForTimeout(1200);
    await expect(pagesOf('#/recorder')).toHaveLength(1);
    await pagesOf('#/recorder')[0]?.evaluate(() =>
      window.framecapt.invoke('recorder:engineEvent', { type: 'sourceLost' }),
    );
    await finishAndWaitForResult();
    const done = await state();
    expect(done.status).toBe('completed');
    expect(done.stopReason).toBe('source-lost');
    await expect(page.getByTestId('result-notice')).toContainText('went away');
    await resetToHome();
  });

  test('a write failure reported while recording stops it and the result says it stopped early', async () => {
    await startScreen();
    const toolbar = await toolbarPage();
    await toolbar.waitForTimeout(1200);
    await pagesOf('#/recorder')[0]?.evaluate(() =>
      window.framecapt.invoke('recorder:engineEvent', {
        type: 'error',
        code: 'DISK_FULL',
        message: 'The disk is full. The recording was stopped.',
      }),
    );
    await finishAndWaitForResult();
    const done = await state();
    expect(done.stopReason).toBe('write-failed');
    expect(done.error?.code).toBe('DISK_FULL');
    await expect(page.getByTestId('result-notice')).toContainText('The disk is full');
    await resetToHome();
  });

  test('cancel during the countdown leaves idle, no session directory and no windows', async () => {
    await setCountdown(true);
    const sessionsBefore = sessionDirs().length;
    const filesBefore = outputFiles().length;
    await startScreen();
    const countdown = await (async () => {
      let found: Page | undefined;
      await expect
        .poll(() => (found = pagesOf('#/countdown')[0]) !== undefined, { timeout: 15_000 })
        .toBe(true);
      return found as Page;
    })();
    await expect(countdown.getByTestId('countdown-number')).toBeVisible();
    await expect(countdown.getByText('Esc to cancel')).toBeVisible();
    // Esc cancels through a global shortcut (this window never takes focus).
    expect(await app.evaluate(({ globalShortcut }) => globalShortcut.isRegistered('Escape'))).toBe(
      true,
    );
    expect((await state()).status).toBe('countdown');
    expect(await mainIsMinimized()).toBe(true);

    await page.evaluate(() => window.framecapt.invoke('recorder:cancel'));
    await waitForStatus('idle');
    await expect.poll(() => pagesOf('#/countdown').length).toBe(0);
    expect(await app.evaluate(({ globalShortcut }) => globalShortcut.isRegistered('Escape'))).toBe(
      false,
    );
    expect(pagesOf('#/toolbar')).toHaveLength(0);
    expect(await mainIsMinimized()).toBe(false);
    expect(sessionDirs()).toHaveLength(sessionsBefore);
    expect(outputFiles()).toHaveLength(filesBefore);
    await expect(page.getByTestId('record-screen')).toBeEnabled();
    await expectResourcesReleased();
    await setCountdown(false);
  });

  test('the countdown runs 3-2-1 and then recording starts (countdown window is gone first)', async () => {
    await setCountdown(true);
    await startScreen();
    await expect.poll(() => pagesOf('#/countdown').length, { timeout: 15_000 }).toBe(1);
    const seen = new Set<string>();
    const countdown = pagesOf('#/countdown')[0] as Page;
    const deadline = Date.now() + 8000;
    while (Date.now() < deadline && pagesOf('#/countdown').length > 0) {
      const text = await countdown
        .getByTestId('countdown-number')
        .textContent({ timeout: 300 })
        .catch(() => null);
      if (text) seen.add(text);
      await page.waitForTimeout(150);
    }
    expect([...seen].sort()).toEqual(['1', '2', '3']);
    const toolbar = await toolbarPage();
    expect(pagesOf('#/countdown')).toHaveLength(0);
    await toolbar.getByTestId('toolbar-stop').click();
    await finishAndWaitForResult();
    await resetToHome();
    await setCountdown(false);
  });

  test('rapid start and stop never leaves anything running', async () => {
    // Stop requested right after start: a cancel during start-up.
    await startScreen();
    await page.evaluate(() => window.framecapt.invoke('recorder:stop'));
    await page.evaluate(() => window.framecapt.invoke('recorder:stop'));
    await expect
      .poll(async () => ['idle', 'completed', 'error'].includes((await state()).status))
      .toBe(true);
    // Then start again and stop as soon as the toolbar shows.
    if ((await state()).status !== 'idle')
      await page.evaluate(() => window.framecapt.invoke('recorder:reset'));
    await waitForStatus('idle');
    await startScreen();
    const toolbar = await toolbarPage();
    await toolbar.getByTestId('toolbar-stop').click();
    await expect
      .poll(async () => ['completed', 'error'].includes((await state()).status), {
        timeout: 30_000,
      })
      .toBe(true);
    const done = await state();
    if (done.status === 'completed') await finishAndWaitForResult();
    expect(pagesOf('#/toolbar')).toHaveLength(0);
    await expectResourcesReleased();
    if (done.status === 'completed') await resetToHome();
    else await page.evaluate(() => window.framecapt.invoke('recorder:reset'));
    await waitForStatus('idle');
  });

  test('system audio that cannot be provided is a visible choice, never silence', async () => {
    await page.getByTestId('opt-system').click();
    await expect(page.getByTestId('opt-system')).toHaveAttribute('aria-checked', 'true');
    await startScreen();
    const dialog = page.getByTestId('choice-dialog');
    await expect(dialog).toBeVisible({ timeout: 20_000 });
    await expect(dialog).toHaveAttribute('data-choice', 'system-audio-unavailable');
    await expect(dialog).toContainText("System audio isn't available");
    expect(await mainIsMinimized()).toBe(false); // the main window comes back for the question
    expect(pagesOf('#/toolbar')).toHaveLength(0);

    // Cancel: back to idle, nothing created.
    const sessionsBefore = sessionDirs().length;
    await page.getByTestId('choice-cancel').click();
    await waitForStatus('idle');
    expect(sessionDirs()).toHaveLength(sessionsBefore);
    expect(pagesOf('#/toolbar')).toHaveLength(0);
    await expectResourcesReleased();

    // Record without system audio: it records and the result says "No audio".
    await startScreen();
    await expect(page.getByTestId('choice-dialog')).toBeVisible({ timeout: 20_000 });
    await page.getByTestId('choice-without').click();
    const toolbar = await toolbarPage();
    await expect(toolbar.getByTestId('meter-system')).toHaveCount(0); // no system audio in this recording
    await toolbar.waitForTimeout(1200);
    await toolbar.getByTestId('toolbar-stop').click();
    await finishAndWaitForResult();
    await expect(page.getByTestId('badge-audio')).toHaveText('No audio');
    await resetToHome();
    await page.getByTestId('opt-system').click();
    await expect(page.getByTestId('opt-system')).toHaveAttribute('aria-checked', 'false');
  });

  test('window recording: the picker, then the toolbar, then a result', async () => {
    await page.getByTestId('record-window').click();
    const picker = page.getByTestId('source-picker');
    await expect(picker).toBeVisible();
    await expect(picker).toContainText('records that window');
    await picker.getByTestId('window-search').fill('terminal');
    await picker.getByTestId('window-card').first().click();
    const toolbar = await toolbarPage();
    await toolbar.waitForTimeout(1200);
    await toolbar.getByTestId('toolbar-stop').click();
    await finishAndWaitForResult();
    // The mock window frame is 1280 x 720.
    await expect(page.getByTestId('badge-dimensions')).toHaveText('1280 × 720');
    await resetToHome();
  });
});

// --- microphone (Chromium's fake device) ------------------------------------------------------

test.describe('microphone with a fake device', () => {
  test.beforeAll(async () => {
    ({
      app,
      page,
      dir: userDataDir,
    } = await launch({ FRAMECAPT_E2E_MOCK_DISPLAYS: '1' }, [
      '--use-fake-device-for-media-stream',
      '--use-fake-ui-for-media-stream',
    ]));
  });
  test.afterAll(async () => {
    printDebugLog();
    if (app) await exitApp(app);
    if (userDataDir) fs.rmSync(userDataDir, { recursive: true, force: true });
  });

  test('mic on: levels move, mute is part of the state, a lost mic shows a badge and a toast', async () => {
    await expect(page.getByTestId('opt-mic')).toBeEnabled({ timeout: 10_000 });
    await page.getByTestId('opt-mic').click();
    await expect(page.getByTestId('opt-mic')).toHaveAttribute('aria-checked', 'true');
    await setCountdown(false);
    await startScreen();
    const toolbar = await toolbarPage();
    await expect(toolbar.getByTestId('mute-mic')).toBeVisible();
    expect((await state()).audio).toEqual({ mic: true, system: false });

    // The fake device beeps: the meter moves above its resting value at some point.
    await expect
      .poll(
        async () => Number(await toolbar.getByTestId('meter-mic').getAttribute('aria-valuenow')),
        { timeout: 15_000 },
      )
      .toBeGreaterThan(0);

    await toolbar.getByTestId('mute-mic').click();
    await expect(toolbar.getByTestId('mute-mic')).toHaveAttribute('aria-pressed', 'true');
    expect((await state()).muted.mic).toBe(true);
    await expect(toolbar.getByTestId('meter-mic')).toHaveAttribute('aria-valuetext', 'Muted');
    await toolbar.getByTestId('mute-mic').click();
    expect((await state()).muted.mic).toBe(false);

    // The engine reports the microphone gone: video goes on, the toolbar warns, main window toasts.
    await pagesOf('#/recorder')[0]?.evaluate(() =>
      window.framecapt.invoke('recorder:engineEvent', { type: 'trackEnded', source: 'mic' }),
    );
    await expect(toolbar.getByTestId('badge-lost-mic')).toHaveText('Microphone disconnected');
    expect((await state()).status).toBe('recording');
    expect((await state()).lost.mic).toBe(true);
    // Mute is no longer possible for a lost source.
    await page.evaluate(() => window.framecapt.invoke('recorder:toggleMute', { source: 'mic' }));
    expect((await state()).muted.mic).toBe(false);

    // A recording shorter than about a second may hold no data yet.
    await toolbar.waitForTimeout(1200);
    await toolbar.getByTestId('toolbar-stop').click();
    await finishAndWaitForResult();
    await expect(page.getByTestId('badge-audio')).toHaveText('With audio');
    await expectResourcesReleased();
    await resetToHome();
  });

  test('a microphone that is not there is a choice with "use default" and "without"', async () => {
    // Pick a device id that does not exist.
    await page.evaluate(() =>
      window.localStorage.setItem(
        'framecapt.recordOptions',
        JSON.stringify({
          mic: { enabled: true, deviceId: 'does-not-exist' },
          systemAudio: false,
          quality: '1080p',
          fps: 30,
          countdown: false,
        }),
      ),
    );
    await page.reload();
    await expect(page.getByTestId('record-screen')).toBeVisible();
    await startScreen();
    const dialog = page.getByTestId('choice-dialog');
    await expect(dialog).toBeVisible({ timeout: 20_000 });
    await expect(dialog).toHaveAttribute('data-choice', 'mic-missing');
    await expect(page.getByTestId('choice-default')).toBeVisible();
    await page.getByTestId('choice-default').click();
    const toolbar = await toolbarPage();
    expect((await state()).audio.mic).toBe(true);
    await toolbar.waitForTimeout(1000);
    await toolbar.getByTestId('toolbar-stop').click();
    await finishAndWaitForResult();
    await resetToHome();
  });
});

// --- two displays: region and pick-a-screen ----------------------------------------------------

test.describe('two displays', () => {
  test.beforeAll(async () => {
    ({ app, page, dir: userDataDir } = await launch());
    await setCountdown(false);
  });
  test.afterAll(async () => {
    printDebugLog();
    if (app) await exitApp(app);
    if (userDataDir) fs.rmSync(userDataDir, { recursive: true, force: true });
  });

  test('region: a live (not frozen) overlay with a Record button; it is gone before recording', async () => {
    await page.getByTestId('record-region').click();
    await expect(page.getByTestId('flow-status')).toContainText('Choose what to record');
    const a = await overlayFor('1001', 'overlay-region');
    await overlayFor('1002', 'overlay-region');
    await expect(a.getByTestId('overlay-region')).toHaveAttribute('data-live', 'true');
    await expect(a.getByTestId('frozen-frame')).toHaveCount(0); // live: no frozen screenshot
    await expect(a.getByTestId('overlay-hint')).toContainText('Enter to record');
    expect(await mainIsMinimized()).toBe(true);

    await drag(a, [200, 150], [840, 510]); // 640 x 360 DIP on display A (scale 1)
    await expect(a.getByTestId('size-label')).toHaveText('640 × 360');
    await expect(a.getByTestId('overlay-capture')).toContainText('Record');
    await a.screenshot({ path: path.join(evidenceDir, 'ui-region-overlay-live.png') });
    await pressClosing(a, 'Enter');

    const toolbar = await toolbarPage();
    // Closed before recording started: no overlay can be in the output.
    expect(pagesOf('#/overlay')).toHaveLength(0);
    expect((await state()).width).toBe(640);
    expect((await state()).height).toBe(360);
    await toolbar.waitForTimeout(1200);
    await toolbar.getByTestId('toolbar-stop').click();
    await finishAndWaitForResult();
    await expect(page.getByTestId('badge-dimensions')).toHaveText('640 × 360');
    await expectResourcesReleased();
    await resetToHome();
  });

  test('region selection can be cancelled with Esc: nothing is created', async () => {
    const sessionsBefore = sessionDirs().length;
    await page.getByTestId('record-region').click();
    const a = await overlayFor('1001', 'overlay-region');
    await pressClosing(a, 'Escape');
    await waitForStatus('idle');
    await expect.poll(() => pagesOf('#/overlay').length).toBe(0);
    expect(await mainIsMinimized()).toBe(false);
    expect(sessionDirs()).toHaveLength(sessionsBefore);
    await expect(page.getByTestId('record-region')).toBeEnabled();
  });

  test('screen with two displays: pick display B, it records at the 1080p preset (3440x1440 -> 1920x804)', async () => {
    await startScreen();
    const b = await overlayFor('1002', 'overlay-pick');
    await overlayFor('1001', 'overlay-pick');
    await b.mouse.click(400, 300);
    const toolbar = await toolbarPage();
    expect(pagesOf('#/overlay')).toHaveLength(0);
    await toolbar.waitForTimeout(1200);
    await toolbar.getByTestId('toolbar-stop').click();
    await finishAndWaitForResult();
    await expect(page.getByTestId('badge-dimensions')).toHaveText('1920 × 804');
    await resetToHome();
  });

  test('the Source preset keeps the full 3440 x 1440 of display B', async () => {
    await page.getByTestId('opt-quality').getByRole('radio', { name: 'Source' }).click();
    await startScreen();
    const b = await overlayFor('1002', 'overlay-pick');
    await b.mouse.click(400, 300);
    const toolbar = await toolbarPage();
    await toolbar.waitForTimeout(1200);
    await toolbar.getByTestId('toolbar-stop').click();
    await finishAndWaitForResult();
    await expect(page.getByTestId('badge-dimensions')).toHaveText('3440 × 1440');
    await resetToHome();
    await page.getByTestId('opt-quality').getByRole('radio', { name: '1080p' }).click();
  });
});

// --- quitting during a recording ----------------------------------------------------------------

test.describe('quit during a recording', () => {
  test('quitting finishes the recording first: remuxed, published, session removed, no partial', async () => {
    ({ app, page, dir: userDataDir } = await launch({ FRAMECAPT_E2E_MOCK_DISPLAYS: '1' }));
    try {
      await setCountdown(false);
      await startScreen();
      const toolbar = await toolbarPage();
      await toolbar.waitForTimeout(1500);
      const quitAt = Date.now();
      const closed = app.waitForEvent('close', { timeout: 60_000 });
      await app.evaluate(({ app: electronApp }) => electronApp.quit());
      await closed;
      const quitMs = Date.now() - quitAt;
      expect(outputFiles()).toHaveLength(1);
      const file = path.join(videosDir(), outputFiles()[0] ?? '');
      expect(Number(probeFile(file).format?.duration)).toBeGreaterThan(1);
      expect(hasCues(file)).toBe(true);
      // finalization finished within the 15 s cap: no session left, a completion record instead
      expect(sessionDirs()).toHaveLength(0);
      expect(fs.readdirSync(path.join(recordingsDir(), 'completed'))).toHaveLength(1);
      expect(fs.readdirSync(videosDir()).filter((name) => name.includes('.partial'))).toEqual([]);
      expect(quitMs).toBeLessThan(15_000);
      const log = fs.readFileSync(path.join(userDataDir, 'logs', 'main.log'), 'utf8');
      expect(log).toContain('Quit requested during a recording');
      expect(log).not.toContain('Finalizing took too long');
    } finally {
      if (userDataDir) fs.rmSync(userDataDir, { recursive: true, force: true });
    }
  });
});
