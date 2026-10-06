/**
 * The professional editor and re-editing from History, end to end (E2E build: mock capture, ONE
 * mock display). Capture -> annotate with several of the new tools -> save -> History -> Edit ->
 * the annotations are still editable -> Save changes (overwrite) and Save a copy (derivedFrom);
 * an old flattened item opens as a plain image with a notice; the redaction note; deleting the
 * editable data; keyboard rebinding of a new tool; accessibility with the properties panel open.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import AxeBuilder from '@axe-core/playwright';
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
import { mockScreenshotPng, newId, seedHistory } from './history-fixtures';

const projectRoot = path.resolve(__dirname, '..', '..');
const FRAME = { width: 2560, height: 1440 };

test.describe.configure({ mode: 'serial' });

interface Session {
  app: ElectronApplication;
  page: Page;
  dir: string;
}

async function launch(
  prepare?: (dir: string) => void,
  extraEnv: Record<string, string> = {},
): Promise<Session> {
  expect(
    fs.existsSync(path.join(projectRoot, '.vite', 'build', 'main.cjs')),
    'Run `npm run package:e2e` first (npm run test:e2e does this).',
  ).toBe(true);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'framecapt-e2e-pro-'));
  prepare?.(dir);
  const app = await electron.launch({
    args: ['.'],
    cwd: projectRoot,
    env: {
      ...process.env,
      FRAMECAPT_USER_DATA_DIR: dir,
      FRAMECAPT_E2E_MOCK_CAPTURE: '1',
      FRAMECAPT_E2E_MOCK_DISPLAYS: '1',
      ...extraEnv,
    },
  });
  const page = await app.firstWindow();
  await page.waitForLoadState('domcontentloaded');
  await expect(page.getByTestId('shot-screen')).toBeVisible();
  return { app, page, dir };
}

async function close(session: Session | undefined): Promise<void> {
  if (!session) return;
  await exitApp(session.app);
  fs.rmSync(session.dir, { recursive: true, force: true });
}

// --- helpers ---------------------------------------------------------------------------------

interface View {
  zoom: number;
  panX: number;
  panY: number;
  dpr: number;
  left: number;
  top: number;
}

const canvasOf = (page: Page): Locator => page.getByTestId('editor-canvas');

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

async function click(page: Page, point: { x: number; y: number }): Promise<void> {
  const view = await viewOf(page);
  const p = toPage(view, point);
  await page.mouse.click(p.x, p.y);
}

type ToolName =
  | 'select'
  | 'crop'
  | 'rect'
  | 'ellipse'
  | 'line'
  | 'arrow'
  | 'pen'
  | 'text'
  | 'callout'
  | 'step'
  | 'stamp'
  | 'highlight'
  | 'blur'
  | 'redact'
  | 'spotlight'
  | 'magnifier'
  | 'ruler';

async function tool(page: Page, name: ToolName): Promise<void> {
  await page.getByTestId(`tool-${name}`).click();
  await expect(page.getByTestId(`tool-${name}`)).toHaveAttribute('aria-pressed', 'true');
}

const annotationCount = async (page: Page): Promise<number> =>
  Number(await canvasOf(page).getAttribute('data-annotations'));

async function openShot(page: Page): Promise<void> {
  await page.getByTestId('shot-screen').click();
  await expect(page.getByTestId('editor-view')).toBeVisible();
  await expect(page.getByTestId('editor-dimensions')).toHaveText(
    `${FRAME.width} × ${FRAME.height}`,
  );
}

async function go(page: Page, name: 'Capture' | 'History' | 'Settings'): Promise<void> {
  await page.getByRole('navigation', { name: 'Primary' }).getByRole('button', { name }).click();
}

async function leaveEditor(page: Page): Promise<void> {
  await page.getByTestId('editor-done').click();
  const confirm = page.getByTestId('confirm-yes');
  if (await confirm.isVisible().catch(() => false)) await confirm.click();
  await expect(page.getByTestId('editor-view')).toHaveCount(0);
}

async function stubSaveDialog(app: ElectronApplication, filePath: string): Promise<void> {
  await app.evaluate(({ dialog }, target) => {
    dialog.showSaveDialog = (() =>
      Promise.resolve({ canceled: false, filePath: target })) as typeof dialog.showSaveDialog;
  }, filePath);
}

interface Item {
  id: string;
  fileName: string;
  path: string;
  width: number;
  height: number;
  sizeBytes: number;
  derivedFrom: string | null;
  editable: boolean;
  format: string;
}

async function historyItems(page: Page): Promise<Item[]> {
  const result = await page.evaluate(() => window.framecapt.invoke('history:list', {}));
  if (!result.ok) throw new Error('history:list failed');
  return result.data.items as unknown as Item[];
}

async function decode(file: string) {
  const image = await loadImage(fs.readFileSync(file));
  const surface = createCanvas(image.width, image.height);
  const context = surface.getContext('2d');
  context.drawImage(image, 0, 0);
  return { width: image.width, height: image.height, context };
}

/** Opens History, then the item whose file name matches, then Edit in its details. */
async function editFromHistory(page: Page, fileName: string): Promise<void> {
  await go(page, 'History');
  const card = page.getByTestId('history-item').filter({ hasText: fileName.replace(/\.png$/, '') });
  await card.first().getByRole('button').first().click();
  await expect(page.getByTestId('history-details')).toBeVisible();
  await page.getByTestId('details-edit').click();
  await expect(page.getByTestId('editor-view')).toBeVisible();
}

