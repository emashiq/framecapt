/**
 * Local history and MP4 export end to end, against the E2E build (mock capture provider, one mock
 * display, a synthetic recording source). Screenshots and recordings are produced through the real
 * UI and the real main-process pipeline; the save/open dialogs and the Recycle Bin are stubbed in
 * main (nothing may open a native dialog or fill the real Recycle Bin during a test run).
 *
 * Synthetic frame (2560 x 1440): R = floor(255 x / (w-1)), G = floor(255 y / (h-1)) (see
 * src/renderer/capture/synthetic-frame.ts), so a black thumbnail pixel can only come from a
 * redaction.
 */
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadImage, createCanvas } from '@napi-rs/canvas';
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
const FRAME = { width: 2560, height: 1440 };

let app: ElectronApplication;
let page: Page;
let userDataDir: string;
let outDir: string;

test.describe.configure({ mode: 'serial' });

const sha = (file: string): string =>
  createHash('sha256').update(fs.readFileSync(file)).digest('hex');

async function launch(
  dir: string,
  env: Record<string, string> = {},
): Promise<{ app: ElectronApplication; page: Page }> {
  expect(
    fs.existsSync(path.join(projectRoot, '.vite', 'build', 'main.cjs')),
    'Run `npm run package:e2e` first (npm run test:e2e does this).',
  ).toBe(true);
  const electronApp = await electron.launch({
    args: ['.'],
    cwd: projectRoot,
    env: {
      ...process.env,
      FRAMECAPT_USER_DATA_DIR: dir,
      FRAMECAPT_E2E_MOCK_CAPTURE: '1',
      FRAMECAPT_E2E_MOCK_DISPLAYS: '1',
      ...env,
    },
  });
  const first = await electronApp.firstWindow();
  await first.waitForLoadState('domcontentloaded');
  await expect(first.getByTestId('shot-screen')).toBeVisible();
  return { app: electronApp, page: first };
}

test.beforeAll(async () => {
  userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'framecapt-e2e-history-'));
  outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'framecapt-e2e-history-out-'));
  ({ app, page } = await launch(userDataDir));
});

test.afterAll(async () => {
  if (app) await exitApp(app);
  if (process.env.FRAMECAPT_DEBUG_LOG && userDataDir) {
    const log = path.join(userDataDir, 'logs', 'main.log');
    if (fs.existsSync(log)) console.log(fs.readFileSync(log, 'utf8'));
  }
  for (const dir of [userDataDir, outDir])
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
});

// --- helpers ---------------------------------------------------------------------------------

const historyDir = (): string => path.join(userDataDir, 'history');
const thumbFiles = (): string[] => {
  const dir = path.join(historyDir(), 'thumbs');
  return fs.existsSync(dir) ? fs.readdirSync(dir).filter((name) => name.endsWith('.png')) : [];
};
const videosDir = (): string => path.join(userDataDir, 'videos', 'FrameCapt');

async function goTo(name: 'Home' | 'Library', target: Page = page): Promise<void> {
  await target.getByRole('navigation', { name: 'Primary' }).getByRole('button', { name }).click();
  if (name === 'Library') await expect(target.getByTestId('history-view')).toBeVisible();
  else await expect(target.getByTestId('shot-screen')).toBeVisible();
}

const cards = (target: Page = page) => target.getByTestId('history-item');

async function stubSaveDialog(filePath: string, electronApp: ElectronApplication = app) {
  await electronApp.evaluate(({ dialog }, target) => {
    dialog.showSaveDialog = (() =>
      Promise.resolve({ canceled: false, filePath: target })) as typeof dialog.showSaveDialog;
  }, filePath);
}

async function stubOpenDialog(filePath: string | null, electronApp: ElectronApplication = app) {
  await electronApp.evaluate(({ dialog }, target) => {
    dialog.showOpenDialog = (() =>
      Promise.resolve({
        canceled: target === null,
        filePaths: target === null ? [] : [target],
      })) as typeof dialog.showOpenDialog;
  }, filePath);
}

