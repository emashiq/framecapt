/**
 * MP4 export with the REAL vendored ffmpeg/ffprobe (`npm run fetch:ffmpeg`): a 4 s VP9 + Opus WebM
 * made by ffmpeg itself is exported, probed (H.264 + AAC, duration within 0.5 s), checked for fast
 * start (moov before mdat) and fully decoded. Cancel at about 30 % must leave the original
 * byte-identical (SHA-256) and no partial file or running encoder, and a retry must succeed; a
 * corrupt or unwritable job must surface an error and leave the original alone. Skipped, with a
 * message, when the binaries are not fetched. FRAMELET_WRITE_EVIDENCE=1 writes
 * docs/evidence/phase07/export-integration.json.
 */
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { detectMp4Capability, exportMp4, mp4TopLevelBoxes } from '../../src/main/media/export';
import { createMediaTools, FfmpegError, resolveFfmpeg } from '../../src/main/media/ffmpeg';
import { writeEvidenceJson } from '../native/evidence';

const repoRoot = path.resolve(__dirname, '..', '..');
const location = { isPackaged: false, resourcesPath: '', appPath: repoRoot };
let paths: ReturnType<typeof resolveFfmpeg> | null = null;
try {
  paths = resolveFfmpeg(location);
} catch (error) {
  if (!(error instanceof FfmpegError)) throw error;
  console.warn(`SKIPPING export integration tests: ${error.message}`);
}

const evidence: Record<string, unknown> = {};
const sha = (file: string): string =>
  createHash('sha256').update(fs.readFileSync(file)).digest('hex');

