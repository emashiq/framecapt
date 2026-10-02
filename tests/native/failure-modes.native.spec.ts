/**
 * Native failure-mode exercise on the real host (production build, real capture, real ffmpeg):
 * the items of the acceptance checklist's "reliability" list that need a real machine.
 *
 *  1. Source closure: the window being recorded is closed mid-recording.
 *  2. Permission denial: the microphone is denied (the session's permission handlers are replaced
 *     from the test, no hook exists in the app); both answers of the visible choice are exercised.
 *  3. Rapid repeated commands: start, pause, resume, stop and cancel fired in bursts.
 *  4. Forced termination DURING FINALIZATION (ffmpeg is remuxing): the main process is killed
 *     (leaving ffmpeg orphaned, like a crash) and, in a second run, the whole tree is killed; the
 *     next start finishes the session and removes the leftover partial file.
 *  5. Write failure at finalization: the output folder stops accepting writes; the recorded data
 *     is kept, the error is visible, and Recover works once the folder is writable again.
 *
 * Disk-full on a real full volume is BLOCKED on this host (it needs an elevated shell to make a
 * small volume); it is covered by injected-filesystem unit tests and the E2E disk-pressure tests.
 * Evidence: docs/evidence/phase09/failure-modes-native.json (redacted).
 */
import { execFileSync, spawn, spawnSync, type ChildProcess } from 'node:child_process';
import crypto from 'node:crypto';
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
import { writeEvidenceJson, evidenceDirFor } from './evidence';

const projectRoot = path.resolve(__dirname, '..', '..');
const evidenceDir = evidenceDirFor(projectRoot, 'phase09');
const vendor = path.join(projectRoot, 'vendor', 'ffmpeg', 'win32-x64');
const FFMPEG = path.join(vendor, 'ffmpeg.exe');
const FFPROBE = path.join(vendor, 'ffprobe.exe');

let userDataDir = '';
let app: ElectronApplication | undefined;
let page: Page;
const evidence: Record<string, unknown> = {};
function record(name: string, value: unknown): void {
  evidence[name] = value;
  writeEvidenceJson(evidenceDir, 'failure-modes-native.json', evidence);
}

const videosDir = (): string => path.join(userDataDir, 'videos', 'Framelet');
const recordingsDir = (): string => path.join(userDataDir, 'recordings');

// --- helpers -----------------------------------------------------------------------------------

interface Probe {
  streams: { codec_type: string; codec_name: string; width?: number; height?: number }[];
  format: { duration?: string; size: string };
}
function ffprobe(file: string): Probe {
  return JSON.parse(
    execFileSync(FFPROBE, ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', file], {
      shell: false,
      encoding: 'utf8',
    }),
  ) as Probe;
}
function decodeAll(file: string): { status: number; stderr: string } {
  const run = spawnSync(
    FFMPEG,
    ['-v', 'error', '-i', file, '-fps_mode', 'vfr', '-f', 'null', '-'],
    {
      shell: false,
      encoding: 'utf8',
    },
  );
  return { status: run.status ?? -1, stderr: run.stderr.trim() };
}
function finishedFiles(): string[] {
  return fs.existsSync(videosDir())
    ? fs
        .readdirSync(videosDir())
        .filter((name) => name.endsWith('.webm') && !name.includes('.partial'))
    : [];
}
function partialFiles(): string[] {
  return fs.existsSync(videosDir())
    ? fs.readdirSync(videosDir()).filter((name) => name.includes('.partial'))
    : [];
}
function sessionDirs(): string[] {
  return fs.existsSync(recordingsDir())
    ? fs
        .readdirSync(recordingsDir())
        .filter(
          (name) =>
            /^[0-9a-f]{8}-/.test(name) &&
            fs.statSync(path.join(recordingsDir(), name)).isDirectory(),
        )
    : [];
}