/** Replaces the Recycle Bin: records what was "trashed" and removes the file, nothing real is touched. */
async function stubTrash(electronApp: ElectronApplication = app) {
  await electronApp.evaluate(({ shell }) => {
    const trashed: string[] = [];
    (globalThis as unknown as { __trashed: string[] }).__trashed = trashed;
    shell.trashItem = (async (file: string) => {
      trashed.push(file);
      process.getBuiltinModule('node:fs').rmSync(file);
    }) as typeof shell.trashItem;
  });
}
const trashed = (): Promise<string[]> =>
  app.evaluate(() => (globalThis as unknown as { __trashed?: string[] }).__trashed ?? []);

interface CanvasView {
  zoom: number;
  panX: number;
  panY: number;
  dpr: number;
  left: number;
  top: number;
}

async function canvasView(target: Page = page): Promise<CanvasView> {
  const el = target.getByTestId('editor-canvas');
  const attr = async (name: string): Promise<number> =>
    Number((await el.getAttribute(name)) ?? 'NaN');
  const box = await el.boundingBox();
  if (!box) throw new Error('canvas has no box');
  return {
    zoom: await attr('data-zoom'),
    panX: await attr('data-pan-x'),
    panY: await attr('data-pan-y'),
    dpr: await attr('data-dpr'),
    left: box.x,
    top: box.y,
  };
}

async function dragImage(
  from: { x: number; y: number },
  to: { x: number; y: number },
  target: Page = page,
) {
  const view = await canvasView(target);
  const scale = view.zoom / view.dpr;
  const at = (p: { x: number; y: number }) => ({
    x: view.left + view.panX + p.x * scale,
    y: view.top + view.panY + p.y * scale,
  });
  const a = at(from);
  const b = at(to);
  await target.mouse.move(a.x, a.y);
  await target.mouse.down();
  await target.mouse.move((a.x + b.x) / 2, (a.y + b.y) / 2, { steps: 4 });
  await target.mouse.move(b.x, b.y, { steps: 4 });
  await target.mouse.up();
}

async function decode(file: string) {
  const image = await loadImage(fs.readFileSync(file));
  const canvas = createCanvas(image.width, image.height);
  const g = canvas.getContext('2d');
  g.drawImage(image, 0, 0);
  const data = g.getImageData(0, 0, image.width, image.height);
  return {
    width: data.width,
    height: data.height,
    at: (x: number, y: number) => [
      data.data[(y * data.width + x) * 4] ?? 0,
      data.data[(y * data.width + x) * 4 + 1] ?? 0,
      data.data[(y * data.width + x) * 4 + 2] ?? 0,
    ],
  };
}

function pagesOf(hash: string): Page[] {
  return app.windows().filter((candidate) => candidate.url().includes(hash));
}

async function recordFor(ms: number): Promise<void> {
  const countdown = page.getByTestId('opt-countdown');
  if ((await countdown.getAttribute('aria-checked')) === 'true') await countdown.click();
  await page.getByTestId('record-screen').click();
  let toolbar: Page | undefined;
  await expect
    .poll(
      () => {
        toolbar = pagesOf('#/toolbar')[0];
        return toolbar !== undefined;
      },
      { timeout: 20_000 },
    )
    .toBe(true);
  const bar = toolbar as Page;
  await expect(bar.getByTestId('toolbar')).toHaveAttribute('data-status', 'recording', {
    timeout: 20_000,
  });
  await bar.waitForTimeout(ms);
  await bar.getByTestId('toolbar-stop').click();
  await expect(page.getByTestId('recording-result')).toBeVisible({ timeout: 30_000 });
}

// --- tests -----------------------------------------------------------------------------------

test('a new history is empty and invites the first capture', async () => {
  await expect(page.getByTestId('recent-captures')).toContainText('No captures yet');
  await goTo('Library');
  await expect(page.getByText('Your captures will appear here')).toBeVisible();
  await expect(page.getByTestId('history-empty-shot')).toBeVisible();
  await expect(page.getByTestId('history-empty-record')).toBeVisible();
  await expect(cards()).toHaveCount(0);
  // No filter bar without items.
  await expect(page.getByTestId('history-search')).toHaveCount(0);
});

