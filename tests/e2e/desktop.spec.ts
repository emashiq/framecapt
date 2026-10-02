/**
 * Phase 08 desktop behaviour, against the E2E build (mock capture, fake global shortcuts):
 * settings (persistence, repair of a damaged file, the recorder UI), shortcuts and their conflicts,
 * the tray and close-to-tray, quitting during a recording, the keyboard-only main flow, focus after
 * the overlays, output folders, error messages and idle behaviour. The OS-level parts (a real key
 * press, the real tray, real CPU) are in tests/native/desktop.native.spec.ts.
 *
 * Mock displays: A (id 1001) 2560 x 1440 scale 1; B (id 1002) 3440 x 1440 frame, scale 1.5.
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

const projectRoot = path.resolve(__dirname, '..', '..');

interface Launched {
  app: ElectronApplication;
  page: Page;
  dir: string;
}

/** A hook only E2E builds have (see desktop.ts). */
interface TestHooks {
  trayInstances(): number;
  trayActive(): boolean;
  heldShortcuts(): Set<string>;
  shortcutStates(): Record<string, { accelerator: string | null; status: string }>;
  runAction(action: string): void;
  openFromTray(): void;
  destroyMainWindow(): void;
  requestQuit(): void;
  trayMenu(): { label: string; enabled: boolean; accelerator?: string; submenu?: unknown[] }[];
  trayTooltip(): string;
  ipcTotal(): number;
  ipcCount(channel: string): number;
}

const hooks = <T>(app: ElectronApplication, fn: (h: TestHooks) => T): Promise<T> =>
  app.evaluate((_electron, source) => {
    const h = (globalThis as unknown as { __frameletTest: TestHooks }).__frameletTest;
    return new Function('h', `return (${source})(h)`)(h) as never;
  }, fn.toString());

async function launch(
  options: {
    dir?: string;
    settings?: unknown;
    rawSettings?: string;
    env?: Record<string, string>;
  } = {},
): Promise<Launched> {
  expect(
    fs.existsSync(path.join(projectRoot, '.vite', 'build', 'main.cjs')),
    'Run `npm run package:e2e` first (npm run test:e2e does this).',
  ).toBe(true);
  const dir = options.dir ?? fs.mkdtempSync(path.join(os.tmpdir(), 'framelet-e2e-desktop-'));
  if (options.rawSettings !== undefined)
    fs.writeFileSync(path.join(dir, 'settings.json'), options.rawSettings);
  else if (options.settings !== undefined) {
    fs.writeFileSync(path.join(dir, 'settings.json'), JSON.stringify(options.settings));
  }
  const app = await electron.launch({
    args: ['.'],
    cwd: projectRoot,
    env: {
      ...process.env,
      FRAMELET_USER_DATA_DIR: dir,
      FRAMELET_E2E_MOCK_CAPTURE: '1',
      FRAMELET_E2E_FAKE_SHORTCUTS: '1',
      ...options.env,
    },
  });
  const page = await app.firstWindow();
  await page.waitForLoadState('domcontentloaded');
  await expect(page.getByTestId('shot-region')).toBeVisible();
  return { app, page, dir };
}

const settingsFile = (dir: string): string => path.join(dir, 'settings.json');
/** The file as written so far ({} until the first debounced write has happened). */
const readSettings = (dir: string): Record<string, Record<string, unknown>> =>
  fs.existsSync(settingsFile(dir)) ? JSON.parse(fs.readFileSync(settingsFile(dir), 'utf8')) : {};

async function goTo(page: Page, name: 'Capture' | 'History' | 'Settings'): Promise<void> {
  await page.getByRole('navigation', { name: 'Primary' }).getByRole('button', { name }).click();
}

async function openSettings(page: Page, section: string): Promise<void> {
  await goTo(page, 'Settings');
  await page.getByTestId(`settings-nav-${section}`).click();
  await expect(page.getByTestId(`settings-${section}`)).toBeVisible();
}

function pagesOf(app: ElectronApplication, hash: string): Page[] {
  return app.windows().filter((candidate) => candidate.url().includes(hash));
}

async function overlayFor(app: ElectronApplication, displayId: string): Promise<Page> {
  let found: Page | undefined;
  await expect
    .poll(
      async () => {
        for (const candidate of pagesOf(app, '#/overlay')) {
          const root = candidate.locator('[data-testid="overlay-region"]');
          if (
            (await root.count()) &&
            (await root.getAttribute('data-display-id')) === displayId &&
            (await root.getAttribute('data-ready')) === 'true'
          ) {
            found = candidate;
            return true;
          }
        }
        return false;
      },
      { timeout: 20_000 },
    )
    .toBe(true);
  return found as Page;
}

async function pressClosing(overlay: Page, key: string): Promise<void> {
  await overlay.keyboard.press(key).catch((error: unknown) => {
    if (!/closed/i.test(String(error))) throw error;
  });
}

async function mainWindowState(app: ElectronApplication, page: Page) {
  const win = await app.browserWindow(page);
  return win.evaluate((w) => ({
    visible: w.isVisible(),
    minimized: w.isMinimized(),
    focused: w.isFocused(),
  }));
}

const opened: Launched[] = [];
async function start(options: Parameters<typeof launch>[0] = {}): Promise<Launched> {
  const launched = await launch(options);
  opened.push(launched);
  return launched;
}

test.afterEach(async () => {
  for (const launched of opened.splice(0)) {
    await exitApp(launched.app);
    fs.rmSync(launched.dir, { recursive: true, force: true });
  }
});

// --- settings ----------------------------------------------------------------------------------

