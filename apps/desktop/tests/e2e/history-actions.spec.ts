/**
 * History multi-select, bulk actions, the context menu and drag-out, against the E2E build (mock
 * capture). Dialogs, the shell and the OS drag are stubbed in main:
 * nothing opens a native dialog, Explorer or starts a real drag.
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
import { makeWebm, mockScreenshotPng, newId, seedHistory, type SeedFile } from './history-fixtures';

const projectRoot = path.resolve(__dirname, '..', '..');

interface Seeded {
  ids: string[];
  files: string[];
}

function seed(dir: string): Seeded {
  const files = path.join(dir, 'files');
  fs.mkdirSync(files, { recursive: true });
  const now = Date.now();
  const items: SeedFile[] = [];
  // Two files share the name "shot.png" in different folders (the copies must not collide).
  const names = ['shot.png', path.join('sub', 'shot.png'), 'other-2.png', 'other-3.png'];
  names.forEach((name, i) => {
    const target = path.join(files, name);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, mockScreenshotPng(640, 360, i));
    items.push({
      id: newId(),
      type: 'screenshot',
      path: target,
      createdAt: now - i * 60_000,
      width: 640,
      height: 360,
      durationMs: null,
      sizeBytes: fs.statSync(target).size,
      format: 'png',
      hasAudio: null,
      source: 'region',
    });
  });
  const clip = path.join(files, 'clip.webm');
  makeWebm(clip, 2, { audio: false });
  items.push({
    id: newId(),
    type: 'recording',
    path: clip,
    createdAt: now - 5 * 60_000,
    width: 640,
    height: 360,
    durationMs: 2000,
    sizeBytes: fs.statSync(clip).size,
    format: 'webm',
    hasAudio: false,
    source: 'screen',
  });
  seedHistory(dir, items);
  return { ids: items.map((item) => item.id), files: items.map((item) => item.path) };
}

async function launch(
  dir: string,
  env: Record<string, string> = {},
): Promise<{ app: ElectronApplication; page: Page }> {
  expect(
    fs.existsSync(path.join(projectRoot, '.vite', 'build', 'main.cjs')),
    'Run `npm run package:e2e` first (npm run test:e2e does this).',
  ).toBe(true);
  const app = await electron.launch({
    args: ['.'],
    cwd: projectRoot,
    env: {
      ...process.env,
      FRAMECAPT_USER_DATA_DIR: dir,
      FRAMECAPT_E2E_MOCK_CAPTURE: '1',
      FRAMECAPT_E2E_MOCK_DISPLAYS: '1',
      FRAMECAPT_E2E_FAKE_SHORTCUTS: '1',
      ...env,
    },
  });
  const page = await app.firstWindow();
  await page.waitForLoadState('domcontentloaded');
  await expect(page.getByTestId('shot-region')).toBeVisible();
  return { app, page };
}

async function openHistory(page: Page, count: number): Promise<void> {
  await page
    .getByRole('navigation', { name: 'Primary' })
    .getByRole('button', { name: 'Library' })
    .click();
  await expect(page.getByTestId('history-item')).toHaveCount(count);
}

const cardsOf = (page: Page) => page.getByTestId('history-item');
const mainOf = (page: Page, index: number) => cardsOf(page).nth(index).locator('[data-card-main]');

test.describe.configure({ mode: 'serial' });

let dir: string;
let seeded: Seeded;
let app: ElectronApplication;
let page: Page;

test.beforeAll(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'framecapt-e2e-hist-actions-'));
  seeded = seed(dir);
  ({ app, page } = await launch(dir));
  await openHistory(page, 5);
});

test.afterAll(async () => {
  if (app) await exitApp(app);
  if (dir) fs.rmSync(dir, { recursive: true, force: true });
});

test('ctrl-click, shift-click, checkbox, Ctrl+A and Escape select; a plain click still opens', async () => {
  const bar = page.getByTestId('selection-bar');
  await expect(bar).toHaveCount(0);

  await mainOf(page, 0).click({ modifiers: ['Control'] });
  await expect(bar).toBeVisible();
  await expect(page.getByTestId('selection-count')).toHaveText('1 item selected');
  await expect(cardsOf(page).nth(0)).toHaveAttribute('data-selected', 'true');
  // Ctrl-click did not open the details view.
  await expect(page.getByTestId('history-details')).toHaveCount(0);

  await mainOf(page, 2).click({ modifiers: ['Shift'] });
  await expect(page.getByTestId('selection-count')).toHaveText('3 items selected');
  await cardsOf(page).nth(1).getByTestId('history-select').uncheck();
  await expect(page.getByTestId('selection-count')).toHaveText('2 items selected');

  await mainOf(page, 3).focus();
  await page.keyboard.press('Control+a');
  await expect(page.getByTestId('selection-count')).toHaveText('5 items selected');
  await expect(page.getByTestId('bulk-select-all')).toHaveCount(0);

  await page.keyboard.press('Escape');
  await expect(bar).toHaveCount(0);

  // Plain click: unchanged behaviour (opens the details view).
  await mainOf(page, 0).click();
  await expect(page.getByTestId('history-details')).toBeVisible();
  await page.getByTestId('history-back').click();
  await expect(page.getByTestId('history-grid')).toBeVisible();
});

test('bulk save copies into a chosen folder: collision-safe, never overwrites, with a summary', async () => {
  const target = fs.mkdtempSync(path.join(os.tmpdir(), 'framecapt-e2e-copies-'));
  fs.writeFileSync(path.join(target, 'shot.png'), 'precious');
  await app.evaluate(({ dialog }, folder) => {
    dialog.showOpenDialog = (() =>
      Promise.resolve({ canceled: false, filePaths: [folder] })) as typeof dialog.showOpenDialog;
  }, target);

  await mainOf(page, 0).click({ modifiers: ['Control'] });
  await mainOf(page, 1).click({ modifiers: ['Control'] });
  await mainOf(page, 2).click({ modifiers: ['Control'] });
  await expect(page.getByTestId('selection-count')).toHaveText('3 items selected');
  await page.getByTestId('bulk-save').click();

  await expect(page.getByText(/Saved 3 copies to/).first()).toBeVisible({ timeout: 15_000 });
  const names = fs.readdirSync(target).sort();
  expect(names).toHaveLength(4);
  expect(fs.readFileSync(path.join(target, 'shot.png'), 'utf8')).toBe('precious');
  // seeded files 0 ("shot.png"), 1 ("sub/shot.png") and 2 ("other-2.png") were copied.
  expect(names).toEqual(['other-2.png', 'shot (2).png', 'shot (3).png', 'shot.png']);
  // Originals are untouched.
  for (const file of seeded.files.slice(0, 3)) expect(fs.existsSync(file)).toBe(true);
  await page.keyboard.press('Escape');
  fs.rmSync(target, { recursive: true, force: true });
});

test('cancelling the folder dialog copies nothing', async () => {
  await app.evaluate(({ dialog }) => {
    dialog.showOpenDialog = (() =>
      Promise.resolve({ canceled: true, filePaths: [] })) as typeof dialog.showOpenDialog;
  });
  await mainOf(page, 0).click({ modifiers: ['Control'] });
  await page.getByTestId('bulk-save').click();
  await expect(page.getByTestId('bulk-progress')).toHaveCount(0);
  await page.getByTestId('bulk-clear').click();
  await expect(page.getByTestId('selection-bar')).toHaveCount(0);
});

test('bulk remove asks first, removes the entries only, and Undo brings them back', async () => {
  await mainOf(page, 0).click({ modifiers: ['Control'] });
  await mainOf(page, 1).click({ modifiers: ['Control'] });
  await page.getByTestId('bulk-remove').click();
  await expect(page.getByTestId('confirm-dialog')).toContainText('Remove 2 items from history?');
  // "Keep them" does nothing.
  await page.getByTestId('confirm-no').click();
  await expect(cardsOf(page)).toHaveCount(5);

  await page.getByTestId('bulk-remove').click();
  await page.getByTestId('confirm-yes').click();
  await expect(cardsOf(page)).toHaveCount(3);
  await expect(page.getByTestId('selection-bar')).toHaveCount(0);
  // Files stay on disk.
  for (const file of seeded.files) expect(fs.existsSync(file)).toBe(true);

  await page.getByRole('button', { name: 'Undo' }).first().click();
  await expect(cardsOf(page)).toHaveCount(5);
});

test('right-click opens a menu with the card actions; Shift+F10 opens it from the keyboard', async () => {
  await app.evaluate(({ shell, clipboard }) => {
    (globalThis as unknown as { __opened: string[] }).__opened = [];
    shell.openPath = (async (file: string) => {
      (globalThis as unknown as { __opened: string[] }).__opened.push(file);
      return '';
    }) as typeof shell.openPath;
    void clipboard;
  });
  const menu = page.getByTestId('history-context-menu');
  await mainOf(page, 0).click({ button: 'right' });
  await expect(menu).toBeVisible();
  for (const id of [
    'ctx-edit',
    'ctx-open',
    'ctx-reveal',
    'ctx-copy',
    'ctx-save-copy',
    'ctx-select',
    'ctx-remove',
    'ctx-delete',
  ]) {
    await expect(page.getByTestId(id), id).toBeVisible();
  }
  await expect(page.getByTestId('ctx-delete-project')).toHaveCount(0); // no editable data
  await page.getByTestId('ctx-open').click();
  await expect
    .poll(() => app.evaluate(() => (globalThis as unknown as { __opened: string[] }).__opened))
    .toEqual([seeded.files[0]]);

  // The recording has no image copy and offers MP4.
  await mainOf(page, 4).click({ button: 'right' });
  await expect(page.getByTestId('ctx-mp4')).toBeVisible();
  // A recording is edited in the video editor.
  await expect(page.getByTestId('ctx-edit')).toHaveText('Edit video');
  await page.keyboard.press('Escape');
  await expect(menu).toHaveCount(0);

  // Keyboard: focus returns to the card, Shift+F10 opens the menu again.
  await expect(mainOf(page, 4)).toBeFocused();
  await mainOf(page, 1).focus();
  await page.keyboard.press('Shift+F10');
  await expect(menu).toBeVisible();
  await page.getByTestId('ctx-select').click();
  await expect(page.getByTestId('selection-count')).toHaveText('1 item selected');
  await mainOf(page, 0).click({ modifiers: ['Control'] });
  // On a card inside a selection of two, the menu acts on all selected cards.
  await mainOf(page, 0).click({ button: 'right' });
  await expect(page.getByTestId('ctx-bulk-save')).toContainText('Save 2 copies');
  await expect(page.getByTestId('ctx-bulk-remove')).toContainText('Remove 2 from history');
  await page.getByTestId('ctx-clear-selection').click();
  await expect(page.getByTestId('selection-bar')).toHaveCount(0);
});

test('a context-menu remove goes through the same undo window', async () => {
  await mainOf(page, 3).click({ button: 'right' });
  await page.getByTestId('ctx-remove').click();
  await expect(cardsOf(page)).toHaveCount(4);
  await page.getByRole('button', { name: 'Undo' }).first().click();
  await expect(cardsOf(page)).toHaveCount(5);
});

test('history has no serious accessibility violations with the selection bar and the menu open', async () => {
  await mainOf(page, 0).click({ modifiers: ['Control'] });
  await mainOf(page, 1).click({ modifiers: ['Control'] });
  await expect(page.getByTestId('selection-bar')).toBeVisible();
  await page.waitForTimeout(500);
  const scan = async (name: string) => {
    const results = await new AxeBuilder({ page })
      .setLegacyMode()
      .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
      .analyze();
    const bad = results.violations
      .filter((violation) => violation.impact === 'serious' || violation.impact === 'critical')
      .map(
        (violation) =>
          `${violation.id}: ${violation.nodes.map((n) => n.target.join(' ')).join(' ;; ')}`,
      );
    expect(bad, name).toEqual([]);
  };
  await scan('selection bar');
  await mainOf(page, 2).click({ button: 'right' });
  await expect(page.getByTestId('history-context-menu')).toBeVisible();
  await scan('selection bar and context menu');
  await page.keyboard.press('Escape');
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('selection-bar')).toHaveCount(0);
});

test('drag-out: main resolves the file from the history item and refuses anything else', async () => {
  await app.evaluate(({ webContents }) => {
    const calls: unknown[] = [];
    (globalThis as unknown as { __drags: unknown[] }).__drags = calls;
    for (const contents of webContents.getAllWebContents()) {
      contents.startDrag = ((item: unknown) => {
        calls.push(item);
      }) as typeof contents.startDrag;
    }
  });
  const drags = (): Promise<{ file: string }[]> =>
    app.evaluate(() => (globalThis as unknown as { __drags: { file: string }[] }).__drags);
  const invoke = (id: string) =>
    page.evaluate((value) => window.framecapt.invoke('history:startDrag', { id: value }), id);

  const ok = await invoke(seeded.ids[0] as string);
  expect(ok.ok).toBe(true);
  expect((await drags()).map((d) => d.file)).toEqual([seeded.files[0]]);

  const foreign = await invoke('00000000-0000-4000-8000-000000000000');
  expect(foreign.ok).toBe(false);
  // A path is not an id: the contract refuses it before the handler.
  const path_ = await page.evaluate(() =>
    window.framecapt.invoke('history:startDrag', { id: 'C:\\Windows\\win.ini' } as never),
  );
  expect(path_.ok).toBe(false);
  expect(await drags()).toHaveLength(1);

  // A card that was dragged with the mouse asks main the same way.
  fs.rmSync(seeded.files[3] as string);
  const gone = await invoke(seeded.ids[3] as string);
  expect(gone.ok).toBe(false);
  expect(await drags()).toHaveLength(1);
});