/** Processes named `name` whose command line contains `needle` (only this test's own ffmpeg). */
function processesWith(name: string, needle: string): { pid: number }[] {
  const script = `Get-CimInstance Win32_Process -Filter "Name='${name}'" | Where-Object { $_.CommandLine -like '*${needle.replaceAll("'", "''")}*' } | ForEach-Object { $_.ProcessId }`;
  const out = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
    shell: false,
    encoding: 'utf8',
  }).stdout;
  return out
    .split(/\r?\n/)
    .map((line) => Number(line.trim()))
    .filter((pid) => pid > 0)
    .map((pid) => ({ pid }));
}
function killAll(name: string, needle: string): number {
  const found = processesWith(name, needle);
  for (const { pid } of found) {
    spawnSync('taskkill', ['/F', '/T', '/PID', String(pid)], { shell: false, stdio: 'ignore' });
  }
  return found.length;
}

async function launchApp(): Promise<void> {
  app = await electron.launch({
    args: ['.'],
    cwd: projectRoot,
    env: { ...process.env, FRAMELET_USER_DATA_DIR: userDataDir },
  });
  page = await app.firstWindow();
  await page.waitForLoadState('domcontentloaded');
  await expect(page.getByTestId('record-screen')).toBeVisible();
}
async function closeApp(): Promise<void> {
  if (app) await exitApp(app);
  app = undefined;
}
async function snapshot() {
  const result = await page.evaluate(() => window.framelet.invoke('recorder:getState'));
  if (!result.ok) throw new Error('recorder:getState failed');
  return result.data;
}
async function waitForStatus(status: string, timeout = 30_000): Promise<void> {
  await expect.poll(async () => (await snapshot()).status, { timeout }).toBe(status);
}
async function primaryDisplayId(): Promise<string> {
  const listed = await page.evaluate(() => window.framelet.invoke('capture:listDisplays'));
  if (!listed.ok) throw new Error('capture:listDisplays failed');
  const display = listed.data.find((d) => d.isPrimary) ?? listed.data[0];
  if (!display) throw new Error('no display');
  return display.id;
}
type StartOptions = { mic?: boolean; system?: boolean };
const recordOptions = (options: StartOptions = {}) => ({
  mic: { enabled: options.mic === true },
  systemAudio: options.system === true,
  quality: '1080p' as const,
  fps: 30 as const,
  countdown: false,
});
async function startScreen(options: StartOptions = {}) {
  const displayId = await primaryDisplayId();
  return page.evaluate((request) => window.framelet.invoke('recorder:start', request), {
    target: 'screen' as const,
    displayId,
    options: recordOptions(options),
  });
}
/** The recording UI windows that exist right now (the toolbar, countdown and selection overlays). */
async function recordingUiWindows(): Promise<string[]> {
  const urls = await (app as ElectronApplication).evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows().map((w) => w.webContents.getURL()),
  );
  return urls.filter(
    (url) => url.includes('#/toolbar') || url.includes('#/countdown') || url.includes('#/overlay'),
  );
}
async function windowCount(): Promise<number> {
  return (app as ElectronApplication).evaluate(
    ({ BrowserWindow }) => BrowserWindow.getAllWindows().length,
  );
}
async function recorderResources() {
  const recorder = (app as ElectronApplication)
    .windows()
    .find((w) => w.url().includes('#/recorder'));
  if (!recorder) return null;
  return recorder.evaluate(() =>
    (
      window as unknown as {
        __frameletResources: () => {
          liveTracks: number;
          openAudioContexts: number;
          activeLoops: number;
          activeRecorders: number;
        };
      }
    ).__frameletResources(),
  );
}
async function expectNothingLeaked(): Promise<Record<string, unknown>> {
  await expect
    .poll(async () => recorderResources(), { timeout: 15_000 })
    .toMatchObject({ liveTracks: 0, openAudioContexts: 0, activeLoops: 0, activeRecorders: 0 });
  return { ...(await recorderResources()) };
}

test.describe.configure({ mode: 'serial' });

test.beforeAll(() => {
  expect(
    fs.existsSync(path.join(projectRoot, '.vite', 'build', 'main.cjs')),
    'Run `npm run package` first (npm run test:native does this).',
  ).toBe(true);
  expect(fs.existsSync(FFMPEG), 'Run `npm run fetch:ffmpeg` first.').toBe(true);
  fs.mkdirSync(evidenceDir, { recursive: true });
});

