/**
 * Meeting recording end to end, against the E2E build: the mock capture provider supplies the
 * windows and screens, the mock window probe (`globalThis.__frameCaptProbe`) stands in for the
 * Win32 window list, and the meeting detector polls fast (FRAMECAPT_E2E_MEETING_POLL_MS). Real
 * capture of a real Zoom, Meet or Teams call is not covered here (it needs the apps).
 *
 * Mock capture windows: ids window:1001..1004 (1005 fails like a minimized window); the fake Zoom
 * window uses hwnd 1002 and the fake Meet tab hwnd 1003, so their `window:<hwnd>:0` ids are
 * capturable. The mock has two displays, so a browser's share indicator is ambiguous.
 *
 * The meeting recording asks for system audio, which the mock cannot provide: the "System audio
 * isn't available" choice appears and the test records without it (Windows; Linux has no system
 * audio and no question). The microphone is Chromium's fake device.
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

let app: ElectronApplication;
let page: Page;
let userDataDir: string;

interface ProbeWindow {
  hwnd: string;
  title: string;
  className: string;
  pid: number;
  exe: string;
  rect: { x: number; y: number; width: number; height: number };
  minimized: boolean;
  visible: boolean;
  cloaked: boolean;
}

const ZOOM: ProbeWindow = {
  hwnd: '1002',
  title: 'Zoom Meeting',
  className: 'ConfMultiTabContentWndClass',
  pid: 4242,
  exe: 'zoom.exe',
  rect: { x: 100, y: 100, width: 1280, height: 720 },
  minimized: false,
  visible: true,
  cloaked: false,
};
const MEET: ProbeWindow = {
  hwnd: '1003',
  title: 'Meet – abc-defg-hij - Google Chrome',
  className: 'Chrome_WidgetWin_1',
  pid: 4343,
  exe: 'chrome.exe',
  rect: { x: 100, y: 100, width: 1280, height: 720 },
  minimized: false,
  visible: true,
  cloaked: false,
};
/** Chrome's "is sharing your screen" bar: it does not say which screen. */
const CHROME_SHARE_BAR: ProbeWindow = {
  hwnd: '2001',
  title: 'meet.google.com is sharing your screen.',
  className: 'Chrome_WidgetWin_1',
  pid: 4343,
  exe: 'chrome.exe',
  rect: { x: 600, y: 8, width: 520, height: 48 },
  minimized: false,
  visible: true,
  cloaked: false,
};

const OPTIONS = {
  mic: { enabled: false },
  systemAudio: false,
  quality: '1080p',
  fps: 30,
  countdown: false,
} as const;

const videosDir = (): string => path.join(userDataDir, 'videos', 'FrameCapt');
const outputFiles = (): string[] =>
  fs.existsSync(videosDir()) ? fs.readdirSync(videosDir()).filter((f) => f.endsWith('.webm')) : [];

function pagesOf(hash: string): Page[] {
  return app.windows().filter((candidate) => candidate.url().includes(hash));
}

async function state() {
  const result = await page.evaluate(() => window.framecapt.invoke('recorder:getState'));
  if (!result.ok) throw new Error('recorder:getState failed');
  return result.data;
}

type Hooks = {
  __frameCaptProbe: { setWindows(windows: unknown[]): void };
  __frameCaptMeetings: { poll(): Promise<void>; list(): { meetings: { app: string }[] } };
};

/** What the (mock) window list shows from now on. */
async function setWindows(windows: ProbeWindow[]): Promise<void> {
  await app.evaluate((_electron, list) => {
    (globalThis as unknown as Hooks).__frameCaptProbe.setWindows(list);
  }, windows);
}

/** One look at the window list (the detector also polls by itself, fast). */
async function pollMeetings(times = 1): Promise<void> {
  for (let i = 0; i < times; i += 1) {
    await app.evaluate(async () => {
      await (globalThis as unknown as Hooks).__frameCaptMeetings.poll();
    });
  }
}

const detected = (): Promise<string[]> =>
  app.evaluate(() =>
    (globalThis as unknown as Hooks).__frameCaptMeetings.list().meetings.map((m) => m.app),
  );

/** No window, no meeting: the detector drops a meeting whose window is gone after two looks. */
async function clearMeetings(): Promise<void> {
  await setWindows([]);
  await pollMeetings(3);
  await expect.poll(detected).toEqual([]);
}