// --- capture, annotate, save, edit again -------------------------------------------------------

let main: Session | undefined;
let outDir = '';
let firstFile = '';
let firstId = '';
const firstFileName = 'FrameCapt re-edit original.png';

test.afterAll(async () => {
  await close(main);
  if (outDir) fs.rmSync(outDir, { recursive: true, force: true });
});

test('annotate with the new tools, save, and the saved screenshot is editable from History', async () => {
  main = await launch();
  const { app, page } = main;
  outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'framecapt-e2e-pro-out-'));
  await openShot(page);

  // The panel is open and offers the arrange, canvas and (for the active tool) appearance sections.
  await expect(page.getByTestId('properties-panel')).toBeVisible();

  await tool(page, 'ellipse');
  await drag(page, { x: 300, y: 300 }, { x: 700, y: 600 });
  await tool(page, 'line');
  await drag(page, { x: 300, y: 800 }, { x: 900, y: 900 });
  await tool(page, 'highlight');
  await drag(page, { x: 1000, y: 300 }, { x: 1500, y: 380 });
  await tool(page, 'blur');
  await drag(page, { x: 1100, y: 500 }, { x: 1500, y: 700 });
  await tool(page, 'step');
  await click(page, { x: 1800, y: 300 });
  await click(page, { x: 1800, y: 500 });
  await expect(page.getByTestId('step-next')).toHaveText('3');
  await tool(page, 'callout');
  await drag(page, { x: 1700, y: 800 }, { x: 2200, y: 950 });
  await page.getByTestId('editor-text-input').fill('Look here');
  await page.keyboard.press('Enter');
  await tool(page, 'stamp');
  await click(page, { x: 2300, y: 300 });
  await tool(page, 'redact');
  await drag(page, { x: 400, y: 1100 }, { x: 900, y: 1250 });
  await expect.poll(() => annotationCount(page)).toBe(9);

  // One-time note: the editable original keeps the pixels under the redaction.
  const note = page.getByTestId('editor-redaction-notice');
  await expect(note).toContainText('Redactions are applied in the exported image');
  await expect(note).toContainText('the editable original keeps the pixels underneath');

  firstFile = path.join(outDir, firstFileName);
  await stubSaveDialog(app, firstFile);
  await page.getByTestId('editor-save').click();
  await expect.poll(() => fs.existsSync(firstFile), { timeout: 15_000 }).toBe(true);
  await expect(page.getByText(/Saved to/).first()).toBeVisible();

  const items = await historyItems(page);
  expect(items).toHaveLength(1);
  firstId = items[0]?.id ?? '';
  expect(items[0]).toMatchObject({ editable: true, derivedFrom: null, format: 'png' });

  // The editable project is app data (never next to the image) and keeps the unredacted original.
  const projectDir = path.join(main.dir, 'projects', firstId);
  expect(fs.existsSync(path.join(projectDir, 'original.png'))).toBe(true);
  expect(fs.existsSync(path.join(projectDir, 'project.json'))).toBe(true);
  const sizeBefore = fs.statSync(firstFile).size;
  const flattened = await decode(firstFile);
  expect(flattened.width).toBe(FRAME.width);
  const redacted = flattened.context.getImageData(600, 1150, 1, 1).data;
  expect([redacted[0], redacted[1], redacted[2]]).toEqual([0, 0, 0]);

  await leaveEditor(page);
  await editFromHistory(page, firstFileName);

  // Everything is editable again: all 9 marks are back, no "flattened copy" notice.
  await expect.poll(() => annotationCount(page)).toBe(9);
  await expect(page.getByTestId('editor-reedit-notice')).toHaveCount(0);
  await expect(page.getByTestId('editor-save')).toHaveText(/Save changes/);

  // Select the ellipse, restyle it through the panel, move it with the keyboard, then delete a step.
  await tool(page, 'select');
  await click(page, { x: 300, y: 450 }); // the ellipse's left edge area
  await expect(canvasOf(page)).toHaveAttribute('data-selected', 'ellipse');
  const before = JSON.parse((await canvasOf(page).getAttribute('data-selected-geometry')) ?? '{}');
  await page.getByTestId('panel-stroke-width').fill('14');
  await page.keyboard.press('Tab');
  await page.keyboard.press('Escape');
  await click(page, { x: 300, y: 450 });
  await page.keyboard.press('ArrowRight');
  await page.keyboard.press('Shift+ArrowDown');
  const after = JSON.parse((await canvasOf(page).getAttribute('data-selected-geometry')) ?? '{}');
  expect(after.rect.x).toBeCloseTo(before.rect.x + 1, 3);
  expect(after.rect.y).toBeCloseTo(before.rect.y + 10, 3);
  await click(page, { x: 1800, y: 300 }); // the first step badge
  await expect(canvasOf(page)).toHaveAttribute('data-selected', 'step');
  await page.keyboard.press('Delete');
  await expect.poll(() => annotationCount(page)).toBe(8);
  await expect(page.getByTestId('editor-undo')).toBeEnabled();

  // Save changes: a confirmation, then the file in History is replaced.
  await page.getByTestId('editor-save').click();
  await page.getByTestId('confirm-yes').click();
  await expect(page.getByText(/Changes saved/).first()).toBeVisible();
  await expect.poll(() => fs.statSync(firstFile).size).not.toBe(sizeBefore);
  const after1 = await historyItems(page);
  expect(after1).toHaveLength(1);
  expect(after1[0]).toMatchObject({ id: firstId, editable: true });

  // Save as copy: a NEW history item that remembers where it came from, with its own project.
  const copyFile = path.join(outDir, 'FrameCapt re-edit copy.png');
  await stubSaveDialog(app, copyFile);
  await page.getByTestId('editor-save-menu').click();
  await page.getByTestId('editor-copy-png').click();
  await expect.poll(() => fs.existsSync(copyFile), { timeout: 15_000 }).toBe(true);
  await expect.poll(async () => (await historyItems(page)).length).toBe(2);
  const both = await historyItems(page);
  const copy = both.find((item) => item.id !== firstId);
  expect(copy).toMatchObject({ derivedFrom: firstId, editable: true });
  expect(fs.existsSync(path.join(main.dir, 'projects', copy?.id ?? 'x', 'project.json'))).toBe(
    true,
  );
  // The original item still points at the file the overwrite wrote.
  expect(both.find((item) => item.id === firstId)?.path).toBe(firstFile);
  await leaveEditor(page);
});

