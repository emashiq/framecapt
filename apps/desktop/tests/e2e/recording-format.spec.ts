/**
 * Recording save format and compression, the clipboard rule and History's "Save in another
 * format", against the E2E build (mock capture, the real vendored ffmpeg). The Recycle Bin is
 * stubbed (the original is deleted instead), so nothing lands in the tester's real bin.
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
import { makeWebm, newId, seedHistory } from './history-fixtures';
import { probeFile } from './media-fixtures';

const projectRoot = path.resolve(__dirname, '..', '..');

interface Launched {
  app: ElectronApplication;
  page: Page;
  dir: string;
}

const opened: Launched[] = [];

async function launch(
  options: { settings?: unknown; env?: Record<string, string>; seed?: (dir: string) => void } = {},
): Promise<Launched> {
  expect(
    fs.existsSync(path.join(projectRoot, '.vite', 'build', 'main.cjs')),
    'Run `npm run package:e2e` first (npm run test:e2e does this).',
  ).toBe(true);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'framecapt-e2e-format-'));
  if (options.settings !== undefined) {
    fs.writeFileSync(path.join(dir, 'settings.json'), JSON.stringify(options.settings));
  }
  options.seed?.(dir);
  const app = await electron.launch({
    args: ['.'],
    cwd: projectRoot,
    env: {
      ...process.env,
      FRAMECAPT_USER_DATA_DIR: dir,
      FRAMECAPT_E2E_MOCK_CAPTURE: '1',
      FRAMECAPT_E2E_MOCK_DISPLAYS: '1',
      FRAMECAPT_E2E_FAKE_SHORTCUTS: '1',
      ...options.env,
    },
  });
  const page = await app.firstWindow();
  await page.waitForLoadState('domcontentloaded');
  await expect(page.getByTestId('record-screen')).toBeVisible();
  const launched = { app, page, dir };
  opened.push(launched);
  return launched;
}

test.afterEach(async () => {
  for (const launched of opened.splice(0)) {
    await exitApp(launched.app);
    fs.rmSync(launched.dir, { recursive: true, force: true });
  }
});

/** The Recycle Bin of the test: the file is deleted, the call is recorded. */
async function stubTrash(app: ElectronApplication): Promise<void> {
  await app.evaluate(({ shell }) => {
    (globalThis as unknown as { __trashed: string[] }).__trashed = [];
    shell.trashItem = (async (file: string) => {
      (globalThis as unknown as { __trashed: string[] }).__trashed.push(file);
      process.getBuiltinModule('node:fs').rmSync(file, { force: true });
    }) as typeof shell.trashItem;
  });
}

const trashed = (app: ElectronApplication): Promise<string[]> =>
  app.evaluate(() => (globalThis as unknown as { __trashed: string[] }).__trashed);

/** The file URIs on the system clipboard (empty when it holds anything else). */
function clipboardFiles(app: ElectronApplication): Promise<string[]> {
  return app.evaluate(async ({ clipboard }) => {
    const [item] = await clipboard.read();
    if (!item?.types.includes('text/uri-list')) return [];
    const text = await (await item.getType('text/uri-list')).text();
    return text.split(/\r?\n/).filter(Boolean);
  });
}

async function historyItems(page: Page) {
  const response = await page.evaluate(() => window.framecapt.invoke('history:list', {}));
  if (!response.ok) throw new Error('history:list failed');
  return response.data.items;
}

async function goTo(page: Page, name: 'Capture' | 'History' | 'Settings'): Promise<void> {
  await page.getByRole('navigation', { name: 'Primary' }).getByRole('button', { name }).click();
}

async function openSettings(page: Page, section: string): Promise<void> {
  await goTo(page, 'Settings');
  await page.getByTestId(`settings-nav-${section}`).click();
  await expect(page.getByTestId(`settings-${section}`)).toBeVisible();
}

const settingsFile = (dir: string): string => path.join(dir, 'settings.json');
const readSettings = (dir: string): Record<string, Record<string, unknown>> =>
  fs.existsSync(settingsFile(dir)) ? JSON.parse(fs.readFileSync(settingsFile(dir), 'utf8')) : {};

