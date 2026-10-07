/**
 * The capture library end to end (E2E build, mock capture; the default capture folders are inside
 * the user-data dir): real folders are made, captures are moved by drag and by "Move to…", a folder
 * is renamed (History follows), a non-empty folder is refused, and a save location sends a new
 * screenshot into its folder.
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
import { mockScreenshotPng, newId, seedHistory, type SeedFile } from './history-fixtures';

const projectRoot = path.resolve(__dirname, '..', '..');

let app: ElectronApplication;
let page: Page;
let dir: string;
let shots: string;
let videos: string;
const ids: string[] = [];
const NAMES = ['a.png', 'b.png', 'c.png', 'd.png'];

test.describe.configure({ mode: 'serial' });

test.beforeAll(async () => {
  expect(
    fs.existsSync(path.join(projectRoot, '.vite', 'build', 'main.cjs')),
    'Run `npm run package:e2e` first (npm run test:e2e does this).',
  ).toBe(true);
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'framecapt-e2e-library-'));
  shots = path.join(dir, 'pictures', 'FrameCapt');
  videos = path.join(dir, 'videos', 'FrameCapt');
  fs.mkdirSync(shots, { recursive: true });
  const now = Date.now();
  const items: SeedFile[] = NAMES.map((name, index) => {
    const file = path.join(shots, name);
    fs.writeFileSync(file, mockScreenshotPng(640, 360, index));
    const id = newId();
    ids.push(id);
    return {
      id,
      type: 'screenshot',
      path: file,
      createdAt: now - index * 60_000,
      width: 640,
      height: 360,
      durationMs: null,
      sizeBytes: fs.statSync(file).size,
      format: 'png',
      hasAudio: null,
      source: 'region',
    };
  });
  seedHistory(dir, items);
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
  await nav('Library');
  await expect(page.getByTestId('history-item')).toHaveCount(4);
});

test.afterAll(async () => {
  if (app) await exitApp(app);
  if (dir) fs.rmSync(dir, { recursive: true, force: true });
});

const nav = (name: 'Home' | 'Library' | 'Settings') =>
  page.getByRole('navigation', { name: 'Primary' }).getByRole('button', { name }).click();
const row = (folder: string) => page.locator(`[data-testid="folder-row"][data-path="${folder}"]`);
const card = (index: number) => page.locator(`[data-card-main][data-id="${ids[index]}"]`);
const exists = (...parts: string[]): boolean => fs.existsSync(path.join(...parts));

async function newFolder(name: string, parent?: string): Promise<void> {
  if (parent) {
    await row(parent).click({ button: 'right' });
    await page.getByTestId('folder-menu-new').click();
  } else {
    await page.getByTestId('folder-new').click();
  }
  await page.getByTestId('folder-name-input').fill(name);
  await page.getByTestId('folder-name-input').press('Enter');
}

const allRow = () => page.locator('[data-testid="folder-row"][data-path=":all"]');

test('creates a folder and a subfolder as real folders in both capture folders', async () => {
  await newFolder('Clients');
  await expect(row('Clients')).toBeVisible();
  expect(exists(shots, 'Clients')).toBe(true);
  expect(exists(videos, 'Clients')).toBe(true);

  await newFolder('Acme', 'Clients');
  await expect(row('Clients/Acme')).toBeVisible();
  await expect(row('Clients/Acme')).toHaveAttribute('aria-level', '2');
  expect(exists(shots, 'Clients', 'Acme')).toBe(true);
  expect(exists(videos, 'Clients', 'Acme')).toBe(true);

  // The new folder is selected and empty.
  await expect(page.getByText('This folder is empty')).toBeVisible();
  await allRow().click();
  await expect(page.getByTestId('history-item')).toHaveCount(4);
});

test('a name that is not allowed is refused in the field', async () => {
  await page.getByTestId('folder-new').click();
  await page.getByTestId('folder-name-input').fill('CON');
  await expect(page.getByTestId('folder-name-problem')).toBeVisible();
  await page.getByTestId('folder-name-input').press('Enter');
  await expect(row('CON')).toHaveCount(0);
  await page.getByTestId('folder-name-input').press('Escape');
  await expect(page.getByTestId('folder-name-input')).toHaveCount(0);
});

test('dragging a card onto a folder moves its file; a selection moves together', async () => {
  await card(0).dragTo(row('Clients'));
  await expect.poll(() => exists(shots, 'Clients', 'a.png')).toBe(true);
  expect(exists(shots, 'a.png')).toBe(false);

  await card(1).click({ modifiers: ['Control'] });
  await card(2).click({ modifiers: ['Control'] });
  await expect(page.getByTestId('selection-count')).toHaveText('2 items selected');
  await card(1).dragTo(row('Clients/Acme'));
  // The files move one after the other: wait for both.
  await expect
    .poll(
      () => exists(shots, 'Clients', 'Acme', 'b.png') && exists(shots, 'Clients', 'Acme', 'c.png'),
    )
    .toBe(true);
  expect(exists(shots, 'b.png') || exists(shots, 'c.png')).toBe(false);
  await expect(row('Clients/Acme').getByTestId('folder-count')).toHaveText('2');
});

test('Move to… in the card menu opens a folder picker and moves the file', async () => {
  await card(3).click({ button: 'right' });
  await page.getByTestId('ctx-move').click();
  await expect(page.getByTestId('folder-picker')).toBeVisible();
  await page.locator('[data-testid="folder-option"][data-path="Clients"]').click();
  await page.getByTestId('folder-picker-confirm').click();
  await expect.poll(() => exists(shots, 'Clients', 'd.png')).toBe(true);
  expect(exists(shots, 'd.png')).toBe(false);

  // A folder shows its own captures; "include subfolders" adds what is below it.
  await row('Clients').click();
  await expect(page.getByTestId('history-item')).toHaveCount(4);
  await page.getByTestId('library-more').click();
  await page.getByTestId('folder-include-sub').click(); // off
  await expect(page.getByTestId('history-item')).toHaveCount(2);
  await page.getByTestId('library-more').click();
  await page.getByTestId('folder-include-sub').click(); // on again
});

test('renaming a folder renames it on disk and History keeps pointing at the files', async () => {
  await row('Clients').focus();
  await page.keyboard.press('F2');
  await page.getByTestId('folder-name-input').fill('Customers');
  await page.getByTestId('folder-name-input').press('Enter');
  await expect(row('Customers')).toBeVisible();
  await expect(row('Customers/Acme')).toBeVisible();
  expect(exists(shots, 'Clients')).toBe(false);
  expect(exists(shots, 'Customers', 'Acme', 'b.png')).toBe(true);
  expect(exists(videos, 'Customers', 'Acme')).toBe(true);

  const listed = await page.evaluate(() => window.framecapt.invoke('history:list', {}));
  if (!listed.ok) throw new Error('history:list failed');
  expect(listed.data.items.every((item) => item.exists)).toBe(true);
  expect(listed.data.items.map((item) => item.folder).sort()).toEqual([
    'Customers',
    'Customers',
    'Customers/Acme',
    'Customers/Acme',
  ]);
  await expect(page.getByTestId('history-item')).toHaveCount(4);
});

test('a folder that is not empty is not deleted, with a clear message', async () => {
  await row('Customers/Acme').click({ button: 'right' });
  await page.getByTestId('folder-menu-delete').click();
  await page.getByTestId('confirm-yes').click();
  await expect(page.getByText(/not empty/).first()).toBeVisible();
  expect(exists(shots, 'Customers', 'Acme', 'b.png')).toBe(true);
  await expect(row('Customers/Acme')).toBeVisible();
});

test('an empty folder can be deleted; its parent keeps working', async () => {
  await allRow().click();
  await newFolder('Temp');
  await expect(row('Temp')).toBeVisible();
  await row('Temp').click({ button: 'right' });
  await page.getByTestId('folder-menu-delete').click();
  await page.getByTestId('confirm-yes').click();
  await expect(row('Temp')).toHaveCount(0);
  expect(exists(shots, 'Temp')).toBe(false);
  expect(exists(videos, 'Temp')).toBe(false);
});

test('the folder tree is an accessible tree with arrow-key navigation', async () => {
  await allRow().click();
  const tree = page.getByRole('tree', { name: 'Capture folders' });
  await expect(tree).toBeVisible();
  await expect(row('Customers')).toHaveAttribute('aria-expanded', 'true');
  // The smart items (All captures, Recent, Screenshots, Recordings, Guides) come first, then the folders.
  await allRow().focus();
  for (const key of ['recent', 'type:screenshot', 'type:recording', 'type:flow']) {
    await page.keyboard.press('ArrowDown');
    await expect(page.locator(`[data-testid="folder-row"][data-path=":${key}"]`)).toBeFocused();
  }
  await page.keyboard.press('ArrowDown');
  await expect(row('Customers')).toBeFocused();
  await page.keyboard.press('ArrowLeft');
  await expect(row('Customers')).toHaveAttribute('aria-expanded', 'false');
  await page.keyboard.press('ArrowRight');
  await page.keyboard.press('ArrowRight');
  await expect(row('Customers/Acme')).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(row('Customers/Acme')).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByTestId('history-item')).toHaveCount(2);
  await allRow().click();
});

test('the folder pane, its menu and the move dialog have no serious accessibility violations (both themes)', async () => {
  const scan = async (name: string) => {
    const results = await new AxeBuilder({ page })
      .setLegacyMode()
      .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
      .analyze();
    const bad = results.violations
      .filter((violation) => violation.impact === 'serious' || violation.impact === 'critical')
      .map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(' ;; ')}`);
    expect(bad, name).toEqual([]);
  };
  for (const scheme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme: scheme });
    await row('Customers/Acme').click();
    await page.waitForTimeout(400);
    await scan(scheme);
    await row('Customers').click({ button: 'right' });
    await expect(page.getByTestId('folder-menu')).toBeVisible();
    await scan(scheme);
    await page.keyboard.press('Escape');
    await card(1).click({ button: 'right' });
    await page.getByTestId('ctx-move').click();
    await expect(page.getByTestId('folder-picker')).toBeVisible();
    await scan(scheme);
    await page.getByTestId('folder-picker-cancel').click();
  }
  await page.emulateMedia({ colorScheme: null });
  await allRow().click();
});

test('a save location sends the next screenshot into that folder', async () => {
  await row('Customers/Acme').click({ button: 'right' });
  await page.getByTestId('folder-menu-set-save').click();
  await expect(row('Customers/Acme').getByTestId('folder-save-badge')).toBeVisible();

  await nav('Home');
  await expect(page.getByTestId('saving-to-folder')).toHaveText('Customers / Acme');
  const target = path.join(shots, 'Customers', 'Acme');
  const saved = (): string[] =>
    fs
      .readdirSync(target)
      .filter((name) => name.startsWith('FrameCapt ') && !name.endsWith('.tmp'));
  expect(saved()).toEqual([]);

  await page.getByTestId('shot-screen').click();
  const editor = await editorPage(app);
  await expect(editor.getByTestId('editor-view')).toBeVisible();
  await editor.getByTestId('editor-canvas').click({ position: { x: 40, y: 40 } });
  await editor.keyboard.press('Control+Shift+S');
  await expect.poll(() => saved().length).toBe(1);
  expect(fs.readdirSync(shots).filter((name) => name.startsWith('FrameCapt '))).toEqual([]);
  await editor.getByTestId('editor-done').click();
  await expectEditorClosed(app);

  // Clearing the save location puts new captures back in the main folder.
  await nav('Library');
  await row('Customers/Acme').click({ button: 'right' });
  await page.getByTestId('folder-menu-clear-save').click();
  await expect(row('Customers/Acme').getByTestId('folder-save-badge')).toHaveCount(0);
  await nav('Home');
  await expect(page.getByTestId('saving-to-folder')).toHaveText('Main capture folders');
});