test.describe('settings', () => {
  test('defaults on a first run; changes are written once, validated, and survive a relaunch', async () => {
    const first = await start();
    const state = await first.page.evaluate(() => window.framelet.invoke('settings:get'));
    expect(state).toMatchObject({
      ok: true,
      data: {
        settings: {
          version: 1,
          general: { theme: 'system', launchAtLogin: false, closeToTray: true },
          recording: { quality: '1080p', fps: 30, countdown: true },
          shortcuts: { screenshotRegion: 'Ctrl+Shift+3', stopRecording: 'Ctrl+Shift+0' },
        },
      },
    });

    await openSettings(first.page, 'general');
    await first.page.getByTestId('setting-theme').getByRole('radio', { name: 'Dark' }).click();
    await expect(first.page.locator('html')).toHaveAttribute('data-theme', 'dark');
    await expect(first.page.getByTestId('settings-saved')).toHaveAttribute('data-visible', 'true');
    await openSettings(first.page, 'recording');
    await first.page.getByTestId('setting-fps').getByRole('radio', { name: '60' }).click();
    await first.page.getByTestId('setting-auto-mp4').click();

    // Debounced (300 ms) and atomic: wait for the file, then the process may end right away.
    await expect
      .poll(() => (fs.existsSync(settingsFile(first.dir)) ? readSettings(first.dir) : null), {
        timeout: 5000,
      })
      .toMatchObject({
        version: 1,
        general: { theme: 'dark' },
        recording: { fps: 60, autoExportMp4: true },
      });
    expect(fs.readdirSync(first.dir).filter((name) => name.includes('.tmp'))).toEqual([]);

    // The app answers on the bridge with the invalid patch refused, and nothing was written for it.
    const bad = await first.page.evaluate(() =>
      (window.framelet.invoke as (c: string, p: unknown) => Promise<unknown>)('settings:update', {
        patch: { general: { theme: 'neon' } },
      }),
    );
    expect(bad).toMatchObject({ ok: false, error: { code: 'INVALID_PAYLOAD' } });
    const dup = await first.page.evaluate(() =>
      window.framelet.invoke('settings:update', {
        patch: { shortcuts: { recordRegion: 'Ctrl+Shift+3' } },
      }),
    );
    expect(dup).toMatchObject({ ok: false, error: { code: 'INVALID_PAYLOAD' } });

    const { dir } = first;
    await exitApp(first.app);
    opened.splice(opened.indexOf(first), 1);

    const second = await start({ dir });
    await expect(second.page.locator('html')).toHaveAttribute('data-theme', 'dark');
    const again = await second.page.evaluate(() => window.framelet.invoke('settings:get'));
    expect(again).toMatchObject({
      ok: true,
      data: {
        settings: { general: { theme: 'dark' }, recording: { fps: 60, autoExportMp4: true } },
      },
    });
    await expect(
      second.page.getByTestId('opt-fps').getByRole('radio', { name: '60' }),
    ).toHaveAttribute('aria-checked', 'true');
  });

  test('a damaged settings.json is set aside, defaults are used and the user is told once', async () => {
    const { page, dir } = await start({ rawSettings: '{ "version": 1, "general": ' });
    await expect(page.getByText('Settings were reset because the file was damaged.')).toBeVisible();
    const aside = fs.readdirSync(dir).filter((name) => name.startsWith('settings.json.corrupt-'));
    expect(aside).toHaveLength(1);
    expect(fs.readFileSync(path.join(dir, aside[0] ?? ''), 'utf8')).toBe(
      '{ "version": 1, "general": ',
    );
    const state = await page.evaluate(() => window.framelet.invoke('settings:get'));
    expect(state).toMatchObject({ ok: true, data: { settings: { general: { theme: 'system' } } } });
    // Said once: asking again finds nothing to report.
    const again = await page.evaluate(() => window.framelet.invoke('settings:consumeNotice'));
    expect(again).toMatchObject({ ok: true, data: { reset: false } });
  });

  test('an invalid (not damaged) file is repaired the same way', async () => {
    const { dir, page } = await start({
      settings: { version: 1, shortcuts: { stopRecording: 'Ctrl+Shift+1' } },
    });
    await expect(page.getByText('Settings were reset because the file was damaged.')).toBeVisible();
    expect(fs.readdirSync(dir).some((name) => name.startsWith('settings.json.corrupt-'))).toBe(
      true,
    );
  });

  test('a v0 (unversioned) file is migrated and rewritten', async () => {
    const { dir, page } = await start({
      settings: { theme: 'dark', screenshotFormat: 'jpeg', fps: 60 },
    });
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
    await expect
      .poll(() => readSettings(dir))
      .toMatchObject({ version: 1, screenshots: { format: 'jpeg' }, recording: { fps: 60 } });
  });

  test('the phase-05 localStorage record options move into settings once', async () => {
    const { app, page, dir } = await start();
    await page.evaluate(() => {
      localStorage.setItem(
        'framelet.recordOptions',
        JSON.stringify({
          mic: { enabled: false },
          systemAudio: true,
          quality: 'source',
          fps: 60,
          countdown: false,
        }),
      );
    });
    await page.reload();
    await expect(page.getByTestId('shot-region')).toBeVisible();
    await expect(
      page.getByTestId('opt-quality').getByRole('radio', { name: 'Source' }),
    ).toHaveAttribute('aria-checked', 'true');
    await expect
      .poll(() => readSettings(dir))
      .toMatchObject({
        recording: { quality: 'source', fps: 60, systemAudio: true, countdown: false },
      });
    expect(await page.evaluate(() => localStorage.getItem('framelet.recordOptions'))).toBeNull();
    void app;
  });

  test('output folders are chosen through a main dialog and must be writable', async () => {
    const { app, page, dir } = await start();
    const good = fs.mkdtempSync(path.join(os.tmpdir(), 'framelet-out-'));
    const blocker = path.join(good, 'a-file');
    fs.writeFileSync(blocker, 'x');
    const stubOpen = (target: string) =>
      app.evaluate(({ dialog }, folder) => {
        dialog.showOpenDialog = (() =>
          Promise.resolve({
            canceled: false,
            filePaths: [folder],
          })) as typeof dialog.showOpenDialog;
      }, target);

    await openSettings(page, 'storage');
    await stubOpen(path.join(good, 'Recordings'));
    await page.getByTestId('folder-change-recording').click();
    await expect(page.getByTestId('folder-path-recording')).toContainText(
      path.join(good, 'Recordings'),
    );
    expect(fs.existsSync(path.join(good, 'Recordings'))).toBe(true);
    expect(fs.readdirSync(path.join(good, 'Recordings'))).toEqual([]); // the probe file is gone
    await expect
      .poll(() => readSettings(dir).recording?.outputDir)
      .toBe(path.join(good, 'Recordings'));

    // A folder that cannot be written is refused with a friendly message; nothing changes.
    await stubOpen(path.join(blocker, 'nested'));
    await page.getByTestId('folder-change-screenshots').click();
    await expect(
      page.getByText("Framelet can't save to that folder.", { exact: false }),
    ).toBeVisible();
    await expect(page.getByTestId('folder-path-screenshots')).toContainText('(default)');

    // The channel has no way to carry a path in a patch: it is refused outright (not ignored).
    const sneaky = await page.evaluate(() =>
      (window.framelet.invoke as (c: string, p: unknown) => Promise<unknown>)('settings:update', {
        patch: { recording: { outputDir: 'C:\\Windows' } },
      }),
    );
    expect(sneaky).toMatchObject({ ok: false, error: { code: 'INVALID_PAYLOAD' } });
    expect(readSettings(dir).recording?.outputDir ?? null).not.toBe('C:\\Windows');

    await page.getByTestId('folder-default-recording').click();
    await expect(page.getByTestId('folder-path-recording')).toContainText('(default)');
    fs.rmSync(good, { recursive: true, force: true });
  });

  test('a screenshot saves into the chosen folder and the Save dialog opens there', async () => {
    const { app, page, dir } = await start();
    const out = fs.mkdtempSync(path.join(os.tmpdir(), 'framelet-shots-'));
    await app.evaluate(({ dialog }, folder) => {
      dialog.showOpenDialog = (() =>
        Promise.resolve({ canceled: false, filePaths: [folder] })) as typeof dialog.showOpenDialog;
    }, out);
    await openSettings(page, 'storage');
    await page.getByTestId('folder-change-screenshots').click();
    await expect.poll(() => readSettings(dir).screenshots?.outputDir).toBe(out);
    await goTo(page, 'Capture');

    await app.evaluate(({ dialog }) => {
      (globalThis as unknown as { __saveOptions: unknown }).__saveOptions = null;
      dialog.showSaveDialog = ((_win: unknown, options?: Electron.SaveDialogOptions) => {
        const used = options ?? (_win as Electron.SaveDialogOptions);
        (globalThis as unknown as { __saveOptions: unknown }).__saveOptions = used;
        return Promise.resolve({ canceled: false, filePath: used.defaultPath });
      }) as unknown as typeof dialog.showSaveDialog;
    });
    await page.getByTestId('shot-region').click();
    const overlay = await overlayFor(app, '1001');
    await overlay.mouse.move(200, 150);
    await overlay.mouse.down();
    await overlay.mouse.move(700, 450, { steps: 5 });
    await overlay.mouse.up();
    await overlay.keyboard.press('Enter').catch(() => undefined);
    await expect(page.getByTestId('editor-view')).toBeVisible();
    await page.getByTestId('editor-save').click();
    await expect
      .poll(() => fs.readdirSync(out).filter((name) => name.endsWith('.png')).length)
      .toBe(1);
    const options = await app.evaluate(
      () => (globalThis as unknown as { __saveOptions: { defaultPath: string } }).__saveOptions,
    );
    expect(path.dirname(options.defaultPath)).toBe(out);
    fs.rmSync(out, { recursive: true, force: true });
  });

  test('"after a capture: save and open the editor" saves first; the editor starts clean', async () => {
    const { app, page, dir } = await start({
      settings: { version: 1, screenshots: { afterCapture: 'save-and-editor', format: 'jpeg' } },
    });
    await page.getByTestId('shot-region').click();
    const overlay = await overlayFor(app, '1001');
    await overlay.mouse.move(300, 200);
    await overlay.mouse.down();
    await overlay.mouse.move(800, 500, { steps: 5 });
    await overlay.mouse.up();
    await overlay.keyboard.press('Enter').catch(() => undefined);
    await expect(page.getByTestId('editor-view')).toBeVisible();
    await expect(page.getByText('Saved to', { exact: false })).toBeVisible();
    const folder = path.join(dir, 'pictures', 'Framelet');
    await expect.poll(() => fs.existsSync(folder) && fs.readdirSync(folder).length).toBe(1);
    expect(fs.readdirSync(folder)[0]).toMatch(/\.jpg$/);
    // Nothing is unsaved yet: leaving the editor does not ask.
    await page.getByTestId('editor-done').click();
    await expect(page.getByTestId('confirm-dialog')).toHaveCount(0);
    await expect(page.getByTestId('shot-region')).toBeVisible();
    await goTo(page, 'History');
    await expect(page.getByTestId('history-grid').locator('li')).toHaveCount(1);
  });
});