test('delete editable data: the image stays, the project folder is gone, and Edit opens the flattened image', async () => {
  const session = main;
  if (!session) throw new Error('first test did not run');
  const { page } = session;
  await go(page, 'History');
  const card = page.getByTestId('history-item').filter({ hasText: 're-edit original' });
  await card.first().getByRole('button').first().click();
  await page.getByTestId('history-delete-project').click();
  await page.getByTestId('confirm-yes').click();
  await expect
    .poll(async () => (await historyItems(page)).find((i) => i.id === firstId)?.editable)
    .toBe(false);
  expect(fs.existsSync(path.join(session.dir, 'projects', firstId))).toBe(false);
  expect(fs.existsSync(firstFile)).toBe(true);

  await page.getByTestId('details-edit').click();
  await expect(page.getByTestId('editor-view')).toBeVisible();
  await expect(page.getByTestId('editor-reedit-notice')).toContainText(
    'Editing a flattened copy: earlier annotations cannot be changed.',
  );
  await expect.poll(() => annotationCount(page)).toBe(0);
  await leaveEditor(page);
});

test('a new tool can be rebound and the editor follows (and the old key stops working)', async () => {
  const session = main;
  if (!session) throw new Error('first test did not run');
  const { page } = session;
  const updated = await page.evaluate(() =>
    window.framecapt.invoke('settings:update', {
      patch: { editorShortcuts: { toolEllipse: 'J' } },
    }),
  );
  expect(updated.ok).toBe(true);
  await go(page, 'Capture');
  await openShot(page);
  await canvasOf(page).click({ position: { x: 5, y: 5 } });
  await page.keyboard.press('j');
  await expect(page.getByTestId('tool-ellipse')).toHaveAttribute('aria-pressed', 'true');
  await page.keyboard.press('v');
  await page.keyboard.press('o'); // the old default no longer selects the ellipse
  await expect(page.getByTestId('tool-select')).toHaveAttribute('aria-pressed', 'true');
  await page.getByTestId('tool-ellipse').hover();
  await expect(page.getByRole('tooltip').first()).toContainText('J');
  await leaveEditor(page);
});

