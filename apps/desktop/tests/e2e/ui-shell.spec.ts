/**
 * The window layout (ADR-050): the icon rail, the pinned Home tab, the editor tabs beside it and
 * the Library's sidebar. E2E build, mock content only. Also takes pictures of every main surface in
 * both themes (test-results/ui-shell/) and runs the accessibility scan on them.
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
import { showHome, tabs } from './editor-window';
import { makeWebm, mockScreenshotPng, newId, seedHistory, type SeedFile } from './history-fixtures';

const projectRoot = path.resolve(__dirname, '..', '..');
const shotsDir = path.join(projectRoot, 'test-results', 'ui-shell');
const THEMES = ['light', 'dark'] as const;

let app: ElectronApplication;
let page: Page;
let dir: string;
let pictures: string;

test.describe.configure({ mode: 'serial' });

function seedPng(file: string, index: number): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, mockScreenshotPng(1280, 720, index));
}

test.beforeAll(async () => {
  test.setTimeout(120_000);
  fs.mkdirSync(shotsDir, { recursive: true });
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'framecapt-e2e-shell-'));
  pictures = path.join(dir, 'pictures', 'FrameCapt');
  const videos = path.join(dir, 'videos', 'FrameCapt');
  const now = Date.now();
  const items: SeedFile[] = [];
  const shot = (rel: string, minutesAgo: number, index: number): void => {
    const file = path.join(pictures, rel);
    seedPng(file, index);
    items.push({
      id: newId(),
      type: 'screenshot',
      path: file,
      createdAt: now - minutesAgo * 60_000,
      width: 1280,
      height: 720,
      durationMs: null,
      sizeBytes: fs.statSync(file).size,
      format: 'png',
      hasAudio: null,
      source: 'region',
    });
  };
  shot('Bug report.png', 3, 0);
  shot('Login screen.png', 40, 1);
  shot(path.join('Clients', 'Acme', 'Checkout error.png'), 90, 2);
  shot(path.join('Clients', 'Acme', 'Bugs', 'Cart total.png'), 150, 3);
  shot(path.join('Clients', 'Acme', 'Bugs', 'Coupon field.png'), 200, 4);
  shot(path.join('Clients', 'Beta', 'Landing page.png'), 400, 5);
  shot(path.join('Archive', 'Old design.png'), 3000, 6);
  fs.mkdirSync(videos, { recursive: true });
  const clip = path.join(videos, 'Demo walkthrough.webm');
  makeWebm(clip, 3, { audio: false });
  items.push({
    id: newId(),
    type: 'recording',
    path: clip,
    createdAt: now - 8 * 60_000,
    width: 640,
    height: 360,
    durationMs: 3000,
    sizeBytes: fs.statSync(clip).size,
    format: 'webm',
    hasAudio: false,
    source: 'screen',
  });
  fs.mkdirSync(path.join(pictures, 'Clients', 'Gamma'), { recursive: true });
  seedHistory(dir, items);
  app = await electron.launch({
    args: ['.'],
    cwd: projectRoot,
    env: {
      ...process.env,
      FRAMECAPT_USER_DATA_DIR: dir,
      FRAMECAPT_E2E_MOCK_CAPTURE: '1',
      FRAMECAPT_E2E_FAKE_SHORTCUTS: '1',
    },
  });
  page = await app.firstWindow();
  await page.waitForLoadState('domcontentloaded');
  await expect(page.getByTestId('shot-region')).toBeVisible();
  const win = await app.browserWindow(page);
  await win.evaluate((w) => w.setSize(1280, 820));
});

test.afterAll(async () => {
  if (app) await exitApp(app);
  if (dir) fs.rmSync(dir, { recursive: true, force: true });
});

async function setTheme(theme: (typeof THEMES)[number]): Promise<void> {
  const result = await page.evaluate(
    (value) => window.framecapt.invoke('settings:update', { patch: { general: { theme: value } } }),
    theme,
  );
  expect(result.ok).toBe(true);
  await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
  await page.waitForTimeout(450);
}

async function scan(name: string): Promise<void> {
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
          .map((node) => `${node.target.join(' ')} | ${node.failureSummary?.split('\n')[1] ?? ''}`)
          .join(' ;; ')}`,
    );
  expect(bad, `${name}: serious or critical accessibility violations`).toEqual([]);
}

/** A picture and an accessibility scan of what is showing, in both themes. */
async function inBothThemes(name: string, before?: () => Promise<void>): Promise<void> {
  for (const theme of THEMES) {
    await setTheme(theme);
    // No stray tooltip or half-scrolled page in the picture.
    await page.mouse.move(640, 400, { steps: 6 });
    await page.waitForTimeout(350);
    await before?.();
    await page.evaluate(() =>
      document.querySelectorAll('.overflow-y-auto').forEach((el) => el.scrollTo(0, 0)),
    );
    await expect(page.locator('[data-sonner-toast]')).toHaveCount(0, { timeout: 12_000 });
    await page.screenshot({ path: path.join(shotsDir, `${name}-${theme}.png`) });
    await scan(`${name} (${theme})`);
  }
}

