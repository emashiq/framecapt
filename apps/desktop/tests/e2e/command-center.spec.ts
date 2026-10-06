/**
 * The title bar's menus and command center, against the E2E build (mock capture, fake global
 * shortcuts). The renderer, the IPC bridge and main's windows are the
 * real ones. Starting a screenshot goes through the same path as the Capture view's buttons, so
 * the observable is the selection overlay window the (mock) flow opens.
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
import { mockScreenshotPng, newId, seedHistory } from './history-fixtures';

const projectRoot = path.resolve(__dirname, '..', '..');
const THEMES = ['light', 'dark'] as const;

let app: ElectronApplication;
let page: Page;
let dir: string;
let seeded: { id: string; name: string }[] = [];

async function launch(): Promise<void> {
  expect(
    fs.existsSync(path.join(projectRoot, '.vite', 'build', 'main.cjs')),
    'Run `npm run package:e2e` first (npm run test:e2e does this).',
  ).toBe(true);
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'framecapt-e2e-command-center-'));
  const files = path.join(dir, 'files');
  fs.mkdirSync(files, { recursive: true });
  const now = Date.now();
  seeded = ['Quarterly report', 'Standup notes'].map((name) => ({ id: newId(), name }));
  seedHistory(
    dir,
    seeded.map(({ id, name }, index) => {
      const file = path.join(files, `${name}.png`);
      fs.writeFileSync(file, mockScreenshotPng(640, 360, index));
      return {
        id,
        type: 'screenshot' as const,
        path: file,
        createdAt: now - (index + 1) * 60_000,
        width: 640,
        height: 360,
        durationMs: null,
        sizeBytes: fs.statSync(file).size,
        format: 'png' as const,
        hasAudio: null,
        source: 'region' as const,
      };
    }),
  );
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
  await expect(page.getByTestId('command-center-button')).toBeVisible();
  // The boot screen covers the app until its first data has loaded.
  await expect(page.getByTestId('boot-screen')).toHaveCount(0, { timeout: 10_000 });
}

test.afterEach(async () => {
  if (app) await exitApp(app);
  if (dir) fs.rmSync(dir, { recursive: true, force: true });
});

const overlayPages = (): Page[] =>
  app.windows().filter((window) => window.url().includes('#/overlay'));
const overlayCount = (): number => overlayPages().length;

/** The first selection overlay that has drawn, then Esc: the flow ends and every overlay closes. */
async function cancelOverlay(): Promise<void> {
  await expect
    .poll(async () => {
      for (const overlay of overlayPages()) {
        if ((await overlay.locator('[data-ready="true"]').count()) > 0) return true;
      }
      return false;
    })
    .toBe(true);
  const overlay = overlayPages()[0]!;
  // The overlay window may be destroyed before Playwright hears back.
  await overlay.keyboard.press('Escape').catch((error: unknown) => {
    if (!/closed/i.test(String(error))) throw error;
  });
  await expect.poll(overlayCount).toBe(0);
}

const palette = () => page.getByTestId('command-palette');
const input = () => page.getByTestId('command-input');
const option = (id: string) => page.getByTestId(`command-${id}`);

async function openByClick(): Promise<void> {
  await page.getByTestId('command-center-button').click();
  await expect(palette()).toBeVisible();
  await expect(input()).toBeFocused();
}

async function setTheme(theme: (typeof THEMES)[number]): Promise<void> {
  const result = await page.evaluate(
    (value) => window.framecapt.invoke('settings:update', { patch: { general: { theme: value } } }),
    theme,
  );
  expect(result.ok).toBe(true);
  await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
  await page.waitForTimeout(400);
}

async function scan(name: string, scope: string): Promise<void> {
  const results = await new AxeBuilder({ page })
    .setLegacyMode()
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
    .include(scope)
    .analyze();
  const bad = results.violations
    .filter((violation) => violation.impact === 'serious' || violation.impact === 'critical')
    .map(
      (violation) =>
        `${violation.id} (${violation.impact}): ${violation.nodes
          .slice(0, 3)
          .map((node) => `${node.target.join(' ')} | ${node.failureSummary?.split('\n')[1] ?? ''}`)
          .join(' ;; ')}`,
    );
  expect(bad, `${name}: serious or critical accessibility violations`).toEqual([]);
}

