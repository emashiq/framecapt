/**
 * The screenshot editor end to end, against the E2E build (mock capture provider, ONE mock display
 * so "Screenshot > Screen" captures at once, synthetic frames). The flattened output is checked as
 * real files and real clipboard pixels produced by CHROMIUM's canvas encoders (the unit tests cover
 * the same renderer code against Skia in Node): saved PNG and JPEG files are decoded in Node with
 * @napi-rs/canvas, the clipboard image is decoded by Electron's nativeImage in the main process.
 *
 * Synthetic frame (2560 x 1440): R = floor(255 x / (w-1)), G = floor(255 y / (h-1)),
 * B = 200 / 60 on a 64 px checker (see src/renderer/capture/synthetic-frame.ts). No pixel of it
 * is black except (0, 0)-ish corners, so any original pixel that survives under a redaction is
 * detected.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createCanvas, loadImage } from '@napi-rs/canvas';
import {
  _electron as electron,
  expect,
  test,
  type ElectronApplication,
  type Locator,
  type Page,
} from '@playwright/test';
import { writeEvidenceJson, evidenceDirFor } from '../native/evidence';
import { exitApp } from './app-exit';
import { editorPage, expectEditorClosed, hasEditorPage } from './editor-window';

const projectRoot = path.resolve(__dirname, '..', '..');
const evidenceDir = evidenceDirFor(projectRoot, 'phase04');
const FRAME = { width: 2560, height: 1440 };

let app: ElectronApplication;
/** The main window; `page` is the Editor window of the latest openShot(). */
let main: Page;
let page: Page;
let userDataDir: string;
let outDir: string;
const measured: Record<string, unknown> = {};

test.describe.configure({ mode: 'serial' });

async function launch(extraArgs: string[] = []): Promise<{
  app: ElectronApplication;
  page: Page;
  dir: string;
}> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'framecapt-e2e-editor-'));
  const electronApp = await electron.launch({
    args: ['.', ...extraArgs],
    cwd: projectRoot,
    env: {
      ...process.env,
      FRAMECAPT_USER_DATA_DIR: dir,
      FRAMECAPT_E2E_MOCK_CAPTURE: '1',
      FRAMECAPT_E2E_MOCK_DISPLAYS: '1',
    },
  });
  const first = await electronApp.firstWindow();
  await first.waitForLoadState('domcontentloaded');
  await expect(first.getByTestId('shot-screen')).toBeVisible();
  return { app: electronApp, page: first, dir };
}

test.beforeAll(async () => {
  expect(
    fs.existsSync(path.join(projectRoot, '.vite', 'build', 'main.cjs')),
    'Run `npm run package:e2e` first (npm run test:e2e does this).',
  ).toBe(true);
  outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'framecapt-e2e-editor-out-'));
  fs.mkdirSync(evidenceDir, { recursive: true });
  ({ app, page: main, dir: userDataDir } = await launch());
});

test.afterAll(async () => {
  if (app) await exitApp(app);
  for (const dir of [userDataDir, outDir])
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
});

// --- helpers ---------------------------------------------------------------------------------

interface CanvasView {
  zoom: number;
  panX: number;
  panY: number;
  dpr: number;
  left: number;
  top: number;
}

function canvas(target: Page = page): Locator {
  return target.getByTestId('editor-canvas');
}

