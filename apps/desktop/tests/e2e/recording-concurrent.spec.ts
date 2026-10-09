/**
 * Several recordings at once, end to end, against the E2E build (mock capture, two mock displays:
 * A id 1001 2560 x 1440, B id 1002 3440 x 1440). Each recording has its own toolbar window and its
 * own hidden recorder (engine) window; the first uses the app's worker window, the others get an
 * extra window that is destroyed once the file is finished. Real capture is covered by
 * tests/native.
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
import { hasEditorPage } from './editor-window';

const projectRoot = path.resolve(__dirname, '..', '..');

let app: ElectronApplication;
let page: Page;
let userDataDir: string;

const OPTIONS = {
  mic: { enabled: false },
  systemAudio: false,
  quality: '1080p',
  fps: 30,
  countdown: false,
} as const;

interface StartArgs {
  target: 'screen' | 'window' | 'region';
  displayId?: string;
  sourceId?: string;
}

const LIVE = ['recording', 'paused'];

function pagesOf(hash: string): Page[] {
  return app.windows().filter((candidate) => candidate.url().includes(hash));
}

async function snapshot() {
  const result = await page.evaluate(() => window.framecapt.invoke('recorder:getState'));
  if (!result.ok) throw new Error('recorder:getState failed');
  return result.data;
}

const liveSessions = async () =>
  (await snapshot()).sessions.filter((session) => LIVE.includes(session.status));

async function waitForLive(count: number): Promise<void> {
  await expect.poll(async () => (await liveSessions()).length, { timeout: 30_000 }).toBe(count);
}

async function startRecording(args: StartArgs) {
  return page.evaluate(
    ({ request, options }) => window.framecapt.invoke('recorder:start', { ...request, options }),
    { request: args, options: OPTIONS },
  );
}

async function stopSession(sessionId: string): Promise<void> {
  const result = await page.evaluate(
    (id) => window.framecapt.invoke('recorder:stop', { sessionId: id }),
    sessionId,
  );
  expect(result.ok).toBe(true);
}

async function overlayFor(displayId: string, testId: string): Promise<Page> {
  let found: Page | undefined;
  await expect
    .poll(
      async () => {
        for (const candidate of pagesOf('#/overlay')) {
          const root = candidate.locator(`[data-testid="${testId}"]`);
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

/** A key that ends the flow: the overlay window may be destroyed before Playwright hears back. */
async function pressClosing(overlay: Page, key: string): Promise<void> {
  await overlay.keyboard.press(key).catch((error: unknown) => {
    if (!/closed/i.test(String(error))) throw error;
  });
}

async function drag(overlay: Page, from: [number, number], to: [number, number]): Promise<void> {
  await overlay.mouse.move(from[0], from[1]);
  await overlay.mouse.down();
  await overlay.mouse.move(to[0], to[1], { steps: 6 });
  await overlay.mouse.up();
}

/** Stops everything still running, waits until nothing is active and clears the finished sessions. */
async function cleanUp(): Promise<void> {
  for (const overlay of pagesOf('#/overlay')) await pressClosing(overlay, 'Escape');
  await page.evaluate(() => window.framecapt.invoke('recorder:stopAll'));
  await expect
    .poll(
      async () =>
        (await snapshot()).sessions.filter(
          (session) => !['idle', 'completed', 'error'].includes(session.status),
        ).length,
      { timeout: 60_000 },
    )
    .toBe(0);
  for (const session of (await snapshot()).sessions) {
    await page.evaluate(
      (id) => window.framecapt.invoke('recorder:reset', { sessionId: id }),
      session.sessionId,
    );
  }
}

async function recordings() {
  const result = await page.evaluate(() =>
    window.framecapt.invoke('history:list', { filter: 'recording' }),
  );
  if (!result.ok) throw new Error('history:list failed');
  return result.data.items;
}

async function screenshots() {
  const result = await page.evaluate(() =>
    window.framecapt.invoke('history:list', { filter: 'screenshot' }),
  );
  if (!result.ok) throw new Error('history:list failed');
  return result.data.items;
}

/** Starts a region recording on display B and confirms a rectangle on its overlay. */
async function startRegionOnB(): Promise<void> {
  const result = await startRecording({ target: 'region' });
  expect(result.ok).toBe(true);
  await overlayFor('1001', 'overlay-region');
  const b = await overlayFor('1002', 'overlay-region');
  await drag(b, [200, 150], [840, 510]);
  await pressClosing(b, 'Enter');
}