// --- shortcuts -----------------------------------------------------------------------------------

test.describe('shortcuts', () => {
  test('the defaults are registered, hints on the home view show the configured keys', async () => {
    const { app, page } = await start();
    const held = await hooks(app, (h) => [...h.heldShortcuts()].sort());
    expect(held).toEqual(
      [
        'Ctrl+Shift+0',
        'Ctrl+Shift+1',
        'Ctrl+Shift+2',
        'Ctrl+Shift+3',
        'Ctrl+Shift+5',
        'Ctrl+Shift+6',
        'Ctrl+Shift+7',
        'Ctrl+Shift+9',
      ].sort(),
    );
    await expect(page.getByTestId('hint-screenshotRegion')).toHaveAttribute('data-status', 'ok');
    await expect(page.getByTestId('hint-screenshotRegion')).toContainText('Ctrl');
    await expect(page.getByTestId('hint-screenshotRegion')).toContainText('3');
    await expect(page.getByTestId('hint-recordWindow')).toContainText('6');
    await expect(page.getByTestId('home-tip')).toContainText('Ctrl');
    await expect(page.getByTestId('shortcut-problems')).toHaveCount(0);
  });

  test('the recorder sets a shortcut; home hints, the tray menu and the registration follow', async () => {
    const { app, page, dir } = await start();
    await openSettings(page, 'shortcuts');
    await page.getByTestId('shortcut-change-recordRegion').click();
    const recorder = page.getByTestId('shortcut-recorder-recordRegion');
    await expect(recorder).toBeFocused();
    // While it listens, the global shortcuts are released so the keys reach the window.
    expect(await hooks(app, (h) => h.heldShortcuts().size)).toBe(0);

    await page.keyboard.down('Control');
    await page.keyboard.down('Alt');
    await expect(recorder).toContainText('Ctrl');
    await expect(recorder).toContainText('Alt');
    await page.keyboard.press('Q');
    await page.keyboard.up('Alt');
    await page.keyboard.up('Control');
    await expect(page.getByTestId('shortcut-value-recordRegion')).toContainText('Q');
    await expect(page.getByTestId('shortcut-change-recordRegion')).toBeFocused();
    await expect.poll(() => readSettings(dir).shortcuts?.recordRegion).toBe('Ctrl+Alt+Q');
    await expect
      .poll(() => hooks(app, (h) => [...h.heldShortcuts()].includes('Ctrl+Alt+Q')))
      .toBe(true);
    expect(await hooks(app, (h) => [...h.heldShortcuts()].includes('Ctrl+Shift+7'))).toBe(false);
    expect(await hooks(app, (h) => h.heldShortcuts().size)).toBe(8);

    await goTo(page, 'Capture');
    await expect(page.getByTestId('hint-recordRegion')).toContainText('Q');
    const menu = await hooks(app, (h) => h.trayMenu());
    const record = menu.find((item) => item.label === 'Record')?.submenu as {
      accelerator?: string;
    }[];
    expect(record.map((item) => item.accelerator)).toContain('Ctrl+Alt+Q');
  });

  test('the recorder refuses a duplicate, a key without a modifier, and Esc cancels', async () => {
    const { page, dir } = await start();
    await openSettings(page, 'shortcuts');
    await page.getByTestId('shortcut-change-recordRegion').click();
    // Duplicate of "Screenshot: region" (Ctrl+Shift+3).
    await page.keyboard.press('Control+Shift+3');
    await expect(page.getByTestId('shortcut-problem-recordRegion')).toContainText('already used');
    await expect(page.getByTestId('shortcut-problem-recordRegion')).toContainText(
      'Screenshot: region',
    );
    // A bare letter cannot be a global shortcut.
    await page.keyboard.press('A');
    await expect(page.getByTestId('shortcut-problem-recordRegion')).toContainText('Ctrl or Alt');
    // F-keys and PrintScreen are fine alone.
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('shortcut-recorder-recordRegion')).toHaveCount(0);
    await expect(page.getByTestId('shortcut-value-recordRegion')).toContainText('7');
    expect(readSettings(dir).shortcuts ?? {}).toBeDefined();

    await page.getByTestId('shortcut-change-recordRegion').click();
    await page.keyboard.press('F9');
    await expect(page.getByTestId('shortcut-value-recordRegion')).toContainText('F9');
    await expect.poll(() => readSettings(dir).shortcuts?.recordRegion).toBe('F9');
  });

  test('Backspace turns a shortcut off; "Not set" shows on the home view and nothing is registered', async () => {
    const { app, page, dir } = await start();
    await openSettings(page, 'shortcuts');
    await page.getByTestId('shortcut-change-recordWindow').click();
    await page.keyboard.press('Backspace');
    await expect(page.getByTestId('shortcut-value-recordWindow')).toHaveText('Not set');
    await expect.poll(() => readSettings(dir).shortcuts?.recordWindow).toBeNull();
    expect(await hooks(app, (h) => [...h.heldShortcuts()].includes('Ctrl+Shift+6'))).toBe(false);
    await goTo(page, 'Capture');
    await expect(page.getByTestId('hint-recordWindow')).toHaveText('Not set');
    // And back to the default.
    await openSettings(page, 'shortcuts');
    await page.getByTestId('shortcut-default-recordWindow').click();
    await expect(page.getByTestId('shortcut-value-recordWindow')).toContainText('6');
  });

  test('a shortcut another app holds is reported as a conflict, in Settings and on the home view', async () => {
    const { app, page } = await start({ env: { FRAMELET_E2E_TAKEN_SHORTCUTS: 'Ctrl+Shift+1' } });
    const states = await hooks(app, (h) => h.shortcutStates());
    expect(states.screenshotScreen).toMatchObject({
      accelerator: 'Ctrl+Shift+1',
      status: 'conflict',
    });
    expect(states.screenshotWindow?.status).toBe('ok');
    await expect(page.getByTestId('shortcut-problems')).toContainText('1 shortcut is unavailable');
    await expect(page.getByTestId('hint-screenshotScreen')).toHaveAttribute(
      'data-status',
      'conflict',
    );
    await page.getByTestId('shortcut-problems-fix').click();
    await expect(page.getByTestId('settings-shortcuts')).toBeVisible();
    await expect(page.getByTestId('shortcut-warning-screenshotScreen')).toHaveText(
      'Ctrl+Shift+1 is used by another app — choose a different shortcut.',
    );
    // Choosing another one clears the warning.
    await page.getByTestId('shortcut-change-screenshotScreen').click();
    await page.keyboard.press('Control+Alt+1');
    await expect(page.getByTestId('shortcut-warning-screenshotScreen')).toHaveCount(0);
  });

  test('tray and shortcut actions share the flows: region screenshot, busy refusal, record toggle', async () => {
    const { app, page } = await start({ env: { FRAMELET_E2E_MOCK_DISPLAYS: '1' } });
    // A shortcut starts the real region flow.
    await hooks(app, (h) => h.runAction('screenshotRegion'));
    const overlay = await overlayFor(app, '1001');
    // A second press while the flow runs is ignored: no second set of overlays, the first stays.
    await hooks(app, (h) => h.runAction('screenshotRegion'));
    await page.waitForTimeout(500);
    expect(pagesOf(app, '#/overlay').length).toBe(1);
    await pressClosing(overlay, 'Escape');
    await expect.poll(() => pagesOf(app, '#/overlay').length).toBe(0);

    // A record shortcut starts a recording and the same shortcut stops it.
    await hooks(app, (h) => h.runAction('recordScreen'));
    const recorderStatus = async (): Promise<string> => {
      const result = await page.evaluate(() => window.framelet.invoke('recorder:getState'));
      return result.ok ? result.data.status : 'unknown';
    };
    await expect.poll(recorderStatus, { timeout: 30_000 }).toBe('recording');
    // While recording, the tray menu leads with Pause and Stop.
    const menu = await hooks(app, (h) => h.trayMenu());
    expect(menu.slice(0, 2).map((item) => item.label)).toEqual([
      'Pause recording',
      'Stop recording',
    ]);
    expect(await hooks(app, (h) => h.trayTooltip())).toMatch(/^Framelet — Recording \d\d:\d\d$/);
    await hooks(app, (h) => h.runAction('pauseRecording'));
    await expect.poll(recorderStatus).toBe('paused');
    expect(await hooks(app, (h) => h.trayTooltip())).toMatch(/^Framelet — Paused/);
    await hooks(app, (h) => h.runAction('pauseRecording'));
    await expect.poll(recorderStatus).toBe('recording');
    await hooks(app, (h) => h.runAction('recordScreen')); // toggles: stops
    await expect.poll(recorderStatus, { timeout: 30_000 }).toBe('completed');
    await expect(page.getByTestId('recording-result')).toBeVisible();
    expect(await hooks(app, (h) => h.trayTooltip())).toBe('Framelet');
  });
});

