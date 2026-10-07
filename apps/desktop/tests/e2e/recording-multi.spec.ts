/**
 * Multi-screen / multi-window recording end to end, against the E2E build (mock capture): the
 * source picker in its multi-select mode, one recording of several sources into one `.fcap`, its
 * header, History (the "Multi" badge, "Open" staying inside FrameCapt, the player with source
 * tabs) and extracting one source of it to MP4 as a new history item. The synthetic display
 * stands in for every screen and window; real capture is covered by tests/native.
 *
 * Mock displays: A (id 1001, source screen:1:0) 2560 x 1440; B (id 1002, source screen:2:0) 3440 x
 * 1440 pixels. Mock windows are 1280 x 720 synthetic pictures.
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
import { probeFile } from './media-fixtures';

const projectRoot = path.resolve(__dirname, '..', '..');

let app: ElectronApplication;
let page: Page;
let userDataDir: string;

const videosDir = (): string => path.join(userDataDir, 'videos', 'FrameCapt');

interface FcapHeader {
  version: number;
  width: number;
  height: number;
  durationMs: number;
  hasAudio: boolean;
  payloadOffset: number;
  payloadLength: number;
  payloadType: string;
  sources: {
    name: string;
    kind: string;
    rect: { x: number; y: number; width: number; height: number };
  }[];
}

/** The header of a `.fcap`, read straight from the bytes (the format of docs/recording-persistence.md). */
function readHeader(file: string): FcapHeader {
  const bytes = fs.readFileSync(file);
  expect(bytes.subarray(0, 5).equals(Buffer.from([0x46, 0x43, 0x41, 0x50, 0x00]))).toBe(true);
  expect(bytes[5]).toBe(1);
  expect([bytes[6], bytes[7]]).toEqual([0, 0]);
  const length = bytes.readUInt32LE(8);
  const header = JSON.parse(bytes.toString('utf8', 12, 12 + length)) as FcapHeader;
  expect(header.payloadOffset).toBe(4096);
  expect(header.payloadOffset + header.payloadLength).toBe(bytes.length);
  expect(header.payloadType).toBe('video/webm');
  // The payload is a WebM (EBML magic) and the bytes between are zero padding.
  expect([...bytes.subarray(4096, 4100)]).toEqual([0x1a, 0x45, 0xdf, 0xa3]);
  expect(bytes.subarray(12 + length, 4096).every((byte) => byte === 0)).toBe(true);
  return header;
}

const fcapFiles = (): string[] =>
  fs.existsSync(videosDir()) ? fs.readdirSync(videosDir()).filter((f) => f.endsWith('.fcap')) : [];

async function state() {
  const result = await page.evaluate(() => window.framecapt.invoke('recorder:getState'));
  if (!result.ok) throw new Error('recorder:getState failed');
  return result.data;
}

async function toolbarPage(): Promise<Page> {
  let found: Page | undefined;
  await expect
    .poll(
      () => {
        found = app.windows().find((candidate) => candidate.url().includes('#/toolbar'));
        return found !== undefined;
      },
      { timeout: 20_000 },
    )
    .toBe(true);
  const toolbar = found as Page;
  await expect(toolbar.getByTestId('toolbar')).toBeVisible();
  await expect.poll(async () => (await state()).status, { timeout: 20_000 }).toBe('recording');
  return toolbar;
}

async function stopAndWait(toolbar: Page): Promise<void> {
  await toolbar.getByTestId('toolbar-stop').click();
  await expect(page.getByTestId('recording-result')).toBeVisible({ timeout: 40_000 });
}

async function historyItems() {
  const result = await page.evaluate(() => window.framecapt.invoke('history:list', {}));
  if (!result.ok) throw new Error('history:list failed');
  return result.data.items;
}

test.describe.configure({ mode: 'serial' });

