/**
 * Opening pictures and image layers, end to end (E2E build: mock capture, ONE mock display).
 * File > Open image (dialog, Ctrl+O, drop, paste), then inside the editor Insert image (file,
 * History, paste, drop), move/resize/undo, export pixels with a redaction above the picture, and the
 * pictures coming back when the saved screenshot is edited again. Pictures are real files made here;
 * the Open dialog is stubbed in the main process the way the other specs stub their dialogs.
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
import { exitApp } from './app-exit';
import { activePanel, editorPage, expectEditorClosed, hasEditorPage } from './editor-window';

const projectRoot = path.resolve(__dirname, '..', '..');
const FRAME = { width: 2560, height: 1440 };

test.describe.configure({ mode: 'serial' });

interface Session {
  app: ElectronApplication;
  page: Page;
  dir: string;
}

async function launch(): Promise<Session> {
  expect(
    fs.existsSync(path.join(projectRoot, '.vite', 'build', 'main.cjs')),
    'Run `npm run package:e2e` first (npm run test:e2e does this).',
  ).toBe(true);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'framecapt-e2e-images-'));
  fs.mkdirSync(path.join(dir, 'files'));
  const app = await electron.launch({
    args: ['.'],
    cwd: projectRoot,
    env: {
      ...process.env,
      FRAMECAPT_USER_DATA_DIR: dir,
      FRAMECAPT_E2E_MOCK_CAPTURE: '1',
      FRAMECAPT_E2E_MOCK_DISPLAYS: '1',
    },
  });
  const page = await app.firstWindow();
  await page.waitForLoadState('domcontentloaded');
  await expect(page.getByTestId('shot-screen')).toBeVisible();
  return { app, page, dir };
}

// --- fixtures: real picture files --------------------------------------------------------------

type PictureFormat = 'png' | 'jpeg' | 'webp';

/** A solid picture with a 4 px white border so that a resize or crop would show. */
function picture(width: number, height: number, color: string, format: PictureFormat = 'png') {
  const canvas = createCanvas(width, height);
  const context = canvas.getContext('2d');
  context.fillStyle = color;
  context.fillRect(0, 0, width, height);
  return format === 'png'
    ? canvas.toBuffer('image/png')
    : format === 'jpeg'
      ? canvas.toBuffer('image/jpeg')
      : canvas.toBuffer('image/webp');
}

function writePicture(dir: string, name: string, bytes: Buffer): string {
  const file = path.join(dir, 'files', name);
  fs.writeFileSync(file, bytes);
  return file;
}

async function stubOpenDialog(app: ElectronApplication, filePath: string): Promise<void> {
  await app.evaluate(({ dialog }, target) => {
    dialog.showOpenDialog = (() =>
      Promise.resolve({
        canceled: false,
        filePaths: [target],
      })) as unknown as typeof dialog.showOpenDialog;
  }, filePath);
}

async function stubSaveDialog(app: ElectronApplication, filePath: string): Promise<void> {
  await app.evaluate(({ dialog }, target) => {
    dialog.showSaveDialog = (() =>
      Promise.resolve({ canceled: false, filePath: target })) as typeof dialog.showSaveDialog;
  }, filePath);
}

// --- editor helpers (the same canvas contract as editor-pro.spec.ts) -----------------------------

const canvasOf = (page: Page): Locator => page.getByTestId('editor-canvas');
const annotationCount = async (page: Page): Promise<number> =>
  Number(await canvasOf(page).getAttribute('data-annotations'));

interface View {
  zoom: number;
  panX: number;
  panY: number;
  dpr: number;
  left: number;
  top: number;
}