test.describe('settings', () => {
  test('Save recordings as and Compression: choices, hints, GIF has no compression, both persist', async () => {
    const { page, dir } = await launch();
    await openSettings(page, 'recording');
    const format = page.getByTestId('setting-save-format');
    const compression = page.getByTestId('setting-compression');
    await expect(format).toHaveValue('webm');
    await expect(compression).toHaveValue('off');
    await expect(format.locator('option')).toHaveText(['WebM', 'MP4', 'MKV', 'GIF']);
    await expect(compression.locator('option')).toHaveText(['Off', 'Light', 'Balanced', 'Strong']);
    await expect(page.getByTestId('settings-recording')).toContainText('no extra processing');

    await format.selectOption('mp4');
    await compression.selectOption('balanced');
    await expect(page.getByTestId('settings-recording')).toContainText(
      'Balanced: about 40–60 % smaller MP4, quality nearly unchanged.',
    );
    // "Also save an MP4" is not needed when MP4 is the format.
    await expect(page.getByTestId('setting-auto-mp4')).toBeDisabled();

    await format.selectOption('gif');
    await expect(compression).toBeDisabled();
    await expect(page.getByTestId('settings-recording')).toContainText('no sound');
    await format.selectOption('mkv');
    await expect(compression).toBeEnabled();

    await expect
      .poll(() => readSettings(dir).recording, { timeout: 5000 })
      .toMatchObject({ saveFormat: 'mkv', compression: 'balanced' });
    await page.reload();
    await openSettings(page, 'recording');
    await expect(page.getByTestId('setting-save-format')).toHaveValue('mkv');
    await expect(page.getByTestId('setting-compression')).toHaveValue('balanced');
  });

  test('both clipboard switches are on by default and persist', async () => {
    const { page, dir } = await launch();
    await openSettings(page, 'recording');
    const recordings = page.getByTestId('setting-auto-copy-recordings');
    await expect(recordings).toHaveAttribute('aria-checked', 'true');
    await recordings.click();
    await openSettings(page, 'screenshots');
    const screenshots = page.getByTestId('setting-auto-copy-screenshots');
    await expect(screenshots).toHaveAttribute('aria-checked', 'true');
    await expect(page.getByText('Copy every screenshot to the clipboard')).toBeVisible();
    await screenshots.click();
    await expect
      .poll(() => readSettings(dir), { timeout: 5000 })
      .toMatchObject({ recording: { autoCopy: false }, screenshots: { autoCopy: false } });
  });

  test('an old file migrates: storage compressed shows MP4 + Balanced; copy-and-editor shows the editor choice', async () => {
    const { page } = await launch({
      settings: {
        version: 1,
        recording: { storage: 'compressed' },
        screenshots: { afterCapture: 'copy-and-editor', copyToClipboardOnSave: true },
      },
    });
    await openSettings(page, 'recording');
    await expect(page.getByTestId('setting-save-format')).toHaveValue('mp4');
    await expect(page.getByTestId('setting-compression')).toHaveValue('balanced');
    await openSettings(page, 'screenshots');
    await expect(page.getByTestId('setting-after-capture')).toHaveValue('editor');
    await expect(page.getByTestId('setting-auto-copy-screenshots')).toHaveAttribute(
      'aria-checked',
      'true',
    );
  });

  test('a build without an H.264 encoder disables MP4 and the compression of MKV, but not WebM', async () => {
    const { page } = await launch({ env: { FRAMECAPT_E2E_NO_H264: '1' } });
    await openSettings(page, 'recording');
    const format = page.getByTestId('setting-save-format');
    await expect(format.locator('option[value="mp4"]')).toBeDisabled();
    await expect(format.locator('option[value="mp4"]')).toHaveText('MP4 (unavailable)');
    await expect(format.locator('option[value="webm"]')).toBeEnabled();
    await expect(format.locator('option[value="mkv"]')).toBeEnabled();
    await expect(format.locator('option[value="gif"]')).toBeEnabled();
    await format.selectOption('mkv');
    await expect(
      page.getByTestId('setting-compression').locator('option[value="light"]'),
    ).toBeDisabled();
    await expect(
      page.getByTestId('setting-compression').locator('option[value="off"]'),
    ).toBeEnabled();
    await format.selectOption('webm');
    await expect(
      page.getByTestId('setting-compression').locator('option[value="light"]'),
    ).toBeEnabled();
  });
});