test.beforeAll(async () => {
  expect(
    fs.existsSync(path.join(projectRoot, '.vite', 'build', 'main.cjs')),
    'Run `npm run package:e2e` first (npm run test:e2e does this).',
  ).toBe(true);
  userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'framecapt-e2e-multi-'));
  app = await electron.launch({
    args: ['.'],
    cwd: projectRoot,
    env: {
      ...process.env,
      FRAMECAPT_USER_DATA_DIR: userDataDir,
      FRAMECAPT_E2E_MOCK_CAPTURE: '1',
      FRAMECAPT_E2E_FAKE_SHORTCUTS: '1',
    },
  });
  page = await app.firstWindow();
  await page.waitForLoadState('domcontentloaded');
  await expect(page.getByTestId('record-multi')).toBeVisible();
  // No countdown, to keep the recordings short.
  const countdown = page.getByTestId('opt-countdown');
  if ((await countdown.getAttribute('aria-checked')) === 'true') await countdown.click();
  await expect(countdown).toHaveAttribute('aria-checked', 'false');
});
test.afterAll(async () => {
  if (app) await exitApp(app);
  if (userDataDir) fs.rmSync(userDataDir, { recursive: true, force: true });
});

test('the Record tiles offer All screens and Multiple…', async () => {
  const record = page.getByTestId('mode-record');
  await expect(record.getByTestId('record-all-screens')).toBeVisible();
  await expect(record.getByTestId('record-multi')).toBeVisible();
  await expect(record.getByTestId('record-multi')).toContainText('Multiple…');
});

test('the multi picker: screens and windows, order badges, a limit of 4, keyboard, a button that counts', async () => {
  await page.getByTestId('record-multi').click();
  const picker = page.getByTestId('source-picker');
  await expect(picker).toBeVisible();
  const cards = picker.getByTestId('source-card');
  // Both screens and the windows are listed.
  await expect(cards).toHaveCount(7);
  expect(await picker.locator('[data-kind="screen"]').count()).toBe(2);
  expect(await picker.locator('[data-kind="window"]').count()).toBe(5);
  const record = picker.getByTestId('record-sources');
  await expect(record).toBeDisabled();
  await expect(record).toHaveText('Pick 2 or more');
  await expect(picker.getByTestId('source-count')).toHaveText('0 of 4 picked');

  const card = (id: string) => picker.locator(`[data-source-id="${id}"]`);
  await card('window:1002:0').click();
  await card('screen:1:0').click();
  await expect(card('window:1002:0')).toHaveAttribute('data-order', '1');
  await expect(card('screen:1:0')).toHaveAttribute('data-order', '2');
  await expect(card('screen:1:0')).toHaveAttribute('aria-checked', 'true');
  await expect(card('screen:1:0').getByTestId('source-order')).toHaveText('2');
  await expect(record).toBeEnabled();
  await expect(record).toHaveText('Record 2 sources');

  // Keyboard: Space toggles the focused card; the first pick keeps its place when another goes.
  await card('window:1003:0').focus();
  await page.keyboard.press('Space');
  await expect(card('window:1003:0')).toHaveAttribute('data-order', '3');
  await card('window:1004:0').focus();
  await page.keyboard.press('Space');
  await expect(picker.getByTestId('source-count')).toHaveText('4 of 4 picked');
  // The limit: a fifth card cannot be picked.
  await card('screen:2:0').click({ force: true });
  await expect(card('screen:2:0')).toHaveAttribute('aria-disabled', 'true');
  await expect(card('screen:2:0')).toHaveAttribute('data-order', '0');
  await expect(record).toHaveText('Record 4 sources');
  // Unpick the middle ones: the order closes up.
  await card('window:1003:0').click();
  await card('window:1004:0').click();
  await expect(card('screen:1:0')).toHaveAttribute('data-order', '2');
  await expect(record).toHaveText('Record 2 sources');

  // Accessibility of the dialog with picks on it.
  const scan = await new AxeBuilder({ page })
    .setLegacyMode()
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
    .analyze();
  expect(
    scan.violations
      .filter((violation) => violation.impact === 'serious' || violation.impact === 'critical')
      .map(
        (violation) =>
          `${violation.id}: ${violation.nodes.map((node) => node.target.join(' ')).join(' ;; ')}`,
      ),
  ).toEqual([]);

  // Esc closes it and nothing starts.
  await page.keyboard.press('Escape');
  await expect(picker).toBeHidden();
  expect((await state()).status).toBe('idle');
});