const rail = () => page.getByRole('navigation', { name: 'Primary' });
const railButton = (name: string) => rail().getByRole('button', { name });
const row = (folder: string) => page.locator(`[data-testid="folder-row"][data-path="${folder}"]`);

test('the rail has Home, Library, Guides, Settings and keyboard shortcuts, with tooltips', async () => {
  await expect(rail().getByRole('button')).toHaveCount(5);
  for (const name of ['Home', 'Library', 'Guides', 'Settings', 'Keyboard shortcuts']) {
    await expect(railButton(name)).toBeVisible();
  }
  await expect(railButton('Home')).toHaveAttribute('aria-current', 'page');
  await expect(railButton('Library')).not.toHaveAttribute('aria-current');
  const box = await page.getByTestId('rail').boundingBox();
  expect(box?.width).toBe(56);

  await railButton('Library').hover();
  await expect(page.getByRole('tooltip')).toContainText('Library');
  await page.mouse.move(700, 450, { steps: 12 });
  await expect(page.getByRole('tooltip')).toHaveCount(0);
  await railButton('Keyboard shortcuts').hover();
  await expect(page.getByRole('tooltip')).toContainText('Keyboard shortcuts');

  // One tab stop, arrow keys move between the icons.
  await railButton('Home').focus();
  await page.keyboard.press('ArrowDown');
  await expect(railButton('Library')).toBeFocused();
  await page.keyboard.press('End');
  await expect(railButton('Keyboard shortcuts')).toBeFocused();
  await page.keyboard.press('ArrowDown');
  await expect(railButton('Home')).toBeFocused();
});

test('the Home tab is pinned: no close button, Ctrl+W leaves it, and the rail changes its section', async () => {
  await expect(page.getByTestId('home-tab')).toBeVisible();
  await expect(page.getByTestId('home-tab').getByTestId('tab-close')).toHaveCount(0);
  await expect(page.getByTestId('home-tab-label')).toHaveText('Home');
  await page.keyboard.press('Control+w');
  await expect(page.getByTestId('home-tab')).toBeVisible();
  await expect(page.getByTestId('shot-region')).toBeVisible();

  await railButton('Library').click();
  await expect(page.getByTestId('home-tab-label')).toHaveText('Library');
  await expect(railButton('Library')).toHaveAttribute('aria-current', 'page');
  await expect(page.getByTestId('history-view')).toBeVisible();
  await railButton('Guides').click();
  await expect(page.getByTestId('home-tab-label')).toHaveText('Guides');
  await expect(page.getByTestId('crumb-current')).toHaveText('Guides');
  await railButton('Settings').click();
  await expect(page.getByTestId('home-tab-label')).toHaveText('Settings');
  await expect(page.getByTestId('settings-view')).toBeVisible();
  await railButton('Home').click();
  await expect(page.getByTestId('home-tab-label')).toHaveText('Home');
});

test('Home: capture tiles, the options bar and the recent captures', async () => {
  await expect(page.getByTestId('mode-screenshot').getByRole('button')).toHaveCount(4);
  await expect(page.getByTestId('mode-record').getByRole('button')).toHaveCount(5);
  await expect(page.getByTestId('steps-start')).toBeVisible();
  await expect(page.getByTestId('open-image')).toBeVisible();
  await expect(page.getByTestId('record-options')).toBeVisible();
  await expect(page.getByTestId('recent-item')).toHaveCount(8);
  await expect(page.getByTestId('saving-to')).toBeVisible();
  await expect(page.getByText('Captures stay on this device.')).toHaveCount(0);
  await inBothThemes('home-first-run');
  // "Got it" dismisses the welcome card and the tip: the dashboard of a returning user.
  await page.getByTestId('onboarding-dismiss').click();
  await expect(page.getByTestId('onboarding-card')).toHaveCount(0);
  await expect(page.getByTestId('home-tip')).toHaveCount(0);
  await inBothThemes('home', async () => {
    await page.getByTestId('shot-region').hover();
  });
});

