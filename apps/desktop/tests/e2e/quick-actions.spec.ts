/**
 * Quick save from the editor (no dialog), the Settings search, and tucking the recording toolbar
 * away, against the E2E build (mock capture; the E2E default folders are inside the user-data dir).
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  _electron as electron,
  expect,
  test,
  type ElectronApplication,
  type Page,
} from '@playwright/test';
import { exitApp } from './app-exit';
import { editorPage, expectEditorClosed } from './editor-window';

const projectRoot = path.resolve(__dirname, '..', '..');

interface Hooks {
  runAction(action: string): void;
}

let app: ElectronApplication;
let page: Page;
let dir: string;

test.describe.configure({ mode: 'serial' });

test.beforeAll(async () => {
  expect(
    fs.existsSync(path.join(projectRoot, '.vite', 'build', 'main.cjs')),
    'Run `npm run package:e2e` first (npm run test:e2e does this).',
  ).toBe(true);
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'framecapt-e2e-quick-'));
  app = await electron.launch({
    args: ['.', '--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'],
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
  await expect(page.getByTestId('shot-screen')).toBeVisible();
});

test.afterAll(async () => {
  if (app) await exitApp(app);
  if (dir) fs.rmSync(dir, { recursive: true, force: true });
});

const nav = (name: 'Home' | 'Library' | 'Settings') =>
  page.getByRole('navigation', { name: 'Primary' }).getByRole('button', { name }).click();

const shotsDir = async (): Promise<string> => {
  const state = await page.evaluate(() => window.framecapt.invoke('settings:get'));
  if (!state.ok) throw new Error('settings:get failed');
  return state.data.effective.screenshotsDir;
};

test('Ctrl+Shift+S saves into the screenshots folder with no dialog, lists it in history, and Undo moves it to the Recycle Bin', async () => {
  await app.evaluate(({ dialog, shell }) => {
    const g = globalThis as unknown as { __dialogs: number; __trashed: string[] };
    g.__dialogs = 0;
    g.__trashed = [];
    dialog.showSaveDialog = (() => {
      g.__dialogs += 1;
      return Promise.resolve({ canceled: true });
    }) as unknown as typeof dialog.showSaveDialog;
    shell.trashItem = (async (file: string) => {
      g.__trashed.push(file);
      process.getBuiltinModule('node:fs').rmSync(file);
    }) as typeof shell.trashItem;
  });
  const folder = await shotsDir();
  // A save is written to a `.tmp` file and renamed: only finished files count (the temp file is
  // there for a moment and would be mistaken for the capture).
  const saved = (): string[] =>
    fs.existsSync(folder) ? fs.readdirSync(folder).filter((name) => !name.endsWith('.tmp')) : [];

  await page.getByTestId('shot-screen').click();
  const editor = await editorPage(app);
  await expect(editor.getByTestId('editor-view')).toBeVisible();
  await editor.getByTestId('editor-canvas').click({ position: { x: 40, y: 40 } });
  await editor.keyboard.press('Control+Shift+S');
  await expect.poll(() => saved().length).toBe(1);
  const first = saved()[0] as string;
  expect(first).toMatch(/^FrameCapt \d{4}-\d{2}-\d{2} at \d{2}\.\d{2}\.\d{2}\.png$/);
  expect(fs.readdirSync(folder).filter((name) => name.endsWith('.tmp'))).toEqual([]);
  await expect(editor.getByText(/Saved to/).first()).toBeVisible();
  // A second quick save of the same capture never overwrites the first.
  await editor.keyboard.press('Control+Shift+S');
  await expect.poll(() => saved().length).toBe(2);
  expect(saved()).toContain(first);
  expect(await app.evaluate(() => (globalThis as unknown as { __dialogs: number }).__dialogs)).toBe(
    0,
  );

  // The menu entry does the same.
  await editor.getByTestId('editor-save-menu').click();
  await editor.getByTestId('editor-quick-save').click();
  await expect.poll(() => saved().length).toBe(3);

  // Undo the last one.
  // Stacked toasts overlap and animate: activate the newest Undo directly.
  await editor.getByRole('button', { name: 'Undo' }).last().dispatchEvent('click');
  await expect.poll(() => saved().length).toBe(2);
  expect(
    await app.evaluate(() => (globalThis as unknown as { __trashed: string[] }).__trashed),
  ).toHaveLength(1);

  // After the undo the editor holds unsaved work again; quick save once more, then leave.
  await editor.keyboard.press('Control+Shift+S');
  await expect.poll(() => saved().length).toBe(3);
  await editor.getByTestId('editor-done').click();
  await expectEditorClosed(app);
  await nav('Library');
  await expect(page.getByTestId('history-item')).toHaveCount(3);
});

test('quick save is a customizable editor shortcut, listed in Settings', async () => {
  await nav('Settings');
  await page.getByTestId('settings-nav-shortcuts').click();
  await expect(page.getByTestId('settings-shortcuts')).toContainText('Quick save');
  await nav('Home');
});

test('Settings search filters sections and options, and shows an empty state', async () => {
  await nav('Settings');
  const search = page.getByTestId('settings-search');
  await search.fill('microphone');
  await expect(page.getByTestId('settings-results')).toBeVisible();
  await expect(page.getByTestId('settings-recording')).toBeVisible();
  await expect(page.getByTestId('settings-general')).toBeHidden();
  await expect(page.getByTestId('setting-theme')).toBeHidden();

  // A section title keeps all of its rows.
  await search.fill('shortcuts');
  await expect(page.getByTestId('settings-shortcuts')).toBeVisible();
  await expect(page.getByTestId('settings-recording')).toBeHidden();

  // Editable data has an anchor of its own.
  await search.fill('editable originals');
  await expect(page.locator('#editable-data')).toBeVisible();

  await search.fill('zzzz-nothing');
  await expect(page.getByText('No settings match').first()).toBeVisible();

  await page.getByTestId('settings-search-clear').click();
  await expect(page.getByTestId('settings-results')).toHaveCount(0);
  await expect(page.getByTestId('settings-nav-recording')).toBeVisible();
  await search.fill('folder');
  await page.keyboard.press('Escape');
  await expect(search).toHaveValue('');
  await nav('Home');
});

test('tucking the toolbar away keeps recording; the pause shortcut works while it is tucked', async () => {
  const hooks = <T>(fn: (h: Hooks) => T): Promise<T> =>
    app.evaluate((_electron, source) => {
      const h = (globalThis as unknown as { __frameCaptTest: Hooks }).__frameCaptTest;
      return new Function('h', `return (${source})(h)`)(h) as never;
    }, fn.toString());
  const state = async () => {
    const result = await page.evaluate(() => window.framecapt.invoke('recorder:getState'));
    if (!result.ok) throw new Error('getState failed');
    return result.data;
  };
  const countdown = page.getByTestId('opt-countdown');
  if ((await countdown.getAttribute('aria-checked')) === 'true') await countdown.click();
  await page.getByTestId('record-screen').click();
  let toolbar: Page | undefined;
  await expect
    .poll(
      () => (toolbar = app.windows().find((w) => w.url().includes('#/toolbar'))) !== undefined,
      {
        timeout: 20_000,
      },
    )
    .toBe(true);
  const bar = toolbar as Page;
  await expect(bar.getByTestId('toolbar')).toHaveAttribute('data-status', 'recording', {
    timeout: 20_000,
  });
  const win = await app.browserWindow(bar);
  const width = () => win.evaluate((w) => w.getBounds().width);
  const full = await width();

  await bar.getByTestId('toolbar-collapse').click();
  await expect(bar.getByTestId('toolbar')).toHaveAttribute('data-compact', 'true');
  await expect(bar.getByTestId('toolbar-stop')).toHaveCount(0);
  await expect.poll(width).toBeLessThan(full - 60);
  // Still recording, the window is still there, the timer keeps counting.
  expect((await state()).status).toBe('recording');
  const t0 = await bar.getByTestId('toolbar-timer').textContent();
  await expect.poll(() => bar.getByTestId('toolbar-timer').textContent()).not.toBe(t0);

  // The global pause shortcut still works while the controls are tucked away.
  await hooks((h) => h.runAction('pauseRecording'));
  await expect.poll(async () => (await state()).status).toBe('paused');
  await expect(bar.getByTestId('toolbar-dot')).toBeVisible();
  await hooks((h) => h.runAction('pauseRecording'));
  await expect.poll(async () => (await state()).status).toBe('recording');

  await bar.getByTestId('toolbar-expand').click();
  await expect(bar.getByTestId('toolbar-stop')).toBeVisible();
  await expect.poll(width).toBeGreaterThan(full - 5);
  expect((await state()).status).toBe('recording');
  await bar.getByTestId('toolbar-stop').click();
  await expect(page.getByTestId('recording-result')).toBeVisible({ timeout: 30_000 });
});