test('a screen and a window recorded together become one .fcap with a header, shown in the result', async () => {
  await page.getByTestId('record-multi').click();
  const picker = page.getByTestId('source-picker');
  await picker.locator('[data-source-id="screen:1:0"]').click();
  await picker.locator('[data-source-id="window:1001:0"]').click();
  await picker.getByTestId('record-sources').click();

  const toolbar = await toolbarPage();
  expect((await state()).target).toBe('multi');
  await toolbar.waitForTimeout(2500);
  await stopAndWait(toolbar);

  // The result: one .fcap in the output folder, nothing else (no WebM, no partial).
  expect(fs.readdirSync(videosDir())).toHaveLength(1);
  const [name] = fcapFiles();
  expect(name).toMatch(/^FrameCapt \d{4}-\d{2}-\d{2} at \d{2}\.\d{2}\.\d{2}\.fcap$/);
  const file = path.join(videosDir(), name ?? '');
  await expect(page.getByTestId('result-file')).toHaveText(name ?? '');
  await expect(page.getByTestId('result-fcap-note')).toBeVisible();
  await expect(page.getByTestId('mp4-export')).toHaveCount(0);

  // A screen (2560 x 1440) next to a window go into a grid of equal cells, capped for 1080p.
  const header = readHeader(file);
  expect(header).toMatchObject({ version: 1, width: 3840, height: 1080 });
  expect(header.durationMs).toBeGreaterThan(1500);
  expect(header.sources).toEqual([
    { name: 'Screen 1', kind: 'screen', rect: { x: 0, y: 0, width: 1920, height: 1080 } },
    { name: 'Window 2', kind: 'window', rect: { x: 1920, y: 0, width: 1920, height: 1080 } },
  ]);
  // Generic names only: nothing of a window title is in the file's header or the session record.
  const raw = fs.readFileSync(file).subarray(0, 4096).toString('latin1');
  expect(raw).not.toContain('Mock window');
  const done = await state();
  const record = fs.readFileSync(
    path.join(userDataDir, 'recordings', 'completed', `${done.sessionId}.json`),
    'utf8',
  );
  expect(JSON.parse(record).source.kind).toBe('multi');
  expect(record).not.toContain('Mock window');
  // The picture itself: the result view plays the payload through framecapt-media: (offset-shifted ranges).
  const video = page.getByTestId('result-video');
  await expect
    .poll(() => video.evaluate((v: HTMLVideoElement) => v.readyState), { timeout: 15_000 })
    .toBeGreaterThanOrEqual(1);
  expect(await video.evaluate((v: HTMLVideoElement) => v.videoWidth)).toBe(3840);
  expect(await video.evaluate((v: HTMLVideoElement) => v.error === null)).toBe(true);
  await expect(page.getByTestId('badge-dimensions')).toHaveText('3840 × 1080');
});

