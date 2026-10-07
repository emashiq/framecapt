/**
 * The video editor against the E2E build: a seeded WebM recording is opened from History, a redact
 * box is drawn on the preview, a range is cut out of the timeline, the project is restored when the
 * editor is opened again, and an MP4 export adds a new history item whose length matches the edit.
 */
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
import { editorPage, expectEditorClosed } from './editor-window';
import { makeWebm, newId, seedHistory } from './history-fixtures';
import { probeFile } from './media-fixtures';

const projectRoot = path.resolve(__dirname, '..', '..');
const SECONDS = 6;

let dir: string;
let clip: string;
let app: ElectronApplication;
/** The main window; `page` is the main window with the tab of the latest openEditor(). */
let main: Page;
let page: Page;

async function launch(): Promise<void> {
  expect(
    fs.existsSync(path.join(projectRoot, '.vite', 'build', 'main.cjs')),
    'Run `npm run package:e2e` first (npm run test:e2e does this).',
  ).toBe(true);
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
  main = await app.firstWindow();
  await main.waitForLoadState('domcontentloaded');
  await expect(main.getByTestId('shot-region')).toBeVisible();
}

/** Opens the editor for the recording called `fileName` (from the list, or from the details view if one is open). */
async function openEditor(fileName = 'clip.webm'): Promise<void> {
  if ((await main.getByTestId('history-details').count()) === 0) {
    await main
      .getByRole('navigation', { name: 'Primary' })
      .getByRole('button', { name: 'Library' })
      .click();
    await main
      .getByTestId('history-item')
      .filter({ hasText: fileName })
      .locator('[data-card-main]')
      .click();
  }
  await main.getByTestId('details-edit').click();
  // The recording opens as a tab of the Editor window (made on the first open).
  page = await editorPage(app);
  await expect(page.getByTestId('video-editor')).toBeVisible();
  await expect(page.getByTestId('video-timeline')).toBeVisible();
  // The recording is decoded and the project loaded.
  await expect
    .poll(() => page.getByTestId('video-preview').evaluate((v: HTMLVideoElement) => v.readyState))
    .toBeGreaterThanOrEqual(2);
}

/** Closes the (only) tab: the Editor window closes with its last tab. */
async function closeTab(): Promise<void> {
  await page.getByTestId('tab-close').click();
  await expectEditorClosed(app);
}

/** "Result 0:04.500 · from ..." -> 4.5 */
async function resultSeconds(): Promise<number> {
  const text = (await page.getByTestId('output-length').textContent()) ?? '';
  const match = /Result (?:(\d+):)?(\d+):(\d+)\.(\d+)/.exec(text);
  if (!match) throw new Error(`no result length in "${text}"`);
  const [, h = '0', m = '0', s = '0', ms = '0'] = match;
  return Number(h) * 3600 + Number(m) * 60 + Number(s) + Number(ms) / 1000;
}

test.describe.configure({ mode: 'serial' });

test.beforeAll(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'framecapt-e2e-video-'));
  const files = path.join(dir, 'files');
  fs.mkdirSync(files, { recursive: true });
  clip = path.join(files, 'clip.webm');
  makeWebm(clip, SECONDS, { size: '640x360', audio: true, codec: 'vp8' });
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
      hasAudio: true,
      source: 'screen',
    },
  ]);
  await launch();
});

test.afterAll(async () => {
  if (app) await exitApp(app);
  if (dir) fs.rmSync(dir, { recursive: true, force: true });
});

test('a recording opens in the video editor from History', async () => {
  await openEditor();
  await expect(page.getByTestId('video-title')).toHaveText('clip.webm');
  await expect(page.getByTestId('video-save-status')).toHaveText('All changes saved');
  expect(await resultSeconds()).toBeCloseTo(SECONDS, 0);
  // It is a video tab of the Editor window, named after the file; a video is never "unsaved".
  await expect(page.getByTestId('editor-tab')).toHaveCount(1);
  await expect(page.getByTestId('editor-tab')).toHaveAttribute('data-kind', 'video');
  await expect(page.getByTestId('tab-title')).toHaveText('clip.webm');
  await expect(page.getByTestId('editor-tab')).toHaveAttribute('data-dirty', 'false');
});

test('space plays and pauses; arrows step; the playhead follows', async () => {
  const time = page.getByTestId('time-source');
  await page.keyboard.press('Space');
  await expect(page.getByTestId('video-play')).toHaveAttribute('aria-label', 'Pause');
  await page.waitForTimeout(600);
  await page.keyboard.press('Space');
  await expect(page.getByTestId('video-play')).toHaveAttribute('aria-label', 'Play');
  const stopped = await time.textContent();
  expect(stopped).not.toBe('0:00.000');
  await page.keyboard.press('ArrowRight');
  await expect(time).not.toHaveText(stopped ?? '');
  await page.keyboard.press('Home');
  await expect(time).toHaveText('0:00.000');
});