test.beforeEach(() => {
  userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'framelet-native-fail-'));
});
test.afterEach(async () => {
  await closeApp();
  killAll('ffmpeg.exe', userDataDir); // an orphan from a test that killed the app
  // The write-failure test leaves a deny rule on the folder; make it deletable first.
  if (fs.existsSync(videosDir())) {
    spawnSync('icacls', [videosDir(), '/remove:d', '*S-1-1-0'], { shell: false, stdio: 'ignore' });
  }
  try {
    fs.rmSync(userDataDir, { recursive: true, force: true, maxRetries: 20, retryDelay: 500 });
  } catch (error) {
    console.warn(`could not remove ${userDataDir}: ${String(error)}`);
  }
});

// --- 1. source closure ---------------------------------------------------------------------------

test('1. closing the window that is being recorded ends the recording gracefully', async () => {
  await launchApp();
  const exe = (await import('node:module')).createRequire(__filename)(
    'electron',
  ) as unknown as string;
  const title = `Framelet failure fixture ${Date.now()}`;
  const fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), 'framelet-fail-fixture-'));
  const fixture: ChildProcess = spawn(
    exe,
    [path.join(__dirname, 'fixtures', 'color-window.mjs'), title, '300', '200', fixtureDir],
    { shell: false, stdio: ['ignore', 'pipe', 'pipe'] },
  );
  try {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('fixture window did not start')), 30_000);
      fixture.stdout?.on('data', (chunk: Buffer) => {
        if (chunk.toString().includes('READY ')) {
          clearTimeout(timer);
          resolve();
        }
      });
      fixture.once('error', reject);
    });
    const baselineWindows = await windowCount();
    const sources = await page.evaluate(() =>
      window.framelet.invoke('capture:listSources', { types: ['window'], thumbnailWidth: 0 }),
    );
    if (!sources.ok) throw new Error('capture:listSources failed');
    const source = sources.data.find((candidate) => candidate.name === title);
    expect(source, 'the fixture window is listed').toBeDefined();
    const started = await page.evaluate(
      (request) => window.framelet.invoke('recorder:start', request),
      { target: 'window' as const, sourceId: source?.id ?? '', options: recordOptions() },
    );
    expect(started.ok).toBe(true);
    await waitForStatus('recording');
    const recordingStartedAt = (await snapshot()).startedAt ?? Date.now();
    await page.waitForTimeout(3500);

    // Close the recorded window the way a user does (the fixture quits on command).
    const closedAt = Date.now();
    fs.writeFileSync(path.join(fixtureDir, 'command.txt'), 'quit');
    await waitForStatus('completed', 40_000);
    const endedAfterCloseMs = Date.now() - closedAt;
    const done = await snapshot();
    const result = done.result;
    expect(result, 'a finished file exists').not.toBeNull();
    expect(done.stopReason).toBe('source-lost');
    const file = result?.path ?? '';
    const probe = ffprobe(file);
    const duration = Number(probe.format.duration);
    expect(probe.streams.some((s) => s.codec_type === 'video')).toBe(true);
    expect(duration).toBeGreaterThan(2.5);
    expect(duration).toBeLessThan((closedAt - recordingStartedAt) / 1000 + 2);
    expect(decodeAll(file)).toEqual({ status: 0, stderr: '' });
    const resources = await expectNothingLeaked();
    expect(sessionDirs()).toEqual([]);
    expect(partialFiles()).toEqual([]);
    // The toolbar is gone with the recording: only the windows that existed before remain.
    await page.evaluate(() => window.framelet.invoke('recorder:reset'));
    await waitForStatus('idle');
    // The toolbar went with the recording (the hidden recorder window stays by design).
    await expect.poll(recordingUiWindows).toEqual([]);
    record('1-source-closure', {
      stopReason: done.stopReason,
      endedAfterCloseMs,
      recordedSeconds: duration,
      msBeforeCloseRecorded: closedAt - recordingStartedAt,
      video: probe.streams.find((s) => s.codec_type === 'video'),
      fullDecodeClean: true,
      resourcesAfter: resources,
      windowsAfter: await windowCount(),
      recordingUiWindowsAfter: await recordingUiWindows(),
      windowsBeforeFirstRecording: baselineWindows,
    });
  } finally {
    fixture.kill();
    fs.rmSync(fixtureDir, { recursive: true, force: true });
  }
});

// --- 2. permission denial -----------------------------------------------------------------------

