/**
 * Native verification of the desktop layer on the real host (production build, real Windows
 * shell): real OS-level key presses reach FrameCapt's global shortcuts, the real tray icon exists,
 * a hotkey held by another process is reported as a conflict, close-to-tray and the second launch
 * work, and an idle app uses (almost) no CPU. Needs an interactive Windows session. Evidence
 * (redacted JSON) goes to docs/evidence/phase08/.
 *
 * Keyboard safety: the only OS-level key presses are FrameCapt's own global shortcuts, and each is
 * sent only after the app reported that exact combination as registered ("ok"); a registered global
 * hotkey is consumed by FrameCapt and never reaches another application. Everything else is driven
 * through Playwright, not the keyboard.
 */
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
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
import { exitApp } from '../e2e/app-exit';
import { editorPage, expectEditorClosed } from '../e2e/editor-window';
import { writeEvidenceJson, evidenceDirFor } from './evidence';

const projectRoot = path.resolve(__dirname, '..', '..');
const evidenceDir = evidenceDirFor(projectRoot, 'phase08');
const fixtures = path.join(__dirname, 'fixtures');

const evidence: Record<string, unknown> = {};
function record(name: string, value: unknown): void {
  evidence[name] = value;
  writeEvidenceJson(evidenceDir, 'desktop-native.json', evidence);
}

interface Launched {
  app: ElectronApplication;
  page: Page;
  dir: string;
}

async function launch(options: { dir?: string; settings?: unknown } = {}): Promise<Launched> {
  expect(
    fs.existsSync(path.join(projectRoot, '.vite', 'build', 'main.cjs')),
    'Run `electron-forge package` first (npm run test:native does this).',
  ).toBe(true);
  const dir = options.dir ?? fs.mkdtempSync(path.join(os.tmpdir(), 'framecapt-native-desktop-'));
  if (options.settings !== undefined) {
    fs.writeFileSync(path.join(dir, 'settings.json'), JSON.stringify(options.settings));
  }
  const app = await electron.launch({
    args: ['.'],
    cwd: projectRoot,
    env: { ...process.env, FRAMECAPT_USER_DATA_DIR: dir },
  });
  const page = await app.firstWindow();
  await page.waitForLoadState('domcontentloaded');
  await expect(page.getByTestId('shot-region')).toBeVisible();
  return { app, page, dir };
}

/** Runs a PowerShell script file with an argument array (no shell). */
function powershell(script: string, args: string[]): ChildProcess {
  return spawn(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script, ...args],
    { shell: false, windowsHide: true, stdio: 'ignore' },
  );
}

function sendKeys(...keys: string[]): void {
  const result = spawnSync(
    'powershell.exe',
    [
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy',
      'Bypass',
      '-File',
      path.join(fixtures, 'send-keys.ps1'),
      ...keys,
    ],
    { shell: false, windowsHide: true, encoding: 'utf8' },
  );
  if (result.status !== 0) throw new Error(`send-keys failed: ${result.stderr} ${result.stdout}`);
}

async function shortcutStates(page: Page) {
  const result = await page.evaluate(() => window.framecapt.invoke('shortcuts:status'));
  if (!result.ok) throw new Error('shortcuts:status failed');
  return result.data;
}

function overlayPages(app: ElectronApplication): Page[] {
  return app.windows().filter((candidate) => candidate.url().includes('#/overlay'));
}

async function readyOverlays(app: ElectronApplication, count: number): Promise<Page[]> {
  let found: Page[] = [];
  await expect
    .poll(
      async () => {
        const ready: Page[] = [];
        for (const candidate of overlayPages(app)) {
          const root = candidate.locator('[data-testid="overlay-region"]');
          if ((await root.count()) && (await root.getAttribute('data-ready')) === 'true') {
            ready.push(candidate);
          }
        }
        found = ready;
        return ready.length;
      },
      { timeout: 20_000 },
    )
    .toBe(count);
  return found;
}

async function pressClosing(page: Page, key: string): Promise<void> {
  await page.keyboard.press(key).catch((error: unknown) => {
    if (!/closed/i.test(String(error))) throw error;
  });
}

async function windowState(app: ElectronApplication, page: Page) {
  const win = await app.browserWindow(page);
  return win.evaluate((w) => ({
    visible: w.isVisible(),
    focused: w.isFocused(),
    minimized: w.isMinimized(),
  }));
}