test('History: a Multi badge, Open stays inside FrameCapt, the player has a tab per source', async () => {
  await page.getByTestId('result-history').click();
  const cards = page.getByTestId('history-item');
  await expect(cards).toHaveCount(1);
  await expect(cards.first().getByTestId('history-multi')).toHaveText('Multi · 2');
  await expect(cards.first().getByTestId('history-type')).toHaveText(/fcap/i);

  // "Open" never reaches the shell: it shows the details view in the app.
  await cards.first().hover();
  await cards.first().getByTestId('history-open').click();
  const details = page.getByTestId('history-details');
  await expect(details).toBeVisible();
  await expect(page.getByTestId('fcap-player')).toBeVisible();
  await expect(page.getByTestId('details-open')).toHaveCount(0);
  await expect(page.getByTestId('fcap-sources')).toHaveText('Screen 1, Window 2');

  const video = page.getByTestId('history-video');
  await expect
    .poll(() => video.evaluate((v: HTMLVideoElement) => v.readyState), { timeout: 15_000 })
    .toBeGreaterThanOrEqual(1);
  expect(await video.evaluate((v: HTMLVideoElement) => v.videoWidth)).toBe(3840);
  expect(await video.evaluate((v: HTMLVideoElement) => v.error === null)).toBe(true);

  // Tabs: All, Screen 1, Window 2.
  const tabs = page.getByTestId('fcap-tabs').getByRole('tab');
  await expect(tabs).toHaveText(['All', 'Screen 1', 'Window 2']);
  await expect(page.getByTestId('fcap-tab-all')).toHaveAttribute('aria-selected', 'true');
  const box = page.getByTestId('fcap-box');
  await expect(box).toHaveAttribute('data-tile', 'all');
  const whole = (await box.boundingBox())!;
  expect(whole.width / whole.height).toBeCloseTo(3840 / 1080, 1);

  // Seeking works and the same <video> keeps playing from where it was when the tab changes.
  const seeked = await video.evaluate(
    (v: HTMLVideoElement) =>
      new Promise<number>((resolve) => {
        v.addEventListener('seeked', () => resolve(v.currentTime), { once: true });
        v.currentTime = 1;
      }),
  );
  expect(seeked).toBeGreaterThan(0.9);

  await page.getByTestId('fcap-tab-1').click();
  await expect(page.getByTestId('fcap-tab-1')).toHaveAttribute('aria-selected', 'true');
  await expect(box).toHaveAttribute('data-tile', '1');
  // The box now has the tile's aspect (16:9) and the video inside is twice as wide, shifted left.
  await expect
    .poll(async () => {
      const tile = (await box.boundingBox())!;
      return Math.round((tile.width / tile.height) * 100);
    })
    .toBe(Math.round((1920 / 1080) * 100));
  const tile = (await box.boundingBox())!;
  await expect
    .poll(async () => {
      const inner = (await video.boundingBox())!;
      return [
        Math.round(inner.width / tile.width),
        Math.round((tile.x - inner.x) / tile.width),
        Math.round(inner.height / tile.height),
      ];
    })
    .toEqual([2, 1, 1]);
  // The time did not change with the tab (nothing was decoded again from the start).
  expect(await video.evaluate((v: HTMLVideoElement) => v.currentTime)).toBeGreaterThan(0.9);

  // Arrow keys move between the tabs (and wrap around).
  await page.getByTestId('fcap-tab-1').focus();
  await page.keyboard.press('ArrowRight');
  await expect(page.getByTestId('fcap-tab-all')).toHaveAttribute('aria-selected', 'true');
  await page.keyboard.press('ArrowLeft');
  await expect(page.getByTestId('fcap-tab-1')).toHaveAttribute('aria-selected', 'true');
  await page.keyboard.press('ArrowLeft');
  await expect(page.getByTestId('fcap-tab-0')).toHaveAttribute('aria-selected', 'true');
  await page.getByTestId('fcap-tab-all').click();

  // The player and its tabs pass the accessibility scan (after the tab colors finished fading).
  await page.waitForTimeout(500);
  const scan = await new AxeBuilder({ page })
    .setLegacyMode()
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
    .analyze();
  expect(
    scan.violations
      .filter((violation) => violation.impact === 'serious' || violation.impact === 'critical')
      .map(
        (violation) =>
          `${violation.id}: ${violation.nodes.map((node) => node.target.join(' ')).join(' ;; ')}`,
      ),
  ).toEqual([]);

  // Play and pause with our own controls.
  await page.getByTestId('fcap-play').click();
  await expect.poll(() => video.evaluate((v: HTMLVideoElement) => !v.paused)).toBe(true);
  await page.getByTestId('fcap-play').click();
  await expect.poll(() => video.evaluate((v: HTMLVideoElement) => v.paused)).toBe(true);
});