test('the editor with the properties panel open has no serious accessibility violations', async () => {
  const session = main;
  if (!session) throw new Error('first test did not run');
  const { page } = session;
  await openShot(page);
  await tool(page, 'rect');
  await drag(page, { x: 300, y: 300 }, { x: 800, y: 600 });
  await tool(page, 'select');
  await expect(canvasOf(page)).toHaveAttribute('data-selected', 'rect');
  await expect(page.getByTestId('properties-panel')).toBeVisible();
  await page.waitForTimeout(400);
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
      .analyze();
    const bad = results.violations
      .filter((violation) => violation.impact === 'serious' || violation.impact === 'critical')
      .map(
        (violation) =>
          `${violation.id} (${violation.impact}): ${violation.nodes
            .slice(0, 3)
            .map((node) => node.target.join(' '))
            .join(' ;; ')}`,
      );
    expect(bad, `editor ${theme}`).toEqual([]);
  }
  await page.evaluate(() =>
    window.framecapt.invoke('settings:update', { patch: { general: { theme: 'system' } } }),
  );
  await leaveEditor(page);
});

test('select several marks, arrange them, frame the export and crop to a shape', async () => {
  const session = main;
  if (!session) throw new Error('first test did not run');
  const { page, app } = session;
  await go(page, 'Capture');
  await openShot(page);
  await tool(page, 'rect');
  await drag(page, { x: 300, y: 300 }, { x: 500, y: 400 });
  await drag(page, { x: 700, y: 520 }, { x: 900, y: 650 });
  await drag(page, { x: 1100, y: 340 }, { x: 1300, y: 420 });
  await expect.poll(() => annotationCount(page)).toBe(3);

  const geometry = async (): Promise<{ rect: { x: number; y: number } }> =>
    JSON.parse((await canvasOf(page).getAttribute('data-selected-geometry')) ?? '{}');
  const topOf = async (point: { x: number; y: number }): Promise<number> => {
    await click(page, point);
    return (await geometry()).rect.y;
  };

  // A box around all three selects them together.
  await tool(page, 'select');
  await drag(page, { x: 100, y: 100 }, { x: 1500, y: 800 });
  await expect(canvasOf(page)).toHaveAttribute('data-selected', 'multiple');
  await expect(canvasOf(page)).toHaveAttribute('data-selected-count', '3');
  await expect(page.getByTestId('panel-selection-count')).toHaveText('3 marks selected');

  // Align top: the three rectangles share one top edge.
  await page.getByTestId('align-top').click();
  const tops = [
    await topOf({ x: 300, y: 350 }),
    await topOf({ x: 700, y: 350 }),
    await topOf({ x: 1100, y: 350 }),
  ];
  expect(new Set(tops.map((t) => Math.round(t))).size).toBe(1);

  // Group nudge: Shift+Down moves every selected mark 10 px, as one undo step.
  await drag(page, { x: 100, y: 100 }, { x: 1500, y: 800 });
  await expect(canvasOf(page)).toHaveAttribute('data-selected-count', '3');
  await page.keyboard.press('Shift+ArrowDown');
  expect(await topOf({ x: 300, y: 360 })).toBeCloseTo((tops[0] ?? 0) + 10, 3);

  // Duplicate (Ctrl+D) adds copies of the selection.
  await drag(page, { x: 100, y: 100 }, { x: 1500, y: 800 });
  await page.keyboard.press('Control+d');
  await expect.poll(() => annotationCount(page)).toBe(6);
  await expect(canvasOf(page)).toHaveAttribute('data-selected-count', '3');
  await page.getByTestId('arrange-delete').click();
  await expect.poll(() => annotationCount(page)).toBe(3);

  // Beautify: the export grows by the padding on every side; the preview shows it.
  await page.getByTestId('panel-beautify').click();
  await expect(canvasOf(page)).toHaveAttribute(
    'data-export-size',
    `${FRAME.width + 96}x${FRAME.height + 96}`,
  );
  await page.getByTestId('panel-beautify-padding').fill('20');
  await expect(canvasOf(page)).toHaveAttribute(
    'data-export-size',
    `${FRAME.width + 40}x${FRAME.height + 40}`,
  );
  await page.getByTestId('panel-preview').click();
  await expect(canvasOf(page)).toHaveAttribute('data-preview', 'true');
  await page.getByTestId('panel-preview').click();
  await expect(canvasOf(page)).toHaveAttribute('data-preview', 'false');
  const framed = path.join(outDir, 'framed.png');
  await stubSaveDialog(app, framed);
  await page.getByTestId('editor-save').click();
  await expect.poll(() => fs.existsSync(framed), { timeout: 15_000 }).toBe(true);
  const framedImage = await decode(framed);
  expect([framedImage.width, framedImage.height]).toEqual([FRAME.width + 40, FRAME.height + 40]);

  // Crop to a 1:1 shape from the panel: the draft has that shape, applying it keeps the crop non-destructive.
  await page.getByTestId('panel-beautify').click(); // frame off
  await page.getByTestId('panel-crop-aspect').getByRole('radio', { name: '1:1' }).click();
  await expect(page.getByTestId('tool-crop')).toHaveAttribute('aria-pressed', 'true');
  const draft = JSON.parse((await canvasOf(page).getAttribute('data-crop-draft')) ?? '{}');
  expect(Math.abs(draft.width - draft.height)).toBeLessThanOrEqual(1);
  await page.getByTestId('crop-apply').click();
  await expect(page.getByTestId('editor-dimensions')).toHaveText(
    `${draft.width} × ${draft.height}`,
  );
  await leaveEditor(page);
});

