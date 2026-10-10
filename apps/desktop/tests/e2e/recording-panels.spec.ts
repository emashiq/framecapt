/**
 * Live panels end to end, against the E2E build (mock capture, two mock displays: A id 1001
 * 2560 x 1440, B id 1002 3440 x 1440): another screen or window added to a running recording is
 * drawn into the SAME video (the recording on the left two thirds, the panels stacked in the right
 * third), can be hidden and removed, and at most three exist. Panels are drawn from a synthetic
 * green picture (PANEL_PALETTE) so the output frame can tell them from the recording itself. Real
 * capture is covered by tests/native.
 */
import { spawnSync } from 'node:child_process';
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
import { FFMPEG, probeFile } from './media-fixtures';

const projectRoot = path.resolve(__dirname, '..', '..');

let app: ElectronApplication;
let page: Page;
let userDataDir: string;

const videosDir = (): string => path.join(userDataDir, 'videos', 'FrameCapt');
const filesWith = (extension: string): string[] =>
  fs.existsSync(videosDir())
    ? fs.readdirSync(videosDir()).filter((f) => f.endsWith(extension))
    : [];

const OPTIONS = {
  mic: { enabled: false },
  systemAudio: false,
  quality: '1080p',
  fps: 30,
  countdown: false,
} as const;

async function snapshot() {
  const result = await page.evaluate(() => window.framecapt.invoke('recorder:getState'));
  if (!result.ok) throw new Error('recorder:getState failed');
  return result.data;
}

async function waitForStatus(status: string, timeout = 30_000): Promise<void> {
  await expect.poll(async () => (await snapshot()).status, { timeout }).toBe(status);
}

async function startScreenA(): Promise<void> {
  const result = await page.evaluate(
    (options) =>
      window.framecapt.invoke('recorder:start', { target: 'screen', displayId: '1001', options }),
    OPTIONS,
  );
  expect(result.ok).toBe(true);
  await waitForStatus('recording');
}

function addPanel(request: { kind: 'screen' | 'window'; sourceId?: string; displayId?: string }) {
  return page.evaluate((args) => window.framecapt.invoke('recorder:addPanel', args), request);
}

async function stopAndWaitForResult(): Promise<void> {
  const result = await page.evaluate(() => window.framecapt.invoke('recorder:stop'));
  expect(result.ok).toBe(true);
  await waitForStatus('completed', 60_000);
}

async function resetToIdle(): Promise<void> {
  await page.evaluate(() => window.framecapt.invoke('recorder:reset'));
  await waitForStatus('idle');
}

async function recordings() {
  const result = await page.evaluate(() =>
    window.framecapt.invoke('history:list', { filter: 'recording' }),
  );
  if (!result.ok) throw new Error('history:list failed');
  return result.data.items;
}

/** One decoded frame near the end of the file, as 8-bit RGB. */
function lastFrame(file: string, width: number, height: number): Buffer {
  const run = spawnSync(
    FFMPEG,
    [
      '-v',
      'error',
      '-sseof',
      '-0.4',
      '-i',
      file,
      '-frames:v',
      '1',
      '-f',
      'rawvideo',
      '-pix_fmt',
      'rgb24',
      'pipe:1',
    ],
    { shell: false, maxBuffer: 64 << 20 },
  );
  expect(run.status, run.stderr?.toString()).toBe(0);
  expect(run.stdout.length).toBe(width * height * 3);
  return run.stdout;
}

const pixelAt = (frame: Buffer, width: number, x: number, y: number): [number, number, number] => {
  const at = (y * width + x) * 3;
  return [frame[at] ?? 0, frame[at + 1] ?? 0, frame[at + 2] ?? 0];
};

test.describe.configure({ mode: 'serial' });

test.beforeAll(async () => {
  expect(
    fs.existsSync(path.join(projectRoot, '.vite', 'build', 'main.cjs')),
    'Run `npm run package:e2e` first (npm run test:e2e does this).',
  ).toBe(true);
  userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'framecapt-e2e-panels-'));
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