test('Extract: one source, a part of the time, MP4 → a new history item with the source size', async () => {
  const [name] = fcapFiles();
  const baseName = (name ?? '').replace(/\.fcap$/, '');
  await page.getByTestId('details-extract').click();
  const dialog = page.getByTestId('extract-dialog');
  await expect(dialog).toBeVisible();
  // Choose Screen 1 (the first source), 0.5 s to 2 s, MP4.
  await dialog.getByTestId('extract-source').getByRole('radio', { name: 'Screen 1' }).click();
  await dialog.getByTestId('extract-start-text').fill('0.5');
  await dialog.getByTestId('extract-start-text').press('Enter');
  await dialog.getByTestId('extract-end-text').fill('0:02');
  await dialog.getByTestId('extract-end-text').press('Enter');
  await expect(dialog.getByTestId('extract-length')).toHaveText('Length 0:01.5');
  // A bad time is refused: the field returns to the last good value.
  await dialog.getByTestId('extract-end-text').fill('nonsense');
  await dialog.getByTestId('extract-end-text').press('Enter');
  await expect(dialog.getByTestId('extract-end-text')).toHaveValue('0:02.0');
  // The sliders edit the same values.
  await dialog.getByTestId('extract-end-slider').focus();
  await page.keyboard.press('ArrowRight');
  await expect(dialog.getByTestId('extract-length')).toHaveText('Length 0:01.6');
  await page.keyboard.press('ArrowLeft');
  await expect(dialog.getByTestId('extract-length')).toHaveText('Length 0:01.5');
  await expect(
    dialog.getByTestId('extract-format').getByRole('radio', { name: 'MP4' }),
  ).toHaveAttribute('aria-checked', 'true');
  await dialog.getByTestId('extract-go').click();
  await expect(dialog).toBeHidden();

  await expect(page.getByTestId('extract-done')).toBeVisible({ timeout: 60_000 });
  const out = path.join(videosDir(), `${baseName} - Screen 1.mp4`);
  expect(fs.existsSync(out)).toBe(true);
  expect(fs.readdirSync(videosDir()).filter((f) => f.includes('.partial'))).toEqual([]);
  const probed = probeFile(out);
  const video = probed.streams.find((stream) => stream.codec_type === 'video');
  expect(video).toMatchObject({ codec_name: 'h264', width: 1920, height: 1080 });
  expect(Number(probed.format?.duration)).toBeGreaterThan(1.2);
  expect(Number(probed.format?.duration)).toBeLessThan(2.0);
  // The fcap is untouched.
  expect(readHeader(path.join(videosDir(), name ?? '')).sources).toHaveLength(2);

  // A new history item that says where it came from.
  const items = await historyItems();
  const fcap = items.find((item) => item.format === 'fcap');
  const extracted = items.find((item) => item.format === 'mp4');
  expect(items).toHaveLength(2);
  expect(extracted).toMatchObject({
    fileName: `${baseName} - Screen 1.mp4`,
    derivedFrom: fcap?.id,
    width: 1920,
    height: 1080,
    exists: true,
    source: 'screen',
  });
  // Another extract of the same source gets its own name, never over the first.
  await page.getByTestId('details-extract').click();
  await page.getByTestId('extract-go').click();
  await expect
    .poll(() => fs.existsSync(path.join(videosDir(), `${baseName} - All.mp4`)), { timeout: 60_000 })
    .toBe(true);
  await expect(page.getByTestId('extract-progress')).toBeHidden({ timeout: 30_000 });
  expect(probeFile(path.join(videosDir(), `${baseName} - All.mp4`)).streams[0]).toMatchObject({
    width: 3840,
    height: 1080,
  });
});

test('Extract can be cancelled and leaves nothing behind', async () => {
  const [name] = fcapFiles();
  const before = fs.readdirSync(videosDir()).length;
  await page.getByTestId('details-extract').click();
  const dialog = page.getByTestId('extract-dialog');
  await dialog.getByTestId('extract-format').getByRole('radio', { name: 'WebM' }).click();
  await dialog.getByTestId('extract-go').click();
  const cancel = page.getByTestId('extract-cancel');
  await expect(cancel).toBeVisible({ timeout: 10_000 });
  await cancel.click();
  await expect(page.getByTestId('extract-progress')).toBeHidden({ timeout: 20_000 });
  await expect(page.getByTestId('extract-done')).toHaveCount(0);
  expect(fs.readdirSync(videosDir())).toHaveLength(before);
  expect(fs.existsSync(path.join(videosDir(), name ?? ''))).toBe(true);
  await page.getByTestId('history-back').click();
});