async function viewOf(page: Page): Promise<View> {
  const el = canvasOf(page);
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

const toPage = (view: View, point: { x: number; y: number }) => {
  const scale = view.zoom / view.dpr;
  return {
    x: view.left + view.panX + point.x * scale,
    y: view.top + view.panY + point.y * scale,
  };
};

async function drag(
  page: Page,
  from: { x: number; y: number },
  to: { x: number; y: number },
): Promise<void> {
  const view = await viewOf(page);
  const a = toPage(view, from);
  const b = toPage(view, to);
  await page.mouse.move(a.x, a.y);
  await page.mouse.down();
  await page.mouse.move((a.x + b.x) / 2, (a.y + b.y) / 2, { steps: 4 });
  await page.mouse.move(b.x, b.y, { steps: 4 });
  await page.mouse.up();
}

/** Takes a screenshot in the main window; it opens as a tab of the Editor window, which is returned. */
async function openShot(main: Page, app: ElectronApplication): Promise<Page> {
  // The main window stays where it was (History after an Edit): go back to the Capture view.
  if (!(await main.getByTestId('shot-screen').isVisible())) {
    await main
      .getByRole('navigation', { name: 'Primary' })
      .getByRole('button', { name: 'Capture', exact: true })
      .click();
  }
  await main.getByTestId('shot-screen').click();
  const editor = await editorPage(app);
  await expect(editor.getByTestId('editor-view')).toBeVisible();
  await expect(editor.getByTestId('editor-dimensions')).toHaveText(
    `${FRAME.width} × ${FRAME.height}`,
  );
  return editor;
}

/** Closes the only tab (Done), answering "Don't save" if it asks; the Editor window closes with it. */
async function leaveEditor(editor: Page, app: ElectronApplication): Promise<void> {
  await editor.getByTestId('editor-done').click();
  await editor
    .getByTestId('confirm-yes')
    .click({ timeout: 1500 })
    .catch(() => undefined);
  await expectEditorClosed(app);
}

interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

async function selectedRect(page: Page): Promise<Rect> {
  const geometry = JSON.parse(
    (await canvasOf(page).getAttribute('data-selected-geometry')) ?? '{}',
  );
  return geometry.rect as Rect;
}

async function decode(file: string) {
  const image = await loadImage(fs.readFileSync(file));
  const surface = createCanvas(image.width, image.height);
  const context = surface.getContext('2d');
  context.drawImage(image, 0, 0);
  return { width: image.width, height: image.height, context };
}

const pixelAt = (decoded: Awaited<ReturnType<typeof decode>>, x: number, y: number): number[] =>
  Array.from(decoded.context.getImageData(x, y, 1, 1).data).slice(0, 3);

/** Dispatches a paste of `bytes` as an image file, as the browser does for Ctrl+V of a picture. */
async function pastePicture(page: Page, bytes: Buffer): Promise<void> {
  await page.evaluate(async (base64) => {
    const data = new DataTransfer();
    data.items.add(
      new File([Uint8Array.from(atob(base64), (c) => c.charCodeAt(0))], 'pasted.png', {
        type: 'image/png',
      }),
    );
    document.body.dispatchEvent(
      new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }),
    );
  }, bytes.toString('base64'));
}

/** Dispatches a drop of `bytes` as an image file on the element, at the given page point. */
async function dropPicture(
  page: Page,
  testId: string | null,
  bytes: Buffer,
  at?: { x: number; y: number },
): Promise<void> {
  await page.evaluate(
    async ({ base64, id, point }) => {
      const data = new DataTransfer();
      data.items.add(
        new File([Uint8Array.from(atob(base64), (c) => c.charCodeAt(0))], 'dropped.png', {
          type: 'image/png',
        }),
      );
      const target = id
        ? (document.querySelector(`[data-testid="${id}"]`) as HTMLElement)
        : document.body;
      target.dispatchEvent(
        new DragEvent('drop', {
          dataTransfer: data,
          bubbles: true,
          cancelable: true,
          clientX: point?.x ?? 10,
          clientY: point?.y ?? 10,
        }),
      );
    },
    { base64: bytes.toString('base64'), id: testId, point: at },
  );
}

const historyItems = async (page: Page) => {
  const result = await page.evaluate(() => window.framecapt.invoke('history:list', {}));
  if (!result.ok) throw new Error('history:list failed');
  return result.data.items;
};

let session: Session | undefined;
test.afterAll(async () => {
  if (session) {
    await exitApp(session.app);
    fs.rmSync(session.dir, { recursive: true, force: true });
  }
});

// --- File > Open image --------------------------------------------------------------------------