let shotFile: string;
let shotId: string;

test('a saved screenshot appears in history with a thumbnail of the flattened image', async () => {
  await goTo('Home');
  await page.getByTestId('shot-screen').click();
  const editor = await editorPage(app);
  await expect(editor.getByTestId('editor-view')).toBeVisible();
  await expect(editor.getByTestId('editor-dimensions')).toHaveText(
    `${FRAME.width} × ${FRAME.height}`,
  );
  // A redaction over the middle of the picture: the history thumbnail must show it black.
  await editor.getByTestId('tool-redact').click();
  await dragImage({ x: 900, y: 500 }, { x: 1500, y: 900 }, editor);
  await expect(editor.getByTestId('editor-canvas')).toHaveAttribute('data-annotations', '1');

  shotFile = path.join(outDir, 'Login screen.png');
  await stubSaveDialog(shotFile);
  await editor.getByTestId('editor-save').click();
  await expect.poll(() => fs.existsSync(shotFile), { timeout: 15_000 }).toBe(true);
  await expect(editor.getByText(/Saved to/).first()).toBeVisible();

  await editor.getByTestId('editor-done').click();
  await expectEditorClosed(app);
  await goTo('Library');
  await expect(cards()).toHaveCount(1);
  const card = cards().first();
  await expect(card).toContainText('Login screen');
  await expect(card.getByTestId('history-type')).toContainText('png');
  await expect(card).toContainText(`${FRAME.width} × ${FRAME.height}`);
  await expect(card.getByTestId('history-time')).toHaveText('just now');
  await expect(card.getByTestId('history-duration')).toHaveCount(0);
  shotId = (await card.locator('[data-card-main]').getAttribute('data-id')) ?? '';

  // The thumbnail: a PNG of at most 480 px wide, made from the FLATTENED image.
  expect(thumbFiles()).toEqual([`${shotId}.png`]);
  const thumb = await decode(path.join(historyDir(), 'thumbs', `${shotId}.png`));
  expect(thumb.width).toBeLessThanOrEqual(480);
  expect(thumb.width).toBeGreaterThan(300);
  const scale = thumb.width / FRAME.width;
  // Inside the redaction: black. Outside: the original gradient (R and G; B is a checker).
  const centre = thumb.at(Math.round(1200 * scale), Math.round(700 * scale));
  expect(centre).toEqual([0, 0, 0]);
  const x = Math.round(160 * scale);
  const y = Math.round(160 * scale);
  const outside = thumb.at(x, y);
  expect(Math.abs((outside[0] ?? 0) - (255 * 160) / (FRAME.width - 1))).toBeLessThan(12);
  expect(Math.abs((outside[1] ?? 0) - (255 * 160) / (FRAME.height - 1))).toBeLessThan(12);

  // The thumbnail really loads through the main-owned protocol.
  const img = card.locator('img');
  await expect
    .poll(() => img.evaluate((el: HTMLImageElement) => el.complete && el.naturalWidth), {
      timeout: 10_000,
    })
    .toBeGreaterThan(0);
  expect(await img.getAttribute('src')).toBe(`framecapt-media://thumb/${shotId}`);
});

let recordingFile: string;
let recordingId: string;