/** Records the mock screen for about a second and stops; resolves with the finished result. */
async function recordOnce(page: Page): Promise<void> {
  await page.getByTestId('record-screen').click();
  await expect
    .poll(
      async () => {
        const state = await page.evaluate(() => window.framecapt.invoke('recorder:getState'));
        return state.ok ? state.data.status : null;
      },
      { timeout: 30_000 },
    )
    .toBe('recording');
  await page.waitForTimeout(1500);
  await page.evaluate(() => window.framecapt.invoke('recorder:stop'));
  await expect(page.getByTestId('recording-result')).toBeVisible({ timeout: 30_000 });
}

test.describe('recording', () => {
  test('with MP4 + Balanced a recording ends as an MP4 in History, the WebM goes to the bin and the MP4 is on the clipboard', async () => {
    const { app, page } = await launch({
      settings: {
        version: 1,
        recording: { countdown: false, saveFormat: 'mp4', compression: 'balanced' },
      },
    });
    await stubTrash(app);
    await recordOnce(page);

    await expect
      .poll(async () => (await historyItems(page)).map((item) => item.format), { timeout: 60_000 })
      .toEqual(['mp4']);
    const [item] = await historyItems(page);
    expect(item?.fileName).toMatch(/^FrameCapt .+\.mp4$/);
    expect(item?.exists).toBe(true);
    const probed = probeFile(item?.path ?? '');
    expect(probed.streams.find((stream) => stream.codec_type === 'video')?.codec_name).toBe('h264');
    expect(item?.durationMs ?? 0).toBeGreaterThan(1000);

    // The WebM went to the (stubbed) bin only after the MP4 was in place; nothing else is left.
    const dirOf = path.dirname(item?.path ?? '');
    expect(fs.readdirSync(dirOf).filter((name) => name.endsWith('.webm'))).toEqual([]);
    expect(fs.readdirSync(dirOf).filter((name) => name.includes('.partial'))).toEqual([]);
    expect((await trashed(app)).map((file) => path.extname(file))).toEqual(['.webm']);

    // The final file (not the WebM that was replaced) is what Ctrl+V pastes.
    await expect
      .poll(async () => (await clipboardFiles(app)).map((uri) => decodeURIComponent(uri)), {
        timeout: 15_000,
      })
      .toEqual([expect.stringMatching(/\.mp4$/)]);
  });

  test('with the defaults (WebM, no compression) the recording stays a WebM and is copied as a file', async () => {
    const { app, page } = await launch({
      settings: { version: 1, recording: { countdown: false } },
    });
    await stubTrash(app);
    await recordOnce(page);
    await expect.poll(async () => (await historyItems(page)).length).toBe(1);
    const [item] = await historyItems(page);
    expect(item?.format).toBe('webm');
    await expect
      .poll(async () => (await clipboardFiles(app)).map((uri) => decodeURIComponent(uri)), {
        timeout: 15_000,
      })
      .toEqual([expect.stringContaining('.webm')]);
    expect(await trashed(app)).toEqual([]);
  });

  test('with auto-copy off for recordings the clipboard is left alone', async () => {
    const { app, page } = await launch({
      settings: { version: 1, recording: { countdown: false, autoCopy: false } },
    });
    await app.evaluate(async ({ clipboard }) => clipboard.writeText('my own copy'));
    await recordOnce(page);
    await expect.poll(async () => (await historyItems(page)).length).toBe(1);
    await page.waitForTimeout(500);
    expect(await app.evaluate(({ clipboard }) => clipboard.readText())).toBe('my own copy');
  });
});