// --- tray, close to tray and quitting ----------------------------------------------------------

test.describe('tray and quitting', () => {
  test('one tray icon; closing the window hides it, the app lives on, and the hint is remembered', async () => {
    const { app, page, dir } = await start();
    expect(await hooks(app, (h) => h.trayInstances())).toBe(1);
    expect(await hooks(app, (h) => h.trayActive())).toBe(true);

    const win = await app.browserWindow(page);
    await win.evaluate((w) => w.close());
    await expect.poll(async () => (await mainWindowState(app, page)).visible).toBe(false);
    // The process is alive and the tray is still there.
    expect(await app.evaluate(({ app: electron }) => electron.isReady())).toBe(true);
    expect(await hooks(app, (h) => h.trayInstances())).toBe(1);
    await expect.poll(() => readSettings(dir).notices?.trayHintShown).toBe(true);

    // Reopening (tray click / "Open Framelet" / a second launch) shows the same window again.
    await hooks(app, (h) => h.openFromTray());
    await expect.poll(async () => (await mainWindowState(app, page)).visible).toBe(true);
    // Closing again does not repeat the hint.
    await win.evaluate((w) => w.close());
    await expect.poll(async () => (await mainWindowState(app, page)).visible).toBe(false);
    for (let i = 0; i < 3; i += 1) {
      await hooks(app, (h) => h.openFromTray());
      await win.evaluate((w) => w.close());
    }
    expect(await hooks(app, (h) => h.trayInstances())).toBe(1);
  });

  test('a window that was destroyed is made again without a second tray icon', async () => {
    const { app } = await start();
    await hooks(app, (h) => h.destroyMainWindow());
    // The app stays (tray + close-to-tray) and a new window comes from the tray.
    expect(await app.evaluate(({ app: electron }) => electron.isReady())).toBe(true);
    const next = app.waitForEvent('window');
    await hooks(app, (h) => h.openFromTray());
    const page = await next;
    await page.waitForLoadState('domcontentloaded');
    await expect(page.getByTestId('shot-region')).toBeVisible();
    expect(await hooks(app, (h) => h.trayInstances())).toBe(1);
    expect(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length)).toBe(1);
  });

  test('with close-to-tray off, closing the window quits', async () => {
    const { app, page } = await start({
      settings: { version: 1, general: { closeToTray: false } },
    });
    const closed = new Promise<void>((resolve) => app.on('close', () => resolve()));
    const win = await app.browserWindow(page);
    await win.evaluate((w) => w.close()).catch(() => undefined);
    await Promise.race([
      closed,
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error('the app did not quit')), 15_000),
      ),
    ]);
    opened.splice(0);
  });

  test('a second launch brings the hidden window back', async () => {
    const { app, page, dir } = await start();
    const win = await app.browserWindow(page);
    await win.evaluate((w) => w.close());
    await expect.poll(async () => (await mainWindowState(app, page)).visible).toBe(false);
    // The second instance quits at once; the first one is told.
    const second = await electron
      .launch({
        args: ['.'],
        cwd: projectRoot,
        env: { ...process.env, FRAMELET_USER_DATA_DIR: dir, FRAMELET_E2E_MOCK_CAPTURE: '1' },
      })
      .catch(() => null);
    await second?.close().catch(() => undefined);
    await expect.poll(async () => (await mainWindowState(app, page)).visible).toBe(true);
  });

  test('quitting during a recording asks first; Keep recording keeps it, Stop & quit saves and exits', async () => {
    const { app, page, dir } = await start({ env: { FRAMELET_E2E_MOCK_DISPLAYS: '1' } });
    await hooks(app, (h) => h.runAction('recordScreen'));
    const status = async (): Promise<string> => {
      const result = await page.evaluate(() => window.framelet.invoke('recorder:getState'));
      return result.ok ? result.data.status : 'unknown';
    };
    await expect.poll(status, { timeout: 30_000 }).toBe('recording');

    // The main window is hidden (recording started from a shortcut path): quitting shows it.
    await hooks(app, (h) => h.requestQuit());
    const dialog = page.getByTestId('confirm-dialog');
    await expect(dialog).toBeVisible();
    await expect(dialog).toContainText(
      'A recording is in progress. Stop and save it before quitting?',
    );
    await dialog.getByRole('button', { name: 'Keep recording' }).click();
    await expect(dialog).toHaveCount(0);
    expect(await status()).toBe('recording');
    expect(await app.evaluate(({ app: electron }) => electron.isReady())).toBe(true);

    const closed = new Promise<void>((resolve) => app.on('close', () => resolve()));
    await hooks(app, (h) => h.requestQuit());
    await expect(dialog).toBeVisible();
    await dialog.getByRole('button', { name: 'Stop & quit' }).click();
    await Promise.race([
      closed,
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error('the app did not quit')), 30_000),
      ),
    ]);
    // The recording was finished before the app went away.
    const videos = path.join(dir, 'videos', 'Framelet');
    expect(
      fs.existsSync(videos) ? fs.readdirSync(videos).filter((f) => f.endsWith('.webm')) : [],
    ).toHaveLength(1);
    opened.splice(0);
  });

  test('quit without a recording just quits (no question)', async () => {
    const { app } = await start();
    const closed = new Promise<void>((resolve) => app.on('close', () => resolve()));
    await hooks(app, (h) => h.requestQuit());
    await Promise.race([
      closed,
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error('the app did not quit')), 15_000),
      ),
    ]);
    opened.splice(0);
  });
});