async function canvasView(target: Page = page): Promise<CanvasView> {
  const el = canvas(target);
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

/** Image px -> page px, the inverse of the editor's screenToImage. */
function toPage(view: CanvasView, point: { x: number; y: number }): { x: number; y: number } {
  const scale = view.zoom / view.dpr;
  return {
    x: view.left + view.panX + point.x * scale,
    y: view.top + view.panY + point.y * scale,
  };
}

async function dragImage(
  from: { x: number; y: number },
  to: { x: number; y: number },
  target: Page = page,
): Promise<void> {
  const view = await canvasView(target);
  const a = toPage(view, from);
  const b = toPage(view, to);
  await target.mouse.move(a.x, a.y);
  await target.mouse.down();
  await target.mouse.move((a.x + b.x) / 2, (a.y + b.y) / 2, { steps: 4 });
  await target.mouse.move(b.x, b.y, { steps: 4 });
  await target.mouse.up();
}

async function clickImage(point: { x: number; y: number }, target: Page = page): Promise<void> {
  const view = await canvasView(target);
  const p = toPage(view, point);
  await target.mouse.click(p.x, p.y);
}

async function chooseTool(
  id: 'select' | 'crop' | 'arrow' | 'rect' | 'text' | 'redact',
  target: Page = page,
): Promise<void> {
  await target.getByTestId(`tool-${id}`).click();
  await expect(target.getByTestId(`tool-${id}`)).toHaveAttribute('aria-pressed', 'true');
}

/** Takes a screenshot in the main window; it opens as a tab of the Editor window, which is returned. */
async function openShot(
  mainTarget: Page = main,
  electronApp: ElectronApplication = app,
): Promise<Page> {
  await mainTarget.getByTestId('shot-screen').click();
  const editor = await editorPage(electronApp);
  await expect(editor.getByTestId('editor-view')).toBeVisible();
  await expect(editor.getByTestId('editor-dimensions')).toHaveText(
    `${FRAME.width} × ${FRAME.height}`,
  );
  if (electronApp === app) page = editor;
  return editor;
}

/**
 * Closes the only tab (Done), answering "Don't save" if it asks: the Editor window closes with its
 * last tab and the main window is where the user is.
 */
async function closeEditor(
  target: Page = page,
  electronApp: ElectronApplication = app,
  mainTarget: Page = main,
): Promise<void> {
  await target.getByTestId('editor-done').click();
  await target
    .getByTestId('confirm-yes')
    .click({ timeout: 1500 })
    .catch(() => undefined);
  await expectEditorClosed(electronApp);
  await expect(mainTarget.getByTestId('shot-screen')).toBeVisible();
}

async function stubSaveDialog(filePath: string, electronApp: ElectronApplication = app) {
  await electronApp.evaluate(({ dialog }, target) => {
    dialog.showSaveDialog = (() =>
      Promise.resolve({ canceled: false, filePath: target })) as typeof dialog.showSaveDialog;
  }, filePath);
}

interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

async function redactions(target: Page = page): Promise<Rect[]> {
  return JSON.parse((await canvas(target).getAttribute('data-redactions')) ?? '[]') as Rect[];
}

async function dataRect(name: string, target: Page = page): Promise<Rect | null> {
  const value = await canvas(target).getAttribute(name);
  return value ? (JSON.parse(value) as Rect) : null;
}

interface Pixels {
  width: number;
  height: number;
  data: Uint8ClampedArray;
}

async function decodeFile(file: string): Promise<Pixels> {
  const image = await loadImage(fs.readFileSync(file));
  const surface = createCanvas(image.width, image.height);
  const context = surface.getContext('2d');
  context.drawImage(image, 0, 0);
  const data = context.getImageData(0, 0, image.width, image.height);
  return { width: data.width, height: data.height, data: data.data };
}

const pixelAt = (pixels: Pixels, x: number, y: number): number[] => {
  const i = (y * pixels.width + x) * 4;
  return [pixels.data[i] ?? 0, pixels.data[i + 1] ?? 0, pixels.data[i + 2] ?? 0];
};

/** Expected synthetic pixel of the frame at (x, y). */
function syntheticPixel(x: number, y: number): number[] {
  return [
    Math.floor((255 * x) / (FRAME.width - 1)),
    Math.floor((255 * y) / (FRAME.height - 1)),
    ((x >> 6) + (y >> 6)) & 1 ? 200 : 60,
  ];
}

/** Whole pixels a drawn redaction rect touches, in output coordinates (offset by the crop origin). */
function coverOf(rect: Rect, origin = { x: 0, y: 0 }, size = FRAME): Rect | null {
  const x0 = Math.max(0, Math.floor(rect.x) - origin.x);
  const y0 = Math.max(0, Math.floor(rect.y) - origin.y);
  const x1 = Math.min(size.width, Math.ceil(rect.x + rect.width) - origin.x);
  const y1 = Math.min(size.height, Math.ceil(rect.y + rect.height) - origin.y);
  return x1 > x0 && y1 > y0 ? { x: x0, y: y0, width: x1 - x0, height: y1 - y0 } : null;
}

/** Highest channel value and number of non-black pixels in a rect of a decoded image. */
function blackness(pixels: Pixels, rect: Rect): { worst: number; nonBlack: number; count: number } {
  let worst = 0;
  let nonBlack = 0;
  for (let y = rect.y; y < rect.y + rect.height; y += 1) {
    for (let x = rect.x; x < rect.x + rect.width; x += 1) {
      const peak = Math.max(...pixelAt(pixels, x, y));
      worst = Math.max(worst, peak);
      if (peak > 0) nonBlack += 1;
    }
  }
  return { worst, nonBlack, count: rect.width * rect.height };
}

async function save(
  format: 'png' | 'jpeg',
  name: string,
  target: Page = page,
  electronApp: ElectronApplication = app,
): Promise<string> {
  const file = path.join(outDir, name);
  await stubSaveDialog(file, electronApp);
  if (format === 'png') await target.getByTestId('editor-save').click();
  else {
    await target.getByTestId('editor-save-menu').click();
    await target.getByTestId('editor-save-jpeg').click();
  }
  await expect.poll(() => fs.existsSync(file), { timeout: 15_000 }).toBe(true);
  await expect(target.getByText(/Saved to/).first()).toBeVisible();
  return file;
}

/**
 * The document the redaction tests work on: a redaction first, then an arrow, a rectangle and
 * white text drawn OVER it (they come later in the z-order), so the test proves a redaction is
 * above everything. Returns the redaction rect as the editor stored it.
 */
async function buildRedactedDoc(target: Page = page): Promise<Rect> {
  await chooseTool('redact', target);
  await dragImage({ x: 900.4, y: 500.6 }, { x: 1500.3, y: 900.2 }, target);
  await expect(canvas(target)).toHaveAttribute('data-annotations', '1');
  await chooseTool('arrow', target);
  await dragImage({ x: 700, y: 400 }, { x: 1700, y: 1000 }, target);
  await chooseTool('rect', target);
  await dragImage({ x: 1000, y: 600 }, { x: 1400, y: 800 }, target);
  await chooseTool('text', target);
  await clickImage({ x: 1000, y: 650 }, target);
  await target.getByTestId('editor-text-input').fill('SECRET');
  await target.keyboard.press('Enter');
  await expect(canvas(target)).toHaveAttribute('data-annotations', '4');
  const [rect] = await redactions(target);
  if (!rect) throw new Error('no redaction rect');
  return rect;
}

// --- tests -----------------------------------------------------------------------------------

test('the editor opens with an accessible toolbar, tool shortcuts and a live region', async () => {
  await openShot();
  const toolbar = page.getByRole('toolbar', { name: 'Screenshot editor' });
  await expect(toolbar).toBeVisible();

  // Roving tabindex: exactly one control of the toolbar is in the tab order.
  await expect.poll(() => toolbar.locator('[data-roving][tabindex="0"]').count()).toBe(1);
  await toolbar.locator('[data-roving][tabindex="0"]').focus();
  const focusedBefore = await page.evaluate(() =>
    document.activeElement?.getAttribute('data-testid'),
  );
  await page.keyboard.press('ArrowRight');
  const focusedAfter = await page.evaluate(() =>
    document.activeElement?.getAttribute('data-testid'),
  );
  expect(focusedAfter).not.toBe(focusedBefore);
  await expect.poll(() => toolbar.locator('[data-roving][tabindex="0"]').count()).toBe(1);

  // Every control has an accessible name.
  const unnamed = await toolbar
    .locator('button')
    .evaluateAll(
      (buttons) =>
        buttons.filter(
          (button) => !(button.getAttribute('aria-label') ?? button.textContent ?? '').trim(),
        ).length,
    );
  expect(unnamed).toBe(0);

  // Single-letter shortcuts, announced in the polite live region.
  const keys: [string, 'select' | 'crop' | 'arrow' | 'rect' | 'text' | 'redact', string][] = [
    ['c', 'crop', 'Crop tool'],
    ['a', 'arrow', 'Arrow tool'],
    ['r', 'rect', 'Rectangle tool'],
    ['t', 'text', 'Text tool'],
    ['x', 'redact', 'Redact tool'],
    ['v', 'select', 'Select tool'],
  ];
  await canvas().click({ position: { x: 5, y: 5 } }); // moves focus off the toolbar
  for (const [key, tool, announced] of keys) {
    await page.keyboard.press(key);
    await expect(page.getByTestId(`tool-${tool}`)).toHaveAttribute('aria-pressed', 'true');
    await expect(page.getByTestId('editor-live')).toHaveText(announced);
  }
  await expect(page.getByTestId('editor-live')).toHaveAttribute('aria-live', 'polite');

  // Redact: no color options, and the tooltip says redactions cover everything.
  await chooseTool('redact');
  await expect(page.getByTestId('color-group')).toHaveCount(0);
  await expect(page.getByTestId('redact-note')).toContainText(
    'Redactions always cover everything beneath',
  );
  await page.mouse.move(600, 400); // the click above had closed its tooltip
  await page.getByTestId('tool-redact').hover();
  await expect(page.getByRole('tooltip').first()).toContainText(
    'Redactions always cover everything beneath',
  );
  await closeEditor();
});

test('shortcuts are scoped to the editor and ignored while typing', async () => {
  // No editor: the letter keys do nothing in the main window and no editor UI exists.
  await main.keyboard.press('x');
  await expect(main.getByTestId('editor-toolbar')).toHaveCount(0);
  expect(hasEditorPage(app)).toBe(false);

  await openShot();
  await chooseTool('text');
  await clickImage({ x: 300, y: 300 });
  const input = page.getByTestId('editor-text-input');
  await expect(input).toBeFocused();
  await page.keyboard.type('vcarxt');
  await expect(input).toHaveValue('vcarxt');
  await expect(page.getByTestId('tool-text')).toHaveAttribute('aria-pressed', 'true');
  await page.keyboard.press('Escape'); // cancels the edit; nothing was added
  await expect(canvas()).toHaveAttribute('data-annotations', '0');
  await closeEditor();
});

test('redaction is solid in saved PNG and JPEG and on the clipboard (Chromium encoders)', async () => {
  await openShot();
  const rect = await buildRedactedDoc();
  const cover = coverOf(rect);
  if (!cover) throw new Error('redaction outside the image');

  // PNG
  const pngFile = await save('png', 'redacted.png');
  const png = await decodeFile(pngFile);
  expect({ width: png.width, height: png.height }).toEqual(FRAME);
  const pngStats = blackness(png, cover);
  expect(pngStats.nonBlack).toBe(0);
  // The 1 px expansion is black as well.
  const ring = coverOf({
    x: rect.x - 1,
    y: rect.y - 1,
    width: rect.width + 2,
    height: rect.height + 2,
  });
  expect(ring && blackness(png, ring).nonBlack).toBe(0);
  // Untouched far corners are the original pixels, exactly.
  for (const [x, y] of [
    [5, 5],
    [2554, 5],
    [5, 1434],
    [2554, 1434],
    [1280, 100],
  ] as const) {
    expect(pixelAt(png, x, y)).toEqual(syntheticPixel(x, y));
  }

  // JPEG
  const jpgFile = await save('jpeg', 'redacted.jpg');
  const jpg = await decodeFile(jpgFile);
  expect({ width: jpg.width, height: jpg.height }).toEqual(FRAME);
  const jpgStats = blackness(jpg, cover);
  expect(jpgStats.worst).toBeLessThanOrEqual(8);

  // Clipboard: read back through Electron's own image decoder.
  await page.getByTestId('editor-copy').click();
  await expect(page.getByText('Copied to clipboard')).toBeVisible();
  const clip = await app.evaluate(async ({ clipboard, nativeImage }, area) => {
    const items = await clipboard.read();
    const blob = await items[0]?.getType('image/png');
    if (!blob || (typeof blob === 'object' && !('arrayBuffer' in blob))) return null;
    const image = nativeImage.createFromBuffer(Buffer.from(await (blob as Blob).arrayBuffer()));
    const { width, height } = image.getSize();
    const bitmap = image.toBitmap(); // BGRA
    let worst = 0;
    let nonBlack = 0;
    for (let y = area.y; y < area.y + area.height; y += 1) {
      for (let x = area.x; x < area.x + area.width; x += 1) {
        const i = (y * width + x) * 4;
        const peak = Math.max(bitmap[i] ?? 0, bitmap[i + 1] ?? 0, bitmap[i + 2] ?? 0);
        worst = Math.max(worst, peak);
        if (peak > 0) nonBlack += 1;
      }
    }
    return { width, height, worst, nonBlack };
  }, cover);
  expect(clip).toMatchObject({ width: FRAME.width, height: FRAME.height, nonBlack: 0 });

  // What the user can keep as evidence: synthetic content only, no real desktop.
  fs.copyFileSync(pngFile, path.join(evidenceDir, 'export-redacted-sample.png'));
  fs.copyFileSync(jpgFile, path.join(evidenceDir, 'export-redacted-sample.jpg'));
  measured.redaction = {
    imageSize: FRAME,
    redactionRect: rect,
    pixelsChecked: cover.width * cover.height,
    png: { nonBlackPixels: pngStats.nonBlack, maxChannelUnderRedaction: pngStats.worst },
    jpeg: {
      quality: 0.92,
      maxChannelUnderRedaction: jpgStats.worst,
      threshold: 8,
      note: 'JPEG redactions are padded to 16 px compression blocks (+2 px margin) so they stay solid.',
    },
    clipboard: {
      size: { width: clip?.width, height: clip?.height },
      nonBlackPixels: clip?.nonBlack,
    },
    encoder: 'Chromium OffscreenCanvas.convertToBlob (PNG, JPEG 0.92)',
  };
  await closeEditor();
});

test('undo and redo drive the export: undone redaction shows the original pixels again', async () => {
  await openShot();
  await chooseTool('redact');
  await dragImage({ x: 400, y: 300 }, { x: 800, y: 600 });
  const [rect] = await redactions();
  if (!rect) throw new Error('no redaction');
  const cover = coverOf(rect) as Rect;

  const covered = await decodeFile(await save('png', 'undo-1.png'));
  expect(blackness(covered, cover).nonBlack).toBe(0);

  await page.keyboard.press('Control+z');
  await expect(canvas()).toHaveAttribute('data-annotations', '0');
  await expect(page.getByTestId('editor-undo')).toBeDisabled();
  const restored = await decodeFile(await save('png', 'undo-2.png'));
  // Every sampled pixel under the former redaction is the original again.
  for (let y = cover.y; y < cover.y + cover.height; y += 37) {
    for (let x = cover.x; x < cover.x + cover.width; x += 41) {
      expect(pixelAt(restored, x, y)).toEqual(syntheticPixel(x, y));
    }
  }

  await page.keyboard.press('Control+Shift+z');
  await expect(canvas()).toHaveAttribute('data-annotations', '1');
  const again = await decodeFile(await save('png', 'undo-3.png'));
  expect(blackness(again, cover).nonBlack).toBe(0);
  await page.keyboard.press('Control+z');
  await page.keyboard.press('Control+y'); // Ctrl+Y is redo as well
  await expect(canvas()).toHaveAttribute('data-annotations', '1');
  await closeEditor();
});

test('crop is non-destructive: export dims, undo/redo of the crop, partial redaction', async () => {
  await openShot();
  await chooseTool('redact');
  await dragImage({ x: 100, y: 100 }, { x: 700, y: 500 });
  const [rect] = await redactions();
  if (!rect) throw new Error('no redaction');

  await chooseTool('crop');
  await dragImage({ x: 400, y: 200 }, { x: 1600, y: 800 }); // cuts through the redaction
  const draft = await dataRect('data-crop-draft');
  expect(draft).not.toBeNull();
  const d = draft as Rect;
  await expect(page.getByTestId('crop-size')).toHaveText(`${d.width} × ${d.height}`);
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('tool-select')).toHaveAttribute('aria-pressed', 'true');
  const crop = (await dataRect('data-crop')) as Rect;
  expect(crop).toEqual(d);
  await expect(page.getByTestId('editor-dimensions')).toHaveText(`${d.width} × ${d.height}`);

  const file = await save('png', 'cropped.png');
  const out = await decodeFile(file);
  expect({ width: out.width, height: out.height }).toEqual({ width: d.width, height: d.height });
  const cover = coverOf(rect, crop, d);
  expect(cover).not.toBeNull();
  expect(blackness(out, cover as Rect).nonBlack).toBe(0);
  // Outside the redaction the pixels are the original ones, offset by the crop origin.
  expect(pixelAt(out, d.width - 5, d.height - 5)).toEqual(
    syntheticPixel(crop.x + d.width - 5, crop.y + d.height - 5),
  );

  // Undo restores the full size; redo brings the crop back; the model keeps original coordinates.
  await page.keyboard.press('Control+z');
  await expect(page.getByTestId('editor-dimensions')).toHaveText(
    `${FRAME.width} × ${FRAME.height}`,
  );
  expect(await dataRect('data-crop')).toBeNull();
  const full = await decodeFile(await save('png', 'uncropped.png'));
  expect({ width: full.width, height: full.height }).toEqual(FRAME);
  await page.keyboard.press('Control+Shift+z');
  await expect(page.getByTestId('editor-dimensions')).toHaveText(`${d.width} × ${d.height}`);
  expect(await dataRect('data-crop')).toEqual(crop);

  // Reset crop.
  await chooseTool('crop');
  await page.getByTestId('crop-reset').click();
  await expect(page.getByTestId('editor-dimensions')).toHaveText(
    `${FRAME.width} × ${FRAME.height}`,
  );
  measured.crop = {
    cropRect: crop,
    exportedSize: { width: out.width, height: out.height },
    redactionRect: rect,
    redactionPixelsCheckedInCrop: (cover as Rect).width * (cover as Rect).height,
  };
  await closeEditor();
});