async function displayCount(app: ElectronApplication): Promise<number> {
  return app.evaluate(({ screen }) => screen.getAllDisplays().length);
}

const opened: Launched[] = [];
const children: ChildProcess[] = [];
async function start(options: Parameters<typeof launch>[0] = {}): Promise<Launched> {
  const launched = await launch(options);
  opened.push(launched);
  return launched;
}

test.describe.configure({ mode: 'serial' });

test.afterEach(async () => {
  for (const child of children.splice(0)) child.kill();
  for (const launched of opened.splice(0)) {
    await exitApp(launched.app);
    fs.rmSync(launched.dir, { recursive: true, force: true });
  }
});

test('(a) a real Ctrl+Shift+3 opens the region overlays; Esc closes them and focuses the main window', async () => {
  const { app, page } = await start();
  const states = await shortcutStates(page);
  expect(
    states.screenshotRegion,
    'Ctrl+Shift+3 is held by another app on this machine: the native test cannot press it safely',
  ).toMatchObject({ accelerator: 'Ctrl+Shift+3', status: 'ok' });
  const displays = await displayCount(app);

  const runs: { overlayMs: number; overlaysAfterEsc: number; stayedMinimized: boolean }[] = [];
  for (let run = 0; run < 3; run += 1) {
    // Another window in front: the shortcut must work "from anywhere", not only with FrameCapt focused.
    await (await app.browserWindow(page)).evaluate((w) => w.minimize());
    await expect.poll(async () => (await windowState(app, page)).minimized).toBe(true);
    const t0 = Date.now();
    sendKeys('ctrl', 'shift', '3');
    const overlays = await readyOverlays(app, displays);
    const overlayMs = Date.now() - t0;
    // The overlay of the first display has the keyboard: Esc cancels (sent to the page, not the OS).
    const first = overlays[0] as Page;
    await pressClosing(first, 'Escape');
    await expect.poll(() => overlayPages(app).length, { timeout: 10_000 }).toBe(0);
    // The window was minimized before: a cancelled capture leaves it as it was.
    expect((await windowState(app, page)).minimized).toBe(true);
    runs.push({ overlayMs, overlaysAfterEsc: overlayPages(app).length, stayedMinimized: true });
    await (
      await app.browserWindow(page)
    ).evaluate((w) => {
      w.restore();
      w.show();
      w.focus();
    });
    await expect.poll(async () => (await windowState(app, page)).visible).toBe(true);
  }

  // Main visible and focused: Esc must give the focus back to the main window and to the button.
  await page.getByTestId('shot-region').focus();
  const t1 = Date.now();
  sendKeys('ctrl', 'shift', '3');
  const overlays = await readyOverlays(app, displays);
  const overlayMsVisible = Date.now() - t1;
  await pressClosing(overlays[0] as Page, 'Escape');
  await expect.poll(() => overlayPages(app).length, { timeout: 10_000 }).toBe(0);
  await expect
    .poll(async () => (await windowState(app, page)).focused, { timeout: 5000 })
    .toBe(true);
  const focusedControl = await page.evaluate(
    () => (document.activeElement as HTMLElement | null)?.dataset.testid ?? '',
  );
  record('shortcutRegion', {
    shortcut: 'Ctrl+Shift+3 (OS-level SendInput)',
    displays,
    runsWithMainMinimized: runs,
    overlayVisibleMsMainFocused: overlayMsVisible,
    mainFocusedAfterEsc: true,
    focusedControlAfterEsc: focusedControl,
    note: 'overlayMs includes starting PowerShell for SendInput (about 0.3-0.6 s)',
  });
  expect(focusedControl).toBe('shot-region');
});

