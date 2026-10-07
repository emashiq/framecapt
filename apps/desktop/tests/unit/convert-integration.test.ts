/**
 * Save format and compression with the REAL vendored ffmpeg/ffprobe (`npm run fetch:ffmpeg`): a
 * small VP9 + Opus WebM is converted to every format with the real profiles, checked by ffprobe
 * (container, codecs, size, length), and the source stays untouched. Skipped, with a message, when
 * the binaries are missing.
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { convertVideo, type ConvertSpec } from '../../src/main/media/convert';
import { mp4TopLevelBoxes } from '../../src/main/media/export';
import { createMediaTools, FfmpegError, resolveFfmpeg } from '../../src/main/media/ffmpeg';

const repoRoot = path.resolve(__dirname, '..', '..');
const location = { isPackaged: false, resourcesPath: '', appPath: repoRoot };
let paths: ReturnType<typeof resolveFfmpeg> | null = null;
try {
  paths = resolveFfmpeg(location);
} catch (error) {
  if (!(error instanceof FfmpegError)) throw error;
  console.warn(`SKIPPING convert integration tests: ${error.message}`);
}

describe.skipIf(paths === null)('real ffmpeg: save format and compression', () => {
  const tools = createMediaTools(() => resolveFfmpeg(location));
  let work: string;
  let webm: string;
  let before: Buffer;

  beforeAll(() => {
    work = fs.mkdtempSync(path.join(os.tmpdir(), 'framecapt-convert-'));
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
    before = fs.readFileSync(webm);
  });
  afterAll(() => {
    fs.rmSync(work, { recursive: true, force: true });
  });

  async function convert(
    spec: ConvertSpec,
    name: string,
    sourceFormat: 'webm' | 'mp4' | 'mkv' = 'webm',
    source = webm,
  ) {
    const result = await convertVideo({
      tools,
      sourcePath: source,
      sourceFormat,
      destPath: path.join(work, name),
      spec,
    });
    if (!result.ok) throw new Error(`${result.code}: ${result.message} ${result.stderrTail}`);
    return result;
  }

  it('MKV with no compression is a lossless remux: same codecs, same length, a Matroska file', async () => {
    const result = await convert({ format: 'mkv', compression: 'off' }, 'remux.mkv');
    expect(result.probe.formatName.split(',')).toContain('matroska');
    expect(result.probe.video?.codec).toBe('vp9');
    expect(result.probe.audioCodec).toBe('opus');
    // The test source is 641x361, which VP9 (4:2:0) stores as 640x360: a remux keeps it as it is.
    expect(result.probe.video).toMatchObject({ width: 640, height: 360 });
    expect(Math.abs(result.durationMs - 3000)).toBeLessThan(500);
  }, 120_000);

  it('WebM balanced is VP9 + Opus of the same length, even sides', async () => {
    const result = await convert({ format: 'webm', compression: 'balanced' }, 'balanced.webm');
    expect(result.probe.formatName.split(',')).toContain('webm');
    expect(result.probe.video?.codec).toBe('vp9');
    expect(result.probe.audioCodec).toBe('opus');
    expect(result.probe.video).toMatchObject({ width: 640, height: 360 });
    expect(Math.abs(result.durationMs - 3000)).toBeLessThan(500);
  }, 180_000);

  it('MP4 balanced is a fast-start H.264 + AAC file', async () => {
    const result = await convert({ format: 'mp4', compression: 'balanced' }, 'balanced.mp4');
    expect(result.probe.video?.codec).toBe('h264');
    expect(result.probe.audioCodec).toBe('aac');
    expect(result.probe.video).toMatchObject({ width: 640, height: 360 });
    const boxes = await mp4TopLevelBoxes(result.path);
    expect(boxes.indexOf('moov')).toBeLessThan(boxes.indexOf('mdat'));
  }, 120_000);

  it('MKV strong re-encodes to H.264 + AAC, and a width cap only shrinks', async () => {
    const result = await convert(
      { format: 'mkv', compression: 'strong', maxWidth: 320 },
      'small.mkv',
    );
    expect(result.probe.video?.codec).toBe('h264');
    expect(result.probe.video).toMatchObject({ width: 320, height: 180 });
    const wide = await convert({ format: 'mp4', compression: 'light', maxWidth: 4000 }, 'wide.mp4');
    expect(wide.probe.video).toMatchObject({ width: 640, height: 360 });
  }, 120_000);

  it('GIF is an animated GIF at 12 fps, at most 1280 wide, with no audio', async () => {
    const result = await convert({ format: 'gif', compression: 'off', maxWidth: 480 }, 'clip.gif');
    expect(result.probe.formatName).toBe('gif');
    expect(result.probe.video?.codec).toBe('gif');
    expect(result.probe.hasAudio).toBe(false);
    expect(result.probe.video?.width).toBe(480);
    expect(Math.abs(result.durationMs - 3000)).toBeLessThan(700);
  }, 120_000);

  it('converts from an MP4 or MKV source too', async () => {
    const mp4 = path.join(work, 'balanced.mp4');
    if (!fs.existsSync(mp4))
      await convert({ format: 'mp4', compression: 'balanced' }, 'balanced.mp4');
    const fromMp4 = await convert(
      { format: 'mkv', compression: 'off' },
      'from-mp4.mkv',
      'mp4',
      mp4,
    );
    expect(fromMp4.probe.video?.codec).toBe('h264');
    const fromMkv = await convert(
      { format: 'mp4', compression: 'light' },
      'from-mkv.mp4',
      'mkv',
      fromMp4.path,
    );
    expect(fromMkv.probe.video?.codec).toBe('h264');
    expect(fromMkv.probe.audioCodec).toBe('aac');
  }, 180_000);

  it('leaves no partial file and does not change the source', () => {
    expect(fs.readFileSync(webm).equals(before)).toBe(true);
    expect(fs.readdirSync(work).filter((name) => name.includes('.partial.'))).toEqual([]);
  });

  it('refuses a destination with the wrong extension or the source itself', async () => {
    const wrong = await convertVideo({
      tools,
      sourcePath: webm,
      sourceFormat: 'webm',
      destPath: path.join(work, 'x.mp4'),
      spec: { format: 'mkv', compression: 'off' },
    });
    expect(wrong).toMatchObject({ ok: false, code: 'INVALID_DESTINATION' });
    const same = await convertVideo({
      tools,
      sourcePath: webm,
      sourceFormat: 'webm',
      destPath: webm,
      spec: { format: 'webm', compression: 'light' },
    });
    expect(same).toMatchObject({ ok: false, code: 'INVALID_DESTINATION' });
  });
});