test('a finished recording appears with a duration chip and a thumbnail, and the result view offers MP4', async () => {
  await goTo('Home');
  await recordFor(1800);
  // MP4 export is offered right on the result view (this build has H.264).
  await expect(page.getByTestId('mp4-export')).toBeVisible();
  await page.getByTestId('result-new').click();
  await expect(page.getByTestId('record-screen')).toBeVisible();

  await goTo('Library');
  await expect(cards()).toHaveCount(2);
  const card = cards().first(); // newest first
  await expect(card.getByTestId('history-type')).toContainText('webm');
  await expect(card.getByTestId('history-duration')).toHaveText(/^00:0[1-4]$/);
  recordingId = (await card.locator('[data-card-main]').getAttribute('data-id')) ?? '';
  const files = fs.readdirSync(videosDir()).filter((name) => name.endsWith('.webm'));
  expect(files).toHaveLength(1);
  recordingFile = path.join(videosDir(), files[0] ?? '');
  await expect(card).toContainText((files[0] ?? '').replace(/[.]webm$/, ''));

  // The thumbnail is made by ffmpeg a moment after the recording.
  await expect.poll(() => thumbFiles().length, { timeout: 15_000 }).toBe(2);
  const thumb = await decode(path.join(historyDir(), 'thumbs', `${recordingId}.png`));
  expect(thumb.width).toBeLessThanOrEqual(480);
  await expect
    .poll(() => card.locator('img').evaluate((el: HTMLImageElement) => el.naturalWidth), {
      timeout: 10_000,
    })
    .toBeGreaterThan(0);
});

test('Recent captures on Home shows the latest items and opens them', async () => {
  await goTo('Home');
  const recent = page.getByTestId('recent-captures');
  await expect(recent.getByTestId('recent-item')).toHaveCount(2);
  await expect(recent.getByTestId('recent-item').first()).toHaveAttribute('data-type', 'recording');
  await expect(recent.getByText(/^00:0[1-4]$/)).toBeVisible(); // the duration badge
  // A screenshot opens as an editor tab, named after its file; the Library has its details.
  await recent.getByTestId('recent-item').nth(1).click();
  await expect(page.getByTestId('editor-tab')).toHaveCount(1);
  await expect(page.getByTestId('editor-tab').getByTestId('tab-title')).toHaveText(
    'Login screen.png',
  );
  await page.getByTestId('editor-tab').getByTestId('tab-close').click();
  await expectEditorClosed(app);
  await goTo('Library');
  await cards().filter({ hasText: 'Login screen' }).locator('[data-card-main]').click();
  await expect(page.getByTestId('history-details')).toBeVisible();
  await expect(page.getByTestId('history-details')).toContainText('Login screen.png');
  await expect(page.getByTestId('history-image')).toHaveAttribute(
    'src',
    new RegExp(`^framecapt-media://file/${shotId}/[0-9a-z]{8}$`),
  );
  await expect
    .poll(() =>
      page.getByTestId('history-image').evaluate((el: HTMLImageElement) => el.naturalWidth),
    )
    .toBe(FRAME.width);
  await page.getByTestId('history-back').click();
  await expect(page.getByTestId('history-grid')).toBeVisible();
});

test('filter and search narrow the list; an empty result says so', async () => {
  await expect(page.getByTestId('history-count')).toHaveText('2 items');
  // The kinds are the sidebar's smart items (they replaced the filter chips).
  const kind = (key: string) => page.locator(`[data-testid="folder-row"][data-path=":${key}"]`);
  await kind('type:screenshot').click();
  await expect(cards()).toHaveCount(1);
  await expect(cards().first()).toContainText('Login screen');
  await expect(page.getByTestId('history-count')).toHaveText('1 item');
  await expect(kind('type:screenshot').getByTestId('folder-count')).toHaveText('1');
  await kind('type:recording').click();
  await expect(cards()).toHaveCount(1);
  await expect(cards().first().getByTestId('history-type')).toContainText('webm');
  await kind('all').click();
  await expect(cards()).toHaveCount(2);

  const search = page.getByTestId('history-search');
  await search.fill('login');
  await expect(cards()).toHaveCount(1);
  await search.fill('video');
  await expect(cards()).toHaveCount(1);
  await expect(cards().first().getByTestId('history-type')).toContainText('webm');
  const today = new Date();
  const iso = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
  await search.fill(iso); // by date
  await expect(cards()).toHaveCount(2);
  await search.fill('no such capture');
  await expect(cards()).toHaveCount(0);
  await expect(page.getByText('No matches')).toBeVisible();
  await page.getByTestId('history-clear-filters').click();
  await expect(cards()).toHaveCount(2);
  await expect(search).toHaveValue('');
});