test('(b) keyboard-only region capture on the real display (arrow keys, Enter) opens the editor', async () => {
  const { app, page } = await start();
  const displays = await displayCount(app);
  expect((await shortcutStates(page)).screenshotRegion.status).toBe('ok');
  sendKeys('ctrl', 'shift', '3');
  const overlays = await readyOverlays(app, displays);
  const overlay = overlays[0] as Page;
  const root = overlay.getByTestId('overlay-region');
  const live = JSON.parse((await root.getAttribute('data-selection')) || 'null');
  expect(live).toBeNull();
  await overlay.keyboard.press('ArrowRight'); // starts the centered selection
  await overlay.keyboard.press('Alt+ArrowLeft');
  const label = await overlay.getByTestId('size-label').textContent();
  await pressClosing(overlay, 'Enter');
  await expect((await editorPage(app)).getByTestId('editor-view')).toBeVisible({ timeout: 20_000 });
  await expect((await editorPage(app)).getByTestId('editor-canvas')).toBeFocused();
  const dimensions = await (await editorPage(app)).getByTestId('editor-dimensions').textContent();
  expect(dimensions).toBe(label);
  record('keyboardRegionCapture', { selectionLabel: label, editorDimensions: dimensions });
  // Discard it: nothing is saved.
  const editor = await editorPage(app);
  await editor.getByTestId('editor-discard').click();
  await editor
    .getByTestId('confirm-yes')
    .click()
    .catch(() => undefined); // the window closes under the click
  await expectEditorClosed(app);
});

test('(c) a hotkey another process holds (RegisterHotKey) is reported as a conflict', async () => {
  const ready = path.join(os.tmpdir(), `framecapt-hotkey-${process.pid}.txt`);
  fs.rmSync(ready, { force: true });
  // Ctrl+Alt+Shift+F12: mask Alt=1 Ctrl=2 Shift=4, virtual key F12 = 0x7B.
  children.push(powershell(path.join(fixtures, 'hold-hotkey.ps1'), [ready, '7', '123']));
  await expect
    .poll(() => (fs.existsSync(ready) ? fs.readFileSync(ready, 'utf8') : ''), { timeout: 20_000 })
    .toMatch(/ok|fail/);
  expect(fs.readFileSync(ready, 'utf8'), 'the holder could not register the hotkey').toBe('ok');

  const { page } = await start({
    settings: { version: 1, shortcuts: { recordWindow: 'Ctrl+Alt+Shift+F12' } },
  });
  const states = await shortcutStates(page);
  record('conflict', {
    heldByOtherProcess: 'Ctrl+Alt+Shift+F12',
    framecapt: states.recordWindow,
    others: { screenshotRegion: states.screenshotRegion.status },
  });
  expect(states.recordWindow).toMatchObject({
    accelerator: 'Ctrl+Alt+Shift+F12',
    status: 'conflict',
  });
  await expect(page.getByTestId('shortcut-problems')).toContainText('1 shortcut is unavailable');
  await page.getByTestId('shortcut-problems-fix').click();
  await expect(page.getByTestId('shortcut-warning-recordWindow')).toHaveText(
    'Ctrl+Alt+Shift+F12 is used by another app — choose a different shortcut.',
  );
  fs.rmSync(ready, { force: true });
});

test('(d) the tray icon exists once; close-to-tray hides the window; a second launch shows it again', async () => {
  const { app, page, dir } = await start();
  const info = await page.evaluate(() => window.framecapt.invoke('app:getInfo'));
  if (!info.ok) throw new Error('app:getInfo failed');
  expect(info.data.tray.active).toBe(true);
  const log = fs.readFileSync(path.join(dir, 'logs', 'main.log'), 'utf8');
  const created = log.match(/Tray created \(instance \d+\)/g) ?? [];
  expect(created).toEqual(['Tray created (instance 1)']);

  // Closing hides: the process and the tray stay.
  const win = await app.browserWindow(page);
  await win.evaluate((w) => w.close());
  await expect.poll(async () => (await windowState(app, page)).visible).toBe(false);
  expect(await app.evaluate(({ app: electron }) => electron.isReady())).toBe(true);
  const after = await app.evaluate(() => process.pid);
  expect(after).toBeGreaterThan(0);

  // A second launch (same user data) exits at once and shows the first window.
  const second = await electron
    .launch({
      args: ['.'],
      cwd: projectRoot,
      env: { ...process.env, FRAMECAPT_USER_DATA_DIR: dir },
    })
    .catch(() => null);
  await second?.close().catch(() => undefined);
  await expect
    .poll(async () => (await windowState(app, page)).visible, { timeout: 10_000 })
    .toBe(true);
  const logAfter = fs.readFileSync(path.join(dir, 'logs', 'main.log'), 'utf8');
  expect((logAfter.match(/Tray created/g) ?? []).length).toBe(1);

  const stillInfo = await page.evaluate(() => window.framecapt.invoke('app:getInfo'));
  record('tray', {
    active: info.ok ? info.data.tray.active : false,
    bounds: info.ok ? info.data.tray.bounds : null,
    boundsNonEmpty: info.ok ? (info.data.tray.bounds?.width ?? 0) > 0 : false,
    createdLogLines: created.length,
    hiddenOnClose: true,
    shownBySecondLaunch: true,
    stillActiveAfter: stillInfo.ok ? stillInfo.data.tray.active : false,
  });
});