test('Open image opens a picture in the editor without saving anything', async () => {
  session = await launch();
  const { app, page, dir } = session;
  // "Save after capture" must not apply to a picture the user opened.
  const set = await page.evaluate(() =>
    window.framecapt.invoke('settings:update', {
      patch: { screenshots: { afterCapture: 'save-and-editor' } },
    }),
  );
  expect(set.ok).toBe(true);

  await stubOpenDialog(app, writePicture(dir, 'photo.png', picture(640, 360, '#00aa44')));
  await expect(page.getByTestId('open-image-card')).toBeVisible();
  await page.getByTestId('open-image').click();
  const editor = await editorPage(app);
  await expect(editor.getByTestId('editor-view')).toBeVisible();
  await expect(editor.getByTestId('editor-dimensions')).toHaveText('640 × 360');
  expect(await historyItems(page)).toHaveLength(0);

  // Nothing was edited: leaving asks nothing.
  await editor.getByTestId('editor-done').click();
  await expectEditorClosed(app); // closed on its own: nothing was asked
  expect(await historyItems(page)).toHaveLength(0);
});

test('JPEG and WebP files open too (the renderer decodes them)', async () => {
  const { app, page, dir } = session as Session;
  for (const format of ['jpeg', 'webp'] as const) {
    await stubOpenDialog(
      app,
      writePicture(dir, `pic.${format}`, picture(300, 200, '#cc3300', format)),
    );
    await page.getByTestId('open-image').click();
    const editor = await editorPage(app);
    await expect(editor.getByTestId('editor-dimensions')).toHaveText('300 × 200');
    await leaveEditor(editor, app);
  }
});

test('Ctrl+O, a dropped file and a pasted picture open the editor; a file that is not a picture is refused', async () => {
  const { app, page, dir } = session as Session;
  await stubOpenDialog(app, writePicture(dir, 'key.png', picture(120, 80, '#112233')));
  await page.keyboard.press('Control+o');
  const first = await editorPage(app);
  await expect(first.getByTestId('editor-dimensions')).toHaveText('120 × 80');
  await leaveEditor(first, app);

  await dropPicture(page, null, picture(200, 100, '#445566'));
  const dropped = await editorPage(app);
  await expect(dropped.getByTestId('editor-dimensions')).toHaveText('200 × 100');
  await leaveEditor(dropped, app);

  await pastePicture(page, picture(90, 60, '#778899'));
  const pasted = await editorPage(app);
  await expect(pasted.getByTestId('editor-dimensions')).toHaveText('90 × 60');
  await leaveEditor(pasted, app);

  await stubOpenDialog(app, writePicture(dir, 'fake.png', Buffer.from('MZ not a picture at all')));
  await page.getByTestId('open-image').click();
  await expect(page.getByText(/not a PNG, JPEG, WebP, GIF or BMP/)).toBeVisible();
  expect(hasEditorPage(app)).toBe(false);
});

test('opening a picture while a screenshot has edits adds a tab and keeps the edits', async () => {
  const { app, page: mainWin, dir } = session as Session;
  const page = await openShot(mainWin, app);
  await page.getByTestId('tool-rect').click();
  await drag(page, { x: 100, y: 100 }, { x: 500, y: 400 });
  await expect.poll(() => annotationCount(page)).toBe(1);
  await stubOpenDialog(app, writePicture(dir, 'other.png', picture(64, 64, '#abcdef')));
  // Ctrl+O works in the Editor window too: the picture is a second tab, nothing is asked.
  await page.keyboard.press('Escape');
  await page.keyboard.press('Control+o');
  await expect(page.getByTestId('editor-tab')).toHaveCount(2);
  await expect(page.getByTestId('confirm-dialog')).toHaveCount(0);
  await expect(activePanel(page)).toHaveCount(1);
  await expect(activePanel(page).getByTestId('editor-dimensions')).toHaveText('64 × 64');

  // Back on the first tab: its edit is still there (each tab keeps its own state).
  await page.getByTestId('editor-tab').first().getByRole('button').first().click();
  await expect(activePanel(page).getByTestId('editor-dimensions')).toHaveText(
    `${FRAME.width} × ${FRAME.height}`,
  );
  await expect(activePanel(page).getByTestId('editor-canvas')).toHaveAttribute(
    'data-annotations',
    '1',
  );
  await page.getByTestId('editor-tab').last().getByTestId('tab-close').click(); // the clean picture
  await expect(page.getByTestId('editor-tab')).toHaveCount(1);
  await leaveEditor(page, app);
});