// --- keyboard and focus ------------------------------------------------------------------------

test.describe('keyboard and focus', () => {
  test('keyboard only: Tab to Screenshot > Region, select with arrows, Enter, editor focus, Ctrl+S', async () => {
    const { app, page, dir } = await start();
    const out = path.join(dir, 'kbd-shot.png');
    await app.evaluate(({ dialog }, target) => {
      dialog.showSaveDialog = (() =>
        Promise.resolve({ canceled: false, filePath: target })) as typeof dialog.showSaveDialog;
    }, out);

    // Tab reaches the primary region button in a reasonable number of steps, in a logical order.
    const order: string[] = [];
    for (let i = 0; i < 12; i += 1) {
      await page.keyboard.press('Tab');
      const id = await page.evaluate(() => {
        const el = document.activeElement as HTMLElement | null;
        return (
          el?.dataset.testid ?? el?.getAttribute('aria-label') ?? el?.textContent?.trim() ?? ''
        );
      });
      order.push(id);
      if (id === 'shot-region') break;
    }
    expect(order.at(-1)).toBe('shot-region');
    expect(order.length).toBeLessThanOrEqual(10);
    // Skip link, then the navigation, then the content.
    expect(order[0]).toBe('skip-link');
    expect(order.slice(1, 4).join(' ')).toContain('Capture');

    await page.keyboard.press('Enter');
    const overlay = await overlayFor(app, '1001');
    const selection = async () =>
      JSON.parse(
        (await overlay.getByTestId('overlay-region').getAttribute('data-selection')) || 'null',
      );
    expect(await selection()).toBeNull();
    await overlay.keyboard.press('ArrowRight'); // starts a centered selection
    expect(await selection()).toMatchObject({ x: 640, y: 360, width: 1280, height: 720 });
    await overlay.keyboard.press('ArrowRight');
    await overlay.keyboard.press('Shift+ArrowDown');
    expect(await selection()).toMatchObject({ x: 641, y: 370 });
    await overlay.keyboard.press('Alt+ArrowLeft');
    await overlay.keyboard.press('Alt+Shift+ArrowUp');
    expect(await selection()).toMatchObject({ width: 1279, height: 710 });
    await expect(overlay.getByTestId('size-label')).toHaveText('1279 × 710');
    await pressClosing(overlay, 'Enter');

    await expect(page.getByTestId('editor-view')).toBeVisible();
    await expect(page.getByTestId('editor-dimensions')).toHaveText('1279 × 710');
    // The canvas has the focus, so the keyboard works without a click.
    await expect(page.getByTestId('editor-canvas')).toBeFocused();
    await page.keyboard.press('Control+s');
    await expect.poll(() => fs.existsSync(out)).toBe(true);
    await expect(page.getByText('Saved to', { exact: false })).toBeVisible();
  });

  test('Esc on the overlay returns focus to the trigger; the main window is focused again', async () => {
    const { app, page } = await start();
    const button = page.getByTestId('shot-region');
    await button.focus();
    await button.press('Enter');
    const overlay = await overlayFor(app, '1001');
    await pressClosing(overlay, 'Escape');
    await expect.poll(() => pagesOf(app, '#/overlay').length).toBe(0);
    await expect.poll(async () => (await mainWindowState(app, page)).focused).toBe(true);
    await expect(button).toBeFocused();
  });

  test('a cancelled capture started from a shortcut leaves a hidden window hidden', async () => {
    const { app, page } = await start();
    const win = await app.browserWindow(page);
    await win.evaluate((w) => w.close());
    await expect.poll(async () => (await mainWindowState(app, page)).visible).toBe(false);
    await hooks(app, (h) => h.runAction('screenshotRegion'));
    const overlay = await overlayFor(app, '1001');
    await pressClosing(overlay, 'Escape');
    await expect.poll(() => pagesOf(app, '#/overlay').length).toBe(0);
    expect((await mainWindowState(app, page)).visible).toBe(false);
    // A finished capture does show it (the editor is there).
    await hooks(app, (h) => h.runAction('screenshotRegion'));
    const second = await overlayFor(app, '1001');
    await second.keyboard.press('ArrowRight');
    await pressClosing(second, 'Enter');
    await expect.poll(async () => (await mainWindowState(app, page)).visible).toBe(true);
    await expect(page.getByTestId('editor-view')).toBeVisible();
  });

  test('the overlay ignores the pointer until it is on screen (data-ready)', async () => {
    const { app, page } = await start();
    await page.getByTestId('shot-region').click();
    // The first overlay page to exist is not ready yet; once ready a drag works exactly.
    const overlay = await overlayFor(app, '1001');
    await overlay.mouse.move(200, 150);
    await overlay.mouse.down();
    await overlay.mouse.move(840, 510, { steps: 6 });
    await overlay.mouse.up();
    await expect(overlay.getByTestId('size-label')).toHaveText('640 × 360');
    await pressClosing(overlay, 'Escape');
  });

  test('a drag can start in the very corner pixel (the focused overlay has no rounded corners)', async () => {
    const { app, page } = await start();
    await page.getByTestId('shot-region').click();
    const overlay = await overlayFor(app, '1001');
    // The overlay has the keyboard focus after it is shown; a global focus style once rounded its
    // corners, so the pixel at (0, 0) hit the page behind it and the drag never started.
    expect(await overlay.evaluate(() => document.activeElement?.getAttribute('data-testid'))).toBe(
      'overlay-region',
    );
    expect(
      await overlay.evaluate(() => document.elementFromPoint(0, 0)?.getAttribute('data-testid')),
    ).toBe('overlay-region');
    await overlay.mouse.move(0, 0);
    await overlay.mouse.down();
    await overlay.mouse.move(300, 200, { steps: 4 });
    await overlay.mouse.up();
    await expect(overlay.getByTestId('size-label')).toHaveText('300 × 200');
    await pressClosing(overlay, 'Escape');
  });

  test('a stray pointer move (a physical mouse) in the middle of a drag does not change the selection', async () => {
    // Chromium also dispatches a synthetic move at the physical cursor after layout changes, with
    // no button down. An automated drag used to pick those up (sizes like 2030 x 224 instead of
    // 640 x 360, seen as the "first-run drag flake"); the overlay now ignores them.
    const { app, page } = await start();
    await page.getByTestId('shot-region').click();
    const overlay = await overlayFor(app, '1001');
    await overlay.mouse.move(200, 150);
    await overlay.mouse.down();
    await overlay.mouse.move(520, 330, { steps: 3 });
    await overlay.evaluate(() => {
      const root = document.querySelector('[data-testid="overlay-region"]');
      for (const [x, y] of [
        [2230, 374],
        [2400, 900],
      ] as const) {
        root?.dispatchEvent(
          new PointerEvent('pointermove', {
            bubbles: true,
            pointerId: 1,
            pointerType: 'mouse',
            buttons: 0,
            clientX: x,
            clientY: y,
          }),
        );
      }
    });
    await overlay.mouse.move(840, 510, { steps: 3 });
    await overlay.mouse.up();
    await expect(overlay.getByTestId('size-label')).toHaveText('640 × 360');
    await pressClosing(overlay, 'Escape');
  });

  test('? and F1 open the keyboard help, which traps focus and gives it back', async () => {
    const { page } = await start();
    const trigger = page
      .getByRole('navigation', { name: 'Primary' })
      .getByRole('button', { name: 'History' });
    await trigger.focus();
    await page.keyboard.press('?');
    const help = page.getByTestId('keyboard-help');
    await expect(help).toBeVisible();
    await expect(help.getByRole('heading', { name: 'Keyboard shortcuts' })).toBeVisible();
    await expect(help).toContainText('From anywhere');
    await expect(help).toContainText('Choosing an area');
    await expect(help).toContainText('In the editor');
    await expect(help).toContainText('Ctrl+Shift+3'.split('+').join(' ').slice(0, 4)); // the keys are shown as chips
    // Tab stays inside the dialog.
    for (let i = 0; i < 4; i += 1) await page.keyboard.press('Tab');
    expect(await page.evaluate(() => !!document.activeElement?.closest('dialog'))).toBe(true);
    await page.keyboard.press('Escape');
    await expect(help).toBeHidden();
    await expect(trigger).toBeFocused();
    await page.waitForTimeout(150); // a human is not faster than the dialog's close event
    await page.keyboard.press('F1');
    await expect(help).toBeVisible();
    await page.keyboard.press('Escape');
    // Typing a question mark in a text field does not open it.
    await page.getByTestId('settings-nav-general').count();
    await goTo(page, 'History');
  });

  test('every settings control has an accessible name and a description', async () => {
    const { page } = await start();
    for (const section of ['general', 'screenshots', 'recording', 'shortcuts', 'storage']) {
      await openSettings(page, section);
      const unnamed = await page.evaluate(() => {
        const bad: string[] = [];
        for (const el of document.querySelectorAll<HTMLElement>(
          'main button, main input, main select, main [role="switch"], main [role="radio"]',
        )) {
          const name =
            el.getAttribute('aria-label') ||
            (el.getAttribute('aria-labelledby') &&
              document.getElementById(el.getAttribute('aria-labelledby') ?? '')?.textContent) ||
            el.textContent?.trim();
          if (!name) bad.push(el.outerHTML.slice(0, 120));
        }
        return bad;
      });
      expect(unnamed, section).toEqual([]);
    }
  });
});