test('(e) idle CPU: 30 s of app metrics with every window open and the recorder worker present', async () => {
  const { app, page } = await start();
  // Wake the hidden worker the way a user does (a short real recording), so it exists while idle.
  const displays = await page.evaluate(() => window.framecapt.invoke('capture:listDisplays'));
  if (!displays.ok) throw new Error('capture:listDisplays failed');
  const primary = displays.data.find((display) => display.isPrimary) ?? displays.data[0];
  expect(primary).toBeDefined();
  const started = await page.evaluate(
    (displayId) =>
      window.framecapt.invoke('recorder:start', {
        target: 'screen',
        displayId,
        options: {
          mic: { enabled: false },
          systemAudio: false,
          quality: '1080p',
          fps: 30,
          countdown: false,
        },
      }),
    primary?.id ?? '',
  );
  expect(started.ok).toBe(true);
  await expect
    .poll(
      async () => {
        const state = await page.evaluate(() => window.framecapt.invoke('recorder:getState'));
        return state.ok ? state.data.status : 'unknown';
      },
      { timeout: 30_000 },
    )
    .toBe('recording');
  await page.waitForTimeout(1500);
  await page.evaluate(() => window.framecapt.invoke('recorder:stop'));
  await expect
    .poll(
      async () => {
        const state = await page.evaluate(() => window.framecapt.invoke('recorder:getState'));
        return state.ok ? state.data.status : 'unknown';
      },
      { timeout: 30_000 },
    )
    .toBe('completed');
  await page.evaluate(() => window.framecapt.invoke('recorder:reset'));
  const windowsOpen = await app.evaluate(
    ({ BrowserWindow }) => BrowserWindow.getAllWindows().length,
  );

  // Let everything settle, then sample the CPU of every process once a second.
  await page.waitForTimeout(8000);
  type Metric = {
    pid: number;
    type: string;
    cpu: { percentCPUUsage: number };
    memory: { workingSetSize: number };
  };
  const sample = (): Promise<Metric[]> =>
    app.evaluate(({ app: electron }) => electron.getAppMetrics() as unknown as Metric[]);
  await sample(); // the first reading covers the time since the app started: discard it
  const samples: Metric[][] = [];
  for (let second = 0; second < 30; second += 1) {
    await page.waitForTimeout(1000);
    samples.push(await sample());
  }
  const byProcess = new Map<number, { type: string; values: number[]; rss: number }>();
  for (const metrics of samples) {
    for (const metric of metrics) {
      const entry = byProcess.get(metric.pid) ?? { type: metric.type, values: [], rss: 0 };
      entry.values.push(metric.cpu.percentCPUUsage);
      entry.rss = metric.memory.workingSetSize;
      byProcess.set(metric.pid, entry);
    }
  }
  const rows = [...byProcess.entries()].map(([pid, entry]) => ({
    pid,
    type: entry.type,
    averagePercent: Number(
      (entry.values.reduce((a, b) => a + b, 0) / Math.max(1, entry.values.length)).toFixed(3),
    ),
    maxPercent: Number(Math.max(...entry.values).toFixed(2)),
    samples: entry.values.length,
    workingSetKB: entry.rss,
  }));
  const total = Number(rows.reduce((sum, row) => sum + row.averagePercent, 0).toFixed(3));
  record('idleCpu', {
    seconds: 30,
    windowsOpen,
    processes: rows,
    totalAveragePercentOfOneCore: total,
    note: 'percentCPUUsage per process, averaged over 30 one-second samples (Electron app.getAppMetrics)',
  });
  for (const row of rows) {
    expect(row.averagePercent, `${row.type} (${row.pid}) average CPU`).toBeLessThan(1);
  }
  expect(total).toBeLessThan(2);
});