test('2. a denied microphone is a visible choice; both answers work and nothing is left open', async () => {
  await launchApp();
  // Only the microphone is denied (the user clicked "Block"); everything else the page asks for
  // is allowed so that screen capture itself keeps working. Replaced from the test: no hook in the app.
  const denied = async () => {
    await (app as ElectronApplication).evaluate(({ session }) => {
      const isMic = (types: readonly string[] | undefined) =>
        types !== undefined && types.includes('audio') && !types.includes('video');
      session.defaultSession.setPermissionRequestHandler(
        (_contents, permission, callback, details) =>
          callback(
            !(permission === 'media' && isMic((details as { mediaTypes?: string[] }).mediaTypes)),
          ),
      );
      session.defaultSession.setPermissionCheckHandler(
        (_contents, permission, _origin, details) =>
          !(permission === 'media' && (details as { mediaType?: string }).mediaType === 'audio'),
      );
    });
  };
  await denied();

  // (a) "continue without": records on, no audio, and the file says so.
  const first = await startScreen({ mic: true });
  expect(first.ok).toBe(true);
  await expect.poll(async () => (await snapshot()).choice, { timeout: 30_000 }).toBe('mic-denied');
  expect((await snapshot()).status).toBe('preflight');
  await page.evaluate(() =>
    window.framelet.invoke('recorder:resolveChoice', { answer: 'continue-without' }),
  );
  await waitForStatus('recording');
  const during = await snapshot();
  expect(during.audio).toEqual({ mic: false, system: false });
  await page.waitForTimeout(3000);
  await page.evaluate(() => window.framelet.invoke('recorder:stop'));
  await waitForStatus('completed', 40_000);
  const done = await snapshot();
  const probe = ffprobe(done.result?.path ?? '');
  expect(done.result?.hasAudio).toBe(false);
  expect(probe.streams.filter((s) => s.codec_type === 'audio')).toHaveLength(0);
  expect(probe.streams.filter((s) => s.codec_type === 'video')).toHaveLength(1);
  await page.evaluate(() => window.framelet.invoke('recorder:reset'));
  await waitForStatus('idle');
  const afterContinue = await expectNothingLeaked();

  // (b) "cancel": nothing is recorded, nothing is left behind.
  const filesBefore = finishedFiles().length;
  const second = await startScreen({ mic: true });
  expect(second.ok).toBe(true);
  await expect.poll(async () => (await snapshot()).choice, { timeout: 30_000 }).toBe('mic-denied');
  await page.evaluate(() => window.framelet.invoke('recorder:resolveChoice', { answer: 'cancel' }));
  await waitForStatus('idle');
  expect(finishedFiles().length).toBe(filesBefore);
  expect(sessionDirs()).toEqual([]);
  const afterCancel = await expectNothingLeaked();

  // Camera was never requested by the app and stays denied by policy regardless of the override.
  record('2-permission-denial', {
    choiceShown: 'mic-denied',
    continueWithout: {
      audioFlagsWhileRecording: during.audio,
      resultHasAudio: done.result?.hasAudio,
      audioStreams: 0,
      resourcesAfter: afterContinue,
    },
    cancel: {
      statusAfter: 'idle',
      newFiles: finishedFiles().length - filesBefore,
      resourcesAfter: afterCancel,
    },
  });
});

// --- 3. rapid repeated commands -------------------------------------------------------------------

