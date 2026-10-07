/**
 * Customizing shortcuts, against the E2E build (mock capture, one mock display, fake global
 * shortcuts): the swap offer when a combination is taken, "Reset all shortcuts", the filter box,
 * the reserved-combination messages, and the editor's own keys being rebound and then working in
 * the real editor. The OS-level part (a real global key press) is in the native specs.
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
import { editorPage } from './editor-window';

const projectRoot = path.resolve(__dirname, '..', '..');

interface TestHooks {
  heldShortcuts(): Set<string>;
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
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'framecapt-e2e-shortcut-edit-'));
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
  await expect(page.getByTestId('shot-screen')).toBeVisible();
});

test.afterAll(async () => {
  if (app) await exitApp(app);
  if (dir) fs.rmSync(dir, { recursive: true, force: true });
});

const held = (): Promise<string[]> =>
  app.evaluate((_electron) => {
    const h = (globalThis as unknown as { __frameCaptTest: TestHooks }).__frameCaptTest;
    return [...h.heldShortcuts()].sort();
  });

const readSettings = (): {
  shortcuts?: Record<string, string | null>;
  editorShortcuts?: Record<string, string | null>;
} =>
  fs.existsSync(path.join(dir, 'settings.json'))
    ? JSON.parse(fs.readFileSync(path.join(dir, 'settings.json'), 'utf8'))
    : {};

async function openShortcuts(): Promise<void> {
  await page
    .getByRole('navigation', { name: 'Primary' })
    .getByRole('button', { name: 'Settings' })
    .click();
  await page.getByTestId('settings-nav-shortcuts').click();
  await expect(page.getByTestId('settings-shortcuts')).toBeVisible();
}

const value = (action: string) => page.getByTestId(`shortcut-value-${action}`);

test('a taken combination offers "Swap", and the swap saves both in one change', async () => {
  await openShortcuts();
  const before = await held();
  expect(before).toHaveLength(10);

  await page.getByTestId('shortcut-change-recordRegion').click();
  // Ctrl+Shift+3 is "Screenshot: region".
  await page.keyboard.press('Control+Shift+3');
  const problem = page.getByTestId('shortcut-problem-recordRegion');
  await expect(problem).toContainText('already used');
  await expect(problem).toContainText('Screenshot: region');
  const swap = page.getByTestId('shortcut-swap-recordRegion');
  await expect(swap).toBeVisible();
  // Still recording: moving focus to the Swap button does not end it.
  await swap.focus();
  await expect(page.getByTestId('shortcut-recorder-recordRegion')).toHaveCount(1);
  await swap.click();

  await expect(value('recordRegion')).toContainText('3');
  await expect(value('screenshotRegion')).toContainText('7');
  await expect.poll(() => readSettings().shortcuts?.recordRegion).toBe('Ctrl+Shift+3');
  expect(readSettings().shortcuts?.screenshotRegion).toBe('Ctrl+Shift+7');
  // The same nine combinations are registered, each for its new action.
  await expect.poll(held).toEqual(before);
  await expect(page.getByTestId('shortcut-problems')).toHaveCount(0);
});

test('the swap is reachable from the keyboard: Tab from the recorder reaches the Swap button', async () => {
  await page.getByTestId('shortcut-change-recordRegion').click();
  await page.keyboard.press('Control+Shift+7');
  await expect(page.getByTestId('shortcut-swap-recordRegion')).toBeVisible();
  await page.keyboard.press('Tab');
  await expect(page.getByTestId('shortcut-swap-recordRegion')).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(value('recordRegion')).toContainText('7');
  await expect(value('screenshotRegion')).toContainText('3');
});

test('reserved combinations are refused before registration, Print Screen only warns', async () => {
  await page.getByTestId('shortcut-change-recordWindow').click();
  await page.keyboard.press('Alt+F4');
  await expect(page.getByTestId('shortcut-problem-recordWindow')).toContainText('Alt+F4');
  await expect(page.getByTestId('shortcut-swap-recordWindow')).toHaveCount(0);
  await expect(value('recordWindow')).toBeHidden(); // still recording

  // Print Screen alone is allowed, with a heads-up that stays next to the shortcut.
  await page.keyboard.press('PrintScreen');
  await expect(value('recordWindow')).toContainText('PrintScreen');
  await expect(page.getByTestId('shortcut-note-recordWindow')).toContainText('Print Screen');
  await expect.poll(() => readSettings().shortcuts?.recordWindow).toBe('PrintScreen');
  await page.getByTestId('shortcut-default-recordWindow').click();
  await expect(page.getByTestId('shortcut-note-recordWindow')).toHaveCount(0);
});

test('the filter narrows the list by name or key, and says when nothing matches', async () => {
  const filter = page.getByTestId('shortcut-filter');
  await filter.fill('arrow');
  await expect(page.getByTestId('shortcut-row-toolArrow')).toBeVisible();
  await expect(page.getByTestId('shortcut-row-recordScreen')).toHaveCount(0);
  await filter.fill('ctrl+shift+9');
  await expect(page.getByTestId('shortcut-row-pauseRecording')).toBeVisible();
  await expect(page.getByTestId('shortcut-row-toolArrow')).toHaveCount(0);
  await filter.fill('zzzz');
  await expect(page.getByTestId('shortcut-no-match')).toBeVisible();
  await page.getByRole('button', { name: 'Clear filter' }).click();
  await expect(page.getByTestId('shortcut-row-recordScreen')).toBeVisible();
});

test('"Reset all shortcuts" puts back the global and the editor keys after a confirmation', async () => {
  // Change one of each.
  await page.getByTestId('shortcut-change-recordScreen').click();
  await page.keyboard.press('F9');
  await expect(value('recordScreen')).toContainText('F9');
  await page.getByTestId('shortcut-change-toolText').click();
  await page.keyboard.press('Y');
  await expect(value('toolText')).toContainText('Y');
  await expect.poll(() => readSettings().editorShortcuts?.toolText).toBe('Y');

  await page.getByTestId('reset-shortcuts').click();
  await expect(page.getByTestId('confirm-dialog')).toBeVisible();
  // Keeping the settings changes nothing.
  await page.getByTestId('confirm-no').click();
  await expect(value('recordScreen')).toContainText('F9');

  await page.getByTestId('reset-shortcuts').click();
  await page.getByTestId('confirm-yes').click();
  await expect(value('recordScreen')).toContainText('5');
  await expect(value('toolText')).toContainText('T');
  await expect.poll(() => readSettings().shortcuts?.recordScreen).toBe('Ctrl+Shift+5');
  expect(readSettings().editorShortcuts?.toolText).toBe('T');
});

test('editor keys: rebound in Settings, then they work in the editor (and the old ones do not)', async () => {
  // Arrow tool -> W (a bare key is fine for the editor).
  await page.getByTestId('shortcut-change-toolArrow').click();
  await page.keyboard.press('W');
  await expect(value('toolArrow')).toContainText('W');
  // A key another editor action holds: swap Select (V) and Rectangle (R).
  await page.getByTestId('shortcut-change-toolRect').click();
  await page.keyboard.press('V');
  await expect(page.getByTestId('shortcut-problem-toolRect')).toContainText('Select tool');
  await page.getByTestId('shortcut-swap-toolRect').click();
  await expect(value('toolRect')).toContainText('V');
  await expect(value('toolSelect')).toContainText('R');
  // Undo -> U.
  await page.getByTestId('shortcut-change-undo').click();
  await page.keyboard.press('U');
  await expect(value('undo')).toContainText('U');
  await expect
    .poll(() => readSettings().editorShortcuts)
    .toMatchObject({ toolArrow: 'W', toolRect: 'V', toolSelect: 'R', undo: 'U' });
  // The editor key that equals a global shortcut is refused, and so is a key the editor keeps.
  await page.getByTestId('shortcut-change-toolCrop').click();
  await page.keyboard.press('Control+Shift+3');
  await expect(page.getByTestId('shortcut-problem-toolCrop')).toContainText('global shortcut');
  await page.keyboard.press('Delete'); // turns the shortcut off (the recorder's own key)
  await expect(value('toolCrop')).toHaveText('Not set');
  await page.getByTestId('shortcut-default-toolCrop').click();
  await expect(value('toolCrop')).toContainText('C');

  // Into the editor.
  await page
    .getByRole('navigation', { name: 'Primary' })
    .getByRole('button', { name: 'Capture' })
    .click();
  await page.getByTestId('shot-screen').click();
  const editor = await editorPage(app);
  await expect(editor.getByTestId('editor-view')).toBeVisible();
  await editor.getByTestId('editor-canvas').click({ position: { x: 5, y: 5 } });

  const pressed = (tool: string) => editor.getByTestId(`tool-${tool}`);
  await editor.keyboard.press('w');
  await expect(pressed('arrow')).toHaveAttribute('aria-pressed', 'true');
  await editor.keyboard.press('v');
  await expect(pressed('rect')).toHaveAttribute('aria-pressed', 'true');
  await editor.keyboard.press('r');
  await expect(pressed('select')).toHaveAttribute('aria-pressed', 'true');
  // The old arrow key is unbound now: nothing changes.
  await editor.keyboard.press('w');
  await editor.keyboard.press('a');
  await expect(pressed('arrow')).toHaveAttribute('aria-pressed', 'true');
  // The toolbar tooltip and the help show the live keys.
  await editor.getByTestId('tool-arrow').hover();
  await expect(editor.getByRole('tooltip').first()).toContainText('W');
  await editor.mouse.move(600, 400);
  await editor.keyboard.press('?');
  await expect(editor.getByTestId('keyboard-help')).toContainText('Arrow tool');
  await expect(editor.getByTestId('keyboard-help').getByLabel('W', { exact: true })).toHaveCount(1);
  await editor.getByRole('button', { name: 'Close keyboard shortcuts' }).click();
  await expect(editor.getByTestId('keyboard-help')).toBeHidden();
});