test.describe('Save in another format', () => {
  function seedClip(dir: string): { id: string; file: string } {
    const files = path.join(dir, 'files');
    fs.mkdirSync(files, { recursive: true });
    const file = path.join(files, 'Clip.webm');
    makeWebm(file, 2, { audio: true });
    const id = newId();
    seedHistory(dir, [
      {
        id,
        type: 'recording',
        path: file,
        createdAt: Date.now(),
        width: 640,
        height: 360,
        durationMs: 2000,
        sizeBytes: fs.statSync(file).size,
        format: 'webm',
        hasAudio: true,
        source: 'screen',
      },
    ]);
    return { id, file };
  }

  test('creates a derived MP4 next to the recording and never replaces it', async () => {
    let seeded: { id: string; file: string } | undefined;
    const { app, page } = await launch({
      seed: (dir) => {
        seeded = seedClip(dir);
      },
    });
    await stubTrash(app);
    await goTo(page, 'History');
    await expect(page.getByTestId('history-item')).toHaveCount(1);
    await page.getByTestId('history-item').first().locator('[data-card-main]').click();
    await page.getByTestId('details-save-as').click();
    const dialog = page.getByTestId('save-as-dialog');
    await expect(dialog).toBeVisible();
    // The source is a WebM: MP4 is chosen, with no compression yet. Say "Balanced".
    await dialog
      .getByTestId('save-as-compression')
      .getByRole('radio', { name: 'Balanced' })
      .click();
    await expect(dialog.getByTestId('save-as-hint')).toContainText('40–60 % smaller MP4');
    await dialog.getByTestId('save-as-go').click();

    await expect.poll(async () => (await historyItems(page)).length, { timeout: 60_000 }).toBe(2);
    const items = await historyItems(page);
    const copy = items.find((item) => item.format === 'mp4');
    const source = items.find((item) => item.format === 'webm');
    expect(copy?.derivedFrom).toBe(seeded?.id);
    expect(path.dirname(copy?.path ?? '')).toBe(path.dirname(seeded?.file ?? ''));
    expect(copy?.fileName).toBe('Clip.mp4');
    expect(source?.path).toBe(seeded?.file);
    expect(fs.existsSync(seeded?.file ?? '')).toBe(true);
    expect(await trashed(app)).toEqual([]);
    expect(probeFile(copy?.path ?? '').streams.map((stream) => stream.codec_name)).toContain(
      'h264',
    );
  });

  test('MKV with no compression is a lossless re-wrap; the card menu and context menu offer the action', async () => {
    const { page, app } = await launch({ seed: (dir) => void seedClip(dir) });
    await stubTrash(app);
    await goTo(page, 'History');
    const card = page.getByTestId('history-item').first();
    await card.getByTestId('history-more').click();
    await expect(page.getByTestId('history-menu-save-as')).toBeVisible();
    await page.keyboard.press('Escape');
    await card.locator('[data-card-main]').click({ button: 'right' });
    await expect(page.getByTestId('ctx-save-as')).toBeVisible();
    await page.getByTestId('ctx-save-as').click();

    const dialog = page.getByTestId('save-as-dialog');
    await dialog.getByTestId('save-as-format').getByRole('radio', { name: 'MKV' }).click();
    await expect(dialog.getByTestId('save-as-hint')).toContainText('without re-encoding');
    await dialog.getByTestId('save-as-go').click();

    await expect
      .poll(async () => (await historyItems(page)).map((item) => item.format).sort(), {
        timeout: 60_000,
      })
      .toEqual(['mkv', 'webm']);
    const mkv = (await historyItems(page)).find((item) => item.format === 'mkv');
    const codecs = probeFile(mkv?.path ?? '').streams.map((stream) => stream.codec_name);
    expect(codecs).toEqual(expect.arrayContaining(['vp9', 'opus']));
    expect(mkv?.fileName).toBe('Clip.mkv');

    // Chromium plays Matroska with VP9 + Opus: the details view shows the player. (When a codec
    // cannot be played it shows a note and Open instead; see history-video-unplayable.)
    await page
      .getByTestId('history-item')
      .filter({ hasText: 'Clip.mkv' })
      .locator('[data-card-main]')
      .click();
    const video = page.getByTestId('history-video');
    await expect(video).toBeVisible();
    await expect
      .poll(() => video.evaluate((element: HTMLVideoElement) => element.videoWidth), {
        timeout: 15_000,
      })
      .toBe(640);
    await expect(page.getByTestId('history-video-unplayable')).toHaveCount(0);
    await expect(page.getByTestId('details-open')).toBeVisible();
  });

  test('the dialog refuses a change that changes nothing, and a GIF of a long recording', async () => {
    const { page } = await launch({
      seed: (dir) => {
        const { id } = seedClip(dir);
        // The recording is "five minutes long" as far as History knows.
        const file = path.join(dir, 'history', 'history.json');
        const data = JSON.parse(fs.readFileSync(file, 'utf8')) as {
          items: { id: string; durationMs: number }[];
        };
        for (const item of data.items) if (item.id === id) item.durationMs = 300_000;
        fs.writeFileSync(file, JSON.stringify(data));
      },
    });
    await goTo(page, 'History');
    await page.getByTestId('history-item').first().locator('[data-card-main]').click();
    await page.getByTestId('details-save-as').click();
    const dialog = page.getByTestId('save-as-dialog');
    await dialog.getByTestId('save-as-format').getByRole('radio', { name: 'WebM' }).click();
    await expect(dialog.getByTestId('save-as-problem')).toContainText('Choose another format');
    await expect(dialog.getByTestId('save-as-go')).toBeDisabled();
    await dialog.getByTestId('save-as-format').getByRole('radio', { name: /GIF/ }).click();
    await expect(dialog.getByTestId('save-as-problem')).toContainText('up to 60 s');
    await expect(dialog.getByTestId('save-as-go')).toBeDisabled();
  });
});