test('3. bursts of start, pause, resume, stop and cancel leave exactly one clean recording', async () => {
  await launchApp();
  const baselineWindows = await windowCount();
  const invoke = (channel: string, payload?: unknown) =>
    page.evaluate(
      ([name, body]) =>
        (
          window.framelet.invoke as unknown as (
            c: string,
            p?: unknown,
          ) => Promise<{ ok: boolean; error?: { code: string } }>
        )(name as string, body),
      [channel, payload] as const,
    );
  const displayId = await primaryDisplayId();
  const startRequest = { target: 'screen', displayId, options: recordOptions() };

  // Ten starts at once: one wins, the rest are refused as busy.
  const starts = await Promise.all(
    Array.from({ length: 10 }, () => invoke('recorder:start', startRequest)),
  );
  const accepted = starts.filter((r) => r.ok).length;
  const busy = starts.filter((r) => !r.ok && r.error?.code === 'BUSY').length;
  expect(accepted).toBe(1);
  expect(accepted + busy).toBe(10);
  await waitForStatus('recording');
  await page.waitForTimeout(1500);

  // Pause/resume hammering: the state machine ends in a consistent state, never throws.
  const toggles = Array.from({ length: 20 }, (_, i) =>
    invoke(i % 2 === 0 ? 'recorder:pause' : 'recorder:resume'),
  );
  await Promise.all(toggles);
  const afterToggles = await snapshot();
  expect(['recording', 'paused']).toContain(afterToggles.status);
  if (afterToggles.status === 'paused') await invoke('recorder:resume');
  await waitForStatus('recording');
  await page.waitForTimeout(1500);

  // Twenty stops at once (and a cancel that must be ignored once recording): one finished file.
  await Promise.all([
    ...Array.from({ length: 20 }, () => invoke('recorder:stop')),
    invoke('recorder:cancel'),
    invoke('recorder:pause'),
  ]);
  await waitForStatus('completed', 60_000);
  const done = await snapshot();
  expect(finishedFiles()).toHaveLength(1);
  expect(decodeAll(done.result?.path ?? '')).toEqual({ status: 0, stderr: '' });
  await invoke('recorder:reset');
  await waitForStatus('idle');

  // Start and immediately cancel, five times, then record once more: no leftovers.
  for (let i = 0; i < 5; i += 1) {
    const started = await invoke('recorder:start', startRequest);
    expect(started.ok).toBe(true);
    await invoke('recorder:cancel');
    await invoke('recorder:stop');
    await waitForStatus('idle', 30_000).catch(async () => {
      await invoke('recorder:reset');
    });
  }
  const finalStart = await invoke('recorder:start', startRequest);
  expect(finalStart.ok).toBe(true);
  await waitForStatus('recording');
  await page.waitForTimeout(1500);
  await invoke('recorder:stop');
  await waitForStatus('completed', 60_000);
  await invoke('recorder:reset');
  await waitForStatus('idle');

  const resources = await expectNothingLeaked();
  expect(finishedFiles()).toHaveLength(2);
  expect(sessionDirs()).toEqual([]);
  expect(partialFiles()).toEqual([]);
  await expect.poll(recordingUiWindows).toEqual([]);
  const stray = processesWith('ffmpeg.exe', userDataDir);
  expect(stray).toEqual([]);
  record('3-rapid-commands', {
    simultaneousStarts: { accepted, refusedBusy: busy },
    pauseResumeBurstEndedIn: afterToggles.status,
    simultaneousStops: 20,
    finishedFiles: finishedFiles().length,
    startCancelCycles: 5,
    resourcesAfter: resources,
    windowsBeforeFirstRecording: baselineWindows,
    windowsAfter: await windowCount(),
    recordingUiWindowsAfter: await recordingUiWindows(),
    strayFfmpegProcesses: stray.length,
  });
});

// --- 4. forced termination during finalization ------------------------------------------------------

/**
 * A large live-style WebM (about 0.85 GB), so that a remux takes seconds and the kill reliably
 * lands inside it. It is placed as the stream of an unfinished session (what a crash leaves) and
 * recovered; recovery uses the same remux and the same partial-file protocol as the first
 * finalization of a recording, which the E2E suite covers separately (quit past the cap).
 */
let bigStream: string | undefined;
function makeBigStream(): string {
  if (bigStream && fs.existsSync(bigStream)) return bigStream;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'framelet-native-bigstream-'));
  const file = path.join(dir, 'big.webm');
  const run = spawnSync(
    FFMPEG,
    [
      '-hide_banner',
      '-v',
      'error',
      '-f',
      'lavfi',
      '-i',
      'testsrc2=size=1920x1080:rate=30',
      '-f',
      'lavfi',
      '-i',
      'sine=frequency=440:sample_rate=48000',
      '-t',
      '240',
      '-c:v',
      'libvpx-vp9',
      '-deadline',
      'realtime',
      '-cpu-used',
      '8',
      '-b:v',
      '40M',
      '-minrate',
      '40M',
      '-maxrate',
      '40M',
      '-c:a',
      'libopus',
      '-f',
      'webm',
      '-live',
      '1',
      file,
    ],
    { shell: false, encoding: 'utf8', windowsHide: true },
  );
  if (run.status !== 0) throw new Error(`could not make the large test stream: ${run.stderr}`);
  bigStream = file;
  return file;
}