// --- image layers -------------------------------------------------------------------------------

test('Insert image from a file: centered, selected, undoable, and in the exported pixels under a redaction', async () => {
  const { app, page: mainWin, dir } = session as Session;
  const page = await openShot(mainWin, app);
  await stubOpenDialog(app, writePicture(dir, 'logo.png', picture(400, 200, '#ff0000')));
  await page.getByTestId('editor-insert-image').click();
  await page.getByTestId('editor-insert-file').click();
  await expect.poll(() => annotationCount(page)).toBe(1);
  await expect(canvasOf(page)).toHaveAttribute('data-selected', 'image');
  // Smaller than 60 % of the canvas: kept at its own size, centered.
  expect(await selectedRect(page)).toEqual({ x: 1080, y: 620, width: 400, height: 200 });
  await expect(page.getByTestId('panel-image')).toBeVisible();

  // Resize with the corner handle: the proportions are kept.
  await page.getByTestId('tool-select').click();
  await drag(page, { x: 1480, y: 820 }, { x: 1680, y: 840 });
  const resized = await selectedRect(page);
  expect(resized.x).toBe(1080);
  expect(resized.y).toBe(620);
  expect(resized.width / resized.height).toBeCloseTo(2, 3);
  expect(resized.width).toBeGreaterThan(400);
  // Reset size puts the picture back to its own pixels.
  await page.getByTestId('panel-image-reset').click();
  const reset = await selectedRect(page);
  expect(reset.width).toBe(400);
  expect(reset.height).toBe(200);

  // Move it with the keyboard, then undo the move.
  await canvasOf(page).focus();
  await page.keyboard.press('Shift+ArrowRight');
  expect((await selectedRect(page)).x).toBe(reset.x + 10);
  await page.getByTestId('editor-undo').click();
  expect((await selectedRect(page)).x).toBe(reset.x);

  // A redaction above the picture covers part of it.
  await page.getByTestId('tool-redact').click();
  await drag(page, { x: 1100, y: 640 }, { x: 1200, y: 700 });
  await expect.poll(() => annotationCount(page)).toBe(2);

  const file = path.join(dir, 'files', 'with-image.png');
  await stubSaveDialog(app, file);
  await page.getByTestId('editor-save').click();
  await expect.poll(() => fs.existsSync(file), { timeout: 15_000 }).toBe(true);
  const exported = await decode(file);
  expect(exported.width).toBe(FRAME.width);
  expect(pixelAt(exported, 1400, 800)).toEqual([255, 0, 0]); // the picture
  expect(pixelAt(exported, 1150, 670)).toEqual([0, 0, 0]); // the redaction above it
  expect(pixelAt(exported, 1070, 800)).not.toEqual([255, 0, 0]); // outside the picture

  // The picture is kept with the editable project.
  const [item] = await historyItems(page);
  expect(item?.editable).toBe(true);
  const assets = path.join(dir, 'projects', item?.id ?? 'x', 'assets');
  expect(fs.readdirSync(assets)).toHaveLength(1);
  expect(fs.readdirSync(assets)[0]).toMatch(/^[0-9a-f]{64}\.png$/);
  await leaveEditor(page, app);
});

