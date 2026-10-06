import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { createCanvas } from '@napi-rs/canvas';
import { FFMPEG } from './media-fixtures';

/** Mock content for the History tests and screenshots: nothing here is a real capture. */

export interface SeedFile {
  id: string;
  type: 'screenshot' | 'recording';
  path: string;
  createdAt: number;
  width: number;
  height: number;
  durationMs: number | null;
  sizeBytes: number;
  format: 'png' | 'jpeg' | 'webm' | 'mp4' | 'gif';
  fps?: number;
  hasAudio: boolean | null;
  source: 'screen' | 'window' | 'region' | 'unknown';
  derivedFrom?: string | null;
  /** false: no thumbnail file is written (the entry shows the placeholder). */
  thumb?: boolean;
}

const PALETTES = [
  ['#4f46e5', '#818cf8'],
  ['#0891b2', '#67e8f9'],
  ['#059669', '#6ee7b7'],
  ['#d97706', '#fcd34d'],
  ['#db2777', '#f9a8d4'],
  ['#475569', '#cbd5e1'],
];

type Context = ReturnType<ReturnType<typeof createCanvas>['getContext']>;

/** A made-up app window: title bar, sidebar, a chart and lines of "text". Deterministic per seed. */
function drawMock(g: Context, width: number, height: number, seed: number): void {
  const [dark = '#4f46e5', light = '#818cf8'] = PALETTES[seed % PALETTES.length] ?? [];
  const u = width / 160; // unit
  g.fillStyle = '#e2e8f0';
  g.fillRect(0, 0, width, height);
  g.fillStyle = '#ffffff';
  g.fillRect(4 * u, 4 * u, width - 8 * u, height - 8 * u);
  g.fillStyle = dark;
  g.fillRect(4 * u, 4 * u, width - 8 * u, 7 * u);
  for (let i = 0; i < 3; i += 1) {
    g.fillStyle = 'rgba(255,255,255,0.8)';
    g.beginPath();
    g.arc((8 + i * 5) * u, 7.5 * u, 1.4 * u, 0, Math.PI * 2);
    g.fill();
  }
  g.fillStyle = '#f1f5f9';
  g.fillRect(4 * u, 11 * u, 30 * u, height - 15 * u);
  for (let i = 0; i < 6; i += 1) {
    g.fillStyle = i === seed % 6 ? light : '#cbd5e1';
    g.fillRect(7 * u, (16 + i * 8) * u, 24 * u, 3.5 * u);
  }
  const baseY = height - 14 * u;
  for (let i = 0; i < 9; i += 1) {
    const h = (8 + ((i * 7 + seed * 5) % 23)) * u;
    g.fillStyle = i % 3 === 0 ? dark : light;
    g.fillRect((42 + i * 9) * u, baseY - h, 6 * u, h);
  }
  for (let i = 0; i < 5; i += 1) {
    g.fillStyle = '#cbd5e1';
    g.fillRect(42 * u, (16 + i * 4.2) * u, (60 - ((i * 13 + seed * 7) % 24)) * u, 1.8 * u);
  }
  g.fillStyle = light;
  g.fillRect(110 * u, 16 * u, 40 * u, 18 * u);
  g.fillStyle = '#f1f5f9';
  g.fillRect(110 * u, 38 * u, 40 * u, 4 * u);
  g.fillRect(110 * u, 45 * u, 28 * u, 4 * u);
}

export function mockScreenshotPng(width: number, height: number, seed: number): Buffer {
  const canvas = createCanvas(width, height);
  drawMock(canvas.getContext('2d'), width, height, seed);
  return canvas.toBuffer('image/png');
}

/** The mock scaled down to at most `maxWidth` (a stand-in for the editor's flattened thumbnail). */
export function scaledPng(width: number, height: number, seed: number, maxWidth = 480): Buffer {
  const full = createCanvas(width, height);
  drawMock(full.getContext('2d'), width, height, seed);
  const scale = Math.min(1, maxWidth / width);
  const out = createCanvas(Math.round(width * scale), Math.round(height * scale));
  const g = out.getContext('2d');
  g.imageSmoothingQuality = 'high';
  g.drawImage(full, 0, 0, out.width, out.height);
  return out.toBuffer('image/png');
}

function ffmpeg(args: string[]): void {
  const run = spawnSync(FFMPEG, ['-hide_banner', '-v', 'error', '-y', ...args], {
    shell: false,
    encoding: 'utf8',
    windowsHide: true,
  });
  if (run.status !== 0) throw new Error(`ffmpeg failed: ${run.stderr}`);
}

/** A real VP9 (+ Opus) WebM of a moving test pattern (a stand-in for a recording). */
export function makeWebm(
  file: string,
  seconds: number,
  options: { size?: string; audio?: boolean; codec?: 'vp9' | 'vp8' } = {},
): void {
  const { size = '640x360', audio = true, codec = 'vp9' } = options;
  ffmpeg([
    ...['-f', 'lavfi', '-i', `testsrc2=size=${size}:rate=30`],
    ...(audio ? ['-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000'] : []),
    ...['-t', String(seconds)],
    ...(codec === 'vp9'
      ? ['-c:v', 'libvpx-vp9', '-deadline', 'realtime', '-cpu-used', '8']
      : ['-c:v', 'libvpx', '-deadline', 'realtime', '-cpu-used', '8']),
    ...(audio ? ['-c:a', 'libopus'] : []),
    file,
  ]);
}

export function videoThumbPng(file: string, out: string, seekSec = 1): void {
  ffmpeg(['-ss', String(seekSec), '-i', file, '-frames:v', '1', '-vf', 'scale=480:-2', out]);
}

/**
 * Writes `history/history.json` and the thumbnails of `items` below `userDataDir`. The files the
 * items point to must already exist (except for "missing" ones, which are meant not to).
 */
export function seedHistory(userDataDir: string, items: SeedFile[]): void {
  const dir = path.join(userDataDir, 'history');
  const thumbs = path.join(dir, 'thumbs');
  fs.mkdirSync(thumbs, { recursive: true });
  const entries = items.map((item, index) => {
    let thumbnail: string | null = null;
    if (item.thumb !== false) {
      thumbnail = `${item.id}.png`;
      const target = path.join(thumbs, thumbnail);
      if (item.type === 'screenshot') {
        fs.writeFileSync(target, scaledPng(item.width || 1600, item.height || 900, index, 480));
      } else if (fs.existsSync(item.path)) {
        videoThumbPng(item.path, target, 1);
      } else {
        thumbnail = null;
      }
    }
    return {
      id: item.id,
      type: item.type,
      createdAt: item.createdAt,
      path: item.path,
      width: item.width,
      height: item.height,
      durationMs: item.durationMs,
      sizeBytes: item.sizeBytes,
      format: item.format,
      thumbnail,
      hasAudio: item.hasAudio,
      source: item.source,
      derivedFrom: item.derivedFrom ?? null,
      ...(item.fps !== undefined && { fps: item.fps }),
    };
  });
  fs.writeFileSync(
    path.join(dir, 'history.json'),
    `${JSON.stringify({ version: 1, backfilled: true, items: entries }, null, 2)}\n`,
  );
}

export const newId = (): string => randomUUID();