describe.skipIf(paths === null)('real ffmpeg: MP4 export', () => {
  const tools = createMediaTools(() => resolveFfmpeg(location));
  let work: string;
  let webm: string; // 4 s, VP9 + Opus, 640x360
  let silent: string; // 3 s, VP8, odd size 641x361, no audio
  let long: string; // 40 s 1080p, quick to make, slow enough to cancel

  function ffmpeg(args: string[]): void {
    const run = spawnSync(paths?.ffmpeg ?? '', ['-hide_banner', '-v', 'error', '-y', ...args], {
      shell: false,
      encoding: 'utf8',
      windowsHide: true,
    });
    if (run.status !== 0) throw new Error(`could not make a test file: ${run.stderr}`);
  }

  function decodeStatus(file: string): { status: number | null; stderr: string } {
    const run = spawnSync(paths?.ffmpeg ?? '', ['-v', 'error', '-i', file, '-f', 'null', '-'], {
      shell: false,
      encoding: 'utf8',
      windowsHide: true,
    });
    return { status: run.status, stderr: run.stderr.trim() };
  }

  function runningEncodersFor(marker: string): boolean {
    const script =
      'Get-CimInstance Win32_Process -Filter "Name=\'ffmpeg.exe\'" | ForEach-Object { $_.CommandLine }';
    const encoded = Buffer.from(script, 'utf16le').toString('base64');
    const out = spawnSync(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded],
      { shell: false, encoding: 'utf8', windowsHide: true },
    ).stdout;
    return out.includes(marker);
  }

  beforeAll(() => {
    work = fs.mkdtempSync(path.join(os.tmpdir(), 'framelet-export-'));
    webm = path.join(work, 'Framelet test.webm');
    ffmpeg([
      ...['-f', 'lavfi', '-i', 'testsrc2=size=640x360:rate=30'],
      ...['-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000'],
      ...['-t', '4', '-c:v', 'libvpx-vp9', '-deadline', 'realtime', '-cpu-used', '8'],
      ...['-c:a', 'libopus', webm],
    ]);
    silent = path.join(work, 'silent odd.webm');
    ffmpeg([
      ...['-f', 'lavfi', '-i', 'testsrc2=size=641x361:rate=30', '-t', '3'],
      ...['-c:v', 'libvpx', '-deadline', 'realtime', '-cpu-used', '8', silent],
    ]);
    long = path.join(work, 'long.webm');
    ffmpeg([
      ...['-f', 'lavfi', '-i', 'testsrc2=size=1920x1080:rate=30'],
      ...['-f', 'lavfi', '-i', 'sine=frequency=330:sample_rate=48000'],
      ...['-t', '40', '-c:v', 'mpeg4', '-q:v', '4', '-c:a', 'libopus', '-f', 'matroska', long],
    ]);
  }, 120_000);

  afterAll(() => {
    fs.rmSync(work, { recursive: true, force: true });
    if (process.env.FRAMELET_WRITE_EVIDENCE === '1') {
      writeEvidenceJson(
        path.join(repoRoot, 'docs', 'evidence', 'phase07'),
        'export-integration.json',
        evidence,
      );
    }
  });

  it('the bundled build offers MP4 (libx264 and the native aac encoder)', async () => {
    const capability = await detectMp4Capability(tools);
    expect(capability).toEqual({ available: true });
    evidence.capability = capability;
    evidence.ffmpeg = await tools.version();
  });

  it('exports H.264 + AAC with the same duration, fast start, and decodes cleanly', async () => {
    const dest = path.join(work, 'out.mp4');
    const before = sha(webm);
    const sourceProbe = await tools.probe(webm);
    const percents: (number | null)[] = [];
    const started = Date.now();
    const result = await exportMp4({
      tools,
      sourcePath: webm,
      destPath: dest,
      onProgress: (percent) => percents.push(percent),
    });
    const elapsedMs = Date.now() - started;
    expect(result.ok).toBe(true);
    const probe = await tools.probe(dest);
    expect(probe.video?.codec).toBe('h264');
    expect(probe.video?.pixFmt).toBe('yuv420p');
    expect(probe.audioCodec).toBe('aac');
    expect(probe.formatName).toContain('mp4');
    expect(Math.abs((probe.durationSec ?? 0) - (sourceProbe.durationSec ?? 0))).toBeLessThanOrEqual(
      0.5,
    );
    const boxes = await mp4TopLevelBoxes(dest);
    expect(boxes.indexOf('moov')).toBeGreaterThan(-1);
    expect(boxes.indexOf('moov')).toBeLessThan(boxes.indexOf('mdat'));
    const decode = decodeStatus(dest);
    expect(decode).toEqual({ status: 0, stderr: '' });
    expect(percents.at(-1)).toBe(100);
    expect(percents.slice(0, -1).every((p) => p === null || (p >= 0 && p <= 99))).toBe(true);
    expect(sha(webm)).toBe(before);
    expect(fs.readdirSync(work).filter((name) => name.includes('.partial.'))).toEqual([]);
    evidence.export = {
      source: {
        durationSec: sourceProbe.durationSec,
        codec: sourceProbe.video?.codec,
        audio: sourceProbe.audioCodec,
        bytes: fs.statSync(webm).size,
      },
      output: {
        durationSec: probe.durationSec,
        codec: probe.video?.codec,
        pixFmt: probe.video?.pixFmt,
        audio: probe.audioCodec,
        bytes: fs.statSync(dest).size,
        topLevelBoxes: boxes,
        decodeExit: decode.status,
        decodeStderr: decode.stderr,
      },
      progressReports: percents,
      elapsedMs,
    };
  }, 60_000);

  it('rounds odd sizes down to even ones and a silent source stays silent', async () => {
    const dest = path.join(work, 'silent.mp4');
    expect((await exportMp4({ tools, sourcePath: silent, destPath: dest })).ok).toBe(true);
    const probe = await tools.probe(dest);
    expect(probe.video).toMatchObject({ width: 640, height: 360, codec: 'h264' });
    expect(probe.hasAudio).toBe(false);
    expect(decodeStatus(dest)).toEqual({ status: 0, stderr: '' });
    evidence.oddSize = {
      in: '641x361',
      out: `${probe.video?.width}x${probe.video?.height}`,
      audio: probe.hasAudio,
    };
  }, 60_000);

  it('cancel at about 30 % keeps the original byte-identical, leaves no partial file, and a retry works', async () => {
    const dest = path.join(work, 'cancelled.mp4');
    const before = sha(long);
    const controller = new AbortController();
    let cancelledAt: number | null = null;
    const started = Date.now();
    const result = await exportMp4({
      tools,
      sourcePath: long,
      destPath: dest,
      signal: controller.signal,
      onProgress: (percent) => {
        if (percent !== null && percent >= 30 && cancelledAt === null) {
          cancelledAt = percent;
          controller.abort();
        }
      },
    });
    const cancelMs = Date.now() - started;
    expect(cancelledAt, 'the export finished before it could be cancelled').not.toBeNull();
    expect(result).toMatchObject({ ok: false, code: 'CANCELLED' });
    expect(fs.existsSync(dest)).toBe(false);
    expect(fs.readdirSync(work).filter((name) => name.includes('.partial.'))).toEqual([]);
    expect(runningEncodersFor('framelet-export-')).toBe(false);
    expect(sha(long)).toBe(before);

    // Retry (not cancelled this time) works.
    const retry = await exportMp4({ tools, sourcePath: long, destPath: dest });
    expect(retry.ok).toBe(true);
    const probe = await tools.probe(dest);
    expect(probe.video?.codec).toBe('h264');
    expect(Math.abs((probe.durationSec ?? 0) - 40)).toBeLessThanOrEqual(0.5);
    expect(sha(long)).toBe(before);
    evidence.cancelRetry = {
      cancelledAtPercent: cancelledAt,
      msToCancel: cancelMs,
      originalSha256Unchanged: true,
      partialFilesLeft: 0,
      encoderProcessLeft: false,
      retryOk: true,
      retryDurationSec: probe.durationSec,
    };
  }, 120_000);

  it('a corrupt input surfaces an error and leaves the file alone', async () => {
    const corrupt = path.join(work, 'corrupt.webm');
    fs.writeFileSync(corrupt, Buffer.from('this is definitely not a webm file '.repeat(200)));
    const before = sha(corrupt);
    const dest = path.join(work, 'corrupt.mp4');
    const result = await exportMp4({ tools, sourcePath: corrupt, destPath: dest });
    expect(result).toMatchObject({ ok: false, code: 'SOURCE_UNREADABLE' });
    expect(fs.existsSync(dest)).toBe(false);
    expect(sha(corrupt)).toBe(before);
    evidence.corruptInput = { code: result.ok ? null : result.code };
  });

  it('a truncated recording either exports something playable or fails cleanly', async () => {
    const bytes = fs.readFileSync(webm);
    const cut = path.join(work, 'cut.webm');
    fs.writeFileSync(cut, bytes.subarray(0, Math.floor(bytes.length * 0.6)));
    const before = sha(cut);
    const dest = path.join(work, 'cut.mp4');
    const result = await exportMp4({ tools, sourcePath: cut, destPath: dest });
    if (result.ok) {
      expect(decodeStatus(dest).status).toBe(0);
    } else {
      expect(fs.existsSync(dest)).toBe(false);
    }
    expect(fs.readdirSync(work).filter((name) => name.includes('.partial.'))).toEqual([]);
    expect(sha(cut)).toBe(before);
    evidence.truncatedInput = { outcome: result.ok ? 'exported' : result.code };
  }, 60_000);

  it('an unwritable destination fails with an error and leaves the source alone', async () => {
    const before = sha(webm);
    const result = await exportMp4({
      tools,
      sourcePath: webm,
      destPath: path.join(work, 'no-such-folder', 'x.mp4'),
    });
    expect(result.ok).toBe(false);
    expect(sha(webm)).toBe(before);
    evidence.unwritableDestination = { code: result.ok ? null : result.code };
  });
});