test('opening a screenshot and a video gives three tabs; Home never closes', async () => {
  await page.locator('[data-testid="recent-item"][data-type="screenshot"]').first().click();
  await expect(tabs(page)).toHaveCount(1);
  await expect(page.locator('[data-testid="editor-panel"][data-kind="shot"]')).toBeVisible();
  await expect(page.getByTestId('editor-tab').first().getByTestId('tab-title')).toHaveText(
    'Bug report.png',
  );
  await page.waitForTimeout(600);
  await inBothThemes('editor-tab');

  await showHome(page);
  await page.locator('[data-testid="recent-item"][data-type="recording"]').first().click();
  await expect(tabs(page)).toHaveCount(2);
  await expect(page.locator('[data-testid="editor-panel"][data-kind="video"]')).toBeVisible();
  await expect(page.getByTestId('home-tab')).toBeVisible();
  // Home plus two items.
  await expect(page.getByTestId('tab-strip').getByRole('button')).toHaveCount(5);
  await page.waitForTimeout(1500);
  await inBothThemes('video-editor-tab');

  // Opening the same screenshot again focuses its tab.
  await showHome(page);
  await page.locator('[data-testid="recent-item"][data-type="screenshot"]').first().click();
  await expect(tabs(page)).toHaveCount(2);
  await expect(tabs(page).first()).toHaveAttribute('data-active', 'true');
});

test('tabs: Ctrl+Tab, Alt+digits, middle click and Ctrl+W (never Home)', async () => {
  await page.keyboard.press('Control+Tab');
  await expect(tabs(page).nth(1)).toHaveAttribute('data-active', 'true');
  await page.keyboard.press('Control+Tab');
  await expect(page.getByTestId('home-panel')).toHaveAttribute('data-active', 'true');
  await page.keyboard.press('Alt+1');
  await expect(page.getByTestId('home-panel')).toHaveAttribute('data-active', 'true');
  await page.keyboard.press('Alt+2');
  await expect(tabs(page).first()).toHaveAttribute('data-active', 'true');
  await page.keyboard.press('Alt+9');
  await expect(tabs(page).nth(1)).toHaveAttribute('data-active', 'true');

  await tabs(page).nth(1).click({ button: 'middle' });
  await expect(tabs(page)).toHaveCount(1);
  await page.keyboard.press('Alt+2');
  await page.keyboard.press('Control+w');
  await expect(tabs(page)).toHaveCount(0);
  await expect(page.getByTestId('home-panel')).toHaveAttribute('data-active', 'true');
  await page.keyboard.press('Control+w');
  await expect(page.getByTestId('home-tab')).toBeVisible();
});

test('Library: sidebar with smart items and folders, breadcrumb, sort, grid and list', async () => {
  await railButton('Library').click();
  await expect(page.getByTestId('folder-pane')).toBeVisible();
  await expect(page.getByTestId('folder-pane')).toHaveCSS('width', '240px');
  for (const key of ['all', 'recent', 'type:screenshot', 'type:recording', 'type:flow']) {
    await expect(page.locator(`[data-testid="folder-row"][data-path=":${key}"]`)).toBeVisible();
  }
  await expect(row('Clients')).toBeVisible();
  await expect(row('Archive')).toBeVisible();

  // The tree: Clients opens to Acme, Beta and Gamma, and Acme to Bugs.
  await row('Clients').click();
  await expect(page.getByTestId('crumb-current')).toHaveText('Clients');
  await row('Clients').getByTestId('folder-chevron').click();
  await row('Clients/Acme').getByTestId('folder-chevron').click();
  await expect(row('Clients/Acme/Bugs')).toBeVisible();
  await expect(row('Clients/Acme/Bugs')).toHaveAttribute('aria-level', '3');
  await row('Clients/Acme/Bugs').click();
  await expect(page.getByTestId('history-item')).toHaveCount(2);

  // The breadcrumb goes back up.
  const crumbs = page.getByTestId('library-breadcrumb');
  await expect(crumbs).toContainText('Library');
  await expect(crumbs).toContainText('Clients');
  await expect(crumbs).toContainText('Acme');
  await crumbs.getByRole('button', { name: 'Acme' }).click();
  await expect(page.getByTestId('crumb-current')).toHaveText('Acme');
  await expect(row('Clients/Acme')).toHaveAttribute('aria-selected', 'true');
  // With subfolders it holds three pictures, without only its own.
  await expect(page.getByTestId('history-item')).toHaveCount(3);
  await page.getByTestId('library-more').click();
  await page.getByTestId('folder-include-sub').click();
  await expect(page.getByTestId('history-item')).toHaveCount(1);
  await page.getByTestId('library-more').click();
  await page.getByTestId('folder-include-sub').click();
  await expect(page.getByTestId('history-item')).toHaveCount(3);

  await inBothThemes('library-grid-nested');

  // The empty folder says so and offers to save new captures into it.
  await row('Clients/Gamma').click();
  await expect(page.getByText('This folder is empty')).toBeVisible();
  await expect(page.getByTestId('folder-empty-set-save')).toBeVisible();
  await inBothThemes('library-empty-folder');
  await page.locator('[data-testid="folder-row"][data-path=":all"]').click();
  await expect(page.getByTestId('history-item')).toHaveCount(8);

  // List view: the table, with a 48 px thumbnail per row.
  await page.getByTestId('library-view-list').click();
  await expect(page.getByTestId('history-list')).toBeVisible();
  await expect(page.getByTestId('history-grid')).toHaveCount(0);
  await expect(page.getByTestId('history-item')).toHaveCount(8);
  const thumb = await page.getByTestId('history-item').first().locator('img').boundingBox();
  expect(Math.round(thumb?.width ?? 0)).toBeGreaterThanOrEqual(46);
  await inBothThemes('library-list');

  // Sorting: the oldest first, then by name.
  await page.getByTestId('library-sort').click();
  await page.getByTestId('sort-oldest').click();
  await expect(
    page.getByTestId('history-item').first().locator('[data-card-main]'),
  ).toHaveAttribute('aria-label', /^Old design/);
  await page.getByTestId('library-sort').click();
  await page.getByTestId('sort-name').click();
  await expect(page.getByTestId('history-item').nth(1).locator('[data-card-main]')).toHaveAttribute(
    'aria-label',
    /^Cart total/,
  );
  await page.getByTestId('library-sort').click();
  await page.getByTestId('sort-newest').click();

  await page.getByTestId('library-view-grid').click();
  await expect(page.getByTestId('history-grid')).toBeVisible();
});

