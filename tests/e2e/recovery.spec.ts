/**
 * Recovery, interrupted finalization and disk pressure, end to end against the E2E build (mock
 * capture; the recording pipeline, session service, REAL vendored ffmpeg and the UI are real).
 * Unfinished sessions are written into the userData directory before the app starts, exactly as an
 * earlier run would have left them. The forced-kill test with a real screen recording is in
 * tests/native/recovery.native.spec.ts.
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
import { decodesClean, generateLiveWebm, hasCues, probeFile } from './media-fixtures';

const projectRoot = path.resolve(__dirname, '..', '..');
const evidenceDir = path.join(projectRoot, 'docs', 'evidence', 'phase06');

const ID_TRUNCATED = '0f0e0d0c-0b0a-4908-8706-050403020100';
const ID_JUNK = '1f1e1d1c-1b1a-4918-8716-151413121110';
const ID_FINALIZING = '2f2e2d2c-2b2a-4928-8726-252423222120';
const ID_CORRUPT = '3f3e3d3c-3b3a-4938-8736-353433323130';

let live: Buffer;
let app: ElectronApplication;
let page: Page;
let userDataDir: string;

const recordingsDir = (): string => path.join(userDataDir, 'recordings');
const videosDir = (): string => path.join(userDataDir, 'videos', 'Framelet');
const outputFiles = (): string[] =>
  fs.existsSync(videosDir()) ? fs.readdirSync(videosDir()).filter((f) => f.endsWith('.webm')) : [];
const liveSessionDirs = (): string[] =>
  fs.existsSync(recordingsDir())
    ? fs.readdirSync(recordingsDir()).filter((name) => name !== 'completed')
    : [];

function manifestFor(id: string, patch: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    version: 1,
    sessionId: id,
    createdAt: Date.UTC(2026, 9, 2, 10, 0, 0),
    updatedAt: Date.UTC(2026, 9, 2, 10, 0, 5),
    state: 'recording',
    mime: 'video/webm;codecs=vp9,opus',
    source: { kind: 'screen', name: 'Screen 1' },
    options: {
      mic: { enabled: false },
      systemAudio: false,
      quality: '1080p',
      fps: 30,
      countdown: true,
    },
    width: 640,
    height: 360,
    chunksWritten: 12,
    bytesWritten: 0,
    lastSeq: 11,
    pausedIntervals: [],
    stats: {
      queueHighWaterChunks: 1,
      queueHighWaterBytes: 4096,
      mainQueueHighWater: 1,
      maxWriteMs: 3,
    },
    appVersion: '0.1.0',
    ...patch,
  };
}

function seedSession(
  dir: string,
  id: string,
  stream: Buffer,
  patch: Record<string, unknown> = {},
  manifestText?: string,
): void {
  const sessionDir = path.join(dir, 'recordings', id);
  fs.mkdirSync(sessionDir, { recursive: true });
  fs.writeFileSync(path.join(sessionDir, 'stream.webm'), stream);
  fs.writeFileSync(
    path.join(sessionDir, 'manifest.json'),
    manifestText ?? JSON.stringify(manifestFor(id, { bytesWritten: stream.length, ...patch })),
  );
}

async function launch(dir: string, env: Record<string, string> = {}): Promise<void> {
  expect(
    fs.existsSync(path.join(projectRoot, '.vite', 'build', 'main.cjs')),
    'Run `npm run package:e2e` first (npm run test:e2e does this).',
  ).toBe(true);
  userDataDir = dir;
  app = await electron.launch({
    args: ['.'],
    cwd: projectRoot,
    env: {
      ...process.env,
      FRAMELET_USER_DATA_DIR: dir,
      FRAMELET_E2E_MOCK_CAPTURE: '1',
      FRAMELET_E2E_MOCK_DISPLAYS: '1',
      ...env,
    },
  });
  page = await app.firstWindow();
  await page.waitForLoadState('domcontentloaded');
  await expect(page.getByTestId('record-screen')).toBeVisible();
}

const tempDir = (): string => fs.mkdtempSync(path.join(os.tmpdir(), 'framelet-e2e-recovery-'));

async function recorderState() {
  const result = await page.evaluate(() => window.framelet.invoke('recorder:getState'));
  if (!result.ok) throw new Error('recorder:getState failed');
  return result.data;
}

async function startScreen(): Promise<void> {
  const countdown = page.getByTestId('opt-countdown');
  if ((await countdown.getAttribute('aria-checked')) === 'true') await countdown.click();
  await page.getByTestId('record-screen').click();
}

async function toolbarPage(): Promise<Page> {
  let found: Page | undefined;
  await expect
    .poll(() => (found = app.windows().find((w) => w.url().includes('#/toolbar'))) !== undefined, {
      timeout: 20_000,
    })
    .toBe(true);
  await expect
    .poll(async () => (await recorderState()).status, { timeout: 20_000 })
    .toBe('recording');
  return found as Page;
}

async function shoot(name: string): Promise<void> {
  fs.mkdirSync(evidenceDir, { recursive: true });
  for (const scheme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme: scheme });
    await page.screenshot({ path: path.join(evidenceDir, `ui-${name}-${scheme}.png`) });
  }
  await page.emulateMedia({ colorScheme: null });
}

test.describe.configure({ mode: 'serial' });

test.beforeAll(() => {
  live = generateLiveWebm(5);
});

test.afterEach(async () => {
  if (app) await exitApp(app);
  if (userDataDir) fs.rmSync(userDataDir, { recursive: true, force: true, maxRetries: 5 });
});

test('unfinished recordings from an earlier run: banner, details, Recover, Discard', async () => {
  const dir = tempDir();
  // A: a stream cut off at 60% (the process died mid recording)
  seedSession(dir, ID_TRUNCATED, live.subarray(0, Math.floor(live.length * 0.6)), {
    createdAt: Date.UTC(2026, 8, 30, 10, 0, 0),
  });
  // B: data that is not a video at all
  seedSession(dir, ID_JUNK, Buffer.from('this is not a webm file '.repeat(100)), {
    createdAt: Date.UTC(2026, 9, 1, 11, 0, 0),
    state: 'failed',
    error: { code: 'WRITE_FAILED', message: 'x' },
  });
  // C: an interrupted finalization (kill during the remux): resumed automatically on start
  const partial = path.join(dir, 'videos', 'Framelet', `.framelet-${ID_FINALIZING}.partial.webm`);
  fs.mkdirSync(path.dirname(partial), { recursive: true });
  fs.writeFileSync(partial, 'half a remux from the dead process');
  fs.writeFileSync(path.join(dir, 'videos', 'Framelet', 'my own notes.webm'), 'a user file');
  seedSession(dir, ID_FINALIZING, live, {
    state: 'finalizing',
    createdAt: Date.UTC(2026, 9, 2, 9, 0, 0),
    finalize: {
      outputDir: path.join(dir, 'videos', 'Framelet'),
      fileName: 'Framelet 2026-10-02 at 09.00.05.webm',
      partialPath: partial,
      startedAt: 1,
    },
  });
  // D: a corrupt manifest with a perfectly fine stream
  seedSession(dir, ID_CORRUPT, live, {}, '{ "version": 1, "sessionId": ');

  await launch(dir);

  // C was finished without asking: its export exists, the partial file is gone, the user file stays.
  await expect
    .poll(() => outputFiles().includes('Framelet 2026-10-02 at 09.00.05.webm'), { timeout: 30_000 })
    .toBe(true);
  expect(fs.existsSync(partial)).toBe(false);
  expect(fs.readFileSync(path.join(videosDir(), 'my own notes.webm'), 'utf8')).toBe('a user file');
  expect(fs.existsSync(path.join(recordingsDir(), ID_FINALIZING))).toBe(false);
  const resumed = probeFile(path.join(videosDir(), 'Framelet 2026-10-02 at 09.00.05.webm'));
  expect(Number(resumed.format?.duration)).toBeGreaterThan(4.9);

  // The banner offers A, B and D (oldest first); not C.
  const banner = page.getByTestId('recovery-banner');
  await expect(banner).toBeVisible();
  const cards = banner.getByTestId('recovery-card');
  await expect(cards).toHaveCount(3);
  await expect(cards.nth(0)).toHaveAttribute('data-session-id', ID_TRUNCATED);
  await expect(cards.nth(1)).toHaveAttribute('data-session-id', ID_JUNK);
  await expect(cards.first()).toContainText('We found an unfinished recording from');
  await expect(banner.getByTestId('recovery-details').first()).not.toHaveAttribute('open', '');
  await banner.getByTestId('recovery-details').first().locator('summary').click();
  await expect(banner.getByTestId('recovery-details').first()).toContainText(
    'Interrupted while recording',
  );
  await expect(banner.getByTestId('recovery-details').first()).toContainText('Screen');
  await shoot('recovery-banner');

  // Recover A: a playable file of about 60% of the recording, honestly worded.
  await cards.nth(0).getByTestId('recovery-recover').click();
  const result = banner.getByTestId('recovery-result');
  await expect(result).toBeVisible({ timeout: 30_000 });
  await expect(result).toContainText('Recovered');
  await expect(result).toContainText('Recovered what could be saved');
  const recovered = outputFiles().find((name) => name.includes('(recovered)'));
  expect(recovered).toBeDefined();
  const recoveredFile = path.join(videosDir(), recovered ?? '');
  const duration = Number(probeFile(recoveredFile).format?.duration);
  expect(duration).toBeGreaterThanOrEqual(2.5);
  expect(duration).toBeLessThanOrEqual(3.2);
  expect(hasCues(recoveredFile)).toBe(true);
  const recoveredDecode = decodesClean(recoveredFile);
  expect(recoveredDecode.errors).toBe('');
  expect(recoveredDecode.clean && recoveredDecode.monotonic).toBe(true);
  expect(fs.existsSync(path.join(recordingsDir(), ID_TRUNCATED))).toBe(false);
  await shoot('recovery-done');
  await result.getByTestId('recovery-dismiss').click();

  // Recover B: not repairable. Said so, the raw data stays, Reveal is offered.
  const junkCard = banner.locator(`[data-session-id="${ID_JUNK}"]`);
  await junkCard.getByTestId('recovery-recover').click();
  await expect(junkCard.getByTestId('recovery-failed')).toContainText("couldn't be repaired", {
    timeout: 30_000,
  });
  await expect(junkCard.getByTestId('recovery-failed')).toContainText('raw data was kept');
  await expect(junkCard.getByTestId('recovery-reveal')).toBeVisible();
  expect(fs.existsSync(path.join(recordingsDir(), ID_JUNK, 'stream.webm'))).toBe(true);
  await shoot('recovery-failed');

  // Discard B: confirmation first; "Keep it" changes nothing, "Discard" deletes only that session.
  await junkCard.getByTestId('recovery-discard').click();
  const dialog = page.getByTestId('confirm-dialog');
  await expect(dialog).toContainText('Discard this unfinished recording?');
  await dialog.getByTestId('confirm-no').click();
  expect(fs.existsSync(path.join(recordingsDir(), ID_JUNK))).toBe(true);
  await junkCard.getByTestId('recovery-discard').click();
  await page.getByTestId('confirm-dialog').getByTestId('confirm-yes').click();
  await expect(junkCard).toHaveCount(0);
  expect(fs.existsSync(path.join(recordingsDir(), ID_JUNK))).toBe(false);
  expect(fs.existsSync(path.join(recordingsDir(), ID_CORRUPT))).toBe(true); // others untouched
  expect(fs.readFileSync(path.join(videosDir(), 'my own notes.webm'), 'utf8')).toBe('a user file');

  // D (unreadable manifest): recoverable; the stream was fine, so all 5 s come back.
  const corruptCard = banner.locator(`[data-session-id="${ID_CORRUPT}"]`);
  await expect(corruptCard.getByTestId('recovery-details')).toContainText('Unknown');
  await corruptCard.getByTestId('recovery-recover').click();
  await expect(banner.getByTestId('recovery-result')).toBeVisible({ timeout: 30_000 });
  expect(fs.existsSync(path.join(recordingsDir(), ID_CORRUPT))).toBe(false);
});

test('a manual banner never appears while recording, and Recover is refused during a capture', async () => {
  const dir = tempDir();
  seedSession(dir, ID_TRUNCATED, live.subarray(0, Math.floor(live.length * 0.6)));
  await launch(dir);
  await expect(page.getByTestId('recovery-banner')).toBeVisible();
  await startScreen();
  await toolbarPage();
  const refused = await page.evaluate(
    (id) => window.framelet.invoke('recovery:recover', { sessionId: id }),
    ID_TRUNCATED,
  );
  expect(refused).toMatchObject({ ok: false, error: { code: 'BUSY' } });
  const listed = await page.evaluate(() => window.framelet.invoke('recovery:list'));
  expect(listed).toMatchObject({ ok: true, data: { candidates: [] } });
  const discardRefused = await page.evaluate(
    (id) => window.framelet.invoke('recovery:discard', { sessionId: id }),
    ID_TRUNCATED,
  );
  expect(discardRefused).toMatchObject({ ok: false, error: { code: 'BUSY' } });
  expect(fs.existsSync(path.join(recordingsDir(), ID_TRUNCATED, 'stream.webm'))).toBe(true);
});

test('recovery IPC refuses ids that are not session uuids (no path ever comes from the renderer)', async () => {
  const dir = tempDir();
  seedSession(dir, ID_TRUNCATED, live);
  const sentinel = path.join(dir, 'sentinel.txt');
  fs.writeFileSync(sentinel, 'keep me');
  await launch(dir);
  for (const sessionId of ['../..', '..\\recordings', 'C:\\Windows', ID_TRUNCATED + '/..', '']) {
    const result = await page.evaluate(
      (id) => window.framelet.invoke('recovery:discard', { sessionId: id }),
      sessionId,
    );
    expect(result, sessionId).toMatchObject({ ok: false, error: { code: 'INVALID_PAYLOAD' } });
  }
  expect(fs.existsSync(sentinel)).toBe(true);
  expect(fs.existsSync(path.join(recordingsDir(), ID_TRUNCATED))).toBe(true);
  // a valid-looking id of a session that does not exist
  const unknown = await page.evaluate(() =>
    window.framelet.invoke('recovery:discard', {
      sessionId: '4f4e4d4c-4b4a-4948-8746-454443424140',
    }),
  );
  expect(unknown).toMatchObject({ ok: false, error: { code: 'NOT_FOUND' } });
});

test('quit while finalizing takes too long: the cap kills the remux, the session stays "finalizing", the next start finishes it', async () => {
  const dir = tempDir();
  await launch(dir, { FRAMELET_E2E_FFMPEG_DELAY_MS: '60000', FRAMELET_E2E_QUIT_CAP_MS: '1500' });
  await startScreen();
  const toolbar = await toolbarPage();
  await toolbar.waitForTimeout(1500);

  const quitAt = Date.now();
  const closed = app.waitForEvent('close', { timeout: 30_000 });
  await app.evaluate(({ app: electronApp }) => electronApp.quit());
  await closed;
  const quitMs = Date.now() - quitAt;
  expect(quitMs).toBeLessThan(10_000); // quit did not wait for the 60 s remux

  const log = fs.readFileSync(path.join(userDataDir, 'logs', 'main.log'), 'utf8');
  expect(log).toContain('Finalizing took too long');
  const [sessionId] = liveSessionDirs();
  expect(sessionId).toBeDefined();
  const manifest = JSON.parse(
    fs.readFileSync(path.join(recordingsDir(), sessionId ?? '', 'manifest.json'), 'utf8'),
  ) as { state: string; finalize?: { partialPath: string } };
  expect(manifest.state).toBe('finalizing');
  expect(
    fs.statSync(path.join(recordingsDir(), sessionId ?? '', 'stream.webm')).size,
  ).toBeGreaterThan(0);
  expect(outputFiles()).toHaveLength(0);

  // Next start (no delay): the interrupted finalization is re-run once, by itself.
  await launch(dir);
  await expect.poll(() => outputFiles().length, { timeout: 30_000 }).toBe(1);
  const file = path.join(videosDir(), outputFiles()[0] ?? '');
  expect(Number(probeFile(file).format?.duration)).toBeGreaterThan(1);
  expect(hasCues(file)).toBe(true);
  const decoded = decodesClean(file);
  expect(decoded.errors).toBe('');
  expect(decoded.clean && decoded.monotonic).toBe(true);
  await expect.poll(() => liveSessionDirs().length).toBe(0);
  expect(fs.readdirSync(videosDir()).filter((name) => name.includes('.partial'))).toEqual([]);
  await expect(page.getByTestId('recovery-banner')).toHaveCount(0);
});

test.describe('disk pressure', () => {
  const GB = 1024 ** 3;
  const MB = 1024 ** 2;

  test('under 1 GB free a recording does not start and says why', async () => {
    const dir = tempDir();
    const freeFile = path.join(dir, 'free-bytes.txt');
    fs.writeFileSync(freeFile, String(GB - 1));
    await launch(dir, { FRAMELET_E2E_FREE_BYTES_FILE: freeFile });
    await startScreen();
    await expect(
      page.getByText(
        'Your disk is almost full. Free up space or choose another folder in Settings',
      ),
    ).toBeVisible({ timeout: 10_000 });
    expect((await recorderState()).status).toBe('idle');
    expect(liveSessionDirs()).toHaveLength(0);
    // With exactly 1 GB it starts.
    fs.writeFileSync(freeFile, String(GB));
    await page.getByTestId('record-screen').click();
    await toolbarPage();
    const toolbar = app.windows().find((w) => w.url().includes('#/toolbar')) as Page;
    await toolbar.waitForTimeout(1500);
    await toolbar.getByTestId('toolbar-stop').click();
    await expect(page.getByTestId('recording-result')).toBeVisible({ timeout: 30_000 });
  });

  test('under 500 MB while recording the recording stops safely and what was recorded is finished', async () => {
    const dir = tempDir();
    const freeFile = path.join(dir, 'free-bytes.txt');
    fs.writeFileSync(freeFile, String(50 * GB));
    await launch(dir, { FRAMELET_E2E_FREE_BYTES_FILE: freeFile });
    await startScreen();
    const toolbar = await toolbarPage();
    await toolbar.waitForTimeout(2000);
    fs.writeFileSync(freeFile, String(400 * MB)); // below 500 MB, above the remux margin
    await expect(page.getByTestId('recording-result')).toBeVisible({ timeout: 30_000 });
    const done = await recorderState();
    expect(done.status).toBe('completed');
    expect(done.stopReason).toBe('write-failed');
    expect(done.error?.code).toBe('DISK_LOW');
    await expect(page.getByTestId('result-notice')).toContainText('almost full');
    expect(outputFiles()).toHaveLength(1);
    const file = path.join(videosDir(), outputFiles()[0] ?? '');
    expect(Number(probeFile(file).format?.duration)).toBeGreaterThan(1);
    expect(liveSessionDirs()).toHaveLength(0);
    await shoot('result-disk-low');
  });
});