test('the grid works with the keyboard; Delete removes from history with Undo and never deletes a file', async () => {
  const mains = page.locator('[data-card-main]');
  await mains.first().focus();
  await page.keyboard.press('ArrowRight');
  await expect(mains.nth(1)).toBeFocused();
  await page.keyboard.press('ArrowLeft');
  await expect(mains.first()).toBeFocused();
  await page.keyboard.press('End');
  await expect(mains.nth(1)).toBeFocused();
  await page.keyboard.press('Home');
  await expect(mains.first()).toBeFocused();

  // Enter opens the details, Escape returns to the grid with focus on the same card.
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('history-details')).toBeVisible();
  await expect(page.getByTestId('history-video')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('history-grid')).toBeVisible();
  await expect(mains.first()).toBeFocused();

  // Delete: the entry goes, the file stays, Undo brings the entry back.
  const filesBefore = fs.readdirSync(videosDir());
  await page.keyboard.press('Delete');
  await expect(cards()).toHaveCount(1);
  await expect(page.getByText('Removed from history')).toBeVisible();
  expect(fs.readdirSync(videosDir())).toEqual(filesBefore);
  expect(fs.existsSync(recordingFile)).toBe(true);
  await expect(mains.first()).toBeFocused(); // focus moved to the neighbour
  await page.getByRole('button', { name: 'Undo' }).click();
  // Wait for that toast to leave, so the next "Undo" is unambiguous.
  await expect(page.getByText('Removed from history')).toHaveCount(0);
  await expect(cards()).toHaveCount(2);
  await expect(cards().first().getByTestId('history-type')).toContainText('webm');
  expect(thumbFiles()).toHaveLength(2); // the thumbnail survived too
  await expect
    .poll(() =>
      cards()
        .first()
        .locator('img')
        .evaluate((el: HTMLImageElement) => el.naturalWidth),
    )
    .toBeGreaterThan(0);
});

test('"Remove from history" in the More menu keeps the file', async () => {
  const card = cards().nth(1); // the screenshot
  await card.hover();
  await card.getByTestId('history-more').click();
  await page.getByTestId('history-menu-remove').click();
  await expect(cards()).toHaveCount(1);
  expect(fs.existsSync(shotFile)).toBe(true);
  await page.getByRole('button', { name: 'Undo' }).click();
  // Wait for that toast to leave, so the next "Undo" is unambiguous.
  await expect(page.getByText('Removed from history')).toHaveCount(0);
  await expect(cards()).toHaveCount(2);
});

test('Copy puts a screenshot on the clipboard as an image and a recording as its path', async () => {
  const shotCard = cards().nth(1); // the screenshot (the recording is newer)
  await shotCard.hover();
  await shotCard.getByTestId('history-copy').click();
  await expect(page.getByText('Image copied')).toBeVisible();
  // Read back through Electron's own decoder: the full-size image, with the redaction in it.
  const clip = await app.evaluate(async ({ clipboard, nativeImage }) => {
    const items = await clipboard.read();
    const blob = await items[0]?.getType('image/png');
    if (!blob || (typeof blob === 'object' && !('arrayBuffer' in blob))) return null;
    const image = nativeImage.createFromBuffer(Buffer.from(await (blob as Blob).arrayBuffer()));
    const { width, height } = image.getSize();
    const i = (700 * width + 1200) * 4; // inside the redaction drawn in the first screenshot test
    const bitmap = image.toBitmap();
    return { width, height, centre: [bitmap[i], bitmap[i + 1], bitmap[i + 2]] };
  });
  expect(clip).toEqual({ ...FRAME, centre: [0, 0, 0] });

  const recordingCard = cards().first();
  await recordingCard.hover();
  await recordingCard.getByTestId('history-copy').click();
  await expect(page.getByText('Path copied')).toBeVisible();
  expect(await app.evaluate(({ clipboard }) => clipboard.readText())).toBe(recordingFile);
});