async function promptPage(): Promise<Page> {
  let found: Page | undefined;
  await expect
    .poll(
      () => {
        found = pagesOf('#/meeting-prompt')[0];
        return found !== undefined;
      },
      { timeout: 20_000 },
    )
    .toBe(true);
  const prompt = found as Page;
  await expect(prompt.getByTestId('meeting-prompt')).toBeVisible();
  return prompt;
}

async function toolbarPage(): Promise<Page> {
  let found: Page | undefined;
  await expect
    .poll(
      () => {
        found = pagesOf('#/toolbar')[0];
        return found !== undefined;
      },
      { timeout: 20_000 },
    )
    .toBe(true);
  const toolbar = found as Page;
  await expect(toolbar.getByTestId('toolbar')).toBeVisible();
  await expect.poll(async () => (await state()).status, { timeout: 30_000 }).toBe('recording');
  return toolbar;
}

/** Answers the "System audio isn't available" question (the mock has no loopback) until recording runs. */
async function waitUntilRecording(): Promise<Page> {
  await expect
    .poll(
      async () => {
        const choice = page.getByTestId('choice-dialog');
        if (await choice.isVisible().catch(() => false)) {
          await page.getByTestId('choice-without').click();
        }
        return (await state()).status;
      },
      { timeout: 40_000, intervals: [250] },
    )
    .toBe('recording');
  return toolbarPage();
}

async function toolbarHeight(toolbar: Page): Promise<number> {
  const win = await app.browserWindow(toolbar);
  return win.evaluate((w) => w.getBounds().height);
}

async function stopAndReset(toolbar: Page): Promise<void> {
  await toolbar.getByTestId('toolbar-stop').click();
  await expect(page.getByTestId('recording-result')).toBeVisible({ timeout: 40_000 });
  await page.getByTestId('result-new').click();
  await expect(page.getByTestId('record-screen')).toBeVisible();
  await expect.poll(async () => (await state()).status).toBe('idle');
}

/** A screen recording of the first mock display, started the way the Record tile does. */
async function startScreenRecording(): Promise<Page> {
  const result = await page.evaluate(
    (options) =>
      window.framecapt.invoke('recorder:start', { target: 'screen', displayId: '1001', options }),
    OPTIONS,
  );
  expect(result.ok).toBe(true);
  return toolbarPage();
}

test.describe.configure({ mode: 'serial' });