test('Esc cancels a crop in progress; Enter applies; the status chip shows the export size', async () => {
  await openShot();
  await chooseTool('crop');
  await dragImage({ x: 100, y: 100 }, { x: 900, y: 500 });
  await expect(page.getByTestId('crop-size')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(canvas()).toHaveAttribute('data-crop-draft', '');
  await expect(page.getByTestId('tool-select')).toHaveAttribute('aria-pressed', 'true');
  expect(await dataRect('data-crop')).toBeNull();
  await expect(page.getByTestId('editor-status')).toContainText(`${FRAME.width} × ${FRAME.height}`);
  await closeEditor();
});

test('zoom and pan: wheel, shortcuts, limits, space-drag; export size ignores zoom', async () => {
  await openShot();
  const zoomOf = async (): Promise<number> => (await canvasView()).zoom;
  const fit = await zoomOf();
  expect(fit).toBeGreaterThan(0.1);
  expect(fit).toBeLessThan(1);
  await expect(page.getByTestId('editor-zoom')).toHaveText(`${Math.round(fit * 100)}%`);

  await page.keyboard.press('Control+1');
  expect(await zoomOf()).toBe(1);
  await expect(page.getByTestId('editor-zoom')).toHaveText('100%');
  await page.keyboard.press('Control+=');
  expect(await zoomOf()).toBeCloseTo(1.25, 3);
  await page.keyboard.press('Control+-');
  await page.keyboard.press('Control+-');
  expect(await zoomOf()).toBeCloseTo(0.8, 3);
  await page.keyboard.press('Control+0');
  expect(await zoomOf()).toBeCloseTo(fit, 4);

  // Ctrl+wheel zooms at the cursor: the image point under the cursor stays put.
  const before = await canvasView();
  const cursor = { x: before.left + 300, y: before.top + 250 };
  const imagePointBefore = {
    x: (cursor.x - before.left - before.panX) * (before.dpr / before.zoom),
    y: (cursor.y - before.top - before.panY) * (before.dpr / before.zoom),
  };
  await page.mouse.move(cursor.x, cursor.y);
  await page.keyboard.down('Control');
  await page.mouse.wheel(0, -400);
  await page.keyboard.up('Control');
  await expect.poll(zoomOf).toBeGreaterThan(fit * 1.3);
  const after = await canvasView();
  const imagePointAfter = {
    x: (cursor.x - after.left - after.panX) * (after.dpr / after.zoom),
    y: (cursor.y - after.top - after.panY) * (after.dpr / after.zoom),
  };
  expect(imagePointAfter.x).toBeCloseTo(imagePointBefore.x, 0);
  expect(imagePointAfter.y).toBeCloseTo(imagePointBefore.y, 0);

  // Limits: 10% .. 800%.
  for (let i = 0; i < 30; i += 1) await page.keyboard.press('Control+=');
  expect(await zoomOf()).toBe(8);
  for (let i = 0; i < 60; i += 1) await page.keyboard.press('Control+-');
  expect(await zoomOf()).toBeCloseTo(0.1, 4);

  // Space + drag pans.
  await page.keyboard.press('Control+1');
  const start = await canvasView();
  const middle = { x: start.left + 400, y: start.top + 300 };
  await page.mouse.move(middle.x, middle.y);
  await page.keyboard.down('Space');
  await page.mouse.down();
  await page.mouse.move(middle.x - 120, middle.y - 80, { steps: 4 });
  await page.mouse.up();
  await page.keyboard.up('Space');
  const panned = await canvasView();
  expect(panned.panX).toBeCloseTo(start.panX - 120, 0);
  expect(panned.panY).toBeCloseTo(start.panY - 80, 0);

  await expect(page.getByTestId('editor-dimensions')).toHaveText(
    `${FRAME.width} × ${FRAME.height}`,
  );
  await closeEditor();
});

test('text: add, edit by double click, empty text removes it, Shift+Enter makes a new line', async () => {
  await openShot();
  await chooseTool('text');
  await clickImage({ x: 500, y: 400 });
  const input = page.getByTestId('editor-text-input');
  await input.fill('Hello');
  await page.keyboard.press('Enter');
  await expect(canvas()).toHaveAttribute('data-annotations', '1');
  await expect(canvas()).toHaveAttribute('data-selected', 'text');

  await chooseTool('select');
  const geometry = JSON.parse((await canvas().getAttribute('data-selected-geometry')) ?? '{}') as {
    at: { x: number; y: number };
    fontSize: number;
  };
  await canvas().dblclick({
    position: await (async () => {
      const view = await canvasView();
      const p = toPage(view, { x: geometry.at.x + 20, y: geometry.at.y + geometry.fontSize * 0.6 });
      return { x: p.x - view.left, y: p.y - view.top };
    })(),
  });
  await expect(input).toBeVisible();
  await expect(input).toHaveValue('Hello');
  await page.keyboard.press('Control+a');
  await page.keyboard.type('Line one');
  await page.keyboard.press('Shift+Enter');
  await page.keyboard.type('line two');
  await expect(input).toHaveValue('Line one\nline two');
  await page.keyboard.press('Enter');
  await expect(input).toHaveCount(0);
  await expect(canvas()).toHaveAttribute('data-annotations', '1');

  // Editing to an empty string deletes the annotation (committed on blur as well).
  await canvas().dblclick({
    position: await (async () => {
      const view = await canvasView();
      const p = toPage(view, { x: geometry.at.x + 20, y: geometry.at.y + geometry.fontSize * 0.6 });
      return { x: p.x - view.left, y: p.y - view.top };
    })(),
  });
  await expect(input).toBeVisible();
  await page.keyboard.press('Control+a');
  await page.keyboard.press('Delete');
  await page.getByTestId('editor-copy').focus(); // blur commits
  await expect(canvas()).toHaveAttribute('data-annotations', '0');
  await closeEditor();
});

test('selection: handles resize, arrow keys nudge (Shift x10), Delete removes, Esc deselects', async () => {
  await openShot();
  await chooseTool('rect');
  await dragImage({ x: 600, y: 400 }, { x: 1000, y: 700 });
  await expect(canvas()).toHaveAttribute('data-selected', 'rect');
  const first = (await dataRect('data-selected-geometry')) as unknown as { rect: Rect };
  const r0 = first.rect;

  // Nudge from the canvas (focus off any button).
  await canvas().click({ position: { x: 3, y: 3 } }); // empty area: with the rect tool this would draw nothing
  await chooseTool('select');
  await clickImage({ x: r0.x, y: r0.y + 100 }); // the left edge
  await expect(canvas()).toHaveAttribute('data-selected', 'rect');
  await page.keyboard.press('ArrowRight');
  await page.keyboard.press('Shift+ArrowDown');
  const moved = (await dataRect('data-selected-geometry')) as unknown as { rect: Rect };
  expect(moved.rect.x).toBeCloseTo(r0.x + 1, 6);
  expect(moved.rect.y).toBeCloseTo(r0.y + 10, 6);
  // One nudge sequence per key press; undo reverts the last one only.
  await page.keyboard.press('Control+z');
  const undone = (await dataRect('data-selected-geometry')) as unknown as { rect: Rect };
  expect(undone.rect.y).toBeCloseTo(r0.y, 6);

  // Resize by dragging the south-east handle.
  const cur = undone.rect;
  await dragImage(
    { x: cur.x + cur.width, y: cur.y + cur.height },
    { x: cur.x + cur.width + 100, y: cur.y + cur.height + 50 },
  );
  const resized = (await dataRect('data-selected-geometry')) as unknown as { rect: Rect };
  expect(resized.rect.width).toBeGreaterThan(cur.width + 80);
  expect(resized.rect.height).toBeGreaterThan(cur.height + 35);

  await page.keyboard.press('Escape');
  await expect(canvas()).toHaveAttribute('data-selected', '');
  await clickImage({ x: resized.rect.x, y: resized.rect.y + 100 });
  await expect(canvas()).toHaveAttribute('data-selected', 'rect');
  await page.keyboard.press('Delete');
  await expect(canvas()).toHaveAttribute('data-annotations', '0');
  await closeEditor();
});

test('Shift constrains arrows to 45 degrees and rectangles to squares', async () => {
  await openShot();
  await chooseTool('arrow');
  await page.keyboard.down('Shift');
  await dragImage({ x: 400, y: 400 }, { x: 900, y: 520 });
  await page.keyboard.up('Shift');
  const arrow = JSON.parse((await canvas().getAttribute('data-selected-geometry')) ?? '{}') as {
    from: { x: number; y: number };
    to: { x: number; y: number };
  };
  const dx = arrow.to.x - arrow.from.x;
  const dy = arrow.to.y - arrow.from.y;
  expect(Math.abs(dy)).toBeLessThan(1); // snapped to horizontal (the closest 45-degree multiple)
  expect(Math.abs(dx)).toBeGreaterThan(100);

  await chooseTool('rect');
  await page.keyboard.down('Shift');
  await dragImage({ x: 1000, y: 300 }, { x: 1400, y: 450 });
  await page.keyboard.up('Shift');
  const rect = ((await dataRect('data-selected-geometry')) as unknown as { rect: Rect }).rect;
  expect(rect.width).toBeCloseTo(rect.height, 6);
  await closeEditor();
});

test('unsaved changes: the save question on Done and Discard; saving clears it', async () => {
  const dirs = () => {
    const dir = path.join(userDataDir, 'shots');
    return fs.existsSync(dir) ? fs.readdirSync(dir).length : 0;
  };
  const before = dirs();
  await openShot();
  expect(dirs()).toBe(before + 1);
  await chooseTool('rect');
  await dragImage({ x: 300, y: 300 }, { x: 700, y: 600 });

  // The tab shows a dot while it holds unsaved work.
  await expect(page.getByTestId('editor-tab')).toHaveAttribute('data-dirty', 'true');
  await expect(page.getByTestId('tab-dirty')).toBeVisible();

  // Done with unsaved work: asks first (Save, Don't save, Cancel), focus lands on the safe choice.
  await page.getByTestId('editor-done').click();
  let dialog = page.getByRole('alertdialog');
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText('Save changes to Screenshot?');
  await expect(page.getByRole('button', { name: 'Cancel' })).toBeFocused();
  // Shortcuts are ignored behind the dialog.
  await page.keyboard.press('x');
  await expect(page.getByTestId('tool-redact')).not.toHaveAttribute('aria-pressed', 'true');
  await page.getByRole('button', { name: 'Cancel' }).click();
  await expect(dialog).toBeHidden();
  await expect(page.getByTestId('editor-view')).toBeVisible();
  expect(dirs()).toBe(before + 1);

  // Esc is Cancel as well.
  await page.getByTestId('editor-done').click();
  await expect(dialog).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
  await expect(page.getByTestId('editor-view')).toBeVisible();

  // The main window is not held up by it: it never asks about the editor's work.
  await main.getByRole('button', { name: 'Settings', exact: true }).click();
  await expect(main.getByRole('alertdialog')).toHaveCount(0);
  await main.getByRole('button', { name: 'Capture', exact: true }).click();

  // Saved: nothing is lost any more, so leaving is silent and deletes the original.
  await save('png', 'dirty-1.png');
  await expect(page.getByTestId('editor-tab')).toHaveAttribute('data-dirty', 'false');
  await page.getByTestId('editor-done').click();
  await expectEditorClosed(app);
  await expect.poll(dirs).toBe(before);

  // An edit after a save makes it dirty again.
  await openShot();
  dialog = page.getByRole('alertdialog'); // a new Editor window
  await save('png', 'dirty-2.png');
  await chooseTool('arrow');
  await dragImage({ x: 300, y: 300 }, { x: 800, y: 700 });
  await page.getByTestId('editor-discard').click();
  await expect(dialog).toBeVisible();
  await page
    .getByTestId('confirm-yes')
    .click() // Don't save
    .catch(() => undefined); // the window closes under the click
  await expectEditorClosed(app);
  await expect.poll(dirs).toBe(before);
  // Undoing back to the saved state is clean again.
  await openShot();
  await save('png', 'dirty-3.png');
  await chooseTool('rect');
  await dragImage({ x: 300, y: 300 }, { x: 700, y: 600 });
  await page.keyboard.press('Control+z');
  await page.getByTestId('editor-done').click();
  await expectEditorClosed(app);
});

test('"Save" in the unsaved-tab question saves and then closes the tab', async () => {
  await openShot();
  await chooseTool('rect');
  await dragImage({ x: 300, y: 300 }, { x: 700, y: 600 });
  const file = path.join(outDir, 'save-on-close.png');
  await stubSaveDialog(file);
  await page.getByTestId('editor-done').click();
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect.poll(() => fs.existsSync(file), { timeout: 15_000 }).toBe(true);
  await expectEditorClosed(app);
});

/** Close-to-tray is on by default (closing hides the window); these tests are about really closing it. */
async function closeInsteadOfHiding(target: Page): Promise<void> {
  const result = await target.evaluate(() =>
    window.framecapt.invoke('settings:update', { patch: { general: { closeToTray: false } } }),
  );
  expect(result.ok).toBe(true);
}

test('closing the Editor window with unsaved work asks once; a second close always goes through', async () => {
  const second = await launch();
  try {
    const editor = await openShot(second.page, second.app);
    await chooseTool('rect', editor);
    await dragImage({ x: 300, y: 300 }, { x: 700, y: 600 }, editor);
    const win = await second.app.browserWindow(editor);

    // First close attempt: the window stays and the renderer asks, naming what is unsaved.
    await win.evaluate((w) => w.close());
    await expect(editor.getByRole('alertdialog')).toBeVisible();
    await expect(editor.getByRole('alertdialog')).toContainText('Screenshot');
    expect(await win.evaluate((w) => w.isDestroyed())).toBe(false);
    // "Keep editing" answers main, and the next attempt asks again.
    await editor.getByRole('button', { name: 'Keep editing' }).click();
    await expect(editor.getByRole('alertdialog')).toBeHidden();
    await win.evaluate((w) => w.close());
    await expect(editor.getByRole('alertdialog')).toBeVisible();

    // A second close while the question is open is a confirmation: quit is never blocked.
    const closed = editor.waitForEvent('close');
    await win.evaluate((w) => w.close()).catch(() => undefined);
    await closed;
    // The main window is not touched by it.
    expect(second.page.isClosed()).toBe(false);
  } finally {
    await exitApp(second.app);
    fs.rmSync(second.dir, { recursive: true, force: true });
  }
  const third = await launch();
  try {
    // Answering "Discard" closes the Editor window and deletes the session.
    const editor = await openShot(third.page, third.app);
    await chooseTool('rect', editor);
    await dragImage({ x: 300, y: 300 }, { x: 700, y: 600 }, editor);
    const win = await third.app.browserWindow(editor);
    const closed = editor.waitForEvent('close');
    await win.evaluate((w) => w.close());
    await editor
      .getByTestId('confirm-yes')
      .click()
      .catch(() => undefined); // the window closes under the click
    await closed;
    const shots = path.join(third.dir, 'shots');
    await expect.poll(() => (fs.existsSync(shots) ? fs.readdirSync(shots).length : 0)).toBe(0);
    expect(third.page.isClosed()).toBe(false);
  } finally {
    await exitApp(third.app);
    fs.rmSync(third.dir, { recursive: true, force: true });
  }
});

test('closing the main window (quitting) asks about unsaved tabs of the Editor window first', async () => {
  const fourth = await launch();
  try {
    await closeInsteadOfHiding(fourth.page);
    const editor = await openShot(fourth.page, fourth.app);
    await chooseTool('rect', editor);
    await dragImage({ x: 300, y: 300 }, { x: 700, y: 600 }, editor);
    const mainWin = await fourth.app.browserWindow(fourth.page);

    // The main window does not close over unsaved work: the Editor window asks first.
    await mainWin.evaluate((w) => w.close());
    await expect(editor.getByRole('alertdialog')).toBeVisible();
    expect(fourth.page.isClosed()).toBe(false);
    await editor.getByRole('button', { name: 'Keep editing' }).click();
    await expect(editor.getByRole('alertdialog')).toBeHidden();
    expect(fourth.page.isClosed()).toBe(false);

    // "Discard & close": the Editor window goes, and the main window (the app) follows.
    const appClosed = fourth.app.waitForEvent('close');
    await mainWin.evaluate((w) => w.close());
    await editor
      .getByTestId('confirm-yes')
      .click()
      .catch(() => undefined);
    await appClosed;
  } finally {
    await exitApp(fourth.app);
    fs.rmSync(fourth.dir, { recursive: true, force: true });
  }
});

test('the original stays in the app folder; exporting never writes it to the user folder', async () => {
  await openShot();
  const shotsDir = path.join(userDataDir, 'shots');
  const [session] = fs.readdirSync(shotsDir);
  expect(session).toBeDefined();
  const originalBefore = fs.readFileSync(path.join(shotsDir, session as string, 'original.png'));
  await chooseTool('redact');
  await dragImage({ x: 400, y: 300 }, { x: 800, y: 600 });
  const file = await save('png', 'edited.png');
  // The export differs from the original; the retained original is untouched and stays private.
  expect(fs.readFileSync(file).equals(originalBefore)).toBe(false);
  expect(
    fs.readFileSync(path.join(shotsDir, session as string, 'original.png')).equals(originalBefore),
  ).toBe(true);
  expect(fs.existsSync(path.join(userDataDir, 'pictures'))).toBe(true); // default export folder only
  await closeEditor();
  expect(fs.existsSync(path.join(shotsDir, session as string))).toBe(false);
});

test('UI evidence: editor with annotations and a redaction, light and dark', async () => {
  await openShot();
  await page.setViewportSize({ width: 1280, height: 800 }).catch(() => undefined);
  await chooseTool('redact');
  await dragImage({ x: 1500, y: 700 }, { x: 2100, y: 900 });
  await chooseTool('rect');
  await dragImage({ x: 300, y: 250 }, { x: 1100, y: 750 });
  await chooseTool('arrow');
  await dragImage({ x: 1500, y: 300 }, { x: 1150, y: 480 });
  await chooseTool('text');
  await clickImage({ x: 1520, y: 250 });
  await page.getByTestId('editor-text-input').fill('Look here');
  await page.keyboard.press('Enter');
  await chooseTool('select');
  await clickImage({ x: 300, y: 500 });

  // Toasts from the previous tests would cover the status chip in the pictures.
  await expect(page.locator('[data-sonner-toast]')).toHaveCount(0, { timeout: 15_000 });
  const snap = async (name: string): Promise<void> => {
    await page.waitForTimeout(400);
    await page.screenshot({ path: path.join(evidenceDir, name) });
  };
  for (const scheme of ['dark', 'light'] as const) {
    await page.emulateMedia({ colorScheme: scheme });
    await snap(`ui-editor-${scheme}.png`);
  }
  await chooseTool('crop');
  await dragImage({ x: 200, y: 150 }, { x: 2200, y: 1000 });
  for (const scheme of ['dark', 'light'] as const) {
    await page.emulateMedia({ colorScheme: scheme });
    await snap(`ui-editor-crop-${scheme}.png`);
  }
  await chooseTool('redact');
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.mouse.move(600, 500);
  await page.getByTestId('tool-redact').hover();
  await expect(page.getByRole('tooltip').first()).toBeVisible();
  await snap('ui-editor-redact-tooltip-dark.png');
  await page.emulateMedia({ colorScheme: null });
  await page.mouse.move(5, 5);
  await closeEditor();
});

test('devicePixelRatio 1.5: pointer coordinates stay in image pixels, export is unscaled', async () => {
  const hi = await launch(['--force-device-scale-factor=1.5']);
  try {
    const editor = await openShot(hi.page, hi.app);
    const view = await canvasView(editor);
    expect(view.dpr).toBeCloseTo(1.5, 5);
    await chooseTool('redact', editor);
    const from = { x: 800, y: 500 };
    const to = { x: 1400, y: 900 };
    await dragImage(from, to, editor);
    const [rect] = await redactions(editor);
    if (!rect) throw new Error('no redaction');
    // The rectangle in the model is what was dragged, in image px, whatever the DPR.
    const tolerance = view.dpr / view.zoom + 1; // one device pixel of pointer precision
    expect(Math.abs(rect.x - from.x)).toBeLessThan(tolerance);
    expect(Math.abs(rect.y - from.y)).toBeLessThan(tolerance);
    expect(Math.abs(rect.x + rect.width - to.x)).toBeLessThan(tolerance);

    const file = await save('png', 'dpr15.png', editor, hi.app);
    const out = await decodeFile(file);
    expect({ width: out.width, height: out.height }).toEqual(FRAME);
    expect(blackness(out, coverOf(rect) as Rect).nonBlack).toBe(0);
    await expect(editor.getByTestId('editor-dimensions')).toHaveText(
      `${FRAME.width} × ${FRAME.height}`,
    );
    measured.devicePixelRatio = {
      dpr: view.dpr,
      zoom: view.zoom,
      exportedSize: { width: out.width, height: out.height },
    };
  } finally {
    await exitApp(hi.app);
    fs.rmSync(hi.dir, { recursive: true, force: true });
  }
});

test('performance: no animation loop while idle; dragging stays smooth at 2560 x 1440', async () => {
  await openShot();
  await chooseTool('rect');
  await dragImage({ x: 300, y: 300 }, { x: 1500, y: 900 });
  await chooseTool('select');

  // Idle: nothing may schedule animation frames (the editor redraws on demand only).
  await page.mouse.move(5, 5);
  await page.waitForTimeout(500);
  const idleFrames = await page.evaluate(async () => {
    let calls = 0;
    const original = window.requestAnimationFrame.bind(window);
    window.requestAnimationFrame = (callback) => {
      calls += 1;
      return original(callback);
    };
    await new Promise((resolve) => setTimeout(resolve, 1500));
    window.requestAnimationFrame = original;
    return calls;
  });
  expect(idleFrames).toBe(0);

  // Dragging a large rectangle across the image: measure the frame intervals.
  await page.evaluate(() => {
    const w = window as unknown as { __intervals: number[]; __stop: boolean };
    w.__intervals = [];
    w.__stop = false;
    let last = performance.now();
    const tick = (now: number): void => {
      w.__intervals.push(now - last);
      last = now;
      if (!w.__stop) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
  const view = await canvasView();
  const edge = toPage(view, { x: 300, y: 600 }); // left edge of the rectangle
  await page.mouse.move(edge.x, edge.y);
  await page.mouse.down();
  for (let i = 0; i < 240; i += 1) {
    const phase = (i / 240) * Math.PI * 4;
    await page.mouse.move(edge.x + Math.sin(phase) * 150 + i * 0.5, edge.y + Math.cos(phase) * 60);
  }
  await page.mouse.up();
  const intervals = await page.evaluate(() => {
    const w = window as unknown as { __intervals: number[]; __stop: boolean };
    w.__stop = true;
    return w.__intervals.slice(2);
  });
  const sorted = [...intervals].sort((a, b) => a - b);
  const at = (q: number): number =>
    sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))] ?? 0;
  const perf = {
    image: FRAME,
    frames: intervals.length,
    medianFrameMs: Math.round(at(0.5) * 10) / 10,
    p95FrameMs: Math.round(at(0.95) * 10) / 10,
    maxFrameMs: Math.round((sorted[sorted.length - 1] ?? 0) * 10) / 10,
    idleAnimationFrameRequests: idleFrames,
  };
  measured.interaction = perf;
  expect(perf.frames).toBeGreaterThan(20);
  expect(perf.p95FrameMs).toBeLessThan(50);
  await closeEditor();
});

test('write the evidence summary (redacted JSON)', async () => {
  writeEvidenceJson(evidenceDir, 'editor-e2e.json', {
    date: new Date().toISOString(),
    build: 'E2E build (mock capture, synthetic 2560x1440 frame), Chromium encoders',
    electron: await app.evaluate(() => process.versions.electron),
    ...measured,
  });
  expect(fs.existsSync(path.join(evidenceDir, 'editor-e2e.json'))).toBe(true);
});