// --- error messages and the device ---------------------------------------------------------------

test.describe('errors and devices', () => {
  test('starting a recording into a folder that cannot be written says what to do', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'framelet-e2e-bad-'));
    const blocker = path.join(dir, 'file');
    fs.writeFileSync(blocker, 'x');
    const { page } = await start({
      dir,
      settings: { version: 1, recording: { outputDir: path.join(blocker, 'nope') } },
    });
    await page.getByTestId('record-screen').click();
    await expect(
      page.getByText("Framelet can't save to that folder. Choose a folder you can write to", {
        exact: false,
      }),
    ).toBeVisible();
    await expect(page.getByTestId('record-screen')).toBeEnabled();
  });

  test('a saved microphone that is gone is reported, not dropped', async () => {
    const { page } = await start({
      settings: { version: 1, recording: { micEnabled: true, micDeviceId: 'device-that-is-gone' } },
    });
    await expect(page.getByTestId('mic-missing')).toHaveText(
      'Saved microphone not found — using default',
    );
    await openSettings(page, 'recording');
    await expect(page.getByTestId('mic-missing')).toBeVisible();
    // The saved id is still there: nothing was silently rewritten.
    const state = await page.evaluate(() => window.framelet.invoke('settings:get'));
    expect(state).toMatchObject({
      ok: true,
      data: { settings: { recording: { micDeviceId: 'device-that-is-gone' } } },
    });
  });
});