test('panels are added, hidden, removed and capped at three; the result is one webm with the panels in it', async () => {
  await startScreenA();
  const original = await snapshot();
  expect(original.panelSlots).toHaveLength(0);
  expect(original).toMatchObject({ width: 1920, height: 1080 });

  // A screen panel, then a window panel.
  const screen = await addPanel({ kind: 'screen', displayId: '1002' });
  expect(screen).toMatchObject({ ok: true, data: { slot: 1 } });
  expect((await snapshot()).panelSlots).toMatchObject([{ slot: 1, kind: 'screen', hidden: false }]);
  const windowPanel = await addPanel({ kind: 'window', sourceId: 'window:1001:0' });
  expect(windowPanel).toMatchObject({ ok: true, data: { slot: 2 } });
  expect((await snapshot()).panelSlots).toHaveLength(2);
  expect((await snapshot()).sessions[0]?.panels).toBe(2);

  // Hide the first panel (a neutral card replaces its picture), then take it out.
  const hid = await page.evaluate(() =>
    window.framecapt.invoke('recorder:setPanelHidden', {
      slot: 1,
      hidden: true,
      placeholder: 'meeting-hidden',
    }),
  );
  expect(hid.ok).toBe(true);
  await expect
    .poll(async () => (await snapshot()).panelSlots.find((panel) => panel.slot === 1)?.hidden)
    .toBe(true);
  const removed = await page.evaluate(() =>
    window.framecapt.invoke('recorder:removePanel', { slot: 1 }),
  );
  expect(removed.ok).toBe(true);
  await expect
    .poll(async () => (await snapshot()).panelSlots.map((panel) => panel.slot))
    .toEqual([2]);
  // Removing it again is an error.
  expect(
    await page.evaluate(() => window.framecapt.invoke('recorder:removePanel', { slot: 1 })),
  ).toMatchObject({ ok: false });

  // Fill the free slots (the lowest free one first); a fourth panel is refused.
  expect(await addPanel({ kind: 'window', sourceId: 'window:1002:0' })).toMatchObject({
    ok: true,
    data: { slot: 1 },
  });
  expect(await addPanel({ kind: 'window', sourceId: 'window:1003:0' })).toMatchObject({
    ok: true,
    data: { slot: 3 },
  });
  expect((await snapshot()).panelSlots).toHaveLength(3);
  expect(await addPanel({ kind: 'window', sourceId: 'window:1004:0' })).toMatchObject({
    ok: false,
    error: { code: 'PANEL_LIMIT' },
  });
  expect((await snapshot()).panelSlots).toHaveLength(3);

  // Let the three panels be in the picture for a while, then stop.
  await page.waitForTimeout(2500);
  const before = filesWith('.webm').length;
  await stopAndWaitForResult();

  // One webm (no fcap), the size of the recording without panels.
  expect(filesWith('.webm')).toHaveLength(before + 1);
  expect(filesWith('.fcap')).toHaveLength(0);
  const result = (await snapshot()).result;
  expect(result).not.toBeNull();
  const file = result?.path ?? '';
  expect(path.extname(file)).toBe('.webm');
  const video = probeFile(file).streams.find((stream) => stream.codec_type === 'video');
  expect(video).toMatchObject({ width: 1920, height: 1080 });
  const items = await recordings();
  expect(items.filter((item) => item.path === file)).toHaveLength(1);
  expect(items.find((item) => item.path === file)).toMatchObject({
    format: 'webm',
    width: 1920,
    height: 1080,
  });

  // The picture (the recording keeps its 16:9 inside the left two thirds, so there are black bars
  // above and below it; (60, 300) is its blue top-left corner): the recording (blue) fills the left two thirds, three green panels the right third.
  const frame = lastFrame(file, 1920, 1080);
  const [r, g, b] = pixelAt(frame, 1920, 60, 300);
  expect(b).toBeGreaterThan(r + 60);
  expect(b).toBeGreaterThan(g + 40);
  for (const y of [40, 400, 760]) {
    const [pr, pg, pb] = pixelAt(frame, 1920, 1700, y);
    expect(pg, `panel at y=${y}`).toBeGreaterThan(pr + 60);
    expect(pg, `panel at y=${y}`).toBeGreaterThan(pb + 30);
  }
  await resetToIdle();
});

test('a recording with one panel keeps its size and shows the panel in the right third', async () => {
  await startScreenA();
  expect(await addPanel({ kind: 'screen', displayId: '1002' })).toMatchObject({
    ok: true,
    data: { slot: 1 },
  });
  await page.waitForTimeout(2500);
  await stopAndWaitForResult();
  const file = (await snapshot()).result?.path ?? '';
  expect(probeFile(file).streams.find((stream) => stream.codec_type === 'video')).toMatchObject({
    width: 1920,
    height: 1080,
  });
  const frame = lastFrame(file, 1920, 1080);
  const [r, g, b] = pixelAt(frame, 1920, 60, 300);
  expect(b).toBeGreaterThan(r + 60);
  // The 3440 x 1440 panel keeps its shape in the right third: bars above and below it.
  const [pr, pg, pb] = pixelAt(frame, 1920, 1700, 420);
  expect(pg).toBeGreaterThan(pr + 60);
  expect(pg).toBeGreaterThan(pb + 30);
  expect(g).toBeLessThan(b);
  await resetToIdle();
});

test('panels are refused for a recording of several sources (.fcap)', async () => {
  const started = await page.evaluate(
    (options) =>
      window.framecapt.invoke('recorder:start', {
        target: 'multi',
        sources: [{ sourceId: 'screen:1:0' }, { sourceId: 'window:1001:0' }],
        options,
      }),
    OPTIONS,
  );
  expect(started.ok).toBe(true);
  await waitForStatus('recording');
  expect(await addPanel({ kind: 'screen', displayId: '1002' })).toMatchObject({
    ok: false,
    error: { code: 'INVALID_PAYLOAD' },
  });
  expect((await snapshot()).panelSlots).toHaveLength(0);
  await page.waitForTimeout(1000);
  await stopAndWaitForResult();
  expect(filesWith('.fcap')).toHaveLength(1);
  await resetToIdle();
});