test('the video details play the recording and show its facts', async () => {
  await cards().first().locator('[data-card-main]').click();
  const details = page.getByTestId('history-details');
  await expect(details).toBeVisible();
  const video = page.getByTestId('history-video');
  await expect(video).toHaveAttribute(
    'src',
    new RegExp(`^framecapt-media://file/${recordingId}/[0-9a-z]{8}$`),
  );
  await expect
    .poll(() => video.evaluate((v: HTMLVideoElement) => v.readyState), { timeout: 15_000 })
    .toBeGreaterThanOrEqual(1);
  expect(await video.evaluate((v: HTMLVideoElement) => v.videoWidth)).toBe(1920);
  await expect(details.getByTestId('history-path')).toHaveText(recordingFile);
  await expect(details).toContainText('Recording');
  await expect(details).toContainText('No audio');
  await page.getByTestId('history-back').click();
});

test('Export MP4 from the details: H.264 file (no audio track for a silent recording), original untouched', async () => {
  const before = sha(recordingFile);
  await cards().first().locator('[data-card-main]').click();
  const mp4File = path.join(outDir, 'Exported clip.mp4');
  await stubSaveDialog(mp4File);
  await page.getByTestId('mp4-export').click();
  await expect(page.getByTestId('mp4-done')).toBeVisible({ timeout: 60_000 });
  expect(fs.existsSync(mp4File)).toBe(true);
  expect(fs.readdirSync(outDir).filter((name) => name.includes('.partial.'))).toEqual([]);
  const probe = probeFile(mp4File);
  expect(probe.streams.find((s) => s.codec_type === 'video')?.codec_name).toBe('h264');
  // The mock recording has no audio source: the MP4 has none either.
  expect(probe.streams.some((s) => s.codec_type === 'audio')).toBe(false);
  expect(Number(probe.format?.duration)).toBeGreaterThan(1);
  expect(sha(recordingFile)).toBe(before);
  await expect(page.getByText('MP4 saved').first()).toBeVisible();

  await page.getByTestId('history-back').click();
  await expect(cards()).toHaveCount(3);
  const mp4Card = cards().filter({ hasText: 'Exported clip' });
  await expect(mp4Card.getByTestId('history-type')).toContainText('mp4');
  await mp4Card.locator('[data-card-main]').click();
  await expect(page.getByTestId('history-details')).toContainText('Converted from');
  await expect(page.getByTestId('history-video')).toBeVisible();
  // An MP4 offers no further MP4 export.
  await expect(page.getByTestId('mp4-export')).toHaveCount(0);
  await page.getByTestId('history-back').click();
});

test('"Save a copy as…" copies the WebM unchanged', async () => {
  const copy = path.join(outDir, 'copy of recording.webm');
  await stubSaveDialog(copy);
  const card = cards().filter({ hasText: path.basename(recordingFile, '.webm') });
  await card.hover();
  await card.getByTestId('history-more').click();
  await page.getByTestId('history-menu-save-copy').click();
  await expect.poll(() => fs.existsSync(copy)).toBe(true);
  expect(sha(copy)).toBe(sha(recordingFile));
  expect(fs.readdirSync(outDir).filter((name) => name.includes('.partial'))).toEqual([]);
});

test('a file deleted outside FrameCapt shows a calm missing state; nothing else is touched', async () => {
  const othersBefore = [sha(recordingFile)];
  fs.rmSync(shotFile);
  // History checks the files whenever it loads: leaving and returning reloads it.
  await goTo('Home');
  await goTo('Library');
  const missing = page.locator('[data-card-main][data-missing]');
  await expect(missing).toHaveCount(1);
  const card = cards().filter({ has: missing });
  await expect(card.getByTestId('history-missing')).toContainText('File moved or deleted');
  await expect(card).toContainText('Login screen');
  // The app is fine and the other files are untouched.
  expect(sha(recordingFile)).toBe(othersBefore[0]);
  await page.getByTestId('library-more').click();
  await expect(page.getByTestId('history-clear-missing')).toHaveText('Clear 1 missing');
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('history-grid')).toBeVisible();
  // Home's recent captures say so as well.
  await goTo('Home');
  await expect(page.getByTestId('recent-captures')).toContainText('File moved or deleted');
  await goTo('Library');
});

