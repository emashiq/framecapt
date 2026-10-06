/**
 * Video editor, text and audio: a text box with a background is drawn on the preview and an audio
 * clip (a WAV the test makes with ffmpeg; the file dialog of main is stubbed) is added; the MP4
 * export is probed (video, AAC audio, length) and sampled: the text box is on the picture only while
 * its item lasts, and the clip is audible only where it is. No production mocks are involved.
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import AxeBuilder from '@axe-core/playwright';
import {
  _electron as electron,
  expect,
  test,
  type ElectronApplication,
  type Page,
} from '@playwright/test';
import { exitApp } from './app-exit';
import { makeWebm, newId, seedHistory } from './history-fixtures';
import { FFMPEG, probeFile } from './media-fixtures';

const projectRoot = path.resolve(__dirname, '..', '..');
const SECONDS = 6;

let dir: string;
let clip: string;
let tone: string;
let app: ElectronApplication;
let page: Page;

function ffmpeg(args: string[]): { status: number | null; stderr: string; stdout: Buffer } {
  const run = spawnSync(FFMPEG, ['-hide_banner', '-y', ...args], {
    shell: false,
    windowsHide: true,
    maxBuffer: 16 * 1024 * 1024,
  });
  return { status: run.status, stderr: String(run.stderr), stdout: run.stdout };
}

/** Mean grey of a window of the frame at `seconds`. */
function meanGrey(
  file: string,
  seconds: number,
  x: number,
  y: number,
  w: number,
  h: number,
): number {
  const run = ffmpeg([
    ...['-v', 'error', '-ss', String(seconds), '-i', file, '-frames:v', '1'],
    ...['-vf', `crop=${w}:${h}:${x}:${y},format=gray`, '-f', 'rawvideo', '-'],
  ]);
  const bytes = [...run.stdout];
  return bytes.reduce((sum, value) => sum + value, 0) / bytes.length;
}

/** The loudest sample (dB) of the audio in `seconds` seconds from `from`. */
function loudness(file: string, from: number, seconds: number): number {
  const run = ffmpeg([
    ...['-ss', String(from), '-t', String(seconds), '-i', file, '-vn', '-af', 'volumedetect'],
    ...['-f', 'null', '-'],
  ]);
  const match = /max_volume: (-?[\d.]+|-inf) dB/.exec(run.stderr);
  if (!match) throw new Error(`no volume in: ${run.stderr.slice(-200)}`);
  return match[1] === '-inf' ? -Infinity : Number(match[1]);
}

test.describe.configure({ mode: 'serial' });

test.beforeAll(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'framecapt-e2e-video-overlays-'));
  const files = path.join(dir, 'files');
  fs.mkdirSync(files, { recursive: true });
  clip = path.join(files, 'screen.webm');
  makeWebm(clip, SECONDS, { size: '640x360', audio: false, codec: 'vp8' });
  tone = path.join(files, 'tone.wav');
  const made = ffmpeg(['-v', 'error', '-f', 'lavfi', '-i', 'sine=frequency=880:duration=2', tone]);
  expect(made.status).toBe(0);
  seedHistory(dir, [
    {
      id: newId(),
      type: 'recording',
      path: clip,
      createdAt: Date.now() - 60_000,
      width: 640,
      height: 360,
      durationMs: SECONDS * 1000,
      sizeBytes: fs.statSync(clip).size,
      format: 'webm',
      hasAudio: false,
      source: 'screen',
      fps: 30,
    },
  ]);
  app = await electron.launch({
    args: ['.'],
    cwd: projectRoot,
    env: {
      ...process.env,
      FRAMECAPT_USER_DATA_DIR: dir,
      FRAMECAPT_E2E_MOCK_CAPTURE: '1',
      FRAMECAPT_E2E_MOCK_DISPLAYS: '1',
      FRAMECAPT_E2E_FAKE_SHORTCUTS: '1',
    },
  });
  page = await app.firstWindow();
  await page.waitForLoadState('domcontentloaded');
  await expect(page.getByTestId('shot-region')).toBeVisible();
  // The Open dialog of main answers with the WAV; nothing native opens.
  await app.evaluate(({ dialog }, file) => {
    dialog.showOpenDialog = () => Promise.resolve({ canceled: false, filePaths: [file] });
  }, tone);
});

test.afterAll(async () => {
  if (app) await exitApp(app);
  if (dir) fs.rmSync(dir, { recursive: true, force: true });
});