async function resourcesOf(recorder: Page) {
  return recorder.evaluate(() =>
    (
      window as unknown as {
        __frameCaptResources: () => {
          liveTracks: number;
          openAudioContexts: number;
          activeLoops: number;
          activeRecorders: number;
        };
      }
    ).__frameCaptResources(),
  );
}

test.describe.configure({ mode: 'serial' });

test.beforeAll(async () => {
  expect(
    fs.existsSync(path.join(projectRoot, '.vite', 'build', 'main.cjs')),
    'Run `npm run package:e2e` first (npm run test:e2e does this).',
  ).toBe(true);
  userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'framecapt-e2e-concurrent-'));
  app = await electron.launch({
    args: ['.'],
    cwd: projectRoot,
    env: {
      ...process.env,
      FRAMECAPT_USER_DATA_DIR: userDataDir,
      FRAMECAPT_E2E_MOCK_CAPTURE: '1',
      FRAMECAPT_E2E_FAKE_SHORTCUTS: '1',
    },
  });
  page = await app.firstWindow();
  await page.waitForLoadState('domcontentloaded');
  await expect(page.getByTestId('record-screen')).toBeVisible();
});
test.afterAll(async () => {
  if (app) await exitApp(app);
  if (userDataDir) fs.rmSync(userDataDir, { recursive: true, force: true });
});
test.afterEach(async () => {
  await cleanUp();
});

test('a region screenshot on the other display is saved directly while a recording runs', async () => {
  const before = (await screenshots()).length;
  expect((await startRecording({ target: 'screen', displayId: '1001' })).ok).toBe(true);
  await waitForLive(1);

  const started = await page.evaluate(() =>
    window.framecapt.invoke('capture:startScreenshot', { target: 'region' }),
  );
  expect(started.ok).toBe(true);
  await overlayFor('1001', 'overlay-region');
  const b = await overlayFor('1002', 'overlay-region');
  await drag(b, [100, 100], [500, 300]);
  await pressClosing(b, 'Enter');

  await expect.poll(async () => (await screenshots()).length, { timeout: 20_000 }).toBe(before + 1);
  expect((await screenshots())[0]).toMatchObject({ type: 'screenshot', exists: true });
  await expect.poll(() => pagesOf('#/overlay').length).toBe(0);
  // The recording was not touched and no editor opened.
  expect((await liveSessions()).length).toBe(1);
  expect(await hasEditorPage(app)).toBe(false);
});

test('a second recording starts beside the first; each stops on its own into its own file', async () => {
  const before = (await recordings()).length;
  expect((await startRecording({ target: 'screen', displayId: '1001' })).ok).toBe(true);
  await waitForLive(1);
  await startRegionOnB();
  await waitForLive(2);

  const snap = await snapshot();
  const live = snap.sessions.filter((session) => LIVE.includes(session.status));
  expect(live).toHaveLength(2);
  expect(snap.canStartAnother).toBe(true);
  // One toolbar and one recorder window per recording.
  await expect.poll(() => pagesOf('#/toolbar').length, { timeout: 15_000 }).toBe(2);
  await expect.poll(() => pagesOf('#/recorder').length, { timeout: 15_000 }).toBe(2);
  const [first, second] = live;
  await page.waitForTimeout(1500);

  // Stopping the second leaves the first running; the extra recorder window is destroyed.
  await stopSession(second!.sessionId);
  await expect
    .poll(
      async () =>
        (await snapshot()).sessions.find((session) => session.sessionId === second!.sessionId)
          ?.status,
      { timeout: 60_000 },
    )
    .toBe('completed');
  const afterSecond = await snapshot();
  expect(
    afterSecond.sessions.find((session) => session.sessionId === first!.sessionId)?.status,
  ).toBe('recording');
  await expect.poll(() => pagesOf('#/recorder').length, { timeout: 15_000 }).toBe(1);
  await expect.poll(() => pagesOf('#/toolbar').length, { timeout: 15_000 }).toBe(1);

  await stopSession(first!.sessionId);
  await expect.poll(async () => (await liveSessions()).length, { timeout: 60_000 }).toBe(0);
  await expect
    .poll(
      async () => (await snapshot()).sessions.every((session) => session.status === 'completed'),
      { timeout: 60_000 },
    )
    .toBe(true);

  // Two separate .webm files in history.
  await expect.poll(async () => (await recordings()).length, { timeout: 20_000 }).toBe(before + 2);
  const added = (await recordings()).slice(0, 2);
  expect(new Set(added.map((item) => item.path)).size).toBe(2);
  for (const item of added) {
    expect(item).toMatchObject({ format: 'webm', exists: true });
    expect(fs.existsSync(item.path)).toBe(true);
  }

  // What is left of the recorder windows (the worker window) holds nothing.
  for (const recorder of pagesOf('#/recorder')) {
    await expect
      .poll(() => resourcesOf(recorder), { timeout: 10_000 })
      .toMatchObject({ liveTracks: 0, openAudioContexts: 0, activeLoops: 0, activeRecorders: 0 });
  }
});

