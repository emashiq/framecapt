/**
 * Native verification of persistence and recovery on the real host (production build, real
 * display capture, real Windows loopback audio, real ffmpeg). Needs an interactive Windows
 * session and a built app (`npm run test:native` packages first). Evidence (redacted JSON; the
 * recovered media is gitignored) goes to docs/evidence/phase06/.
 *
 *  1. A normal 6 s recording: the finished file has a container duration (not N/A), a seek index,
 *     seeking decodes, no stream.webm copy is left, no partial file is left.
 *  2. A real 10 s recording (screen + system audio) whose whole Electron process tree is killed
 *     with `taskkill /F /T` after ~5 s. The same userData directory is launched again: the recovery
 *     banner appears, Recover is clicked, and the output is probed (video + audio, duration) and
 *     decoded without errors.
 */
import { execFileSync, spawnSync } from 'node:child_process';
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
import { writeEvidenceJson } from './evidence';

const projectRoot = path.resolve(__dirname, '..', '..');
const evidenceDir = path.join(projectRoot, 'docs', 'evidence', 'phase06');
const vendor = path.join(projectRoot, 'vendor', 'ffmpeg', 'win32-x64');
const FFMPEG = path.join(vendor, 'ffmpeg.exe');
const FFPROBE = path.join(vendor, 'ffprobe.exe');

let userDataDir: string;
let app: ElectronApplication | undefined;
let page: Page;

const evidence: Record<string, unknown> = {};
function record(name: string, value: unknown): void {
  evidence[name] = value;
  writeEvidenceJson(evidenceDir, 'recovery-native.json', evidence);
}

const videosDir = (): string => path.join(userDataDir, 'videos', 'Framelet');
const recordingsDir = (): string => path.join(userDataDir, 'recordings');

interface Probe {
  streams: { codec_type: string; codec_name: string; width?: number; height?: number }[];
  format: { duration?: string; size: string; format_name: string };
}

function ffprobe(file: string): Probe {
  return JSON.parse(
    execFileSync(FFPROBE, ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', file], {
      shell: false,
      encoding: 'utf8',
    }),
  ) as Probe;
}

/** Decodes the whole file: exit code 0 and nothing on stderr at -v error. */
function decodeAll(file: string): { status: number; stderr: string } {
  const run = spawnSync(FFMPEG, ['-v', 'error', '-i', file, '-f', 'null', '-'], {
    shell: false,
    encoding: 'utf8',
  });
  return { status: run.status ?? -1, stderr: run.stderr.trim() };
}

function meanVolume(file: string): number | null {
  const run = spawnSync(
    FFMPEG,
    ['-hide_banner', '-i', file, '-vn', '-af', 'volumedetect', '-f', 'null', '-'],
    { shell: false, encoding: 'utf8' },
  );
  const mean = /mean_volume:\s*(-?[\d.]+|-inf) dB/.exec(run.stderr)?.[1];
  return mean === undefined || mean === '-inf' ? null : Number(mean);
}

function hasCues(file: string): boolean {
  return fs.readFileSync(file).indexOf(Buffer.from([0x1c, 0x53, 0xbb, 0x6b])) !== -1;
}

function seekDecodes(file: string, at: number): boolean {
  const run = spawnSync(
    FFMPEG,
    ['-v', 'error', '-ss', String(at), '-i', file, '-t', '1', '-f', 'null', '-'],
    { shell: false, encoding: 'utf8' },
  );
  return run.status === 0 && run.stderr.trim() === '';
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

/** A quiet 440 Hz tone through the default output, so Windows loopback has something to record. */
async function startTone(): Promise<void> {
  await page.evaluate(() => {
    const w = window as unknown as { __tone?: { ctx: AudioContext; osc: OscillatorNode } };
    if (w.__tone) return;
    const ctx = new AudioContext();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.frequency.value = 440;
    gain.gain.value = 0.08;
    osc.connect(gain).connect(ctx.destination);
    osc.start();
    void ctx.resume();
    w.__tone = { ctx, osc };
  });
}

async function stopTone(): Promise<void> {
  await page.evaluate(async () => {
    const w = window as unknown as { __tone?: { ctx: AudioContext; osc: OscillatorNode } };
    if (!w.__tone) return;
    w.__tone.osc.stop();
    await w.__tone.ctx.close();
    delete w.__tone;
  });
}

async function startRecording(): Promise<void> {
  const displayId = await primaryDisplayId();
  const started = await page.evaluate(
    (id) =>
      window.framelet.invoke('recorder:start', {
        target: 'screen',
        displayId: id,
        options: {
          mic: { enabled: false },
          systemAudio: true,
          quality: '1080p',
          fps: 30,
          countdown: false,
        },
      }),
    displayId,
  );
  expect(started.ok).toBe(true);
  await waitForStatus('recording');
}

test.describe.configure({ mode: 'serial' });

test.beforeAll(() => {
  expect(
    fs.existsSync(path.join(projectRoot, '.vite', 'build', 'main.cjs')),
    'Run `npm run package` first (npm run test:native does this).',
  ).toBe(true);
  expect(fs.existsSync(FFMPEG), 'Run `npm run fetch:ffmpeg` first.').toBe(true);
  userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'framelet-native-recovery-'));
  fs.mkdirSync(evidenceDir, { recursive: true });
});

