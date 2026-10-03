/**
 * Recording benchmark on a real interactive Windows desktop: `npm run bench:recording`
 * (DURATION_MIN=30 by default; DURATION_MIN=3 for a quick tooling check).
 *
 * It launches the REAL app (the production build in .vite/build, never the mock/E2E build: that is
 * verified first with check-no-mocks), with a throw-away userData folder, and records the primary
 * display at the 1080p / 30 fps preset with system audio. A separate process (bench/sync-beacon)
 * plays a continuous tone plus a 1 kHz beep every 10 s and flashes a small always-on-top window
 * in step with each beep (one clock for both). Every 5 s the script samples:
 *   - app.getAppMetrics(): CPU and memory of every process of the app, summed for the whole tree,
 *   - the recorder window's resource counters (live tracks, audio contexts, timers/loops) and JS heap,
 *   - the session manifest (chunks, bytes, renderer queue high-water, slowest write) and the growth
 *     of stream.webm on disk,
 *   - the CPU load of the whole machine (so the beacon and the harness are visible too).
 * After the stop it waits for finalization and probes the output (duration, frame count, average
 * and worst frame gaps, dimensions, audio length) and measures A/V sync from the recorded file:
 * beep onsets in the audio against flash onsets in the picture, in a window at the start and one
 * at the end; the drift is the change of that offset.
 *
 * Output: docs/evidence/phase09/bench-<date>-<minutes>min.{json,md} (redacted: no paths with the
 * user name, no window titles). The recording itself shows the real desktop and is deleted.
 */
/* global window */
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { _electron as electron } from '@playwright/test';
import { redactedJson } from '../tests/native/evidence.ts';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const electronBinary = require('electron');

const DURATION_MIN = Number(process.env.DURATION_MIN ?? 30);
const SAMPLE_SEC = Number(process.env.SAMPLE_SEC ?? 5);
const WARMUP_SEC = Number(process.env.WARMUP_SEC ?? 120);
if (!(DURATION_MIN > 0)) throw new Error('DURATION_MIN must be a positive number');
const DURATION_SEC = DURATION_MIN * 60;

const evidenceDir = path.join(root, 'docs', 'evidence', 'phase09');
const stamp = new Date().toISOString().slice(0, 10);
const MOTION = process.env.MOTION !== '0';
const CORES = os.cpus().length;
const IDLE_SEC = Number(process.env.IDLE_SEC ?? 30);
const KEEP_DIR = process.env.BENCH_KEEP_DIR;
const baseName = `bench-${stamp}-${DURATION_MIN}min-${MOTION ? 'motion' : 'static'}`;

const log = (...parts) =>
  console.log(`[bench ${new Date().toISOString().slice(11, 19)}]`, ...parts);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// --- ffmpeg tools (verification only: the bundled build, else PATH) ----------------------------

function tool(name) {
  const bundled = path.join(root, 'vendor', 'ffmpeg', 'win32-x64', `${name}.exe`);
  return fs.existsSync(bundled) ? bundled : name;
}
const FFMPEG = tool('ffmpeg');
const FFPROBE = tool('ffprobe');

function run(file, args, options = {}) {
  const result = spawnSync(file, args, {
    shell: false,
    encoding: 'utf8',
    maxBuffer: 1024 * 1024 * 1024,
    windowsHide: true,
    ...options,
  });
  if (result.error) throw result.error;
  return { stdout: result.stdout ?? '', stderr: result.stderr ?? '', status: result.status ?? -1 };
}

// --- statistics ---------------------------------------------------------------------------------

const sum = (values) => values.reduce((total, value) => total + value, 0);
const mean = (values) => (values.length === 0 ? null : sum(values) / values.length);
function percentile(values, p) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))];
}
const median = (values) => percentile(values, 50);
const round = (value, digits = 2) =>
  value === null || value === undefined || !Number.isFinite(value)
    ? null
    : Number(value.toFixed(digits));

/** Least-squares slope of y against x (units of y per unit of x). */
function slope(points) {
  if (points.length < 2) return null;
  const mx = mean(points.map((p) => p.x));
  const my = mean(points.map((p) => p.y));
  let num = 0;
  let den = 0;
  for (const { x, y } of points) {
    num += (x - mx) * (y - my);
    den += (x - mx) ** 2;
  }
  return den === 0 ? null : num / den;
}

// --- the machine ------------------------------------------------------------------------------

function powershell(script) {
  return run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script]).stdout.trim();
}

function environment() {
  return {
    os: `${os.type()} ${os.release()} (${os.version()})`,
    cpu: os.cpus()[0]?.model?.trim(),
    logicalCores: os.cpus().length,
    ramGiB: Number((os.totalmem() / 1024 ** 3).toFixed(1)),
    node: process.version,
    ffmpeg: run(FFMPEG, ['-version']).stdout.split('\n')[0]?.trim(),
  };
}

function electronProcessCount() {
  const out = run('tasklist', ['/FI', 'IMAGENAME eq electron.exe', '/FO', 'CSV', '/NH']).stdout;
  return out.split('\n').filter((line) => line.toLowerCase().includes('electron.exe')).length;
}

/** CPU seconds (all time) of the given process ids: the OS's own count, a cross-check of getAppMetrics. */
function cpuSecondsOf(pids) {
  if (pids.length === 0) return {};
  const text = powershell(
    `Get-Process -Id ${pids.join(',')} -ErrorAction SilentlyContinue | ForEach-Object { "$($_.Id) $([math]::Round($_.TotalProcessorTime.TotalSeconds, 3))" }`,
  );
  const out = {};
  for (const line of text.split(/\r?\n/)) {
    const [pid, seconds] = line.trim().split(/\s+/);
    if (pid && seconds) out[pid] = Number(seconds);
  }
  return out;
}