/** What a crash leaves behind: a session folder with its manifest and a stream. */
function seedUnfinishedSession(sessionId: string, stream: string): number {
  const dir = path.join(recordingsDir(), sessionId);
  fs.mkdirSync(dir, { recursive: true });
  fs.copyFileSync(stream, path.join(dir, 'stream.webm'));
  const bytes = fs.statSync(path.join(dir, 'stream.webm')).size;
  const now = Date.now();
  fs.writeFileSync(
    path.join(dir, 'manifest.json'),
    JSON.stringify({
      version: 1,
      sessionId,
      createdAt: now - 120_000,
      updatedAt: now - 60_000,
      state: 'recording',
      mime: 'video/webm;codecs=vp9,opus',
      source: { kind: 'screen', name: 'Screen' },
      options: {
        mic: { enabled: false },
        systemAudio: true,
        quality: '1080p',
        fps: 30,
        countdown: false,
      },
      width: 1920,
      height: 1080,
      chunksWritten: 1,
      bytesWritten: bytes,
      lastSeq: 0,
      pausedIntervals: [],
      stats: {
        queueHighWaterChunks: 0,
        queueHighWaterBytes: 0,
        mainQueueHighWater: 0,
        maxWriteMs: 0,
      },
      appVersion: '0.1.0',
    }),
  );
  return bytes;
}

interface FinalizeKill {
  mode: 'main-process-only (ffmpeg orphaned)' | 'whole process tree';
  streamMB: number;
  partialMBAtKill: number;
  manifestStateAfterKill: string;
  orphanFfmpegRunningAfterKill: boolean;
  orphanFfmpegEndedAfterSeconds: number | null;
  restartedWhileOrphanRunning: boolean;
  startupLog: string[];
  sessionFinishedByStartup: boolean;
  needsManualRecoverClick: boolean;
  finishedFiles: number;
  partialFilesAfterRestart: number;
  recoveredSeconds: number;
  fullDecodeClean: boolean;
}