test.afterAll(async () => {
  if (app) await exitApp(app);
  if (userDataDir)
    fs.rmSync(userDataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 });
});

test('a normal 6 s recording is finalized: duration in the container, seek index, no duplicate stream', async () => {
  await launchApp();
  await startTone();
  await startRecording();
  const startedAt = (await snapshot()).startedAt ?? Date.now();
  await page.waitForTimeout(6000 - (Date.now() - startedAt));
  await page.evaluate(() => window.framelet.invoke('recorder:stop'));
  await waitForStatus('completed');
  const done = await snapshot();
  const result = done.result;
  if (!result) throw new Error('no result');
  await stopTone();

  const probe = ffprobe(result.path);
  const duration = Number(probe.format.duration);
  expect(Number.isFinite(duration), 'ffprobe format.duration is a number, not N/A').toBe(true);
  expect(duration).toBeGreaterThan(5);
  expect(duration).toBeLessThan(7.5);
  expect(probe.streams.filter((s) => s.codec_type === 'video')).toHaveLength(1);
  expect(probe.streams.filter((s) => s.codec_type === 'audio')).toHaveLength(1);
  expect(hasCues(result.path)).toBe(true);
  expect(seekDecodes(result.path, 3)).toBe(true);
  expect(decodeAll(result.path)).toEqual({ status: 0, stderr: '' });
  expect(result.unindexed).toBe(false);
  // The in-app duration is the probed container duration.
  expect(Math.abs(result.durationMs / 1000 - duration)).toBeLessThan(0.01);
  // No duplicate stream: the session directory is gone, a small record remains, no partial file.
  expect(fs.existsSync(path.join(recordingsDir(), done.sessionId ?? 'x'))).toBe(false);
  expect(fs.readdirSync(path.join(recordingsDir(), 'completed'))).toHaveLength(1);
  expect(fs.readdirSync(videosDir()).filter((n) => n.includes('.partial'))).toEqual([]);
  expect(fs.readdirSync(videosDir())).toHaveLength(1);

  record('normalRecording', {
    containerDurationSeconds: duration,
    appReportedDurationMs: result.durationMs,
    bytes: Number(probe.format.size),
    format: probe.format.format_name,
    streams: probe.streams.map((s) => ({ type: s.codec_type, codec: s.codec_name })),
    seekIndex: true,
    seekTo3sDecodesClean: true,
    fullDecodeClean: true,
    sessionDirectoryRemoved: true,
    meanVolumeDb: meanVolume(result.path),
  });
  await page.evaluate(() => window.framelet.invoke('recorder:reset'));
  await waitForStatus('idle');
  await exitApp(app as ElectronApplication);
  app = undefined;
  fs.rmSync(videosDir(), { recursive: true, force: true });
});

interface KillRun {
  plannedKillAfterMs: number;
  killedAfterRecordingMs: number;
  streamBytesJustBeforeKill: number;
  streamBytesAfterKill: number;
  manifestBytesWritten: number;
  manifestChunksWritten: number;
  manifestState: string;
  recoveredDurationSeconds: number;
  lostSecondsVersusKillTime: number;
  recoveredBytes: number;
  streams: { type: string; codec: string; width?: number; height?: number }[];
  meanVolumeDb: number | null;
  file: string;
}

/**
 * One cycle: launch, record screen + system audio, kill the whole process tree after `killAfterMs`
 * of recording (no stop, no flush, no quit handler), relaunch with the same userData, check the
 * banner, click Recover, then probe and decode the result.
 */