let lastCpuTimes = null;
/** Busy fraction of the whole machine since the previous call, 0..100. */
function systemCpuPercent() {
  const now = os.cpus().map((cpu) => cpu.times);
  const total = (times) => times.user + times.nice + times.sys + times.idle + times.irq;
  let percent = null;
  if (lastCpuTimes) {
    const busy = sum(
      now.map((t, i) => total(t) - t.idle - (total(lastCpuTimes[i]) - lastCpuTimes[i].idle)),
    );
    const all = sum(now.map((t, i) => total(t) - total(lastCpuTimes[i])));
    percent = all > 0 ? (100 * busy) / all : null;
  }
  lastCpuTimes = now;
  return percent;
}

// --- A/V sync analysis from the recorded file ---------------------------------------------------

/** Beep onsets (seconds, file timeline): where the 1 kHz band comes out of silence. */
function audioOnsets(file, from, length) {
  const { stderr } = run(FFMPEG, [
    '-hide_banner',
    '-ss',
    String(from),
    '-t',
    String(length),
    '-i',
    file,
    '-vn',
    '-af',
    // 4th-order band around 1 kHz: the steady 440 Hz tone is ~25 dB further down than the beep.
    'highpass=f=900,highpass=f=900,lowpass=f=1100,lowpass=f=1100,silencedetect=n=-42dB:d=0.05',
    '-f',
    'null',
    '-',
  ]);
  return (
    [...stderr.matchAll(/silence_end:\s*(-?[\d.]+)/g)]
      .map((match) => Number(match[1]))
      // ffmpeg also prints a silence_end where the analysed window itself ends: not a beep.
      .filter((onset) => onset < length - 0.2)
  );
}

/** Flash onsets (seconds, file timeline): where the mean brightness of the beacon crop turns white. */
function flashOnsets(file, from, length, crop) {
  const { stdout } = run(FFMPEG, [
    '-hide_banner',
    '-ss',
    String(from),
    '-t',
    String(length),
    '-i',
    file,
    '-an',
    '-vf',
    `crop=${crop.width}:${crop.height}:${crop.x}:${crop.y},format=gray,signalstats,metadata=mode=print:key=lavfi.signalstats.YAVG:file=-`,
    '-f',
    'null',
    '-',
  ]);
  const onsets = [];
  let time = null;
  let previous = 0;
  const brightness = [];
  for (const line of stdout.split(/\r?\n/)) {
    const t = /pts_time:(-?[\d.]+)/.exec(line);
    if (t) time = Number(t[1]);
    const y = /lavfi\.signalstats\.YAVG=([\d.]+)/.exec(line);
    if (y && time !== null) {
      const value = Number(y[1]);
      brightness.push(value);
      if (value > 128 && previous <= 128) onsets.push(time);
      previous = value;
    }
  }
  return { onsets, frames: brightness.length, maxBrightness: Math.max(...brightness, 0) };
}

/** Pairs each beep with the nearest flash within one second: offsets (ms) of flash minus beep. */
function pairOffsets(beeps, flashes) {
  const offsets = [];
  for (const beep of beeps) {
    let best = null;
    for (const flash of flashes) {
      if (
        Math.abs(flash - beep) < 1 &&
        (best === null || Math.abs(flash - beep) < Math.abs(best - beep))
      ) {
        best = flash;
      }
    }
    if (best !== null) offsets.push(Math.round((best - beep) * 1000));
  }
  return offsets;
}

function syncWindow(file, from, length, crop) {
  const beeps = audioOnsets(file, from, length);
  const flashes = flashOnsets(file, from, length, crop);
  const offsets = pairOffsets(beeps, flashes.onsets);
  return {
    fromSec: from,
    lengthSec: length,
    beepsDetected: beeps.length,
    flashesDetected: flashes.onsets.length,
    videoFramesAnalysed: flashes.frames,
    maxBrightness: round(flashes.maxBrightness, 1),
    beepOnsetsSec: beeps.map((value) => round(value, 3)),
    flashOnsetsSec: flashes.onsets.map((value) => round(value, 3)),
    pairs: offsets.length,
    offsetsMs: offsets,
    medianOffsetMs: median(offsets),
    meanOffsetMs: round(mean(offsets), 1),
  };
}

// --- the output file ------------------------------------------------------------------------------

