/**
 * Accessibility scan (axe-core) of every main view and dialog, in both themes, against the E2E
 * build: zero serious or critical violations (WCAG 2.0/2.1 A and AA rules, including colour
 * contrast). The theme is switched through the real setting, so the same code path users take
 * (nativeTheme + data-theme) is the one being scanned.
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
import { makeWebm, mockScreenshotPng, newId, seedHistory } from './history-fixtures';

const projectRoot = path.resolve(__dirname, '..', '..');
const THEMES = ['light', 'dark'] as const;

let app: ElectronApplication;
let page: Page;
let dir: string;

test.describe.configure({ mode: 'serial' });

test.beforeAll(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'framelet-e2e-a11y-'));
  // A little history so the History view is scanned with real cards.
  const files = path.join(dir, 'files');
  fs.mkdirSync(files, { recursive: true });
  const now = Date.now();
  const shot = path.join(files, 'Framelet 2026-10-02 at 10.00.00.png');
  fs.writeFileSync(shot, mockScreenshotPng(640, 360, 1));
  const clip = path.join(files, 'Framelet 2026-10-02 at 10.05.00.webm');
  makeWebm(clip, 2, { audio: false });
  seedHistory(dir, [
    {
      id: newId(),
      type: 'screenshot',
      path: shot,
      createdAt: now - 60_000,
      width: 640,
      height: 360,
      durationMs: null,
      sizeBytes: fs.statSync(shot).size,
      format: 'png',
      hasAudio: null,
      source: 'region',
    },
    {
      id: newId(),
      type: 'recording',
      path: clip,
      createdAt: now - 120_000,
      width: 640,
      height: 360,
      durationMs: 2000,
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
      FRAMELET_USER_DATA_DIR: dir,
      FRAMELET_E2E_MOCK_CAPTURE: '1',
      FRAMELET_E2E_MOCK_DISPLAYS: '1',
      FRAMELET_E2E_FAKE_SHORTCUTS: '1',
    },
  });
  page = await app.firstWindow();
  await page.waitForLoadState('domcontentloaded');
  await expect(page.getByTestId('shot-region')).toBeVisible();
});

test.afterAll(async () => {
  if (app) await exitApp(app);
  if (dir) fs.rmSync(dir, { recursive: true, force: true });
});

async function setTheme(theme: (typeof THEMES)[number]): Promise<void> {
  const result = await page.evaluate(
    (value) => window.framelet.invoke('settings:update', { patch: { general: { theme: value } } }),
    theme,
  );
  expect(result.ok).toBe(true);
  await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
  // Let transitions and the entry animation finish: axe reads the final colours.
  await page.waitForTimeout(400);
}

async function scan(name: string, scope?: string): Promise<void> {
  let builder = new AxeBuilder({ page })
    .setLegacyMode()
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']);
  if (scope) builder = builder.include(scope);
  const results = await builder.analyze();
  const bad = results.violations.filter(
    (violation) => violation.impact === 'serious' || violation.impact === 'critical',
  );
  const summary = bad.map(
    (violation) =>
      `${violation.id} (${violation.impact}): ${violation.nodes
        .slice(0, 3)
        .map((node) => `${node.target.join(' ')} | ${node.failureSummary?.split('\n')[1] ?? ''}`)
        .join(' ;; ')}`,
  );
  expect(summary, `${name}: serious or critical accessibility violations`).toEqual([]);
}

async function go(name: 'Capture' | 'History' | 'Settings'): Promise<void> {
  await page.getByRole('navigation', { name: 'Primary' }).getByRole('button', { name }).click();
}

for (const theme of THEMES) {
  test(`Home, History and every Settings section (${theme})`, async () => {
    await setTheme(theme);
    await go('Capture');
    await expect(page.getByTestId('shot-region')).toBeVisible();
    await expect(page.getByTestId('home-tip')).toBeVisible();
    await scan(`Home ${theme}`);

    await go('History');
    await expect(page.getByTestId('history-grid').locator('li').first()).toBeVisible();
    await page.waitForTimeout(500); // thumbnails
    await scan(`History ${theme}`);

    await go('Settings');
    for (const section of [
      'general',
      'screenshots',
      'recording',
      'shortcuts',
      'storage',
      'about',
    ]) {
      await page.getByTestId(`settings-nav-${section}`).click();
      await expect(
        page.getByTestId(`settings-${section === 'about' ? 'view' : section}`),
      ).toBeVisible();
      await scan(`Settings ${section} ${theme}`);
    }
    await page.getByTestId('settings-nav-advanced').click();
    await expect(page.getByTestId('settings-advanced')).toBeVisible();
    await scan(`Settings advanced ${theme}`);
  });

  test(`Editor, dialogs and the window picker (${theme})`, async () => {
    await setTheme(theme);
    await go('Capture');
    // The editor, from a real region capture on the mock display.
    await page.getByTestId('shot-region').click();
    const overlay = await (async () => {
      let found: Page | undefined;
      await expect
        .poll(async () => {
          for (const candidate of app.windows().filter((w) => w.url().includes('#/overlay'))) {
            const root = candidate.locator('[data-testid="overlay-region"]');
            if ((await root.count()) && (await root.getAttribute('data-ready')) === 'true') {
              found = candidate;
              return true;
            }
          }
          return false;
        })
        .toBe(true);
      return found as Page;
    })();
    await overlay.keyboard.press('ArrowRight');
    await overlay.keyboard.press('Enter').catch(() => undefined);
    await expect(page.getByTestId('editor-view')).toBeVisible();
    await page.waitForTimeout(500);
    await scan(`Editor ${theme}`);

    // Dialogs over the editor: the discard question and the keyboard help.
    await page.getByTestId('editor-discard').click();
    await expect(page.getByTestId('confirm-dialog')).toBeVisible();
    await scan(`Discard dialog ${theme}`);
    await page.getByTestId('confirm-yes').click();
    await expect(page.getByTestId('shot-region')).toBeVisible();

    await page.keyboard.press('?');
    await expect(page.getByTestId('keyboard-help')).toBeVisible();
    await scan(`Keyboard help ${theme}`);
    await page.keyboard.press('Escape');

    await page.getByTestId('shot-window').click();
    await expect(page.getByTestId('source-picker')).toBeVisible();
    await expect(page.getByTestId('window-grid')).toBeVisible();
    await scan(`Window picker ${theme}`);
    await page.keyboard.press('Escape');
  });
}