async function killAndRecover(killAfterMs: number): Promise<KillRun> {
  await launchApp();
  await startTone();
  await startRecording();
  const state = await snapshot();
  const recordingStartedAt = state.startedAt ?? Date.now();
  const sessionId = state.sessionId ?? '';
  expect(sessionId).not.toBe('');

  await page.waitForTimeout(Math.max(0, killAfterMs - (Date.now() - recordingStartedAt)));
  const sessionDir = path.join(recordingsDir(), sessionId);
  const streamBeforeKill = fs.statSync(path.join(sessionDir, 'stream.webm')).size;
  const pid = (app as ElectronApplication).process().pid;
  expect(pid).toBeGreaterThan(0);
  const killedAfterMs = Date.now() - recordingStartedAt;
  execFileSync('taskkill', ['/F', '/T', '/PID', String(pid)], { shell: false, stdio: 'ignore' });
  await new Promise((resolve) => setTimeout(resolve, 1500));
  app = undefined; // the process is gone; Playwright's handle is stale

  // What the dead process left behind.
  expect(fs.existsSync(path.join(sessionDir, 'stream.webm'))).toBe(true);
  const streamAfterKill = fs.statSync(path.join(sessionDir, 'stream.webm')).size;
  const manifestAtKill = JSON.parse(
    fs.readFileSync(path.join(sessionDir, 'manifest.json'), 'utf8'),
  ) as { state: string; bytesWritten: number; chunksWritten: number };
  expect(['recording', 'stopping']).toContain(manifestAtKill.state);
  const before = fs.existsSync(videosDir()) ? fs.readdirSync(videosDir()) : [];
  expect(streamAfterKill).toBeGreaterThan(0);

  // Same userData, new process: the banner offers the unfinished recording.
  await launchApp();
  const banner = page.getByTestId('recovery-banner');
  await expect(banner).toBeVisible({ timeout: 20_000 });
  const card = banner.locator(`[data-session-id="${sessionId}"]`);
  await expect(card).toBeVisible();
  await expect(card).toContainText('We found an unfinished recording from');
  await card.locator('summary').click();
  await expect(card.getByTestId('recovery-details')).toContainText('Screen');
  await card.getByTestId('recovery-recover').click();
  const result = banner.getByTestId('recovery-result');
  await expect(result).toBeVisible({ timeout: 60_000 });
  await expect(result).toContainText('Recovered what could be saved');

  const added = fs.readdirSync(videosDir()).filter((name) => !before.includes(name));
  expect(added).toHaveLength(1);
  const recoveredFile = path.join(videosDir(), added[0] ?? '');
  expect(path.basename(recoveredFile)).toContain('(recovered)');
  const probe = ffprobe(recoveredFile);
  const duration = Number(probe.format.duration);
  expect(duration).toBeGreaterThanOrEqual(Math.min(3, killAfterMs / 1000 - 1.5));
  expect(probe.streams.some((s) => s.codec_type === 'video')).toBe(true);
  expect(probe.streams.some((s) => s.codec_type === 'audio')).toBe(true);
  expect(decodeAll(recoveredFile)).toEqual({ status: 0, stderr: '' });
  expect(hasCues(recoveredFile)).toBe(true);
  expect(seekDecodes(recoveredFile, Math.max(0, Math.floor(duration) - 2))).toBe(true);
  expect(fs.existsSync(sessionDir)).toBe(false);
  expect(fs.readdirSync(videosDir()).filter((n) => n.includes('.partial'))).toEqual([]);

  const run: KillRun = {
    plannedKillAfterMs: killAfterMs,
    killedAfterRecordingMs: killedAfterMs,
    streamBytesJustBeforeKill: streamBeforeKill,
    streamBytesAfterKill: streamAfterKill,
    manifestBytesWritten: manifestAtKill.bytesWritten,
    manifestChunksWritten: manifestAtKill.chunksWritten,
    manifestState: manifestAtKill.state,
    recoveredDurationSeconds: duration,
    lostSecondsVersusKillTime: Number((killedAfterMs / 1000 - duration).toFixed(2)),
    recoveredBytes: Number(probe.format.size),
    streams: probe.streams.map((s) => ({
      type: s.codec_type,
      codec: s.codec_name,
      ...(s.width !== undefined && { width: s.width }),
      ...(s.height !== undefined && { height: s.height }),
    })),
    meanVolumeDb: meanVolume(recoveredFile),
    file: recoveredFile,
  };
  await exitApp(app as unknown as ElectronApplication);
  app = undefined;
  return run;
}

test('force-kill the whole app during real recordings at three moments, relaunch, recover, probe and decode', async () => {
  const runs: KillRun[] = [];
  for (const killAfterMs of [2300, 3700, 5000]) {
    runs.push(await killAndRecover(killAfterMs));
  }
  // Keep the last recovered recording as evidence (gitignored: it shows the real desktop).
  const last = runs.at(-1) as KillRun;
  fs.copyFileSync(last.file, path.join(evidenceDir, 'recovered-after-forced-kill.webm'));
  const losses = runs.map((r) => r.lostSecondsVersusKillTime);
  record('forcedKillRecovery', {
    note:
      'The whole Electron process tree was killed (taskkill /F /T) during a real 10 s screen + system audio ' +
      'recording; the same userData was launched again, the banner appeared, Recover was clicked, the output ' +
      'was probed and decoded with ffmpeg. The manifest is rewritten every 5 s or 10 chunks, so it lags the ' +
      'file; recovery uses the real file size. lostSecondsVersusKillTime = time recorded before the kill minus ' +
      'recovered duration (negative: the recovered file is slightly longer than the timer, which starts a ' +
      'little after the first frame).',
    runs: runs.map(({ file: _file, ...rest }) => rest),
    worstLossSeconds: Math.max(...losses),
    bestLossSeconds: Math.min(...losses),
    uiBannerShown: true,
    sessionDirectoryRemovedAfterRecovery: true,
  });
  // The documented bound: at most about one 1 s timeslice plus what was in flight is lost.
  expect(Math.max(...losses)).toBeLessThan(2.5);
});
