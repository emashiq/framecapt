/**
 * The editor tabs of the main window, end to end (E2E build). Two screenshots and one video are
 * opened from the Library: three tabs beside the pinned Home tab. Opening an item again focuses
 * its tab; every tab keeps its own state; a hidden video pauses; closing a tab with unsaved work
 * asks (Save, Don't save, Cancel); closing the window or quitting with unsaved tabs asks once and
 * names them; Home is never closed.
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
import { activePanel, editorPage, expectEditorClosed, tabs } from './editor-window';
import { makeWebm, mockScreenshotPng, newId, seedHistory } from './history-fixtures';

const projectRoot = path.resolve(__dirname, '..', '..');

let dir: string;
let app: ElectronApplication;
let main: Page;
/** The editors are tabs of the main window: the same page. */
let editor: Page;

test.describe.configure({ mode: 'serial' });

const files = (): string => path.join(dir, 'files');

test.beforeAll(async () => {
  expect(
    fs.existsSync(path.join(projectRoot, '.vite', 'build', 'main.cjs')),
    'Run `npm run package:e2e` first (npm run test:e2e does this).',
  ).toBe(true);
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'framecapt-e2e-tabs-'));
  fs.mkdirSync(files(), { recursive: true });
  const alpha = path.join(files(), 'alpha.png');
  const beta = path.join(files(), 'beta.png');
  const clip = path.join(files(), 'clip.webm');
  fs.writeFileSync(alpha, mockScreenshotPng(1280, 720, 1));
  fs.writeFileSync(beta, mockScreenshotPng(1280, 720, 2));
  makeWebm(clip, 4, { size: '640x360', audio: false, codec: 'vp8' });
  const now = Date.now();
  const shot = (file: string, age: number) => ({
    id: newId(),
    type: 'screenshot' as const,
    path: file,
    createdAt: now - age,
    width: 1280,
    height: 720,
    durationMs: null,
    sizeBytes: fs.statSync(file).size,
    format: 'png' as const,
    hasAudio: null,
    source: 'region' as const,
  });
  seedHistory(dir, [
    shot(alpha, 3000),
    shot(beta, 2000),
    {
      id: newId(),
      type: 'recording',
      path: clip,
      createdAt: now - 1000,
      width: 640,
      height: 360,
      durationMs: 4000,
      sizeBytes: fs.statSync(clip).size,
      format: 'webm',
      hasAudio: false,
      source: 'screen',
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
  main = await app.firstWindow();
  await main.waitForLoadState('domcontentloaded');
  await expect(main.getByTestId('shot-region')).toBeVisible();
});

test.afterAll(async () => {
  if (app) await exitApp(app);
  if (dir) fs.rmSync(dir, { recursive: true, force: true });
});

/** Opens the history item called `name` as a tab (its Edit action in the details). */
async function editFromHistory(name: string): Promise<void> {
  const nav = main.getByRole('navigation', { name: 'Primary' });
  await nav.getByRole('button', { name: 'Home', exact: true }).click();
  await nav.getByRole('button', { name: 'Library' }).click();
  await main
    .getByTestId('history-item')
    .filter({ hasText: name })
    .locator('[data-card-main]')
    .click();
  await main.getByTestId('details-edit').click();
}

const titles = async (): Promise<string[]> =>
  tabs(editor).getByTestId('tab-title').allTextContents();

async function drawRect(page: Page): Promise<void> {
  await activePanel(page).getByTestId('tool-rect').click();
  const box = await activePanel(page).getByTestId('editor-canvas').boundingBox();
  if (!box) throw new Error('no canvas');
  await page.mouse.move(box.x + 100, box.y + 100);
  await page.mouse.down();
  await page.mouse.move(box.x + 300, box.y + 220, { steps: 5 });
  await page.mouse.up();
}

const annotations = (page: Page) =>
  activePanel(page).getByTestId('editor-canvas').getAttribute('data-annotations');

test('two screenshots and a video from the Library are three tabs beside Home', async () => {
  await editFromHistory('alpha');
  editor = await editorPage(app);
  await expect(tabs(editor)).toHaveCount(1);
  await editFromHistory('beta');
  await expect(tabs(editor)).toHaveCount(2);
  await editFromHistory('clip');
  await expect(tabs(editor)).toHaveCount(3);

  // One window, Home first and pinned, then the three tabs in the order opened; the newest shows.
  expect(app.windows().filter((w) => w.url().includes('#/editor'))).toHaveLength(0);
  expect(editor).toBe(main);
  expect(await titles()).toEqual(['alpha.png', 'beta.png', 'clip.webm']);
  await expect(main.getByTestId('home-tab')).toBeVisible();
  await expect(main.getByTestId('home-tab').getByTestId('tab-close')).toHaveCount(0);
  await expect(tabs(editor).nth(0)).toHaveAttribute('data-kind', 'shot');
  await expect(tabs(editor).nth(2)).toHaveAttribute('data-kind', 'video');
  await expect(tabs(editor).nth(2)).toHaveAttribute('data-active', 'true');
  await expect(activePanel(editor).getByTestId('video-editor')).toBeVisible();

  // Home is one click away and the editors are still open behind it.
  await main.getByTestId('home-tab').click();
  await expect(main.getByTestId('home-panel')).toHaveAttribute('data-active', 'true');
  await expect(tabs(editor)).toHaveCount(3);
  await tabs(editor).nth(2).getByRole('button').first().click();
  await expect(tabs(editor).nth(2)).toHaveAttribute('data-active', 'true');
});

test('opening an item that is open focuses its tab instead of adding one', async () => {
  await editFromHistory('alpha');
  await expect(tabs(editor).nth(0)).toHaveAttribute('data-active', 'true');
  await expect(tabs(editor)).toHaveCount(3);
});

test('switching: click, Ctrl+Tab, Alt+number; each tab keeps its own state', async () => {
  // Alpha: draw a mark; beta stays clean.
  await expect(tabs(editor).nth(0)).toHaveAttribute('data-active', 'true');
  await drawRect(editor);
  await expect.poll(() => annotations(editor)).toBe('1');
  await expect(tabs(editor).nth(0)).toHaveAttribute('data-dirty', 'true');
  await expect(tabs(editor).nth(0).getByTestId('tab-dirty')).toBeVisible();
  await expect(tabs(editor).nth(1)).toHaveAttribute('data-dirty', 'false');

  await tabs(editor).nth(1).getByRole('button').first().click();
  await expect(tabs(editor).nth(1)).toHaveAttribute('data-active', 'true');
  await expect.poll(() => annotations(editor)).toBe('0');
  // Only the shown tab is in the accessibility tree; the others are inert.
  await expect(editor.locator('[data-testid="editor-panel"][inert]')).toHaveCount(2);

  await editor.keyboard.press('Control+Tab');
  await expect(tabs(editor).nth(2)).toHaveAttribute('data-active', 'true');
  // Past the last tab comes Home (it is part of the cycle), then alpha again.
  await editor.keyboard.press('Control+Tab');
  await expect(main.getByTestId('home-panel')).toHaveAttribute('data-active', 'true');
  await editor.keyboard.press('Control+Tab');
  await expect(tabs(editor).nth(0)).toHaveAttribute('data-active', 'true');
  await editor.keyboard.press('Control+Shift+Tab');
  await expect(main.getByTestId('home-panel')).toHaveAttribute('data-active', 'true');
  await editor.keyboard.press('Control+Shift+Tab');
  await expect(tabs(editor).nth(2)).toHaveAttribute('data-active', 'true');
  await editor.keyboard.press('Alt+2');
  await expect(tabs(editor).nth(0)).toHaveAttribute('data-active', 'true');
  await expect.poll(() => annotations(editor)).toBe('1'); // alpha's own mark is still there
  await editor.keyboard.press('Alt+9');
  await expect(tabs(editor).nth(2)).toHaveAttribute('data-active', 'true');
  await editor.keyboard.press('Alt+3');
  await expect(tabs(editor).nth(1)).toHaveAttribute('data-active', 'true');
  // Alt+1 is Home.
  await editor.keyboard.press('Alt+1');
  await expect(main.getByTestId('home-panel')).toHaveAttribute('data-active', 'true');
  await editor.keyboard.press('Alt+3');
});

test('the tab strip and the open editors have no serious accessibility violations in either theme', async () => {
  for (const theme of ['light', 'dark'] as const) {
    const set = await editor.evaluate(
      (value) =>
        window.framecapt.invoke('settings:update', { patch: { general: { theme: value } } }),
      theme,
    );
    expect(set.ok).toBe(true);
    await expect(editor.locator('html')).toHaveAttribute('data-theme', theme);
    await editor.waitForTimeout(400);
    // A dirty tab (alpha has a mark), a clean one and a video are in the strip.
    const results = await new AxeBuilder({ page: editor })
      .setLegacyMode()
      .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
      .analyze();
    const bad = results.violations
      .filter((v) => v.impact === 'serious' || v.impact === 'critical')
      .map(
        (v) =>
          v.id +
          ': ' +
          v.nodes
            .slice(0, 3)
            .map((n) => n.target.join(' '))
            .join(' ;; '),
      );
    expect(bad, 'editor ' + theme).toEqual([]);
  }
  await editor.evaluate(() =>
    window.framecapt.invoke('settings:update', { patch: { general: { theme: 'system' } } }),
  );
});

test('a video that is not showing is paused; undo history is per tab', async () => {
  const video = editor.locator('[data-testid="video-preview"]');
  await editor.keyboard.press('Alt+9');
  await expect(tabs(editor).nth(2)).toHaveAttribute('data-active', 'true');
  await expect
    .poll(() => video.evaluate((v: HTMLVideoElement) => v.readyState), { timeout: 15_000 })
    .toBeGreaterThanOrEqual(2);
  await editor.keyboard.press('Space');
  await expect(activePanel(editor).getByTestId('video-play')).toHaveAttribute(
    'aria-label',
    'Pause',
  );
  expect(await video.evaluate((v: HTMLVideoElement) => v.paused)).toBe(false);
  // Away from it: the video stops by itself.
  await editor.keyboard.press('Alt+2');
  await expect.poll(() => video.evaluate((v: HTMLVideoElement) => v.paused)).toBe(true);
  // Space on alpha does not reach the hidden video.
  await editor.keyboard.press('Space');
  expect(await video.evaluate((v: HTMLVideoElement) => v.paused)).toBe(true);

  // Ctrl+Z undoes alpha's mark only.
  await editor.keyboard.press('Control+z');
  await expect.poll(() => annotations(editor)).toBe('0');
  await expect(tabs(editor).nth(0)).toHaveAttribute('data-dirty', 'false');
});

test('tabs reorder by dragging', async () => {
  await tabs(editor).nth(2).dragTo(tabs(editor).nth(0));
  await expect.poll(titles).toEqual(['clip.webm', 'alpha.png', 'beta.png']);
});

test('closing a clean tab is silent: ×, a middle click and Ctrl+W', async () => {
  // Reopen alpha's state: it is clean after the undo. Close it with the ×.
  await tabs(editor).filter({ hasText: 'alpha.png' }).getByTestId('tab-close').click();
  await expect(tabs(editor)).toHaveCount(2);
  expect(await titles()).toEqual(['clip.webm', 'beta.png']);

  // A middle click closes too (the video: nothing is unsaved in a video).
  await tabs(editor).filter({ hasText: 'clip.webm' }).click({ button: 'middle' });
  await expect(tabs(editor)).toHaveCount(1);
  await expect(editor.getByRole('alertdialog')).toHaveCount(0);

  // Reopen two more, close the shown one with Ctrl+W.
  await editFromHistory('alpha');
  await editFromHistory('clip');
  await expect(tabs(editor)).toHaveCount(3);
  await editor.keyboard.press('Control+w');
  await expect(tabs(editor)).toHaveCount(2);
  expect(await titles()).toEqual(['beta.png', 'alpha.png']);
});

test("closing a tab with unsaved work asks: Cancel keeps it, Don't save closes it", async () => {
  await tabs(editor).filter({ hasText: 'beta.png' }).getByRole('button').first().click();
  await drawRect(editor);
  await expect(tabs(editor).filter({ hasText: 'beta.png' })).toHaveAttribute('data-dirty', 'true');

  await tabs(editor).filter({ hasText: 'beta.png' }).getByTestId('tab-close').click();
  const dialog = editor.getByRole('alertdialog');
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText('Save changes to beta.png?');
  await expect(editor.getByRole('button', { name: 'Cancel' })).toBeFocused();
  // The editor keys are ignored behind the dialog.
  await editor.keyboard.press('x');
  await expect(activePanel(editor).getByTestId('tool-redact')).not.toHaveAttribute(
    'aria-pressed',
    'true',
  );
  await editor.getByRole('button', { name: 'Cancel' }).click();
  await expect(dialog).toBeHidden();
  await expect(tabs(editor)).toHaveCount(2);

  // Ctrl+W asks the same.
  await editor.keyboard.press('Control+w');
  await expect(dialog).toBeVisible();
  await editor.getByTestId('confirm-yes').click(); // Don't save
  await expect(tabs(editor)).toHaveCount(1);
  expect(await titles()).toEqual(['alpha.png']);
});

test('Home never closes: Ctrl+W and the middle click leave it', async () => {
  await main.getByTestId('home-tab').click();
  await expect(main.getByTestId('home-panel')).toHaveAttribute('data-active', 'true');
  await main.keyboard.press('Control+w');
  await main.getByTestId('home-tab').click({ button: 'middle' });
  await expect(main.getByTestId('home-tab')).toBeVisible();
  await expect(main.getByTestId('home-panel')).toHaveAttribute('data-active', 'true');
  await expect(tabs(editor)).toHaveCount(1);
  // Closing the last tab with the keyboard lands on Home too.
  await tabs(editor).first().getByRole('button').first().click();
  await expect(tabs(editor).first()).toHaveAttribute('data-active', 'true');
  await tabs(editor).first().getByTestId('tab-close').click();
  await expectEditorClosed(app);
  await expect(main.getByTestId('home-panel')).toHaveAttribute('data-active', 'true');
});

test('many tabs scroll with chevrons and a fade, and the shown tab stays in view', async () => {
  for (const name of ['alpha', 'beta', 'clip']) await editFromHistory(name);
  await expect(tabs(editor)).toHaveCount(3);
  // Everything fits: no chevrons.
  await expect(main.getByTestId('tabs-scroll-right')).toHaveCount(0);
  // A narrow strip (as with many tabs): the list scrolls, chevrons appear on the side that has more.
  await main.addStyleTag({ content: '[data-testid="editor-tabs"] { max-width: 220px; }' });
  await expect(main.getByTestId('tabs-scroll-right')).toBeVisible();
  await main.getByTestId('tabs-scroll-right').click();
  await expect(main.getByTestId('tabs-scroll-left')).toBeVisible();
  await expect
    .poll(() => main.getByTestId('editor-tabs').evaluate((el) => el.scrollLeft))
    .toBeGreaterThan(0);
  // The shown tab is scrolled into view when it changes.
  await main.keyboard.press('Alt+2');
  await expect(tabs(editor).first()).toBeInViewport();
  for (let n = 0; n < 3; n += 1) await tabs(editor).first().getByTestId('tab-close').click();
  await expectEditorClosed(app);
});

test('quitting the app (tray, menu) asks about unsaved tabs first; Keep editing cancels the quit', async () => {
  await editFromHistory('alpha');
  editor = await editorPage(app);
  await drawRect(editor);
  await expect(tabs(editor).first()).toHaveAttribute('data-dirty', 'true');

  const requestQuit = (): Promise<void> =>
    app.evaluate(() => {
      const hooks = (globalThis as Record<string, unknown>).__frameCaptTest as {
        requestQuit: () => void;
      };
      hooks.requestQuit();
    });
  await requestQuit();
  const dialog = editor.getByRole('alertdialog');
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText('alpha.png');
  await editor.getByRole('button', { name: 'Keep editing' }).click();
  await expect(dialog).toBeHidden();
  // The app is still there, with the window and its work.
  expect(main.isClosed()).toBe(false);
  await expect(tabs(editor)).toHaveCount(1);
  await expect(tabs(editor).first()).toHaveAttribute('data-dirty', 'true');

  // Quit again and discard: every window goes and the app ends.
  const ended = app.waitForEvent('close');
  await requestQuit();
  await expect(dialog).toBeVisible();
  await editor
    .getByTestId('confirm-yes')
    .click()
    .catch(() => undefined);
  await ended;
});