test('Library: a new folder from the + button, and the sidebar collapses and comes back (Ctrl+B)', async () => {
  await page.getByTestId('folder-new').click();
  await page.getByTestId('folder-name-input').fill('Projects');
  await page.getByTestId('folder-name-input').press('Enter');
  await expect(row('Projects')).toBeVisible();
  expect(fs.existsSync(path.join(pictures, 'Projects'))).toBe(true);
  await expect(page.getByTestId('crumb-current')).toHaveText('Projects');

  await page.getByTestId('folder-pane-collapse').click();
  await expect(page.getByTestId('folder-pane')).toHaveCount(0);
  await expect(page.getByTestId('folder-pane-expand')).toBeVisible();
  await page.getByTestId('folder-pane-expand').click();
  await expect(page.getByTestId('folder-pane')).toBeVisible();

  await page.keyboard.press('Control+b');
  await expect(page.getByTestId('folder-pane')).toHaveCount(0);
  await page.keyboard.press('Control+b');
  await expect(page.getByTestId('folder-pane')).toBeVisible();

  // The edge resizes it within 200..360 px.
  const handle = page.getByTestId('sidebar-resize');
  await handle.focus();
  await page.keyboard.press('ArrowRight');
  await expect(handle).toHaveAttribute('aria-valuenow', '256');
  await page.keyboard.press('Home');
  await expect(handle).toHaveAttribute('aria-valuenow', '200');
  await page.keyboard.press('End');
  await expect(handle).toHaveAttribute('aria-valuenow', '360');
  await page.keyboard.press('Home');
  await page.getByTestId('sidebar-resize').dblclick();
  await expect(handle).toHaveAttribute('aria-valuenow', '240');
});

test('the smallest window keeps the rail, the tabs and every section usable', async () => {
  const win = await app.browserWindow(page);
  await win.evaluate((w) => w.setSize(860, 560));
  await page.waitForTimeout(300);
  const noSideScroll = async (): Promise<void> => {
    const [scroll, client] = await page.evaluate(() => [
      document.documentElement.scrollWidth,
      document.documentElement.clientWidth,
    ]);
    expect(scroll).toBeLessThanOrEqual(client);
  };
  await railButton('Home').click();
  await expect(page.getByTestId('shot-region')).toBeVisible();
  await noSideScroll();
  await inBothThemes('narrow-home');
  await railButton('Library').click();
  await page.locator('[data-testid="folder-row"][data-path=":all"]').click();
  await expect(page.getByTestId('history-item').first()).toBeVisible();
  await noSideScroll();
  await inBothThemes('narrow-library');
  await page.getByTestId('library-view-list').click();
  await noSideScroll();
  await inBothThemes('narrow-library-list');
  await page.getByTestId('library-view-grid').click();
  await win.evaluate((w) => w.setSize(1280, 820));
  await page.waitForTimeout(300);
});

test('Settings looks right in both themes', async () => {
  await railButton('Settings').click();
  await expect(page.getByTestId('settings-view')).toBeVisible();
  await inBothThemes('settings');
});

test('Home and Library pass the accessibility scan in both themes', async () => {
  await railButton('Home').click();
  await expect(page.getByTestId('shot-region')).toBeVisible();
  for (const theme of THEMES) {
    await setTheme(theme);
    await scan(`Home ${theme}`);
  }
  await railButton('Library').click();
  await expect(page.getByTestId('history-grid')).toBeVisible();
  await page.waitForTimeout(500);
  for (const theme of THEMES) {
    await setTheme(theme);
    await scan(`Library ${theme}`);
  }
});