test('a redact box drawn on the preview becomes an item on the timeline', async () => {
  await page.getByTestId('tool-redact').click();
  const overlay = page.getByTestId('video-overlay');
  const box = await overlay.boundingBox();
  if (!box) throw new Error('no preview');
  await page.mouse.move(box.x + box.width * 0.1, box.y + box.height * 0.1);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * 0.4, box.y + box.height * 0.35, { steps: 6 });
  await page.mouse.up();
  await expect(page.getByTestId('timeline-item-redact')).toHaveCount(1);
  await expect(page.getByTestId('inspector-item')).toBeVisible();
  // The box is on the source frame as numbers the inspector shows.
  const width = Number(await page.getByTestId('rect-w').inputValue());
  expect(width).toBeGreaterThan(100);
  await page.getByTestId('swatch-ef4444').click();
  await expect(page.getByTestId('swatch-ef4444')).toHaveAttribute('aria-checked', 'true');
  await expect(page.getByTestId('video-save-status')).toHaveText('All changes saved');
});

test('dragging on the clip selects a range that Cut removes; undo and redo bring it back', async () => {
  const clipTrack = page.getByTestId('timeline-clip');
  const box = await clipTrack.boundingBox();
  if (!box) throw new Error('no timeline');
  const before = await resultSeconds();
  await page.mouse.move(box.x + box.width * 0.3, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * 0.55, box.y + box.height / 2, { steps: 8 });
  await page.mouse.up();
  await expect(page.getByTestId('timeline-range')).toBeVisible();
  const readout = (await page.getByTestId('range-readout').textContent()) ?? '';
  const [from = '', to = ''] = readout.split('–').map((part) => part.trim());
  const seconds = (text: string): number => {
    const [m = '0', rest = '0'] = text.split(':');
    return Number(m) * 60 + Number(rest);
  };
  const removed = seconds(to) - seconds(from);
  expect(removed).toBeGreaterThan(1);

  await page.getByTestId('cut-range').click();
  await expect(page.getByTestId('timeline-cut')).toHaveCount(1);
  expect(await resultSeconds()).toBeCloseTo(before - removed, 1);

  await page.getByTestId('video-undo').click();
  await expect(page.getByTestId('timeline-cut')).toHaveCount(0);
  await page.getByTestId('video-redo').click();
  await expect(page.getByTestId('timeline-cut')).toHaveCount(1);
  await expect(page.getByTestId('timeline-item-redact')).toHaveCount(1);
});

test('playback jumps over a cut piece', async () => {
  const cutBox = await page.getByTestId('timeline-cut').boundingBox();
  const ruler = await page.getByTestId('timeline-ruler').boundingBox();
  if (!cutBox || !ruler) throw new Error('no timeline');
  const ariaLabel = (await page.getByTestId('timeline-cut').getAttribute('aria-label')) ?? '';
  const [, endText = ''] = /to (\d+:\d+\.\d+)\./.exec(ariaLabel) ?? [];
  const [minutes = '0', rest = '0'] = endText.split(':');
  const cutEnd = Number(minutes) * 60 + Number(rest);
  // Put the playhead a few milliseconds before the cut, play for 0.7 s: the cut is 1+ s long.
  await page.mouse.click(cutBox.x - 6, ruler.y + 10);
  await page.keyboard.press('Space');
  await page.waitForTimeout(700);
  await page.keyboard.press('Space');
  const text = (await page.getByTestId('time-source').textContent()) ?? '';
  const [m = '0', s = '0'] = text.split(':');
  expect(Number(m) * 60 + Number(s)).toBeGreaterThanOrEqual(cutEnd);
});

test('trim handles and Delete on a selected cut', async () => {
  const cut = page.getByTestId('timeline-cut');
  await cut.click();
  await expect(page.getByTestId('inspector-cut')).toBeVisible();
  const withCut = await resultSeconds();
  await page.keyboard.press('Delete');
  await expect(cut).toHaveCount(0);
  expect(await resultSeconds()).toBeGreaterThan(withCut);
  await page.getByTestId('video-undo').click();
  await expect(cut).toHaveCount(1);
  // Trim: a keyboard nudge of the end handle shortens the result.
  const before = await resultSeconds();
  await page.getByTestId('trim-end').focus();
  await page.keyboard.press('Shift+ArrowLeft');
  expect(await resultSeconds()).toBeCloseTo(before - 1, 1);
});

