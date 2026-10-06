/**
 * Launch smoke test.
 *
 * Runs the Forge/Vite build output in .vite/build (via `electron .`) and NOT the packaged
 * FrameCapt.exe: the packaged build disables EnableNodeCliInspectArguments through Electron fuses,
 * and Playwright needs the inspect arguments to drive the app. The renderer is loaded the same way
 * as in a packaged build (app://framecapt, because MAIN_WINDOW_VITE_DEV_SERVER_URL is undefined in
 * `electron-forge package` output), so the production CSP and sandbox settings are exercised.
 * `npm run test:e2e` runs `scripts/package-e2e.mjs` (electron-forge package with the mock capture
 * provider compiled in) first to produce that output. This file does not set
 * FRAMECAPT_E2E_MOCK_CAPTURE, so it still uses the real provider.
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

  userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'framecapt-e2e-'));
  app = await electron.launch({
    args: ['.'],
    cwd: projectRoot,
    env: { ...process.env, FRAMECAPT_USER_DATA_DIR: userDataDir },
  });
  page = await app.firstWindow();
  await page.waitForLoadState('domcontentloaded');
});

test.afterAll(async () => {
  await app?.close();
  if (userDataDir) fs.rmSync(userDataDir, { recursive: true, force: true });
});

test('opens a FrameCapt window loaded from app://framecapt with the sidebar nav', async () => {
  await expect(page).toHaveTitle('FrameCapt');
  expect(page.url()).toMatch(/^app:\/\/framecapt\/index\.html/);

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

test('screenshot and record buttons are enabled', async () => {
  const shots = page.getByTestId('mode-screenshot');
  const record = page.getByTestId('mode-record');
  for (const name of ['Screen', 'Window', 'Region']) {
    await expect(shots.getByRole('button', { name, exact: true })).toBeEnabled();
    await expect(record.getByRole('button', { name })).toBeEnabled();
  }
});

test('navigating to Settings shows About with the Electron version from app:getInfo', async () => {
  await page
    .getByRole('navigation', { name: 'Primary' })
    .getByRole('button', { name: 'Settings' })
    .click();
  await page.getByTestId('settings-nav-about').click();
  await expect(page.getByRole('heading', { name: 'About' })).toBeVisible();

  const electronVersion = await app.evaluate(() => process.versions.electron);
  await expect(page.getByTestId('about-electron')).toHaveText(electronVersion ?? '');
  // No update feed is compiled in: said plainly, and nothing is ever checked.
  await expect(page.getByTestId('about-updates')).toHaveText('Not configured for this build');

  const result = await page.evaluate(() => window.framecapt.invoke('app:getInfo'));
  expect(result).toMatchObject({
    ok: true,
    data: { electron: electronVersion, isPackaged: false, updates: { state: 'unconfigured' } },
  });
});

test('Settings has a Capture diagnostics section with the recorder format probe', async () => {
  await page
    .getByRole('navigation', { name: 'Primary' })
    .getByRole('button', { name: 'Settings' })
    .click();
  await page.getByTestId('settings-nav-advanced').click();
  await expect(page.getByRole('heading', { name: 'Capture diagnostics' })).toBeVisible();
  await expect(page.getByTestId('diag-displays')).toBeAttached();
  await expect(page.getByTestId('rec-start')).toBeAttached();
  // The format list comes from MediaRecorder.isTypeSupported at runtime; WebM VP9/VP8 is expected
  // in every Chromium build, so a default must have been picked.
  await expect(page.getByTestId('format-default')).not.toContainText('none supported');
  await expect(page.getByTestId('diag-resources')).toHaveAttribute('data-live-tracks', '0');
});

test('capture grants are refused for unknown sources and malformed ids', async () => {
  const grant = await page.evaluate(() =>
    window.framecapt.invoke('capture:grant', { sourceId: 'screen:987654:0', systemAudio: false }),
  );
  expect(grant).toMatchObject({ ok: false, error: { code: 'NOT_FOUND' } });

  const badId = await page.evaluate(() =>
    (window.framecapt.invoke as (c: string, p: unknown) => Promise<unknown>)('capture:grant', {
      sourceId: '../etc',
      systemAudio: false,
    }),
  );
  expect(badId).toMatchObject({ ok: false, error: { code: 'INVALID_PAYLOAD' } });
});

test('renderer has no Node access and a minimal bridge', async () => {
  const surface = await page.evaluate(() => ({
    require: typeof (window as unknown as { require?: unknown }).require,
    process: typeof (window as unknown as { process?: unknown }).process,
    ipcRenderer: typeof (window as unknown as { ipcRenderer?: unknown }).ipcRenderer,
    bridgeKeys: Object.keys(window.framecapt).sort(),
  }));
  expect(surface.require).toBe('undefined');
  expect(surface.process).toBe('undefined');
  expect(surface.ipcRenderer).toBe('undefined');
  expect(surface.bridgeKeys).toEqual(['invoke', 'on']);
});

test('the bridge rejects channels outside the contract and bad payloads', async () => {
  const unknown = await page.evaluate(() =>
    (window.framecapt.invoke as (channel: string) => Promise<unknown>)('not:a:channel'),
  );
  expect(unknown).toMatchObject({ ok: false, error: { code: 'UNKNOWN_CHANNEL' } });

  const prototypeKey = await page.evaluate(() =>
    (window.framecapt.invoke as (channel: string) => Promise<unknown>)('toString'),
  );
  expect(prototypeKey).toMatchObject({ ok: false, error: { code: 'UNKNOWN_CHANNEL' } });

  const badPayload = await page.evaluate(() =>
    (window.framecapt.invoke as (channel: string, payload: unknown) => Promise<unknown>)(
      'app:reportError',
      { source: 'window-error', message: 'x'.repeat(5000) },
    ),
  );
  expect(badPayload).toMatchObject({ ok: false, error: { code: 'INVALID_PAYLOAD' } });

  const unsubscribe = await page.evaluate(
    () => typeof window.framecapt.on('app:themeChanged', () => {}),
  );
  expect(unsubscribe).toBe('function');
});

test('renderer errors are reported to the main-process log', async () => {
  const result = await page.evaluate(() =>
    window.framecapt.invoke('app:reportError', {
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

test('the app:// protocol serves the renderer and refuses everything else', async () => {
  const fetchFromMain = (url: string) =>
    app.evaluate(async ({ net }, target) => {
      const response = await net.fetch(target, { bypassCustomProtocolHandlers: false });
      return {
        status: response.status,
        type: response.headers.get('content-type'),
        csp: response.headers.get('content-security-policy'),
        sniff: response.headers.get('x-content-type-options'),
        size: (await response.arrayBuffer()).byteLength,
      };
    }, url);

  const entry = await fetchFromMain('app://framecapt/index.html');
  expect(entry).toMatchObject({ status: 200, type: 'text/html; charset=utf-8', sniff: 'nosniff' });
  expect(entry.csp).toContain("default-src 'none'");
  expect(entry.size).toBeGreaterThan(100);

  // A built asset (the script the page itself loaded) is served with its MIME type.
  const script = await page.evaluate(
    () => document.querySelector<HTMLScriptElement>('script[type="module"]')?.src ?? '',
  );
  expect(script).toMatch(/^app:\/\/framecapt\/assets\/.+\.js$/);
  expect(await fetchFromMain(script)).toMatchObject({
    status: 200,
    type: 'text/javascript; charset=utf-8',
  });

  // Everything else never reaches the file system: unknown types, traversal, other hosts.
  for (const [url, status] of [
    ['app://framecapt/main.cjs', 404],
    ['app://framecapt/assets/missing.js', 404],
    ['app://framecapt/..%2f..%2fmain.cjs', 400],
    // Chromium folds %2e%2e into the URL path before the handler runs: /preload.cjs, not a served type.
    ['app://framecapt/%2e%2e/preload.cjs', 404],
    ['app://framecapt/assets/..%5c..%5cmain.js', 400],
    ['app://other/index.html', 404],
  ] as const) {
    expect(await fetchFromMain(url), url).toMatchObject({ status });
  }
});
