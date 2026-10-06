/**
 * Compressed storage with the REAL vendored ffmpeg/ffprobe (`npm run fetch:ffmpeg`): a small VP9 +
 * Opus WebM is re-encoded with the "compressed" profile into an H.264 + AAC MP4 with the same
 * length, and the source stays untouched. Skipped, with a message, when the binaries are missing.
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { exportMp4, mp4TopLevelBoxes } from '../../src/main/media/export';
import { createMediaTools, FfmpegError, resolveFfmpeg } from '../../src/main/media/ffmpeg';

const repoRoot = path.resolve(__dirname, '..', '..');
const location = { isPackaged: false, resourcesPath: '', appPath: repoRoot };
let paths: ReturnType<typeof resolveFfmpeg> | null = null;
try {
  paths = resolveFfmpeg(location);
} catch (error) {
  if (!(error instanceof FfmpegError)) throw error;
  console.warn(`SKIPPING compress integration tests: ${error.message}`);
}

describe.skipIf(paths === null)('real ffmpeg: compressed storage', () => {
  const tools = createMediaTools(() => resolveFfmpeg(location));
  let work: string;
  let webm: string;

  beforeAll(() => {
    work = fs.mkdtempSync(path.join(os.tmpdir(), 'framecapt-compress-'));
    webm = path.join(work, 'Clip.webm');
    const run = spawnSync(
      paths?.ffmpeg ?? '',
      [
        ...['-hide_banner', '-v', 'error', '-y'],
        ...['-f', 'lavfi', '-i', 'testsrc2=size=641x361:rate=30'],
        ...['-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000'],
        ...['-t', '3', '-c:v', 'libvpx-vp9', '-b:v', '1M', '-c:a', 'libopus', webm],
      ],
      { shell: false, encoding: 'utf8', windowsHide: true },
    );
    if (run.status !== 0) throw new Error(`could not make a test file: ${run.stderr}`);
  });
  afterAll(() => {
    fs.rmSync(work, { recursive: true, force: true });
  });

  it('makes a valid fast-start H.264 + AAC MP4 of the same length and leaves the WebM alone', async () => {
    const before = fs.readFileSync(webm);
    const dest = path.join(work, 'Clip.mp4');
    const result = await exportMp4({
      tools,
      sourcePath: webm,
      destPath: dest,
      profile: 'compressed',
    });
    if (!result.ok) throw new Error(`${result.code}: ${result.message} ${result.stderrTail}`);
    expect(result.probe.video?.codec).toBe('h264');
    expect(result.probe.audioCodec).toBe('aac');
    expect(result.probe.video).toMatchObject({ width: 640, height: 360 });
    expect(Math.abs(result.durationMs - 3000)).toBeLessThan(500);
    const boxes = await mp4TopLevelBoxes(dest);
    expect(boxes.indexOf('moov')).toBeLessThan(boxes.indexOf('mdat'));
    expect(fs.readFileSync(webm).equals(before)).toBe(true);
    expect(fs.readdirSync(work).filter((name) => name.includes('.partial.'))).toEqual([]);
  }, 120_000);
});