// --- an old item: only a flattened image, no project ---------------------------------------------

test.describe('an item saved before editable projects existed', () => {
  let session: Session | undefined;
  let file = '';
  const id = newId();

  test.afterAll(async () => close(session));

  test('Edit opens the saved image as the base, says so, and Save changes works', async () => {
    session = await launch((dir) => {
      const files = path.join(dir, 'files');
      fs.mkdirSync(files, { recursive: true });
      file = path.join(files, 'FrameCapt old item.png');
      fs.writeFileSync(file, mockScreenshotPng(1280, 720, 2));
      seedHistory(dir, [
        {
          id,
          type: 'screenshot',
          path: file,
          createdAt: Date.now() - 60_000,
          width: 1280,
          height: 720,
          durationMs: null,
          sizeBytes: fs.statSync(file).size,
          format: 'png',
          hasAudio: null,
          source: 'region',
        },
      ]);
    });
    const { page } = session;
    expect((await historyItems(page))[0]).toMatchObject({ editable: false });
    await editFromHistory(page, 'FrameCapt old item.png');
    await expect(page.getByTestId('editor-reedit-notice')).toHaveText(
      'Editing a flattened copy: earlier annotations cannot be changed.',
    );
    await expect(page.getByTestId('editor-dimensions')).toHaveText('1280 × 720');
    await expect.poll(() => annotationCount(page)).toBe(0);

    const sizeBefore = fs.statSync(file).size;
    await tool(page, 'rect');
    await drag(page, { x: 100, y: 100 }, { x: 600, y: 400 });
    await expect.poll(() => annotationCount(page)).toBe(1);
    // Nothing touches the saved file until the user saves.
    expect(fs.statSync(file).size).toBe(sizeBefore);
    await page.getByTestId('editor-save').click();
    await page.getByTestId('confirm-yes').click();
    await expect(page.getByText(/Changes saved/).first()).toBeVisible();
    await expect.poll(() => fs.statSync(file).size).not.toBe(sizeBefore);
    // The item is editable from now on (its project's base is the saved image).
    await expect.poll(async () => (await historyItems(page))[0]?.editable).toBe(true);
    await leaveEditor(page);
  });

  test('"Keep editable originals" off: a new export stores no project', async () => {
    const live = session;
    if (!live) throw new Error('previous test did not run');
    const { page, app, dir } = live;
    const off = await page.evaluate(() =>
      window.framecapt.invoke('settings:update', {
        patch: { screenshots: { keepEditableOriginals: false } },
      }),
    );
    expect(off.ok).toBe(true);
    await go(page, 'Capture');
    await openShot(page);
    await tool(page, 'rect');
    await drag(page, { x: 100, y: 100 }, { x: 600, y: 400 });
    const target = path.join(dir, 'files', 'no project.png');
    await stubSaveDialog(app, target);
    await page.getByTestId('editor-save').click();
    await expect.poll(() => fs.existsSync(target), { timeout: 15_000 }).toBe(true);
    await expect.poll(async () => (await historyItems(page)).length).toBe(2);
    const created = (await historyItems(page)).find((item) => item.fileName === 'no project.png');
    expect(created?.editable).toBe(false);
    expect(fs.existsSync(path.join(dir, 'projects', created?.id ?? 'x'))).toBe(false);
    await leaveEditor(page);
  });

  test('the Settings switch for editable originals changes the setting and says what is kept', async () => {
    const live = session;
    if (!live) throw new Error('previous test did not run');
    const { page } = live;
    await go(page, 'Settings');
    await page.getByTestId('settings-nav-screenshots').click();
    const toggle = page.getByTestId('setting-keep-editable');
    await expect(toggle).toHaveAttribute('aria-checked', 'false'); // turned off by the previous test
    await expect(page.getByTestId('settings-screenshots')).toContainText('unredacted original');
    await toggle.click();
    await expect(toggle).toHaveAttribute('aria-checked', 'true');
    await expect
      .poll(async () => {
        const state = await page.evaluate(() => window.framecapt.invoke('settings:get'));
        return state.ok && state.data.settings.screenshots.keepEditableOriginals;
      })
      .toBe(true);
  });
});

// --- editing from History: ids are validated, never paths ------------------------------------------

test.describe('opening from History by id', () => {
  let session: Session | undefined;

  test.afterEach(async () => {
    await close(session);
    session = undefined;
  });

  test('an unknown id is NOT_FOUND and a path-like id is refused', async () => {
    session = await launch(() => undefined);
    const { page } = session;
    const call = (historyId: string) =>
      page.evaluate(
        (id) => window.framecapt.invoke('shot:openFromHistory', { historyId: id }),
        historyId,
      );
    const unknown = await call(newId());
    expect(unknown.ok).toBe(false);
    if (!unknown.ok) expect(unknown.error.code).toBe('NOT_FOUND');
    const traversal = await call('../../history');
    expect(traversal.ok).toBe(false);
    if (!traversal.ok) expect(traversal.error.code).toBe('INVALID_PAYLOAD');
  });
});