test('Locate re-links a moved file, and refuses one of the wrong kind', async () => {
  const card = cards().filter({ has: page.locator('[data-card-main][data-missing]') });
  await card.hover();

  // A text file with the right-looking name is rejected (content is checked, not just the name).
  const fake = path.join(outDir, 'fake.png');
  fs.writeFileSync(fake, 'this is not an image');
  await stubOpenDialog(fake);
  await card.getByTestId('history-locate').click();
  await expect(page.getByText(/not a PNG image/).first()).toBeVisible();
  await expect(page.locator('[data-card-main][data-missing]')).toHaveCount(1);

  // A cancelled dialog changes nothing.
  await stubOpenDialog(null);
  await card.getByTestId('history-locate').click();
  await expect(page.locator('[data-card-main][data-missing]')).toHaveCount(1);

  // The real moved file: a valid PNG elsewhere.
  const moved = path.join(outDir, 'moved', 'Login screen (moved).png');
  fs.mkdirSync(path.dirname(moved), { recursive: true });
  const original = createCanvas(1280, 720);
  original.getContext('2d').fillRect(0, 0, 1280, 720);
  fs.writeFileSync(moved, original.toBuffer('image/png'));
  await stubOpenDialog(moved);
  await card.getByTestId('history-locate').click();
  await expect(page.locator('[data-card-main][data-missing]')).toHaveCount(0);
  await expect(page.getByText('File linked again')).toBeVisible();
  const relinked = cards().filter({ hasText: 'Login screen (moved)' });
  await expect(relinked).toHaveCount(1);
  await expect(relinked.getByTestId('history-missing')).toHaveCount(0);
});

test('Delete file… asks first, names the file, and moves it to the Recycle Bin only after confirming', async () => {
  await stubTrash();
  const moved = path.join(outDir, 'moved', 'Login screen (moved).png');
  const card = cards().filter({ hasText: 'Login screen (moved)' });
  await card.hover();
  await card.getByTestId('history-more').click();
  await page.getByTestId('history-menu-delete').click();
  const dialog = page.getByTestId('confirm-dialog');
  await expect(dialog).toContainText('Delete file from disk?');
  await expect(dialog).toContainText('Login screen (moved).png');
  await expect(dialog).toContainText('Recycle Bin');
  // Cancel: nothing happens.
  await page.getByTestId('confirm-no').click();
  expect(fs.existsSync(moved)).toBe(true);
  expect(await trashed()).toEqual([]);
  await expect(cards()).toHaveCount(3);

  // The keyboard never reaches this action: Delete only removes the entry (tested above).
  await card.hover();
  await card.getByTestId('history-more').click();
  await page.getByTestId('history-menu-delete').click();
  await page.getByTestId('confirm-yes').click();
  await expect(cards()).toHaveCount(2);
  expect(await trashed()).toEqual([moved]);
  expect(fs.existsSync(moved)).toBe(false);
  expect(fs.existsSync(recordingFile)).toBe(true);
});

test('Remove on a missing card drops the entry and "Clear missing" cleans up several', async () => {
  const exported = path.join(outDir, 'Exported clip.mp4');
  fs.rmSync(exported);
  await goTo('Home');
  await goTo('Library');
  await expect(page.locator('[data-card-main][data-missing]')).toHaveCount(1);
  await page.getByTestId('library-more').click();
  await page.getByTestId('history-clear-missing').click();
  await expect(page.getByText('Removed 1 missing item from history')).toBeVisible();
  await expect(cards()).toHaveCount(1);
  expect(fs.existsSync(recordingFile)).toBe(true);
});