test('a text box and an audio clip are added from the tool bar', async () => {
  await page
    .getByRole('navigation', { name: 'Primary' })
    .getByRole('button', { name: 'History' })
    .click();
  await page.getByTestId('history-item').first().locator('[data-card-main]').click();
  await page.getByTestId('details-edit').click();
  await expect(page.getByTestId('video-timeline')).toBeVisible();
  await expect
    .poll(() => page.getByTestId('video-preview').evaluate((v: HTMLVideoElement) => v.readyState))
    .toBeGreaterThanOrEqual(2);

  // Text: drag a box on the preview, type the words, give it a background.
  await page.getByTestId('tool-text').click();
  const overlay = page.getByTestId('video-overlay');
  const box = await overlay.boundingBox();
  if (!box) throw new Error('no preview');
  await page.mouse.move(box.x + box.width * 0.2, box.y + box.height * 0.6);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * 0.8, box.y + box.height * 0.9, { steps: 6 });
  await page.mouse.up();
  await expect(page.getByTestId('timeline-item-text')).toHaveCount(1);
  await page.getByTestId('text-content').fill('Hello FrameCapt');
  await expect(page.getByTestId('timeline-item-text')).toContainText('Hello FrameCapt');
  await page.getByTestId('text-background').click();
  await expect(page.getByTestId('text-background-color')).toBeVisible();
  await page.getByTestId('text-background-opacity').fill('100');
  // Italic, an outline and a fade are plain controls.
  await page.getByTestId('text-italic').click();
  await expect(page.getByTestId('text-italic')).toHaveAttribute('aria-checked', 'true');

  // Audio: the stubbed dialog gives the WAV; it lands on the audio track at the playhead.
  await page.getByTestId('tool-audio').click();
  await expect(page.getByTestId('timeline-item-audio')).toHaveCount(1);
  await expect(page.getByTestId('audio-name')).toContainText('tone.wav');
  await expect(page.getByTestId('timeline-item-audio')).toContainText('tone.wav');

  // The clip is a copy in the project's assets, named by its hash; the user's file is untouched.
  await expect(page.getByTestId('video-save-status')).toHaveText('All changes saved');
  const projects = path.join(dir, 'video-projects');
  const [projectId] = fs.readdirSync(projects);
  const assets = fs.readdirSync(path.join(projects, projectId ?? '', 'assets'));
  expect(assets).toHaveLength(1);
  expect(assets[0]).toMatch(/^[0-9a-f]{64}\.wav$/);
  expect(fs.existsSync(tone)).toBe(true);
  const saved = JSON.parse(
    fs.readFileSync(path.join(projects, projectId ?? '', 'project.json'), 'utf8'),
  );
  expect(saved.items.map((item: { kind: string }) => item.kind).sort()).toEqual(['audio', 'text']);
  // The source's rate is the recorder's (the history item carries it).
  expect(saved.source.fps).toBe(30);
});

test('playing with a clip on the track works, and the text and audio panels have no violations', async () => {
  // A mouse click on a tool button must not leave it holding the keyboard (Space would press it again).
  expect(
    await page.evaluate(
      () => (document.activeElement as HTMLElement | null)?.dataset['testid'] ?? '',
    ),
  ).not.toBe('tool-audio');
  await page.keyboard.press('Home');
  await page.keyboard.press('Space');
  await page.waitForTimeout(500);
  await page.keyboard.press('Space');
  await expect(page.getByTestId('video-play')).toHaveAttribute('aria-label', 'Play');
  for (const theme of ['light', 'dark'] as const) {
    const set = await page.evaluate(
      (value) =>
        window.framecapt.invoke('settings:update', { patch: { general: { theme: value } } }),
      theme,
    );
    expect(set.ok).toBe(true);
    await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
    await page.waitForTimeout(400);
    for (const kind of ['text', 'audio'] as const) {
      await page.getByTestId(`timeline-item-${kind}`).click();
      await expect(page.getByTestId('inspector-item')).toBeVisible();
      const results = await new AxeBuilder({ page })
        .setLegacyMode()
        .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
        .include('[data-testid="video-editor"]')
        .analyze();
      expect(
        results.violations.map(
          (violation) =>
            `${violation.id}: ${violation.nodes.map((node) => node.target.join(' ')).join(' | ')}`,
        ),
        `${kind} panel, ${theme}`,
      ).toEqual([]);
    }
  }
  await page.evaluate(() =>
    window.framecapt.invoke('settings:update', { patch: { general: { theme: 'system' } } }),
  );
});

test('the export has the text only while it lasts and the clip only where it is', async () => {
  await page.getByTestId('video-export').click();
  await expect(page.locator('[data-sonner-toast]', { hasText: 'MP4 exported' })).toBeVisible({
    timeout: 90_000,
  });
  const output = path.join(path.dirname(clip), 'screen (edited).mp4');
  const probed = probeFile(output);
  expect(probed.streams.find((s) => s.codec_type === 'video')).toMatchObject({
    codec_name: 'h264',
    width: 640,
    height: 360,
  });
  expect(probed.streams.find((s) => s.codec_type === 'audio')?.codec_name).toBe('aac');
  expect(Math.abs(Number(probed.format?.duration) - SECONDS)).toBeLessThan(0.4);

  // The text lasts three seconds from the start; its box is dark (a black background) meanwhile.
  const inside = meanGrey(output, 1, 135, 225, 40, 25);
  const after = meanGrey(output, 4.5, 135, 225, 40, 25);
  expect(inside).toBeLessThan(after - 25);
  // The 2 s tone plays from the start of the recording; the rest of the track is silent.
  expect(loudness(output, 0.3, 0.8)).toBeGreaterThan(-30);
  expect(loudness(output, 3, 1)).toBeLessThan(-60);
});