function probeFile(file) {
  const json = JSON.parse(
    run(FFPROBE, ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', file]).stdout,
  );
  const video = json.streams.find((stream) => stream.codec_type === 'video');
  const audio = json.streams.find((stream) => stream.codec_type === 'audio');
  return {
    container: json.format.format_name,
    sizeBytes: Number(json.format.size),
    durationSec: Number(json.format.duration),
    bitRateKbps: round(Number(json.format.bit_rate) / 1000, 0),
    video: video && {
      codec: video.codec_name,
      width: video.width,
      height: video.height,
      avgFrameRate: video.avg_frame_rate,
      rFrameRate: video.r_frame_rate,
    },
    audio: audio && {
      codec: audio.codec_name,
      sampleRate: Number(audio.sample_rate),
      channels: audio.channels,
    },
  };
}

/** Frame timing from the packet timestamps (fast; the packets of a WebM are its frames). */
function frameTiming(file) {
  const out = run(FFPROBE, [
    '-v',
    'error',
    '-select_streams',
    'v:0',
    '-show_entries',
    'packet=pts_time',
    '-of',
    'csv=p=0',
    file,
  ]).stdout;
  const times = out
    .split(/\r?\n/)
    .map((line) => Number(line))
    .filter((value) => Number.isFinite(value))
    .sort((a, b) => a - b);
  const gaps = times.slice(1).map((time, i) => (time - times[i]) * 1000);
  const perSecond = new Map();
  for (const time of times)
    perSecond.set(Math.floor(time), (perSecond.get(Math.floor(time)) ?? 0) + 1);
  const counts = [...perSecond.values()];
  return {
    packets: times.length,
    spanSec: round(times.at(-1) - times[0], 3),
    meanGapMs: round(mean(gaps), 2),
    p50GapMs: round(percentile(gaps, 50), 1),
    p99GapMs: round(percentile(gaps, 99), 1),
    maxGapMs: round(Math.max(...gaps, 0), 1),
    gapsOver100ms: gaps.filter((gap) => gap > 100).length,
    gapsOver250ms: gaps.filter((gap) => gap > 250).length,
    minFramesInASecond: counts.length > 2 ? Math.min(...counts.slice(1, -1)) : null,
    secondsBelow25fps: counts.slice(1, -1).filter((count) => count < 25).length,
  };
}

/** Decodes the whole video and counts frames (what `ffprobe -count_frames` does). */
function countFrames(file) {
  const out = run(FFPROBE, [
    '-v',
    'error',
    '-count_frames',
    '-select_streams',
    'v:0',
    '-show_entries',
    'stream=nb_read_frames',
    '-of',
    'csv=p=0',
    file,
  ]).stdout.trim();
  return Number(out);
}

/** Decodes one stream and reads the last timestamp ffmpeg printed (a MediaRecorder stream has no per-stream duration). */
function decodedSeconds(file, only) {
  const { stderr } = run(FFMPEG, [
    '-hide_banner',
    '-i',
    file,
    only === 'audio' ? '-vn' : '-an',
    '-f',
    'null',
    '-',
  ]);
  const last = [...stderr.matchAll(/time=(\d+):(\d+):(\d+\.\d+)/g)].at(-1);
  return last ? Number(last[1]) * 3600 + Number(last[2]) * 60 + Number(last[3]) : null;
}

// --- main ---------------------------------------------------------------------------------------

async function main() {
  fs.mkdirSync(evidenceDir, { recursive: true });
  if (!fs.existsSync(path.join(root, '.vite', 'build', 'main.cjs'))) {
    throw new Error(
      'No build found. Run `npm run package` first (it makes the real, non-mock build).',
    );
  }
  const mocks = spawnSync(process.execPath, [path.join(root, 'scripts', 'check-no-mocks.mjs')], {
    shell: false,
    encoding: 'utf8',
  });
  if (mocks.status !== 0) {
    throw new Error(
      `The build contains mock/E2E code, a benchmark would be meaningless:\n${mocks.stdout}${mocks.stderr}`,
    );
  }
  log('build verified: no mock or test-hook code', mocks.stdout.trim());

  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'framecapt-bench-'));
  const userData = path.join(work, 'userdata');
  const free = fs.statfsSync(work);
  const freeGiB = (Number(free.bavail) * Number(free.bsize)) / 1024 ** 3;
  const neededGiB = 0.04 * DURATION_MIN + 2;
  if (freeGiB < neededGiB * 2)
    throw new Error(`Not enough free disk (${freeGiB.toFixed(1)} GiB) for ${DURATION_MIN} min.`);

  const electronBefore = electronProcessCount();
  const env = environment();
  let beacon = null;
  let app = null;
  const result = {
    benchmark: 'recording',
    startedAt: new Date().toISOString(),
    plan: {
      durationMin: DURATION_MIN,
      sampleSec: SAMPLE_SEC,
      warmupSec: WARMUP_SEC,
      preset: '1080p',
      fps: 30,
      systemAudio: true,
      mic: false,
    },
    environment: env,
    build:
      'production bundle (.vite/build), check-no-mocks OK, launched as `electron .` with a temporary userData',
    notes: [],
  };

  try {
    // The beacon: tone, beep and flash in the top-left corner of the primary display.
    log('starting the A/V beacon');
    beacon = spawn(
      electronBinary,
      [
        path.join(root, 'scripts', 'bench', 'sync-beacon.mjs'),
        '40',
        '40',
        '200',
        MOTION ? 'motion' : 'static',
      ],
      {
        shell: false,
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: false,
      },
    );
    const beaconInfo = await new Promise((resolve, reject) => {
      let text = '';
      const timer = setTimeout(() => reject(new Error(`beacon did not start: ${text}`)), 30_000);
      beacon.stdout.on('data', (chunk) => {
        text += chunk;
        const match = /READY (\{.*\})/.exec(text);
        if (match) {
          clearTimeout(timer);
          resolve(JSON.parse(match[1]));
        }
      });
      beacon.on('exit', (code) => reject(new Error(`beacon exited early (${code}): ${text}`)));
    });
    result.beacon = beaconInfo;
    const beaconStartedAt = Date.now();

    log('launching FrameCapt');
    app = await electron.launch({
      args: ['.'],
      cwd: root,
      env: { ...process.env, FRAMECAPT_USER_DATA_DIR: userData },
    });
    const page = await app.firstWindow();
    await page.waitForLoadState('domcontentloaded');
    await page.waitForFunction(() => typeof window.framecapt?.invoke === 'function');
    const info = await page.evaluate(() => window.framecapt.invoke('app:getInfo'));
    const displays = await page.evaluate(() => window.framecapt.invoke('capture:listDisplays'));
    if (!info.ok || !displays.ok) throw new Error('app:getInfo / capture:listDisplays failed');
    result.environment.app = {
      version: info.data.version,
      electron: info.data.electron,
      chrome: info.data.chrome,
      isPackaged: info.data.isPackaged,
    };
    result.environment.displays = displays.data.map((d) => ({
      bounds: d.bounds,
      scaleFactor: d.scaleFactor,
      physicalSize: d.physicalSize,
      isPrimary: d.isPrimary,
    }));
    const primary = displays.data.find((d) => d.isPrimary) ?? displays.data[0];
    const metricsOf = () => app.evaluate(({ app: electronApp }) => electronApp.getAppMetrics());
    const state = () =>
      page.evaluate(() => window.framecapt.invoke('recorder:getState')).then((r) => r.data);

    // --- idle: the app open with no recording (the OS's own CPU time is the reference) -----------
    await sleep(8000);
    await metricsOf(); // the first reading covers the time since launch: discarded
    const idlePids = (await metricsOf()).map((m) => m.pid);
    const osIdleBefore = cpuSecondsOf(idlePids);
    const idleStartedAt = Date.now();
    const idleReadings = [];
    for (let second = 0; second < IDLE_SEC; second += 1) {
      await sleep(1000);
      idleReadings.push(sum((await metricsOf()).map((m) => m.cpu.percentCPUUsage * CORES)));
    }
    const osIdleAfter = cpuSecondsOf(idlePids);
    const idleSec = (Date.now() - idleStartedAt) / 1000;
    result.idle = {
      seconds: round(idleSec, 1),
      processes: idlePids.length,
      electronMetricsPercentOfOneCore: round(mean(idleReadings), 3),
      osCpuPercentOfOneCore: round(
        (100 *
          sum(Object.keys(osIdleAfter).map((pid) => osIdleAfter[pid] - (osIdleBefore[pid] ?? 0)))) /
          idleSec,
        3,
      ),
      note: 'app open (main window, no recording yet, recorder window not created); Electron percentCPUUsage x logical cores, and the OS TotalProcessorTime delta',
    };
    log('idle CPU', JSON.stringify(result.idle));

    // --- record -------------------------------------------------------------------------------
    await sleep(2000);
    const pidsAtStart = (await metricsOf()).map((m) => m.pid);
    const cpuAtStart = cpuSecondsOf(pidsAtStart);
    lastCpuTimes = os.cpus().map((cpu) => cpu.times);
    log(`starting the recording (${DURATION_MIN} min)`);
    const started = await page.evaluate(
      (request) => window.framecapt.invoke('recorder:start', request),
      {
        target: 'screen',
        displayId: primary.id,
        options: {
          mic: { enabled: false },
          systemAudio: true,
          quality: '1080p',
          fps: 30,
          countdown: false,
        },
      },
    );
    if (!started.ok) throw new Error(`recorder:start failed: ${JSON.stringify(started.error)}`);
    const sessionId = started.data.sessionId;
    for (let waited = 0; ; waited += 250) {
      const snapshot = await state();
      if (snapshot.status === 'recording') break;
      if (snapshot.choice)
        throw new Error(`The recorder asked for a decision (${snapshot.choice}); no system audio?`);
      if (snapshot.status === 'error')
        throw new Error(`The recorder failed to start: ${JSON.stringify(snapshot.error)}`);
      if (waited > 60_000) throw new Error('Timed out waiting for the recording to start.');
      await sleep(250);
    }
    const recordingStart = Date.now();
    const before = await state();
    result.recordingStartedAtEpochMs = before.startedAt;
    log('recording; sampling every', SAMPLE_SEC, 's');

    const sessionDir = path.join(userData, 'recordings', sessionId);
    const samples = [];
    const recorderPage = () => app.windows().find((w) => w.url().includes('#/recorder'));
    for (let k = 1; ; k += 1) {
      const target = recordingStart + k * SAMPLE_SEC * 1000;
      if (target - recordingStart > DURATION_SEC * 1000) break;
      await sleep(Math.max(0, target - Date.now()));
      const t = (Date.now() - recordingStart) / 1000;
      const sample = { t: round(t, 1) };
      try {
        const metrics = await metricsOf();
        sample.processes = metrics.map((m) => ({
          pid: m.pid,
          type: m.type,
          // Electron reports percentCPUUsage as a share of the WHOLE machine (verified against the
          // OS's own CPU time: 100 = every core busy). x cores = percent of one core.
          cpu: round(m.cpu.percentCPUUsage * CORES, 2),
          wakeups: m.cpu.idleWakeupsPerSecond,
          workingSetMB: round(m.memory.workingSetSize / 1024, 1),
          privateMB: round(m.memory.privateBytes / 1024, 1),
        }));
        sample.totals = {
          processes: metrics.length,
          cpuPercentOfOneCore: round(sum(sample.processes.map((p) => p.cpu)), 2),
          workingSetMB: round(sum(sample.processes.map((p) => p.workingSetMB)), 1),
          privateMB: round(sum(sample.processes.map((p) => p.privateMB)), 1),
        };
      } catch (error) {
        sample.metricsError = String(error);
      }
      sample.machineCpuPercent = round(systemCpuPercent(), 1);
      try {
        const rec = recorderPage();
        if (rec) {
          sample.recorder = await rec.evaluate(() => {
            const resources = window.__frameCaptResources?.();
            const heap = performance.memory;
            return {
              liveTracks: resources?.liveTracks,
              audioContexts: resources?.openAudioContexts,
              activeLoops: resources?.activeLoops,
              loopNames: resources?.loopNames,
              activeRecorders: resources?.activeRecorders,
              jsHeapUsedMB: heap ? Math.round((heap.usedJSHeapSize / 1048576) * 10) / 10 : null,
            };
          });
        }
      } catch (error) {
        sample.recorderError = String(error);
      }
      try {
        const manifest = JSON.parse(
          fs.readFileSync(path.join(sessionDir, 'manifest.json'), 'utf8'),
        );
        sample.session = {
          chunksWritten: manifest.chunksWritten,
          bytesWritten: manifest.bytesWritten,
          queueHighWaterChunks: manifest.stats.queueHighWaterChunks,
          queueHighWaterBytes: manifest.stats.queueHighWaterBytes,
          mainQueueHighWater: manifest.stats.mainQueueHighWater,
          maxWriteMs: round(manifest.stats.maxWriteMs, 1),
          state: manifest.state,
        };
        sample.streamBytesOnDisk = fs.statSync(path.join(sessionDir, 'stream.webm')).size;
      } catch (error) {
        sample.sessionError = String(error.code ?? error);
      }
      if (k % 12 === 0) {
        const snapshot = await state();
        sample.status = snapshot.status;
        log(
          `t=${Math.round(t)}s cpu=${sample.totals?.cpuPercentOfOneCore}% (1 core) ws=${sample.totals?.workingSetMB}MB chunks=${sample.session?.chunksWritten} qHW=${sample.session?.queueHighWaterChunks} status=${snapshot.status}`,
        );
        if (snapshot.status !== 'recording')
          throw new Error(`The recording is ${snapshot.status}, not recording.`);
      }
      samples.push(sample);
    }

    // --- stop and finalize ------------------------------------------------------------------------
    const wallSec = (Date.now() - recordingStart) / 1000;
    const pidsAtEnd = (await metricsOf()).map((m) => m.pid);
    const cpuAtEnd = cpuSecondsOf(pidsAtEnd);
    const stopAt = Date.now();
    log('stopping');
    await page.evaluate(() => window.framecapt.invoke('recorder:stop'));
    let done = null;
    for (;;) {
      const snapshot = await state();
      if (snapshot.status === 'completed') {
        done = snapshot;
        break;
      }
      if (snapshot.status === 'error')
        throw new Error(`Finalization failed: ${JSON.stringify(snapshot.error)}`);
      if (Date.now() - stopAt > 15 * 60_000) throw new Error('Timed out waiting for finalization.');
      await sleep(500);
    }
    const finalizeSec = (Date.now() - stopAt) / 1000;
    const output = done.result;
    log(
      `finalized in ${finalizeSec.toFixed(1)} s: ${(output.bytes / 1048576).toFixed(0)} MB, app duration ${(output.durationMs / 1000).toFixed(1)} s`,
    );

    let completion = null;
    try {
      completion = JSON.parse(
        fs.readFileSync(
          path.join(userData, 'recordings', 'completed', `${sessionId}.json`),
          'utf8',
        ),
      );
    } catch (error) {
      result.notes.push(`completion record not readable: ${error}`);
    }
    await sleep(3000);
    const afterStop = await metricsOf();
    const recorderAfter = await (recorderPage()?.evaluate(() => window.__frameCaptResources?.()) ??
      null);

    // Beacon off before the (CPU heavy) analysis: nothing more to measure live.
    beacon.kill();
    await sleep(500);

    // --- analyse the file ---------------------------------------------------------------------------
    log('probing the output');
    const file = output.path;
    const probe = probeFile(file);
    const timing = frameTiming(file);
    log('counting decoded frames (full decode)');
    const decodeStart = Date.now();
    const framesDecoded = countFrames(file);
    const decodeSec = (Date.now() - decodeStart) / 1000;
    const durationSec = probe.durationSec;
    const audioSeconds = probe.audio ? decodedSeconds(file, 'audio') : null;
    const videoSeconds = timing.spanSec + (timing.meanGapMs ?? 0) / 1000;
    if (KEEP_DIR) {
      fs.mkdirSync(KEEP_DIR, { recursive: true });
      fs.copyFileSync(file, path.join(KEEP_DIR, `${baseName}.webm`));
    }

    const videoW = probe.video.width;
    const scale = videoW / primary.physicalSize.width;
    const b = beaconInfo.contentBounds;
    const crop = {
      x: Math.round(
        (b.x - primary.bounds.x) * primary.scaleFactor * scale +
          b.width * primary.scaleFactor * scale * 0.2,
      ),
      y: Math.round(
        (b.y - primary.bounds.y) * primary.scaleFactor * scale +
          b.height * primary.scaleFactor * scale * 0.2,
      ),
      width: Math.round(b.width * primary.scaleFactor * scale * 0.6),
      height: Math.round(b.height * primary.scaleFactor * scale * 0.6),
    };
    const windowSec = Math.min(120, Math.max(30, Math.floor(durationSec / 4)));
    log(
      `A/V sync windows of ${windowSec} s at the start and the end; crop ${JSON.stringify(crop)}`,
    );
    const startWindow = syncWindow(file, 5, windowSec, crop);
    const endWindow = syncWindow(file, Math.max(5, durationSec - windowSec - 5), windowSec, crop);
    const drift =
      startWindow.meanOffsetMs !== null && endWindow.meanOffsetMs !== null
        ? round(endWindow.meanOffsetMs - startWindow.meanOffsetMs, 1)
        : null;
    const driftMedian =
      startWindow.medianOffsetMs !== null && endWindow.medianOffsetMs !== null
        ? endWindow.medianOffsetMs - startWindow.medianOffsetMs
        : null;

    // --- summaries ----------------------------------------------------------------------------------
    const ok = samples.filter((s) => s.totals);
    const cpu = ok.map((s) => s.totals.cpuPercentOfOneCore);
    const afterWarm = ok.filter((s) => s.t >= WARMUP_SEC);
    const at = (seconds) =>
      ok.reduce(
        (best, s) => (Math.abs(s.t - seconds) < Math.abs(best.t - seconds) ? s : best),
        ok[0],
      );
    const warm = at(WARMUP_SEC);
    const last = ok.at(-1);
    const types = [...new Set(ok.flatMap((s) => s.processes.map((p) => p.type)))];
    const byType = Object.fromEntries(
      types.map((type) => {
        const series = (key) =>
          ok.map((s) => sum(s.processes.filter((p) => p.type === type).map((p) => p[key])));
        return [
          type,
          {
            cpuAvg: round(mean(series('cpu'))),
            cpuMax: round(Math.max(...series('cpu'))),
            workingSetAtWarmupMB: round(
              sum(warm.processes.filter((p) => p.type === type).map((p) => p.workingSetMB)),
              1,
            ),
            workingSetAtEndMB: round(
              sum(last.processes.filter((p) => p.type === type).map((p) => p.workingSetMB)),
              1,
            ),
            privateAtWarmupMB: round(
              sum(warm.processes.filter((p) => p.type === type).map((p) => p.privateMB)),
              1,
            ),
            privateAtEndMB: round(
              sum(last.processes.filter((p) => p.type === type).map((p) => p.privateMB)),
              1,
            ),
          },
        ];
      }),
    );
    const slopeOf = (key, series = afterWarm) =>
      slope(series.map((s) => ({ x: s.t / 60, y: s.totals[key] })));
    const stream = samples.filter((s) => s.streamBytesOnDisk !== undefined);
    const heap = samples.filter((s) => s.recorder?.jsHeapUsedMB != null);
    const crossCheck = {};
    let crossTotal = 0;
    for (const pid of Object.keys(cpuAtEnd)) {
      // A process that did not exist at the start (the recorder window is created by the first
      // recording) has used only CPU time since: its start value is zero.
      const delta = cpuAtEnd[pid] - (cpuAtStart[pid] ?? 0);
      crossCheck[pid] = round(delta, 2);
      crossTotal += delta;
    }

    result.finishedAt = new Date().toISOString();
    result.recording = {
      sessionId: '[session id]',
      wallSecondsRecording: round(wallSec, 1),
      appActiveSeconds: round(output.durationMs / 1000, 2),
      stopToCompletedSeconds: round(finalizeSec, 1),
      outputBytes: output.bytes,
      unindexed: output.unindexed,
      stats: completion?.stats ?? null,
      beaconRanSeconds: round((Date.now() - beaconStartedAt) / 1000, 0),
    };
    result.output = {
      probe,
      frames: {
        decoded: framesDecoded,
        decodeSeconds: round(decodeSec, 0),
        avgFps: round(framesDecoded / videoSeconds, 3),
        videoSeconds: round(videoSeconds, 3),
        ...timing,
      },
      audioSeconds: round(audioSeconds, 3),
      avgFpsFromContainer: round(timing.packets / durationSec, 3),
      audioMinusVideoDurationSec: round(
        audioSeconds === null ? null : audioSeconds - videoSeconds,
        3,
      ),
      containerMinusAppSeconds: round(durationSec - output.durationMs / 1000, 3),
    };
    result.avSync = {
      method:
        'beep onsets (1 kHz band, silencedetect) vs flash onsets (beacon crop brightness) in the recorded file; offset = flash minus beep',
      beaconCropInVideo: crop,
      start: startWindow,
      end: endWindow,
      driftMs: drift,
      driftMedianMs: driftMedian,
      driftNote:
        'drift = mean(end offsets) - mean(start offsets) (the beeps are 10.0111 s apart so successive beeps fall on different phases of the 30 fps frame grid and the quantisation averages out); constant latencies cancel',
    };
    result.process = {
      samples: ok.length,
      cpuPercentOfOneCore: {
        avg: round(mean(cpu)),
        avgAfterWarmup: round(mean(afterWarm.map((s) => s.totals.cpuPercentOfOneCore))),
        p95: round(percentile(cpu, 95)),
        max: round(Math.max(...cpu)),
        avgOfWholeMachinePercent: round(mean(cpu) / env.logicalCores, 2),
      },
      cpuByType: byType,
      memory: {
        warmupAtSec: warm.t,
        workingSetAtWarmupMB: warm.totals.workingSetMB,
        workingSetAtEndMB: last.totals.workingSetMB,
        workingSetGrowthMB: round(last.totals.workingSetMB - warm.totals.workingSetMB, 1),
        workingSetMaxMB: round(Math.max(...ok.map((s) => s.totals.workingSetMB)), 1),
        privateAtWarmupMB: warm.totals.privateMB,
        privateAtEndMB: last.totals.privateMB,
        privateGrowthMB: round(last.totals.privateMB - warm.totals.privateMB, 1),
        privateMaxMB: round(Math.max(...ok.map((s) => s.totals.privateMB)), 1),
        workingSetSlopeMBPerMinAfterWarmup: round(slopeOf('workingSetMB'), 3),
        privateSlopeMBPerMinAfterWarmup: round(slopeOf('privateMB'), 3),
      },
      processCountMin: Math.min(...ok.map((s) => s.totals.processes)),
      processCountMax: Math.max(...ok.map((s) => s.totals.processes)),
      osCpuSecondsPerPid: crossCheck,
      osCpuAvgPercentOfOneCore: round((100 * crossTotal) / wallSec, 2),
      osCpuNote:
        'TotalProcessorTime deltas of the processes alive at both ends (start/end of the recording); a cross-check of getAppMetrics',
      machineCpuPercentAvg: round(
        mean(ok.map((s) => s.machineCpuPercent).filter((v) => v !== null)),
        1,
      ),
      machineCpuPercentMax: round(Math.max(...ok.map((s) => s.machineCpuPercent ?? 0)), 1),
    };
    result.recorderWindow = {
      jsHeapAtWarmupMB: heap.length
        ? heap.reduce((best, s) =>
            Math.abs(s.t - WARMUP_SEC) < Math.abs(best.t - WARMUP_SEC) ? s : best,
          ).recorder.jsHeapUsedMB
        : null,
      jsHeapAtEndMB: heap.at(-1)?.recorder.jsHeapUsedMB ?? null,
      jsHeapMaxMB: heap.length ? Math.max(...heap.map((s) => s.recorder.jsHeapUsedMB)) : null,
      activeLoopsDuringRecording: [
        ...new Set(
          samples.map((s) => JSON.stringify([s.recorder?.activeLoops, s.recorder?.loopNames])),
        ),
      ].map((v) => JSON.parse(v)),
      liveTracksDuringRecording: [...new Set(samples.map((s) => s.recorder?.liveTracks))],
      audioContextsDuringRecording: [...new Set(samples.map((s) => s.recorder?.audioContexts))],
      afterStop: recorderAfter,
    };
    result.queue = {
      rendererQueueHighWaterChunks: completion?.stats?.queueHighWaterChunks ?? null,
      rendererQueueHighWaterBytes: completion?.stats?.queueHighWaterBytes ?? null,
      mainQueueHighWater: completion?.stats?.mainQueueHighWater ?? null,
      slowestWriteMs: round(completion?.stats?.maxWriteMs ?? null, 1),
      chunksWritten: samples.at(-1)?.session?.chunksWritten ?? null,
      limits: { maxPendingChunks: 16, maxPendingBytes: 64 * 1024 * 1024 },
    };
    result.disk = {
      streamBytesAtEnd: stream.at(-1)?.streamBytesOnDisk ?? null,
      avgGrowthMBPerMin:
        stream.length > 1
          ? round(
              (stream.at(-1).streamBytesOnDisk - stream[0].streamBytesOnDisk) /
                1048576 /
                ((stream.at(-1).t - stream[0].t) / 60),
              2,
            )
          : null,
      finalFileMB: round(output.bytes / 1048576, 1),
      streamVsFinalNote:
        'stream.webm (live MediaRecorder file) vs the remuxed output; the session folder is deleted after publishing',
    };
    result.afterStopMetrics = afterStop.map((m) => ({
      type: m.type,
      workingSetMB: round(m.memory.workingSetSize / 1024, 1),
    }));
    result.samples = samples;

    // Verify the clean stop: no recorder resources, session folder gone, only one electron.exe family.
    result.cleanup = {
      sessionDirRemoved: !fs.existsSync(sessionDir),
      partialFilesLeft: fs
        .readdirSync(path.dirname(file))
        .filter((name) => name.includes('.partial.')),
    };

    fs.writeFileSync(path.join(evidenceDir, `${baseName}.json`), redactedJson(result));
    fs.writeFileSync(path.join(evidenceDir, `${baseName}.md`), markdown(result));
    log(`written docs/evidence/phase09/${baseName}.{json,md}`);
  } finally {
    if (beacon && !beacon.killed) beacon.kill();
    if (app) {
      await app.evaluate(({ app: electronApp }) => electronApp.exit(0)).catch(() => undefined);
      await app.close().catch(() => undefined);
    }
    await sleep(1500);
    const left = electronProcessCount() - electronBefore;
    log(`electron.exe processes left behind by this run: ${left}`);
    fs.rmSync(work, { recursive: true, force: true, maxRetries: 10, retryDelay: 500 });
  }
}