/** Size of the PNG on the system clipboard, or null when there is none. */
function clipboardImageSize(app: ElectronApplication) {
  return app.evaluate(async ({ clipboard, nativeImage }) => {
    const [item] = await clipboard.read();
    if (!item?.types.includes('image/png')) return null;
    const bytes = Buffer.from(await (await item.getType('image/png')).arrayBuffer());
    return nativeImage.createFromBuffer(bytes).getSize();
  });
}

test.describe('screenshots', () => {
  test('a captured screenshot is on the clipboard as soon as the editor opens', async () => {
    const { app, page } = await launch();
    await app.evaluate(({ clipboard }) => clipboard.writeText('before'));
    await page.getByTestId('shot-screen').click();
    await expect(page.getByTestId('editor-dimensions')).toHaveText('2560 × 1440');
    await expect
      .poll(() => clipboardImageSize(app), { timeout: 10_000 })
      .toEqual({
        width: 2560,
        height: 1440,
      });
  });

  test('with auto-copy off for screenshots the clipboard is left alone', async () => {
    const { app, page } = await launch({
      settings: { version: 1, screenshots: { autoCopy: false } },
    });
    await app.evaluate(({ clipboard }) => clipboard.writeText('my own copy'));
    await page.getByTestId('shot-screen').click();
    await expect(page.getByTestId('editor-dimensions')).toHaveText('2560 × 1440');
    await page.waitForTimeout(500);
    expect(await app.evaluate(({ clipboard }) => clipboard.readText())).toBe('my own copy');
  });

  test('an old copy-and-editor setting still copies the capture and opens the editor', async () => {
    const { app, page } = await launch({
      settings: { version: 1, screenshots: { afterCapture: 'copy-and-editor' } },
    });
    await page.getByTestId('shot-screen').click();
    await expect(page.getByTestId('editor-dimensions')).toHaveText('2560 × 1440');
    await expect
      .poll(() => clipboardImageSize(app), { timeout: 10_000 })
      .toEqual({
        width: 2560,
        height: 1440,
      });
  });
});