test.beforeAll(async () => {
  expect(
    fs.existsSync(path.join(projectRoot, '.vite', 'build', 'main.cjs')),
    'Run `npm run package:e2e` first (npm run test:e2e does this).',
  ).toBe(true);
  userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'framecapt-e2e-meeting-'));
  app = await electron.launch({
    args: ['.', '--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'],
    cwd: projectRoot,
    env: {
      ...process.env,
      FRAMECAPT_USER_DATA_DIR: userDataDir,
      FRAMECAPT_E2E_MOCK_CAPTURE: '1',
      FRAMECAPT_E2E_FAKE_SHORTCUTS: '1',
      FRAMECAPT_E2E_MOCK_PROBE: '1',
      FRAMECAPT_E2E_MEETING_POLL_MS: '250',
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

test('a Zoom meeting is offered, recorded, hidden when minimized, and saved as one video', async () => {
  await setWindows([ZOOM]);
  await pollMeetings(2);
  await expect.poll(detected).toEqual(['zoom']);

  // Home lists the meeting too.
  await expect(page.getByTestId('meeting-chip')).toContainText('Zoom meeting detected');
  await expect(page.getByTestId('meeting-chip-action')).toHaveText('Record');

  const prompt = await promptPage();
  await expect(prompt.getByTestId('meeting-prompt')).toHaveAttribute('data-app', 'zoom');
  await expect(prompt.getByTestId('meeting-add')).toHaveCount(0); // nothing is recording
  await prompt.getByTestId('meeting-record').click();

  const toolbar = await waitUntilRecording();
  const started = await state();
  expect(started.meeting).toMatchObject({ app: 'zoom', appLabel: 'Zoom', state: 'visible' });
  expect(started.audio.mic).toBe(true);
  await expect(toolbar.getByTestId('meeting-banner')).toHaveCount(0);
  const flat = await toolbarHeight(toolbar);

  // The Zoom window is minimized: the picture is replaced by a card, the audio goes on.
  await setWindows([{ ...ZOOM, minimized: true }]);
  const banner = toolbar.getByTestId('meeting-banner');
  await expect(banner).toBeVisible({ timeout: 15_000 });
  await expect(banner).toHaveAttribute('data-kind', 'meeting-hidden');
  await expect(banner).toContainText('Zoom window is hidden');
  await expect(banner).toContainText('Audio is still recording');
  await expect.poll(async () => (await state()).meeting?.state).toBe('hidden');
  expect((await state()).audio).toEqual(started.audio);
  expect((await state()).status).toBe('recording');
  // The toolbar grew to hold the banner row.
  await expect.poll(() => toolbarHeight(toolbar)).toBeGreaterThan(flat);

  // It comes back: the banner goes and the picture returns.
  await setWindows([ZOOM]);
  await expect(banner).toHaveCount(0, { timeout: 15_000 });
  await expect.poll(async () => (await state()).meeting?.state).toBe('visible');
  await expect.poll(() => toolbarHeight(toolbar)).toBe(flat);
  expect((await state()).audio).toEqual(started.audio);

  await toolbar.waitForTimeout(1200);
  await stopAndReset(toolbar);
  await expect.poll(() => outputFiles().length).toBe(1);
  await clearMeetings();
});

test('a meeting that appears during a screen recording can be added to it', async () => {
  const toolbar = await startScreenRecording();
  expect((await state()).meeting).toBeNull();

  await setWindows([ZOOM]);
  await pollMeetings(2);
  const prompt = await promptPage();
  await expect(prompt.getByTestId('meeting-add')).toHaveText('Add to current recording');
  await prompt.getByTestId('meeting-add').click();

  await expect.poll(async () => (await state()).panelSlots.length, { timeout: 20_000 }).toBe(1);
  const snapshot = await state();
  expect(snapshot.panelSlots[0]).toMatchObject({ slot: 1, kind: 'window', hidden: false });
  expect(snapshot.meeting).toMatchObject({ app: 'zoom', state: 'visible' });
  await expect(toolbar.getByTestId('toolbar-panel-count')).toHaveText('1');

  // Minimized: the panel shows a card (it is hidden in the snapshot), the screen recording goes on.
  await setWindows([{ ...ZOOM, minimized: true }]);
  await expect
    .poll(async () => (await state()).panelSlots[0]?.hidden, { timeout: 15_000 })
    .toBe(true);
  await expect(toolbar.getByTestId('meeting-banner')).toHaveAttribute(
    'data-kind',
    'meeting-hidden',
  );

  await setWindows([ZOOM]);
  await expect
    .poll(async () => (await state()).panelSlots[0]?.hidden, { timeout: 15_000 })
    .toBe(false);

  await toolbar.waitForTimeout(1200);
  await stopAndReset(toolbar);
  await clearMeetings();
});

test('a screen shared from a browser meeting is asked about, and the question goes with the share', async () => {
  const toolbar = await startScreenRecording();

  await setWindows([MEET]);
  await pollMeetings(2);
  await expect.poll(detected).toEqual(['meet']);
  const meetings = await page.evaluate(() => window.framecapt.invoke('meeting:list'));
  expect(meetings.ok).toBe(true);
  const meetingId = meetings.ok ? meetings.data.meetings[0]?.meetingId : undefined;
  expect(meetingId).toBeTruthy();
  const added = await page.evaluate(
    (id) => window.framecapt.invoke('meeting:addToRecording', { meetingId: id ?? '' }),
    meetingId,
  );
  expect(added.ok).toBe(true);
  await expect.poll(async () => (await state()).panelSlots.length, { timeout: 20_000 }).toBe(1);

  // Chrome's sharing bar appears. Two screens, and it does not say which: the user is asked.
  await setWindows([MEET, CHROME_SHARE_BAR]);
  await pollMeetings(1);
  const banner = toolbar.getByTestId('meeting-banner');
  await expect(banner).toBeVisible({ timeout: 15_000 });
  await expect(banner).toHaveAttribute('data-kind', 'share-ask');
  await expect(banner).toContainText("You're sharing your screen");
  await expect(toolbar.getByTestId('meeting-banner-add')).toBeVisible();
  const asking = await state();
  expect(asking.meeting).toMatchObject({ app: 'meet', sharing: true, banner: 'share-ask' });
  expect(asking.panelSlots).toHaveLength(1); // nothing was added by itself

  // The bar goes away: the question goes with it.
  await setWindows([MEET]);
  await pollMeetings(3);
  await expect(banner).toHaveCount(0, { timeout: 15_000 });
  const done = await state();
  expect(done.meeting).toMatchObject({ sharing: false, banner: null });

  await toolbar.waitForTimeout(1200);
  await stopAndReset(toolbar);
  await clearMeetings();
});