async function killDuringRemux(
  mode: FinalizeKill['mode'],
  restartImmediately: boolean,
): Promise<FinalizeKill> {
  const stream = makeBigStream();
  const sessionId = crypto.randomUUID();
  const streamBytes = seedUnfinishedSession(sessionId, stream);
  await launchApp();
  // The real browser process (Playwright's own handle is a cmd.exe wrapper around it).
  const pid = await (app as ElectronApplication).evaluate(() => process.pid);
  // Start recovering without waiting for the answer: the remux runs for seconds.
  await page.evaluate(
    (id) => void window.framelet.invoke('recovery:recover', { sessionId: id }),
    sessionId,
  );
  const partial = path.join(videosDir(), `.framelet-${sessionId}.partial.webm`);
  // A tight synchronous poll (the remux of this file takes a second or two): kill the moment the
  // partial file has a few MB, long before ffmpeg is done.
  const spinUntil = Date.now() + 60_000;
  let partialAtKill = 0;
  while (Date.now() < spinUntil && partialAtKill < 4 * 1024 * 1024) {
    try {
      partialAtKill = fs.statSync(partial).size;
    } catch {
      partialAtKill = 0;
    }
  }
  if (mode === 'whole process tree') {
    spawnSync('taskkill', ['/F', '/T', '/PID', String(pid)], { shell: false, stdio: 'ignore' });
  } else {
    process.kill(pid, 'SIGKILL'); // TerminateProcess: ffmpeg keeps running, as after a crash
  }
  const killedAt = Date.now();
  app = undefined;
  await new Promise((resolve) => setTimeout(resolve, 600));
  const sessionDir = path.join(recordingsDir(), sessionId);
  const manifestState = (
    JSON.parse(fs.readFileSync(path.join(sessionDir, 'manifest.json'), 'utf8')) as { state: string }
  ).state;
  const orphanAlive = (): boolean => processesWith('ffmpeg.exe', userDataDir).length > 0;
  const orphanRunning = orphanAlive();
  let orphanEndedAfter: number | null = orphanRunning ? null : 0;

  if (!restartImmediately) {
    for (let waited = 0; orphanRunning && waited < 240; waited += 1) {
      if (!orphanAlive()) {
        orphanEndedAfter = (Date.now() - killedAt) / 1000;
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }
  const restartedWithOrphan = orphanAlive();

  await launchApp();
  // The start-up scan finishes the interrupted finalization by itself.
  const finishedByStartup = await expect
    .poll(() => sessionDirs().length, { timeout: 90_000 })
    .toBe(0)
    .then(
      () => true,
      () => false,
    );
  if (orphanRunning && orphanEndedAfter === null) {
    for (let waited = 0; waited < 240 && orphanAlive(); waited += 1) {
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    orphanEndedAfter = (Date.now() - killedAt) / 1000;
  }
  const logFile = path.join(userDataDir, 'logs', 'main.log');
  const startupLog = fs.existsSync(logFile)
    ? fs
        .readFileSync(logFile, 'utf8')
        .split(/\r?\n/)
        .filter((line) => /Recovery|ffmpeg is not usable|could not handle/i.test(line))
        .map((line) => line.replace(/^\S+ /, '').replaceAll(userDataDir, '[userData]'))
    : [];
  let needsManual = false;
  if (!finishedByStartup) {
    // The automatic attempt could not finish (the orphan still held the file): the session must
    // still be offered, and Recover must work once the orphan is gone.
    needsManual = true;
    const listed = await page.evaluate(() => window.framelet.invoke('recovery:list'));
    expect(listed.ok && listed.data.candidates.map((c) => c.sessionId)).toContain(sessionId);
    for (let waited = 0; waited < 240 && orphanAlive(); waited += 1) {
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    const recovered = await page.evaluate(
      (id) => window.framelet.invoke('recovery:recover', { sessionId: id }),
      sessionId,
    );
    expect(recovered.ok).toBe(true);
  }
  const files = finishedFiles();
  expect(files, 'one finished file, no duplicate').toHaveLength(1);
  const recoveredFile = path.join(videosDir(), files[0] ?? '');
  const probe = ffprobe(recoveredFile);
  const seconds = Number(probe.format.duration);
  expect(seconds).toBeGreaterThan(200);
  expect(probe.streams.some((s) => s.codec_type === 'video')).toBe(true);
  expect(decodeAll(recoveredFile)).toEqual({ status: 0, stderr: '' });
  expect(partialFiles()).toEqual([]);
  expect(sessionDirs()).toEqual([]);
  await closeApp();
  return {
    mode,
    streamMB: Math.round(streamBytes / 1048576),
    partialMBAtKill: Math.round(partialAtKill / 1048576),
    manifestStateAfterKill: manifestState,
    orphanFfmpegRunningAfterKill: orphanRunning,
    orphanFfmpegEndedAfterSeconds:
      orphanEndedAfter === null ? null : Number(orphanEndedAfter.toFixed(1)),
    restartedWhileOrphanRunning: restartImmediately ? orphanRunning : restartedWithOrphan,
    startupLog,
    sessionFinishedByStartup: finishedByStartup,
    needsManualRecoverClick: needsManual,
    finishedFiles: files.length,
    partialFilesAfterRestart: partialFiles().length,
    recoveredSeconds: Number(seconds.toFixed(1)),
    fullDecodeClean: true,
  };
}

test.afterAll(() => {
  if (bigStream) fs.rmSync(path.dirname(bigStream), { recursive: true, force: true });
});

test('4a. main process killed while ffmpeg remuxes (ffmpeg orphaned), app restarted at once: nothing is lost', async () => {
  test.setTimeout(480_000);
  const result = await killDuringRemux('main-process-only (ffmpeg orphaned)', true);
  expect(result.manifestStateAfterKill).toBe('finalizing');
  record('4a-kill-during-remux-main-only-immediate-restart', result);
});

test('4b. main process killed while ffmpeg remuxes, app restarted after the orphan ended', async () => {
  test.setTimeout(480_000);
  const result = await killDuringRemux('main-process-only (ffmpeg orphaned)', false);
  expect(result.manifestStateAfterKill).toBe('finalizing');
  record('4b-kill-during-remux-main-only-late-restart', result);
});

test('4c. whole process tree killed while ffmpeg remuxes: the partial file is half written, the restart finishes the recording', async () => {
  test.setTimeout(480_000);
  const result = await killDuringRemux('whole process tree', false);
  expect(result.manifestStateAfterKill).toBe('finalizing');
  expect(result.orphanFfmpegRunningAfterKill).toBe(false);
  record('4c-kill-during-remux-whole-tree', result);
});

// --- 5. write failure at finalization --------------------------------------------------------------------

test('5. the output folder refuses writes at finalization: the data is kept, the error is visible, Recover works afterwards', async () => {
  await launchApp();
  fs.mkdirSync(videosDir(), { recursive: true });
  const started = await startScreen({ system: false });
  expect(started.ok).toBe(true);
  await waitForStatus('recording');
  const sessionId = (await snapshot()).sessionId ?? '';
  await page.waitForTimeout(5000);

  // From now on nothing can be created in the output folder (deny rule for Everyone).
  execFileSync('icacls', [videosDir(), '/deny', '*S-1-1-0:(OI)(CI)(WD,AD)'], {
    shell: false,
    stdio: 'ignore',
  });
  await page.evaluate(() => window.framelet.invoke('recorder:stop'));
  await waitForStatus('error', 60_000);
  const failed = await snapshot();
  expect(failed.error?.code).toBeTruthy();
  expect(failed.error?.message).toMatch(/kept|recover/i);
  expect(failed.result).toBeNull();
  const sessionDir = path.join(recordingsDir(), sessionId);
  expect(fs.existsSync(path.join(sessionDir, 'stream.webm')), 'the recorded data is kept').toBe(
    true,
  );
  const keptBytes = fs.statSync(path.join(sessionDir, 'stream.webm')).size;
  expect(keptBytes).toBeGreaterThan(100_000);
  expect(finishedFiles()).toEqual([]);

  // The folder is writable again: the recording can be recovered from what was kept.
  execFileSync('icacls', [videosDir(), '/remove:d', '*S-1-1-0'], { shell: false, stdio: 'ignore' });
  await page.evaluate(() => window.framelet.invoke('recorder:reset'));
  await waitForStatus('idle');
  // The error text promises recovery "the next time Framelet starts": restart on the same data.
  await closeApp();
  await launchApp();
  const listed = await page.evaluate(() => window.framelet.invoke('recovery:list'));
  expect(listed.ok && listed.data.candidates.map((c) => c.sessionId)).toContain(sessionId);
  const recovered = await page.evaluate(
    (id) => window.framelet.invoke('recovery:recover', { sessionId: id }),
    sessionId,
  );
  expect(recovered.ok).toBe(true);
  if (!recovered.ok || recovered.data.outcome !== 'recovered') throw new Error('not recovered');
  const probe = ffprobe(recovered.data.path);
  expect(Number(probe.format.duration)).toBeGreaterThan(3);
  expect(decodeAll(recovered.data.path)).toEqual({ status: 0, stderr: '' });
  expect(sessionDirs()).toEqual([]);
  expect(partialFiles()).toEqual([]);
  record('5-write-failure-at-finalization', {
    errorCode: failed.error?.code,
    errorMessage: failed.error?.message,
    keptStreamBytes: keptBytes,
    stateAfterFailure: failed.status,
    recoveredAfterFolderWritable: true,
    recoveredSeconds: Number(probe.format.duration),
  });
});

// --- blocked ---------------------------------------------------------------------------------------------

test('6. disk full on a real small volume is BLOCKED here (needs an elevated shell); the injected tests stand in', () => {
  const elevated = spawnSync('net', ['session'], { shell: false, stdio: 'ignore' }).status === 0;
  record('6-real-disk-full', {
    status: elevated ? 'POSSIBLE_BUT_NOT_AUTOMATED' : 'BLOCKED',
    reason:
      'Making a small volume (a VHD or a quota) needs an elevated shell; this session is not elevated. ' +
      'Covered instead by tests/unit/session-service.test.ts (ENOSPC on write, DISK_FULL), recovery.test.ts ' +
      'and the E2E disk-pressure tests (free-space file hook): refuse to start under 1 GB, stop safely under 500 MB.',
  });
});