test('at most three recordings run at once; a fourth is refused; Stop all ends them all', async () => {
  const before = (await recordings()).length;
  expect((await startRecording({ target: 'screen', displayId: '1001' })).ok).toBe(true);
  await waitForLive(1);
  expect((await startRecording({ target: 'screen', displayId: '1002' })).ok).toBe(true);
  await waitForLive(2);
  expect((await startRecording({ target: 'window', sourceId: 'window:1001:0' })).ok).toBe(true);
  await waitForLive(3);

  expect((await snapshot()).canStartAnother).toBe(false);
  const fourth = await startRecording({ target: 'screen', displayId: '1001' });
  expect(fourth).toMatchObject({ ok: false, error: { code: 'BUSY' } });
  expect((await liveSessions()).length).toBe(3);
  await expect.poll(() => pagesOf('#/recorder').length, { timeout: 15_000 }).toBe(3);
  await page.waitForTimeout(1000);

  await page.evaluate(() => window.framecapt.invoke('recorder:stopAll'));
  await expect.poll(async () => (await liveSessions()).length, { timeout: 60_000 }).toBe(0);
  await expect.poll(async () => (await recordings()).length, { timeout: 60_000 }).toBe(before + 3);
  await expect.poll(() => pagesOf('#/recorder').length, { timeout: 15_000 }).toBe(1);
  expect((await snapshot()).canStartAnother).toBe(true);
});

test('a start is refused while another recording is still choosing its region', async () => {
  expect((await startRecording({ target: 'screen', displayId: '1001' })).ok).toBe(true);
  await waitForLive(1);

  // The second recording is in start-up: its selection overlays are open.
  expect((await startRecording({ target: 'region' })).ok).toBe(true);
  await overlayFor('1002', 'overlay-region');
  const snap = await snapshot();
  expect(snap.canStartAnother).toBe(false);
  expect(await startRecording({ target: 'screen', displayId: '1002' })).toMatchObject({
    ok: false,
    error: { code: 'BUSY' },
  });
  expect((await liveSessions()).length).toBe(1);

  // Esc cancels only the start-up; the first recording is untouched.
  await pressClosing(await overlayFor('1002', 'overlay-region'), 'Escape');
  await expect.poll(() => pagesOf('#/overlay').length).toBe(0);
  await expect.poll(async () => (await snapshot()).canStartAnother).toBe(true);
  expect((await liveSessions()).length).toBe(1);
});

test('the region overlay stays open when the recording toolbar takes focus', async () => {
  expect((await startRecording({ target: 'screen', displayId: '1001' })).ok).toBe(true);
  await waitForLive(1);
  const toolbar = pagesOf('#/toolbar')[0];
  expect(toolbar).toBeDefined();

  expect((await startRecording({ target: 'region' })).ok).toBe(true);
  const a = await overlayFor('1001', 'overlay-region');
  await overlayFor('1002', 'overlay-region');
  expect(pagesOf('#/overlay')).toHaveLength(2);

  // Clicking the toolbar must not read as "the user left FrameCapt".
  const toolbarWindow = await app.browserWindow(toolbar!);
  await toolbarWindow.evaluate((win) => win.focus());
  await expect.poll(() => toolbarWindow.evaluate((win) => win.isFocused())).toBe(true);
  // The blur check runs after a short delay: give it time to (wrongly) cancel.
  await page.waitForTimeout(1000);
  expect(pagesOf('#/overlay')).toHaveLength(2);
  expect((await snapshot()).sessions.some((session) => session.status === 'selecting')).toBe(true);

  await pressClosing(a, 'Escape');
  await expect.poll(() => pagesOf('#/overlay').length).toBe(0);
  await expect.poll(async () => (await snapshot()).canStartAnother).toBe(true);
  expect((await liveSessions()).length).toBe(1);
});