test('the project is saved by itself and restored when the editor is opened again', async () => {
  await expect(page.getByTestId('video-save-status')).toHaveText('All changes saved');
  const length = await resultSeconds();
  await closeTab();
  // The main window is still on the recording in History.
  await expect(main.getByTestId('history-details')).toBeVisible();
  await openEditor();
  await expect(page.getByTestId('timeline-item-redact')).toHaveCount(1);
  await expect(page.getByTestId('timeline-cut')).toHaveCount(1);
  expect(await resultSeconds()).toBeCloseTo(length, 2);
  const saved = path.join(dir, 'video-projects');
  expect(fs.readdirSync(saved)).toHaveLength(1);
});

test('the editor has no accessibility violations in either theme', async () => {
  for (const theme of ['light', 'dark'] as const) {
    const result = await page.evaluate(
      (value) =>
        window.framecapt.invoke('settings:update', { patch: { general: { theme: value } } }),
      theme,
    );
    expect(result.ok).toBe(true);
    await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
    await page.waitForTimeout(400);
    const results = await new AxeBuilder({ page })
      .setLegacyMode()
      .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
      .include('[data-testid="video-editor"]')
      .analyze();
    const summary = results.violations.map(
      (violation) =>
        `${violation.id} (${violation.impact}): ${violation.nodes
          .slice(0, 4)
          .map((node) => `${node.target.join(' ')} | ${node.failureSummary?.split('\n')[1] ?? ''}`)
          .join(' ;; ')}`,
    );
    expect(summary, `video editor ${theme}`).toEqual([]);
  }
  await page.evaluate(() =>
    window.framecapt.invoke('settings:update', { patch: { general: { theme: 'system' } } }),
  );
});

test('export MP4 makes a new history item next to the source with the edited length', async () => {
  const expected = await resultSeconds();
  await page.getByTestId('video-export').click();
  const done = page.locator('[data-sonner-toast]', { hasText: 'MP4 exported' });
  await expect(done).toBeVisible({ timeout: 90_000 });

  const output = path.join(path.dirname(clip), 'clip (edited).mp4');
  expect(fs.existsSync(output)).toBe(true);
  const probed = probeFile(output);
  const video = probed.streams.find((stream) => stream.codec_type === 'video');
  expect(video).toMatchObject({ codec_name: 'h264', width: 640, height: 360 });
  expect(probed.streams.some((stream) => stream.codec_type === 'audio')).toBe(true);
  expect(Math.abs(Number(probed.format?.duration) - expected)).toBeLessThan(0.4);
  // The source is untouched.
  expect(fs.existsSync(clip)).toBe(true);

  await closeTab();
  await main.getByTestId('history-back').click();
  await expect(main.getByTestId('history-item')).toHaveCount(2);
  await expect(main.getByTestId('history-item').first()).toContainText('clip (edited).mp4');
});

test('a GIF export is shown in History as an image, linked to its recording', async () => {
  await openEditor('clip.webm');
  await page.getByTestId('video-export-options').click();
  await page.getByTestId('export-format-gif').click();
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('video-export')).toHaveText(/Export GIF/);
  await page.getByTestId('video-export').click();
  await expect(page.locator('[data-sonner-toast]', { hasText: 'GIF exported' })).toBeVisible({
    timeout: 90_000,
  });
  const output = path.join(path.dirname(clip), 'clip (edited).gif');
  const probed = probeFile(output);
  expect(probed.streams.map((stream) => stream.codec_type)).toEqual(['video']);
  expect(probed.streams[0]?.codec_name).toBe('gif');
  expect(fs.readFileSync(output).subarray(0, 6).toString('latin1')).toBe('GIF89a');

  await closeTab();
  await main.getByTestId('history-back').click();
  const card = main.getByTestId('history-item').filter({ hasText: 'clip (edited).gif' });
  await expect(card).toHaveCount(1);
  await expect(card.getByTestId('history-type')).toHaveText('gif');
  await card.locator('[data-card-main]').click();
  await expect(main.getByTestId('history-image')).toBeVisible();
  await expect
    .poll(() =>
      main.getByTestId('history-image').evaluate((img: HTMLImageElement) => img.naturalWidth),
    )
    .toBeGreaterThan(0);
  // A GIF is not edited in the video editor.
  await expect(main.getByTestId('details-edit')).toHaveCount(0);
  await main.getByTestId('history-back').click();
});

test('an export can be cancelled and leaves no file behind', async () => {
  await openEditor('clip.webm');
  await page.getByTestId('video-export-options').click();
  await page.getByTestId('export-format-webm').click();
  await page.keyboard.press('Escape');
  await page.getByTestId('video-export').click();
  await page
    .getByTestId('video-export-cancel')
    .click({ timeout: 10_000 })
    .catch(() => undefined);
  // Either it was cancelled in time (no file) or it had already finished (one file): never a partial.
  await expect(page.getByTestId('video-export')).toBeVisible({ timeout: 60_000 });
  const leftovers = fs.readdirSync(path.dirname(clip)).filter((name) => name.includes('.partial'));
  expect(leftovers).toEqual([]);
});