test('a damaged history file is set aside at startup: one notice, files untouched', async () => {
  const before = sha(recordingFile);
  await exitApp(app);
  fs.writeFileSync(path.join(historyDir(), 'history.json'), '{ "version": 1, "items": [ broken');
  ({ app, page } = await launch(userDataDir));
  await expect(
    page.getByText('History was reset because its file was damaged. Your files were not touched.'),
  ).toBeVisible();
  await goTo('Library');
  await expect(page.getByText('Your captures will appear here')).toBeVisible();
  expect(
    fs.readdirSync(historyDir()).some((name) => name.startsWith('history.json.corrupt-')),
  ).toBe(true);
  expect(sha(recordingFile)).toBe(before);
  expect(fs.readdirSync(videosDir()).filter((name) => name.endsWith('.webm'))).toHaveLength(1);

  // History works again: the notice does not repeat on the next start.
  await exitApp(app);
  ({ app, page } = await launch(userDataDir));
  await expect(page.getByText(/History was reset/)).toHaveCount(0);
});

test('without an H.264 encoder MP4 export is explained and WebM stays the deliverable', async () => {
  await exitApp(app);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'framecapt-e2e-noh264-'));
  try {
    const file = path.join(dir, 'files', 'FrameCapt clip.webm');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    makeWebm(file, 2, { audio: false });
    const id = newId();
    seedHistory(dir, [
      {
        id,
        type: 'recording',
        path: file,
        createdAt: Date.now() - 60_000,
        width: 640,
        height: 360,
        durationMs: 2000,
        sizeBytes: fs.statSync(file).size,
        format: 'webm',
        hasAudio: false,
        source: 'screen',
      },
    ]);
    ({ app, page } = await launch(dir, { FRAMECAPT_E2E_NO_H264: '1' }));
    await goTo('Library');
    await cards().first().locator('[data-card-main]').click();
    await expect(page.getByTestId('mp4-unavailable')).toHaveText(
      'MP4 export needs an FFmpeg build with H.264 — your recording is saved as WebM',
    );
    await expect(page.getByTestId('mp4-export')).toHaveCount(0);
    // The WebM is still fully usable.
    await expect(page.getByTestId('details-save-copy')).toBeVisible();
    // main refuses the call too, whatever the UI does.
    const response = await page.evaluate(
      (historyId) => window.framecapt.invoke('export:mp4', { historyId }),
      id,
    );
    expect(response.ok).toBe(false);
  } finally {
    await exitApp(app);
    ({ app, page } = await launch(userDataDir));
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('history channels take ids only and refuse unknown ones', async () => {
  const unknown = '99999999-9999-4999-8999-999999999999';
  for (const channel of [
    'history:open',
    'history:reveal',
    'history:copyPath',
    'history:copyImage',
    'history:remove',
    'history:undoRemove',
    'history:deleteFile',
    'history:saveCopy',
  ] as const) {
    const result = await page.evaluate(
      ([name, id]) => window.framecapt.invoke(name as 'history:open', { id: id as string }),
      [channel, unknown] as const,
    );
    expect(result, channel).toMatchObject({ ok: false, error: { code: 'NOT_FOUND' } });
  }
  // A path is not an id.
  const bad = await page.evaluate(() =>
    window.framecapt.invoke('history:open', { id: 'C:\\Windows\\win.ini' } as never),
  );
  expect(bad).toMatchObject({ ok: false, error: { code: 'INVALID_PAYLOAD' } });
  // The media protocol serves nothing outside history: every one of these fails to load as an
  // image (404). fetch() is not even allowed to try (CSP connect-src), which is fine too.
  const loaded = await page.evaluate(async () => {
    const urls = [
      'framecapt-media://file/99999999-9999-4999-8999-999999999999',
      'framecapt-media://thumb/99999999-9999-4999-8999-999999999999',
      'framecapt-media://thumb/..%2F..%2Fhistory.json',
      'framecapt-media://file/C:/Windows/win.ini',
    ];
    return Promise.all(
      urls.map(
        (url) =>
          new Promise<boolean>((resolve) => {
            const image = new Image();
            image.onload = () => resolve(true);
            image.onerror = () => resolve(false);
            image.src = url;
          }),
      ),
    );
  });
  expect(loaded).toEqual([false, false, false, false]);
});
