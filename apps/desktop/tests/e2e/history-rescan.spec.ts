/**
 * "Find existing captures" end to end (E2E build, mock capture): a capture file that is in the
 * output folder but not in history is added by the button, from the empty History page and again
 * from the toolbar (which then finds nothing new). The file itself is never touched.
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
import { mockScreenshotPng } from './history-fixtures';

const projectRoot = path.resolve(__dirname, '..', '..');
const NAME = 'FrameCapt 2026-10-02 at 14.05.09.png';

let app: ElectronApplication;
let page: Page;
let userDataDir: string;

test.beforeAll(async () => {
  expect(
    fs.existsSync(path.join(projectRoot, '.vite', 'build', 'main.cjs')),
    'Run `npm run package:e2e` first (npm run test:e2e does this).',
  ).toBe(true);
  userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'framecapt-e2e-rescan-'));
  app = await electron.launch({
    args: ['.'],
    cwd: projectRoot,
    env: {
      ...process.env,
      FRAMECAPT_USER_DATA_DIR: userDataDir,
      FRAMECAPT_E2E_MOCK_CAPTURE: '1',
      FRAMECAPT_E2E_MOCK_DISPLAYS: '1',
    },
  });
  page = await app.firstWindow();
  await page.waitForLoadState('domcontentloaded');
  await expect(page.getByTestId('shot-screen')).toBeVisible();
});

test.afterAll(async () => {
  if (app) await exitApp(app);
  if (userDataDir) fs.rmSync(userDataDir, { recursive: true, force: true });
});

test('Find existing captures adds a file from the output folder, once', async () => {
  // The first-run rescan has already looked at the (empty) folders; this file appears afterwards.
  const folder = path.join(userDataDir, 'pictures', 'FrameCapt');
  fs.mkdirSync(folder, { recursive: true });
  const file = path.join(folder, NAME);
  const bytes = mockScreenshotPng(320, 200, 1);
  fs.writeFileSync(file, bytes);

  await page
    .getByRole('navigation', { name: 'Primary' })
    .getByRole('button', { name: 'History' })
    .click();
  await expect(page.getByText('Your captures will appear here')).toBeVisible();
  await page.getByTestId('history-empty-find').click();
  await expect(page.getByText('Added 1 capture')).toBeVisible();
  await expect(page.getByTestId('history-item')).toHaveCount(1);

  await page.getByTestId('history-find-existing').click();
  await expect(page.getByText('No new captures found')).toBeVisible();
  await expect(page.getByTestId('history-item')).toHaveCount(1);
  expect(fs.readFileSync(file).equals(bytes)).toBe(true);
});