test('Edit video: the .fcap opens in the video editor, Source crops to one window, the export is a normal MP4', async () => {
  const [name] = fcapFiles();
  const header = readHeader(path.join(videosDir(), name ?? ''));
  const window2 = header.sources[1]!.rect;
  await page
    .getByTestId('history-item')
    .filter({ hasText: 'Multi' })
    .locator('[data-card-main]')
    .click();
  await page.getByTestId('details-edit').click();
  const editor = await editorPage(app);
  await expect(editor.getByTestId('video-editor')).toBeVisible();
  // The preview plays the payload through the same media route as the History player.
  await expect
    .poll(
      () => editor.getByTestId('video-preview').evaluate((v: HTMLVideoElement) => v.readyState),
      {
        timeout: 15_000,
      },
    )
    .toBeGreaterThanOrEqual(2);
  await expect(editor.getByTestId('output-size')).toHaveText(
    new RegExp(`^Output ${header.width} × ${header.height}`),
  );

  // Source: All, Screen 1, Window 2 (from the layout); choosing one sets the crop to its tile.
  const source = editor.getByTestId('source-select');
  await expect(source.locator('option:not([hidden])')).toHaveText(['All', 'Screen 1', 'Window 2']);
  await source.selectOption({ label: 'Window 2' });
  await expect(editor.getByTestId('output-size')).toHaveText(
    `Output ${window2.width} × ${window2.height} (cropped from ${header.width} × ${header.height})`,
  );
  await source.selectOption({ label: 'All' });
  await expect(editor.getByTestId('output-size')).toHaveText(
    `Output ${header.width} × ${header.height}`,
  );
  await source.selectOption({ label: 'Window 2' });

  await editor.getByTestId('video-export').click();
  await expect(editor.locator('[data-sonner-toast]', { hasText: 'MP4 exported' })).toBeVisible({
    timeout: 90_000,
  });
  const out = path.join(videosDir(), `${(name ?? '').replace(/.fcap$/, '')} (edited).mp4`);
  const video = probeFile(out).streams.find((stream) => stream.codec_type === 'video');
  expect(video).toMatchObject({ codec_name: 'h264', width: window2.width, height: window2.height });
  // The fcap is untouched and the export is a normal MP4 derived from it.
  expect(readHeader(path.join(videosDir(), name ?? '')).sources).toHaveLength(2);
  const items = await historyItems();
  const fcap = items.find((item) => item.format === 'fcap');
  expect(items.find((item) => item.fileName === path.basename(out))).toMatchObject({
    format: 'mp4',
    derivedFrom: fcap?.id,
  });

  await editor.getByTestId('tab-close').click();
  await expectEditorClosed(app);
  await page.getByTestId('history-back').click();
});

test('All screens records both displays at their places on the virtual desktop', async () => {
  await page
    .getByRole('navigation', { name: 'Primary' })
    .getByRole('button', { name: 'Home' })
    .click();
  // The finished recording is still shown on the Capture tab: start a new one.
  await page.getByTestId('result-new').click();
  await expect(page.getByTestId('record-all-screens')).toBeVisible();
  const before = fcapFiles();
  await page.getByTestId('record-all-screens').click();
  const toolbar = await toolbarPage();
  await toolbar.waitForTimeout(2000);
  await stopAndWait(toolbar);
  const files = fcapFiles();
  expect(files).toHaveLength(before.length + 1);
  const newest = files.find((f) => !before.includes(f)) ?? '';
  const header = readHeader(path.join(videosDir(), newest));
  expect(header.sources.map((source) => [source.name, source.kind])).toEqual([
    ['Screen 1', 'screen'],
    ['Screen 2', 'screen'],
  ]);
  // Screens only keep their positions: B (3440 wide) sits left of A (2560 wide), one row, scaled to fit.
  const [first, second] = header.sources;
  expect(second!.rect.x).toBeLessThan(first!.rect.x);
  expect(first!.rect.y).toBe(second!.rect.y);
  expect(header.width).toBeLessThanOrEqual(3840);
  expect(header.height).toBeLessThanOrEqual(2160);
  expect(header.width * header.height).toBeLessThanOrEqual(3840 * 1080);
  expect(first!.rect.width / first!.rect.height).toBeCloseTo(2560 / 1440, 1);
  expect(second!.rect.width / second!.rect.height).toBeCloseTo(3440 / 1440, 1);
});
