/**
 * Launch smoke test.
 *
 * Runs the Forge/Vite build output in .vite/build (via `electron .`) and NOT the packaged
 * Framelet.exe: the packaged build disables EnableNodeCliInspectArguments through Electron fuses,
 * and Playwright needs the inspect arguments to drive the app. The renderer is loaded the same way
 * as in a packaged build (file://, because MAIN_WINDOW_VITE_DEV_SERVER_URL is undefined in
 * `electron-forge package` output), so the production CSP and sandbox settings are exercised.
 * `npm run test:e2e` runs `electron-forge package` first to produce that output.
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

const projectRoot = path.resolve(__dirname, '..', '..');
let app: ElectronApplication;
let page: Page;
let userDataDir: string;

test.beforeAll(async () => {
  expect(
    fs.existsSync(path.join(projectRoot, '.vite', 'build', 'main.cjs')),
    'Run `electron-forge package` first (npm run test:e2e does this).',
  ).toBe(true);

  userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'framelet-e2e-'));
  app = await electron.launch({
    args: ['.'],
    cwd: projectRoot,
    env: { ...process.env, FRAMELET_USER_DATA_DIR: userDataDir },
  });
  page = await app.firstWindow();
  await page.waitForLoadState('domcontentloaded');
});

test.afterAll(async () => {
  await app?.close();
  if (userDataDir) fs.rmSync(userDataDir, { recursive: true, force: true });
});

test('opens a Framelet window loaded from file:// with the sidebar nav', async () => {
  await expect(page).toHaveTitle('Framelet');
  expect(page.url()).toMatch(/^file:\/\/.*\/renderer\/main_window\/index\.html/);

  const nav = page.getByRole('navigation', { name: 'Primary' });
  await expect(nav).toBeVisible();
  for (const name of ['Capture', 'History', 'Settings']) {
    await expect(nav.getByRole('button', { name })).toBeVisible();
  }
  await expect(nav.getByRole('button', { name: 'Capture' })).toHaveAttribute(
    'aria-current',
    'page',
  );
  await expect(
    page.getByRole('heading', { name: 'What would you like to capture?' }),
  ).toBeVisible();

  const window = await app.browserWindow(page);
  const size = await window.evaluate((win) => win.getSize());
  expect(size[0]).toBeGreaterThanOrEqual(860);
  expect(size[1]).toBeGreaterThanOrEqual(560);
});

test('capture buttons are present but unavailable in this build', async () => {
  const card = page.getByTestId('mode-screenshot');
  for (const name of ['Screen', 'Window', 'Region']) {
    await expect(card.getByRole('button', { name })).toHaveAttribute('aria-disabled', 'true');
  }
});

test('navigating to Settings shows About with the Electron version from app:getInfo', async () => {
  await page
    .getByRole('navigation', { name: 'Primary' })
    .getByRole('button', { name: 'Settings' })
    .click();
  await expect(page.getByRole('heading', { name: 'About' })).toBeVisible();

  const electronVersion = await app.evaluate(() => process.versions.electron);
  await expect(page.getByTestId('about-electron')).toHaveText(electronVersion ?? '');

  const result = await page.evaluate(() => window.framelet.invoke('app:getInfo'));
  expect(result).toMatchObject({
    ok: true,
    data: { electron: electronVersion, isPackaged: false },
  });
});

test('renderer has no Node access and a minimal bridge', async () => {
  const surface = await page.evaluate(() => ({
    require: typeof (window as unknown as { require?: unknown }).require,
    process: typeof (window as unknown as { process?: unknown }).process,
    ipcRenderer: typeof (window as unknown as { ipcRenderer?: unknown }).ipcRenderer,
    bridgeKeys: Object.keys(window.framelet).sort(),
  }));
  expect(surface.require).toBe('undefined');
  expect(surface.process).toBe('undefined');
  expect(surface.ipcRenderer).toBe('undefined');
  expect(surface.bridgeKeys).toEqual(['invoke', 'on']);
});

test('the bridge rejects channels outside the contract and bad payloads', async () => {
  const unknown = await page.evaluate(() =>
    (window.framelet.invoke as (channel: string) => Promise<unknown>)('not:a:channel'),
  );
  expect(unknown).toMatchObject({ ok: false, error: { code: 'UNKNOWN_CHANNEL' } });

  const prototypeKey = await page.evaluate(() =>
    (window.framelet.invoke as (channel: string) => Promise<unknown>)('toString'),
  );
  expect(prototypeKey).toMatchObject({ ok: false, error: { code: 'UNKNOWN_CHANNEL' } });

  const badPayload = await page.evaluate(() =>
    (window.framelet.invoke as (channel: string, payload: unknown) => Promise<unknown>)(
      'app:reportError',
      { source: 'window-error', message: 'x'.repeat(5000) },
    ),
  );
  expect(badPayload).toMatchObject({ ok: false, error: { code: 'INVALID_PAYLOAD' } });

  const unsubscribe = await page.evaluate(
    () => typeof window.framelet.on('app:themeChanged', () => {}),
  );
  expect(unsubscribe).toBe('function');
});

test('renderer errors are reported to the main-process log', async () => {
  const result = await page.evaluate(() =>
    window.framelet.invoke('app:reportError', {
      source: 'window-error',
      message: 'e2e-reported-error',
    }),
  );
  expect(result).toMatchObject({ ok: true });

  const logFile = path.join(userDataDir, 'logs', 'main.log');
  await expect
    .poll(() => (fs.existsSync(logFile) ? fs.readFileSync(logFile, 'utf8') : ''))
    .toContain('e2e-reported-error');
});

test('CSP blocks injected inline scripts', async () => {
  const outcome = await page.evaluate(async () => {
    const violations: string[] = [];
    document.addEventListener('securitypolicyviolation', (event) => {
      violations.push(event.violatedDirective);
    });
    const script = document.createElement('script');
    script.textContent = 'window.__cspProbe = "executed"';
    document.head.appendChild(script);
    await new Promise((resolve) => setTimeout(resolve, 100));
    return {
      executed: (window as unknown as { __cspProbe?: string }).__cspProbe === 'executed',
      violations,
    };
  });
  expect(outcome.executed).toBe(false);
  expect(outcome.violations.join(' ')).toContain('script-src');
});

test('production CSP is delivered with the document', async () => {
  const meta = await page.evaluate(() =>
    document.querySelector('meta[http-equiv="Content-Security-Policy"]')?.getAttribute('content'),
  );
  expect(meta).toContain("default-src 'none'");
  expect(meta).toContain("script-src 'self'");
});

test('navigation and window.open to foreign origins are blocked', async () => {
  const before = page.url();
  await page.evaluate(() => {
    window.location.href = 'https://example.invalid/';
  });
  await page.waitForTimeout(500);
  expect(page.url()).toBe(before);

  const windowsBefore = app.windows().length;
  await page.evaluate(() => window.open('https://example.invalid/', '_blank'));
  await page.waitForTimeout(500);
  expect(app.windows().length).toBe(windowsBefore);
});