function markdown(r) {
  const p = r.process;
  const o = r.output;
  const row = (...cells) => `| ${cells.join(' | ')} |`;
  const lines = [
    `# Recording benchmark ${r.plan.durationMin} min (${r.startedAt.slice(0, 10)})`,
    '',
    `Real capture of the primary display, ${r.plan.preset} / ${r.plan.fps} fps, system audio on (a tone plus a beep every 10 s, with a flashing window for A/V sync). ${r.build}.`,
    '',
    '## Environment',
    '',
    `- OS: ${r.environment.os}`,
    `- CPU: ${r.environment.cpu} (${r.environment.logicalCores} logical cores), RAM ${r.environment.ramGiB} GiB`,
    `- Electron ${r.environment.app?.electron} (Chromium ${r.environment.app?.chrome}), app ${r.environment.app?.version}; ${r.environment.ffmpeg}`,
    `- Displays: ${r.environment.displays.map((d) => `${d.physicalSize.width}x${d.physicalSize.height} @${d.scaleFactor}x${d.isPrimary ? ' (primary, recorded)' : ''}`).join(', ')}`,
    `- Duration: ${r.recording.wallSecondsRecording} s of wall time; ${r.process.samples} samples every ${r.plan.sampleSec} s`,
    '',
    '## Output',
    '',
    row('Property', 'Value'),
    row('---', '---'),
    row(
      'File',
      `${o.probe.container}, ${(o.probe.sizeBytes / 1048576).toFixed(0)} MB, ${o.probe.bitRateKbps} kbit/s`,
    ),
    row(
      'Video',
      `${o.probe.video.codec} ${o.probe.video.width}x${o.probe.video.height}, container duration ${o.probe.durationSec.toFixed(3)} s`,
    ),
    row(
      'Audio',
      o.probe.audio
        ? `${o.probe.audio.codec} ${o.probe.audio.sampleRate} Hz x${o.probe.audio.channels}, ${o.audioSeconds} s decoded`
        : 'none',
    ),
    row(
      'Frames (decoded)',
      `${o.frames.decoded} in ${o.frames.videoSeconds} s = ${o.frames.avgFps} fps`,
    ),
    row(
      'Frame gaps',
      `mean ${o.frames.meanGapMs} ms, p99 ${o.frames.p99GapMs} ms, max ${o.frames.maxGapMs} ms; >100 ms: ${o.frames.gapsOver100ms}, >250 ms: ${o.frames.gapsOver250ms}; slowest second ${o.frames.minFramesInASecond} frames`,
    ),
    row('Audio minus video length', `${o.audioMinusVideoDurationSec} s`),
    row('Container minus app active time', `${o.containerMinusAppSeconds} s`),
    row('Stop to completed', `${r.recording.stopToCompletedSeconds} s`),
    '',
    '## A/V sync (recorded file)',
    '',
    row(
      'Window',
      'beeps',
      'flashes',
      'pairs',
      'mean / median offset (flash - beep)',
      'offsets (ms)',
    ),
    row('---', '---', '---', '---', '---', '---'),
    row(
      `start (${r.avSync.start.fromSec}-${r.avSync.start.fromSec + r.avSync.start.lengthSec} s)`,
      r.avSync.start.beepsDetected,
      r.avSync.start.flashesDetected,
      r.avSync.start.pairs,
      `${r.avSync.start.meanOffsetMs} / ${r.avSync.start.medianOffsetMs} ms`,
      r.avSync.start.offsetsMs.join(', '),
    ),
    row(
      `end (${Math.round(r.avSync.end.fromSec)}-${Math.round(r.avSync.end.fromSec + r.avSync.end.lengthSec)} s)`,
      r.avSync.end.beepsDetected,
      r.avSync.end.flashesDetected,
      r.avSync.end.pairs,
      `${r.avSync.end.meanOffsetMs} / ${r.avSync.end.medianOffsetMs} ms`,
      r.avSync.end.offsetsMs.join(', '),
    ),
    '',
    `**Drift (end - start): ${r.avSync.driftMs} ms** (by medians: ${r.avSync.driftMedianMs} ms)`,
    '',
    '## Idle (before recording)',
    '',
    r.idle.seconds +
      ' s with the app open and no recording: ' +
      r.idle.electronMetricsPercentOfOneCore +
      ' % of one core by Electron metrics, ' +
      r.idle.osCpuPercentOfOneCore +
      ' % by the OS CPU time (' +
      r.idle.processes +
      ' processes).',
    '',
    '## CPU (whole process tree, % of one core; the machine has ' +
      r.environment.logicalCores +
      ' logical cores)',
    '',
    row('Metric', 'Value'),
    row('---', '---'),
    row(
      'Average',
      `${p.cpuPercentOfOneCore.avg} % (${p.cpuPercentOfOneCore.avgOfWholeMachinePercent} % of the machine)`,
    ),
    row('Average after warm-up', `${p.cpuPercentOfOneCore.avgAfterWarmup} %`),
    row('p95 / max', `${p.cpuPercentOfOneCore.p95} % / ${p.cpuPercentOfOneCore.max} %`),
    row('OS cross-check (TotalProcessorTime)', `${p.osCpuAvgPercentOfOneCore} % of one core`),
    row(
      'Machine total (beacon and harness included)',
      `avg ${p.machineCpuPercentAvg} %, max ${p.machineCpuPercentMax} %`,
    ),
    '',
    row(
      'Process type',
      'CPU avg %',
      'CPU max %',
      'working set at warm-up MB',
      'at end MB',
      'private at warm-up MB',
      'at end MB',
    ),
    row('---', '---', '---', '---', '---', '---', '---'),
    ...Object.entries(p.cpuByType).map(([type, v]) =>
      row(
        type,
        v.cpuAvg,
        v.cpuMax,
        v.workingSetAtWarmupMB,
        v.workingSetAtEndMB,
        v.privateAtWarmupMB,
        v.privateAtEndMB,
      ),
    ),
    '',
    '## Memory (sum over the tree)',
    '',
    row('Metric', 'Value'),
    row('---', '---'),
    row(
      `Working set at ${p.memory.warmupAtSec} s / at end`,
      `${p.memory.workingSetAtWarmupMB} MB / ${p.memory.workingSetAtEndMB} MB (growth ${p.memory.workingSetGrowthMB} MB, max ${p.memory.workingSetMaxMB} MB)`,
    ),
    row(
      `Private at ${p.memory.warmupAtSec} s / at end`,
      `${p.memory.privateAtWarmupMB} MB / ${p.memory.privateAtEndMB} MB (growth ${p.memory.privateGrowthMB} MB, max ${p.memory.privateMaxMB} MB)`,
    ),
    row(
      'Slope after warm-up (working set / private)',
      `${p.memory.workingSetSlopeMBPerMinAfterWarmup} / ${p.memory.privateSlopeMBPerMinAfterWarmup} MB per minute`,
    ),
    row(
      'Recorder window JS heap (warm-up / end / max)',
      `${r.recorderWindow.jsHeapAtWarmupMB} / ${r.recorderWindow.jsHeapAtEndMB} / ${r.recorderWindow.jsHeapMaxMB} MB`,
    ),
    row('Processes (min-max)', `${p.processCountMin}-${p.processCountMax}`),
    '',
    '## Queue, disk, resources',
    '',
    row('Metric', 'Value'),
    row('---', '---'),
    row(
      'Renderer queue high-water',
      `${r.queue.rendererQueueHighWaterChunks} chunks, ${r.queue.rendererQueueHighWaterBytes} bytes (limits ${r.queue.limits.maxPendingChunks} chunks / ${r.queue.limits.maxPendingBytes} bytes)`,
    ),
    row(
      'Main queue high-water / slowest write',
      `${r.queue.mainQueueHighWater} / ${r.queue.slowestWriteMs} ms`,
    ),
    row('Chunks written', r.queue.chunksWritten),
    row(
      'Disk growth of stream.webm',
      `${r.disk.avgGrowthMBPerMin} MB per minute, ${(r.disk.streamBytesAtEnd / 1048576).toFixed(0)} MB at the end; final file ${r.disk.finalFileMB} MB`,
    ),
    row(
      'Recorder window during recording: live tracks / audio contexts / loops',
      `${JSON.stringify(r.recorderWindow.liveTracksDuringRecording)} / ${JSON.stringify(r.recorderWindow.audioContextsDuringRecording)} / ${JSON.stringify(r.recorderWindow.activeLoopsDuringRecording)}`,
    ),
    row('After stop', JSON.stringify(r.recorderWindow.afterStop)),
    row(
      'Cleanup',
      `session folder removed: ${r.cleanup.sessionDirRemoved}; partial files left: ${r.cleanup.partialFilesLeft.length}`,
    ),
    '',
  ];
  if (r.notes.length) lines.push('## Notes', '', ...r.notes.map((n) => `- ${n}`), '');
  return `${lines.join('\n')}\n`;
}

main().catch((error) => {
  console.error('[bench] FAILED:', error);
  process.exitCode = 1;
});