test('the saved screenshot opens again with its image layer, and editing it keeps the picture', async () => {
  const { app, page: mainWin, dir } = session as Session;
  const nav = mainWin.getByRole('navigation', { name: 'Primary' });
  await nav.getByRole('button', { name: 'Capture', exact: true }).click();
  await nav.getByRole('button', { name: 'History' }).click();
  await mainWin.getByTestId('history-item').first().getByRole('button').first().click();
  await mainWin.getByTestId('details-edit').click();
  const page = await editorPage(app);
  await expect(page.getByTestId('editor-view')).toBeVisible();
  await expect.poll(() => annotationCount(page)).toBe(2);

  // Select the picture (its rectangle) and make it translucent through the panel.
  await page.getByTestId('tool-select').click();
  const view = await viewOf(page);
  const p = toPage(view, { x: 1400, y: 800 });
  await page.mouse.click(p.x, p.y);
  await expect(canvasOf(page)).toHaveAttribute('data-selected', 'image');
  await page.getByTestId('panel-opacity').fill('50');
  await page.keyboard.press('Tab');

  await page.getByTestId('editor-save').click();
  await page.getByTestId('confirm-yes').click();
  await expect(page.getByText(/Changes saved/).first()).toBeVisible();
  const [item] = await historyItems(page);
  const exported = await decode(item?.path ?? '');
  const [r, g, b] = pixelAt(exported, 1400, 800);
  expect(r).toBeGreaterThan(130); // translucent red over the screenshot, no longer pure red
  expect(r).toBeLessThan(255);
  expect(g! + b!).toBeGreaterThan(0);
  expect(fs.readdirSync(path.join(dir, 'projects', item?.id ?? 'x', 'assets'))).toHaveLength(1);
  await leaveEditor(page, app);
});

test('Insert image by paste and by dropping on the canvas, and from History', async () => {
  const { app, page: mainWin, dir } = session as Session;
  const page = await openShot(mainWin, app);
  await canvasOf(page).focus();

  await pastePicture(page, picture(300, 150, '#00ff00'));
  await expect.poll(() => annotationCount(page)).toBe(1);
  await expect(canvasOf(page)).toHaveAttribute('data-selected', 'image');
  expect(await selectedRect(page)).toEqual({ x: 1130, y: 645, width: 300, height: 150 });

  // A drop lands centered under the pointer.
  const view = await viewOf(page);
  const target = toPage(view, { x: 400, y: 300 });
  await dropPicture(page, 'editor-stage', picture(100, 100, '#0000ff'), target);
  await expect.poll(() => annotationCount(page)).toBe(2);
  const dropped = await selectedRect(page);
  expect(dropped.x + dropped.width / 2).toBeCloseTo(400, -1);
  expect(dropped.y + dropped.height / 2).toBeCloseTo(300, -1);

  // From History: the saved screenshot of the earlier test comes in scaled to fit 60 %.
  await page.getByTestId('editor-insert-image').click();
  await page.getByTestId('editor-insert-history').click();
  await expect(page.getByTestId('history-image-picker')).toBeVisible();
  await page.getByTestId('history-image-item').first().click();
  await expect.poll(() => annotationCount(page)).toBe(3);
  const nested = await selectedRect(page);
  expect(nested.width).toBeLessThanOrEqual(FRAME.width * 0.6);
  expect(nested.height).toBeLessThanOrEqual(FRAME.height * 0.6);
  expect(nested.width / nested.height).toBeCloseTo(FRAME.width / FRAME.height, 2);

  // Everything is flattened into one export.
  const file = path.join(dir, 'files', 'three-images.png');
  await stubSaveDialog((session as Session).app, file);
  await page.getByTestId('editor-save').click();
  await expect.poll(() => fs.existsSync(file), { timeout: 15_000 }).toBe(true);
  const exported = await decode(file);
  expect(pixelAt(exported, 400, 300)).toEqual([0, 0, 255]);
  await leaveEditor(page, app);
});

test('a picture that is not a PNG, or too many pictures, are refused with a message', async () => {
  const { app, page: mainWin } = session as Session;
  const page = await openShot(mainWin, app);
  await canvasOf(page).focus();
  await page.evaluate(async () => {
    const data = new DataTransfer();
    data.items.add(new File([new Uint8Array([1, 2, 3, 4])], 'broken.png', { type: 'image/png' }));
    document.body.dispatchEvent(
      new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }),
    );
  });
  await expect(page.getByText(/could not be read/).first()).toBeVisible();
  expect(await annotationCount(page)).toBe(0);

  // The 33rd distinct picture is refused (32 are allowed).
  for (let i = 0; i < 32; i += 1) {
    await pastePicture(page, picture(10 + i, 10, '#123456'));
    await expect.poll(() => annotationCount(page)).toBe(i + 1);
  }
  await pastePicture(page, picture(80, 10, '#123456'));
  await expect(page.getByText(/up to 32 inserted pictures/).first()).toBeVisible();
  expect(await annotationCount(page)).toBe(32);
  await leaveEditor(page, app);
});