test.describe('title bar and command center', () => {
  test.beforeEach(async () => launch());

  test('the bar has the logo, the menus, a centred search box and the window controls', async () => {
    const bar = page.getByTestId('title-bar');
    await expect(bar).toBeVisible();
    expect((await bar.boundingBox())?.height).toBe(36);
    await expect(bar.locator('img').first()).toBeVisible();
    await expect(page.getByRole('menubar', { name: 'Application menu' })).toBeVisible();
    for (const name of ['File', 'View', 'Help']) {
      await expect(page.getByRole('menuitem', { name, exact: true })).toBeVisible();
    }
    const search = page.getByTestId('command-center-button');
    await expect(search).toContainText('Search commands and captures…');
    await expect(search).toContainText('Ctrl');

    // The search box sits in the middle of the room left of the window controls.
    const box = (await search.boundingBox())!;
    const area = await page.evaluate(() => {
      const overlay = (
        navigator as unknown as {
          windowControlsOverlay?: { visible: boolean; getTitlebarAreaRect(): DOMRect };
        }
      ).windowControlsOverlay;
      return overlay
        ? { visible: overlay.visible, width: overlay.getTitlebarAreaRect().width }
        : null;
    });
    const room = area?.visible ? area.width : (await bar.boundingBox())!.width;
    expect(box.x + box.width / 2).toBeGreaterThan(room * 0.3);
    expect(box.x + box.width / 2).toBeLessThan(room * 0.7);
    // Nothing of the bar sits under the window buttons.
    expect(box.x + box.width).toBeLessThanOrEqual(room + 1);

    if (process.platform === 'win32' || process.platform === 'linux') {
      expect(area?.visible, 'window-controls overlay in use').toBe(true);
      expect(area!.width).toBeLessThan((await bar.boundingBox())!.width);
    }
  });

  test('the window can be maximized and restored (the overlay stays out of the way)', async () => {
    const win = await app.browserWindow(page);
    const state = () =>
      win.evaluate((w) => ({ maximized: w.isMaximized(), resizable: w.isResizable() }));
    expect((await state()).resizable).toBe(true);
    await win.evaluate((w) => w.maximize());
    await expect.poll(async () => (await state()).maximized).toBe(true);
    await expect(page.getByTestId('command-center-button')).toBeVisible();
    await win.evaluate((w) => w.unmaximize());
    await expect.poll(async () => (await state()).maximized).toBe(false);
  });

  test('a click and Ctrl+K open the command center; Esc closes it and gives the focus back', async () => {
    await openByClick();
    await expect(input()).toHaveAttribute('role', 'combobox');
    await page.keyboard.press('Escape');
    await expect(palette()).toBeHidden();
    await expect(page.getByTestId('command-center-button')).toBeFocused();

    await page.getByTestId('flow-status').click();
    await page.keyboard.press('Control+K');
    await expect(palette()).toBeVisible();
    await expect(input()).toBeFocused();
    await expect(input()).toHaveAttribute('placeholder', 'Search commands and captures…');
    await page.keyboard.press('Escape');
    await expect(palette()).toBeHidden();

    await page.keyboard.press('Control+Shift+P');
    await expect(palette()).toBeVisible();
    await expect(input()).toHaveAttribute('placeholder', 'Search commands…');
  });

  test('typing "screen" lists the screenshot commands, grouped, with the live shortcuts', async () => {
    await openByClick();
    await input().fill('screen');
    const group = page.getByTestId('command-group-Capture');
    for (const target of ['region', 'window', 'screen']) {
      await expect(group.getByText(`Take screenshot – ${target}`)).toBeVisible();
    }
    await expect(option('shot.region')).toContainText('Ctrl+Shift+3');
    await expect(page.getByTestId('command-status')).toHaveText(/\d+ results?/);
    await input().fill('qqqqzzzz');
    await expect(page.getByTestId('command-empty')).toHaveText('No matching commands');
    await expect(page.getByTestId('command-status')).toHaveText('No matching commands');
  });

  test('arrow keys move the highlighted option (aria-activedescendant)', async () => {
    await openByClick();
    await input().fill('screen');
    const first = await input().getAttribute('aria-activedescendant');
    await page.keyboard.press('ArrowDown');
    const second = await input().getAttribute('aria-activedescendant');
    expect(second).not.toBe(first);
    await expect(page.locator(`#${second}`)).toHaveAttribute('aria-selected', 'true');
    await page.keyboard.press('ArrowUp');
    await expect(input()).toHaveAttribute('aria-activedescendant', first!);
  });

  test('Enter on "Take screenshot – region" starts the same flow as the button', async () => {
    await openByClick();
    await input().fill('screenshot region');
    await expect(option('shot.region')).toHaveAttribute('aria-selected', 'true');
    await page.keyboard.press('Enter');
    await expect(palette()).toBeHidden();
    await expect.poll(overlayCount).toBeGreaterThan(0);
    await cancelOverlay();
    await expect(page.getByTestId('shot-region')).toBeEnabled();
  });

  test('"history" navigates, and the command shows up as recent next time', async () => {
    await openByClick();
    await input().fill('history');
    await page.keyboard.press('Enter');
    await expect(page.getByTestId('history-view')).toBeVisible();
    await expect(
      page.getByRole('navigation', { name: 'Primary' }).getByRole('button', { name: 'History' }),
    ).toHaveAttribute('aria-current', 'page');

    await openByClick();
    const first = page.getByTestId('command-group-Recent');
    await expect(first).toBeVisible();
    await expect(first.getByTestId('command-nav.history')).toBeVisible();
    // Recent is the first group of the list.
    await expect(page.locator('[data-testid^="command-group-"]').first()).toHaveAttribute(
      'data-testid',
      'command-group-Recent',
    );
  });

  test('a saved capture is found by its name; Enter opens it in History', async () => {
    const target = seeded[0]!;
    await openByClick();
    await input().fill('quarterly');
    const found = page.getByTestId('command-group-Recent captures').getByTestId('command-capture');
    await expect(found).toHaveCount(1);
    await expect(found).toContainText(`${target.name}.png`);
    await expect(found).toHaveAttribute('data-id', target.id);
    // The commands still answer first; move to the capture row.
    await page.keyboard.press('ArrowDown');
    await expect(found).toHaveAttribute('aria-selected', 'true');
    await page.keyboard.press('Enter');
    await expect(palette()).toBeHidden();
    await expect(page.getByTestId('history-details')).toBeVisible();
    await expect(page.getByTestId('history-path')).toContainText(`${target.name}.png`);
  });

  test('a search with no saved match says nothing wrong, and a failing search is reported', async () => {
    await openByClick();
    await input().fill('zzzzzz-nothing');
    await expect(page.getByTestId('command-empty')).toBeVisible();
    await expect(page.getByTestId('command-group-Recent captures')).toHaveCount(0);

    // Main refuses the history search (a damaged service): the palette says so.
    await app.evaluate(({ ipcMain }) => {
      ipcMain.removeHandler('history:list');
      ipcMain.handle('history:list', () => ({
        ok: false,
        error: { code: 'INTERNAL', message: 'boom' },
      }));
    });
    await input().fill('standup');
    await expect(page.getByTestId('command-note')).toBeVisible();
  });

  test('the menu bar works from the keyboard', async () => {
    const file = page.getByTestId('menubar-file');
    await file.focus();
    await page.keyboard.press('ArrowDown');
    const popup = page.getByTestId('menu-popup');
    await expect(popup).toBeVisible();
    await expect(popup).toHaveAttribute('role', 'menu');
    await expect(page.getByTestId('menu-item-file.openImage')).toBeFocused();
    await expect(page.getByTestId('menu-item-file.openImage')).toContainText('Ctrl+O');
    await page.keyboard.press('ArrowDown');
    await expect(page.getByTestId('menu-item-shot.region')).toBeFocused();
    await expect(page.getByTestId('menu-item-shot.region')).toContainText('Ctrl+Shift+3');
    await page.keyboard.press('ArrowDown');
    await expect(page.getByTestId('menu-item-shot.window')).toBeFocused();
    await page.keyboard.press('End');
    await expect(page.getByTestId('menu-item-app.quit')).toBeFocused();

    await page.keyboard.press('ArrowRight');
    await expect(popup).toHaveAttribute('data-menu', 'view');
    await page.keyboard.press('ArrowDown');
    await expect(page.getByTestId('menu-item-nav.history')).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(popup).toBeHidden();
    await expect(page.getByTestId('history-view')).toBeVisible();

    await page.getByTestId('menubar-help').focus();
    await page.keyboard.press('Enter');
    await expect(popup).toHaveAttribute('data-menu', 'help');
    await page.keyboard.press('Escape');
    await expect(popup).toBeHidden();
    await expect(page.getByTestId('menubar-help')).toBeFocused();
  });

  test('File, New screenshot – region starts the flow; Help opens the shortcuts', async () => {
    await page.getByTestId('menubar-file').click();
    await page.getByTestId('menu-item-shot.region').click();
    await expect.poll(overlayCount).toBeGreaterThan(0);
    await cancelOverlay();

    await page.getByTestId('menubar-help').click();
    await page.getByTestId('menu-item-help.shortcuts').click();
    await expect(page.getByTestId('keyboard-help')).toBeVisible();
    await expect(page.getByTestId('keyboard-help')).toContainText('Command center');
    await page.keyboard.press('Escape');
  });

  test('View, Toggle light or dark theme changes the theme', async () => {
    await setTheme('light');
    await page.getByTestId('menubar-view').click();
    await page.getByTestId('menu-item-view.toggleTheme').click();
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  });

  test('the palette opens a Settings section', async () => {
    await openByClick();
    await input().fill('settings shortcuts');
    await expect(option('settings.shortcuts')).toBeVisible();
    await page.keyboard.press('Enter');
    await expect(page.getByTestId('settings-view')).toBeVisible();
  });

  test('the command center keys are editable in Settings and shown in the keyboard help', async () => {
    const result = await page.evaluate(() =>
      window.framecapt.invoke('settings:update', {
        patch: { editorShortcuts: { commandCenter: 'Ctrl+J' } },
      }),
    );
    expect(result.ok).toBe(true);
    await expect(page.getByTestId('command-center-button')).toContainText('J');
    await page.keyboard.press('Control+K');
    await expect(palette()).toBeHidden();
    await page.keyboard.press('Control+J');
    await expect(palette()).toBeVisible();
    await page.keyboard.press('Escape');

    await page
      .getByRole('navigation', { name: 'Primary' })
      .getByRole('button', { name: 'Settings' })
      .click();
    await page.getByTestId('settings-nav-shortcuts').click();
    await expect(page.getByTestId('shortcut-row-commandCenter')).toBeVisible();
    await expect(page.getByTestId('shortcut-row-commandPalette')).toBeVisible();
  });

  test('a narrow window collapses the menus into one button and the search box into an icon', async () => {
    const win = await app.browserWindow(page);
    await win.evaluate((w) => {
      w.setMinimumSize(300, 400);
      w.setSize(440, 700);
    });
    const search = page.getByTestId('command-center-button');
    await expect(page.getByTestId('menubar-all')).toBeVisible();
    await expect(page.getByTestId('menubar-file')).toHaveCount(0);
    await expect(search).toHaveAttribute('aria-label', 'Search commands and captures');
    await expect(search).not.toContainText('Search commands');
    await page.getByTestId('menubar-all').click();
    await expect(page.getByTestId('menu-item-nav.history')).toBeVisible();
    await page.keyboard.press('Escape');
    await win.evaluate((w) => {
      w.setMinimumSize(860, 560);
      w.setSize(1100, 720);
    });
    await expect(page.getByTestId('menubar-file')).toBeVisible();
  });

  for (const theme of THEMES) {
    test(`accessibility (${theme}): the title bar with the palette open and with a menu open`, async () => {
      await setTheme(theme);
      await scan('title bar', '[data-testid="title-bar"]');

      await openByClick();
      await input().fill('screen');
      await expect(option('shot.region')).toBeVisible();
      await scan('command center', '[data-testid="command-palette"]');
      await page.keyboard.press('Escape');

      await page.getByTestId('menubar-file').click();
      await expect(page.getByTestId('menu-popup')).toBeVisible();
      await scan('file menu', '[data-testid="menu-popup"]');
      await scan('title bar with a menu open', '[data-testid="title-bar"]');
      await page.keyboard.press('Escape');
    });
  }

  test('a picture of the bar in both themes (read by the author, not compared)', async () => {
    const out = process.env.FRAMECAPT_E2E_SHOTS;
    test.skip(!out, 'FRAMECAPT_E2E_SHOTS names a folder for the pictures');
    fs.mkdirSync(out!, { recursive: true });
    for (const theme of THEMES) {
      await setTheme(theme);
      await page.screenshot({
        path: path.join(out!, `bar-${theme}.png`),
        clip: { x: 0, y: 0, width: 1100, height: 120 },
      });
      await page.getByTestId('menubar-file').click();
      await page.screenshot({
        path: path.join(out!, `menu-${theme}.png`),
        clip: { x: 0, y: 0, width: 700, height: 420 },
      });
      await page.keyboard.press('Escape');
      await openByClick();
      await input().fill('screen');
      await page.screenshot({
        path: path.join(out!, `palette-${theme}.png`),
        clip: { x: 150, y: 0, width: 800, height: 420 },
      });
      await page.keyboard.press('Escape');
    }
  });
});