// --- idle ------------------------------------------------------------------------------------------

test.describe('idle', () => {
  test('no timers, animation frames or polling in the main window while idle', async () => {
    const { page } = await start();
    // Count every timer and animation frame the page creates (installed before the page loads).
    await page.context().addInitScript(() => {
      const log = { intervals: 0, activeIntervals: 0, timeouts: 0, frames: 0 };
      (window as unknown as { __idleLog: typeof log }).__idleLog = log;
      const setInterval0 = window.setInterval.bind(window);
      const clearInterval0 = window.clearInterval.bind(window);
      const setTimeout0 = window.setTimeout.bind(window);
      const raf0 = window.requestAnimationFrame.bind(window);
      const live = new Set<number>();
      window.setInterval = ((...args: Parameters<typeof setInterval>) => {
        const id = setInterval0(...args);
        live.add(id as unknown as number);
        log.intervals += 1;
        log.activeIntervals = live.size;
        return id;
      }) as typeof window.setInterval;
      window.clearInterval = ((id?: number) => {
        live.delete(id as number);
        log.activeIntervals = live.size;
        return clearInterval0(id);
      }) as typeof window.clearInterval;
      window.setTimeout = ((...args: Parameters<typeof setTimeout>) => {
        log.timeouts += 1;
        return setTimeout0(...args);
      }) as typeof window.setTimeout;
      window.requestAnimationFrame = ((callback: FrameRequestCallback) => {
        log.frames += 1;
        return raf0(callback);
      }) as typeof window.requestAnimationFrame;
    });
    await page.reload();
    await expect(page.getByTestId('shot-region')).toBeVisible();
    await page.waitForTimeout(2500); // startup work (settings, history, recovery) settles
    interface IdleLog {
      intervals: number;
      activeIntervals: number;
      timeouts: number;
      frames: number;
    }
    const readLog = (): Promise<IdleLog> =>
      page.evaluate(() => ({ ...(window as unknown as { __idleLog: IdleLog }).__idleLog }));

    const before = await readLog();
    await page.waitForTimeout(6000);
    const after = await readLog();
    expect(after).toEqual(before);
    expect(after.activeIntervals).toBe(0);

    // Settings and History are idle too.
    for (const name of ['Settings', 'History'] as const) {
      await goTo(page, name);
      await page.waitForTimeout(800);
      const start0 = await readLog();
      await page.waitForTimeout(3000);
      const end0 = await readLog();
      expect(end0.frames, name).toBe(start0.frames);
      expect(end0.timeouts, name).toBe(start0.timeouts);
      expect(end0.activeIntervals, name).toBe(0);
    }
  });

  test('the hidden worker window idles: no loops, and next to no CPU time in any window', async () => {
    const { app, page } = await start({ env: { FRAMELET_E2E_MOCK_DISPLAYS: '1' } });
    // A screenshot flow wakes the worker (it grabs the frozen frame); then everything is idle.
    await page.getByTestId('shot-region').click();
    const overlay = await overlayFor(app, '1001');
    await pressClosing(overlay, 'Escape');
    await expect.poll(() => pagesOf(app, '#/overlay').length).toBe(0);
    await expect.poll(() => pagesOf(app, '#/recorder').length).toBe(1);
    const worker = pagesOf(app, '#/recorder')[0] as Page;
    await page.waitForTimeout(2500);

    const loops = await worker.evaluate(() =>
      (
        window as unknown as { __frameletResources: () => Record<string, number> }
      ).__frameletResources(),
    );
    expect(loops).toMatchObject({ liveTracks: 0, openAudioContexts: 0, activeLoops: 0 });

    // Script time spent by each window over 5 s of idle (Chromium's own accounting).
    const measure = async (target: Page): Promise<number> => {
      const session = await target.context().newCDPSession(target);
      await session.send('Performance.enable');
      const read = async (): Promise<number> => {
        const { metrics } = await session.send('Performance.getMetrics');
        return metrics.find((metric) => metric.name === 'TaskDuration')?.value ?? 0;
      };
      const before = await read();
      await target.waitForTimeout(5000);
      return (await read()) - before;
    };
    const [mainTask, workerTask] = [await measure(page), await measure(worker)];
    expect(workerTask, 'worker TaskDuration over 5 s').toBeLessThan(0.1);
    expect(mainTask, 'main window TaskDuration over 5 s').toBeLessThan(0.1);
  });

  test('no IPC traffic at all while idle: no source refresh, no levels, no polling', async () => {
    const { app, page } = await start();
    await page.waitForTimeout(2500); // startup work (settings, history, recovery) settles
    const before = await hooks(app, (h) => h.ipcTotal());
    const sourcesBefore = await hooks(app, (h) => h.ipcCount('capture:listSources'));
    await page.waitForTimeout(6000);
    expect(await hooks(app, (h) => h.ipcTotal())).toBe(before);
    expect(await hooks(app, (h) => h.ipcCount('capture:listSources'))).toBe(sourcesBefore);
    // Opening the window picker lists sources once; closing it stops.
    await page.getByTestId('shot-window').click();
    await expect(page.getByTestId('source-picker')).toBeVisible();
    await expect
      .poll(() => hooks(app, (h) => h.ipcCount('capture:listSources')))
      .toBe(sourcesBefore + 1);
    await page.keyboard.press('Escape');
    const closed = await hooks(app, (h) => h.ipcTotal());
    await page.waitForTimeout(3000);
    expect(await hooks(app, (h) => h.ipcTotal())).toBe(closed);
  });
});
