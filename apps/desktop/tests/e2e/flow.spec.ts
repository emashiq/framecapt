/**
 * Step guides end to end (E2E build, mock capture): start steps from the Capture view, take two
 * steps (the global-shortcut action and the pill's camera button), Done, the guide in History, the
 * Flow view (two steps, a caption, the title), the HTML export with its caption escaped, History's
 * Guides filter, reorder / delete / undo, and the rules: nothing else starts while a guide is being
 * captured, and Cancel throws it away.
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
import { editorPage, expectEditorClosed } from './editor-window';

const projectRoot = path.resolve(__dirname, '..', '..');

let app: ElectronApplication;
let page: Page;
let userDataDir: string;

const guidesDir = (): string => path.join(userDataDir, 'pictures', 'FrameCapt');
const guideFolders = (): string[] =>
  fs.existsSync(guidesDir())
    ? fs.readdirSync(guidesDir()).filter((name) => name.startsWith('FrameCapt Steps '))
    : [];
const readFlow = (folder: string) =>
  JSON.parse(fs.readFileSync(path.join(guidesDir(), folder, 'flow.json'), 'utf8')) as {
    title?: string;
    steps: { file: string; caption: string; width: number; cursor: unknown }[];
  };

type Hooks = {
  runAction(action: string): void;
  stepsState(): { state: string; count: number; auto: boolean; notice: string | null };
  trayMenu(): { label: string; enabled: boolean; accelerator?: string }[];
};
const hooks = <T>(fn: (h: Hooks) => T): Promise<T> =>
  app.evaluate((_electron, source) => {
    const h = (globalThis as unknown as { __frameCaptTest: Hooks }).__frameCaptTest;
    return new Function('h', `return (${source})(h)`)(h) as never;
  }, fn.toString());

async function pillPage(): Promise<Page> {
  let found: Page | undefined;
  await expect
    .poll(() => (found = app.windows().find((w) => w.url().includes('mode=steps'))) !== undefined, {
      timeout: 20_000,
    })
    .toBe(true);
  const pill = found as Page;
  await expect(pill.getByTestId('steps-pill')).toBeVisible();
  return pill;
}

async function nav(name: string): Promise<void> {
  await page.getByRole('navigation', { name: 'Primary' }).getByRole('button', { name }).click();
}

test.beforeAll(async () => {
  expect(
    fs.existsSync(path.join(projectRoot, '.vite', 'build', 'main.cjs')),
    'Run `npm run package:e2e` first (npm run test:e2e does this).',
  ).toBe(true);
  userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'framecapt-e2e-flow-'));
  app = await electron.launch({
    args: ['.'],
    cwd: projectRoot,
    env: {
      ...process.env,
      FRAMECAPT_USER_DATA_DIR: userDataDir,
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
  if (userDataDir) fs.rmSync(userDataDir, { recursive: true, force: true });
});

test.describe.configure({ mode: 'serial' });

test('the Capture view offers Steps, with how it works and its shortcut', async () => {
  await expect(page.getByTestId('mode-steps')).toBeVisible();
  await expect(page.getByTestId('steps-hint')).toContainText('pause');
  await expect(page.getByTestId('hint-stepsToggle')).toBeVisible();
  await expect(page.getByTestId('steps-start')).toBeEnabled();
  // The tray offers it too.
  const menu = await hooks((h) => h.trayMenu());
  expect(menu.find((item) => item.label === 'Capture steps')).toMatchObject({
    enabled: true,
    accelerator: 'Ctrl+Shift+8',
  });
});

test('start, two steps, Done: a guide in History and the Flow view', async () => {
  await page.getByTestId('steps-start').click();
  const pill = await pillPage();
  await expect(pill.getByTestId('steps-count')).toHaveText('0 steps');
  expect((await hooks((h) => h.stepsState())).state).toBe('active');

  // Step 1 through the shortcut's action, step 2 through the pill's camera button.
  await hooks((h) => h.runAction('stepsCapture'));
  await expect(pill.getByTestId('steps-count')).toHaveText('1 step');
  await pill.getByTestId('steps-capture').click();
  await expect(pill.getByTestId('steps-count')).toHaveText('2 steps');

  await pill.getByTestId('steps-done').click();
  await expect(page.getByTestId('flow-view')).toBeVisible({ timeout: 20_000 });
  await expect(page.getByTestId('flow-step')).toHaveCount(2);
  await expect(page.getByTestId('flow-count')).toContainText('2 steps');
  expect((await hooks((h) => h.stepsState())).state).toBe('idle');

  // The folder and its files are on disk, with empty captions.
  await expect.poll(() => guideFolders().length).toBe(1);
  const folder = guideFolders()[0] as string;
  expect(folder).toMatch(/^FrameCapt Steps \d{4}-\d{2}-\d{2} at \d{2}\.\d{2}\.\d{2}$/);
  expect(fs.readdirSync(path.join(guidesDir(), folder)).sort()).toEqual([
    'flow.json',
    'step-01.png',
    'step-02.png',
  ]);
  expect(readFlow(folder).steps.map((s) => s.caption)).toEqual(['', '']);

  // The pictures load through the main-owned route, with the ring on its own canvas.
  const image = page.getByTestId('flow-step-image').first();
  await expect(image).toBeVisible();
  await expect
    .poll(() => image.evaluate((img) => (img as HTMLImageElement).naturalWidth))
    .toBeGreaterThan(0);
  await expect(page.getByTestId('flow-step-ring').first()).toBeAttached();
});

test('edit the title and a caption: saved to flow.json by themselves', async () => {
  await page.getByTestId('flow-title').fill('Set up the thing');
  const caption = '<b>Click</b> "Save" & go';
  await page.getByTestId('flow-step-caption').first().fill(caption);
  const folder = guideFolders()[0] as string;
  await expect.poll(() => readFlow(folder).steps[0]?.caption, { timeout: 10_000 }).toBe(caption);
  expect(readFlow(folder).title).toBe('Set up the thing');
});

test('export as HTML: one file with the caption escaped and nothing external', async () => {
  const target = path.join(userDataDir, 'guide.html');
  await app.evaluate(({ dialog }, file) => {
    dialog.showSaveDialog = (() =>
      Promise.resolve({ canceled: false, filePath: file })) as typeof dialog.showSaveDialog;
  }, target);
  await page.getByTestId('flow-export').click();
  await page.getByTestId('flow-export-html').click();
  await expect.poll(() => fs.existsSync(target), { timeout: 20_000 }).toBe(true);
  const html = fs.readFileSync(target, 'utf8');
  expect(html).toContain('&lt;b&gt;Click&lt;/b&gt; &quot;Save&quot; &amp; go');
  expect(html).toContain('<title>Set up the thing</title>');
  expect(html).not.toContain('<b>Click</b>');
  expect(html).not.toMatch(/<script/i);
  expect(html).not.toMatch(/https?:\/\//i);
  expect(html.match(/<img /g)).toHaveLength(2);
  await expect(page.getByText('Guide saved')).toBeVisible();
});

test('export as an MP4 slideshow: a real file, and a derived item in History', async () => {
  const target = path.join(userDataDir, 'guide.mp4');
  await app.evaluate(({ dialog }, file) => {
    dialog.showSaveDialog = (() =>
      Promise.resolve({ canceled: false, filePath: file })) as typeof dialog.showSaveDialog;
  }, target);
  await page.getByTestId('flow-export').click();
  await page.getByTestId('flow-export-mp4').click();
  await expect(page.getByText('Guide video saved')).toBeVisible({ timeout: 60_000 });
  const bytes = fs.readFileSync(target);
  // An MP4 starts with a `ftyp` box.
  expect(bytes.subarray(4, 8).toString('latin1')).toBe('ftyp');
  const listed = await page.evaluate(() => window.framecapt.invoke('history:list', {}));
  if (!listed.ok) throw new Error('history:list failed');
  const guide = listed.data.items.find((item) => item.type === 'flow');
  const video = listed.data.items.find((item) => item.format === 'mp4');
  expect(video).toMatchObject({ type: 'recording', derivedFrom: guide?.id, hasAudio: false });
  expect(video?.durationMs).toBeGreaterThan(4500);
  expect(video?.durationMs).toBeLessThan(5500);
  // Take the derived video out of the list again so the next checks see one guide.
  await page.evaluate((id) => window.framecapt.invoke('history:remove', { id }), video?.id ?? '');
});

test('Open in editor on one step: Save changes writes over that step alone, the guide stays one item', async () => {
  const folder = guideFolders()[0] as string;
  const first = path.join(guidesDir(), folder, 'step-01.png');
  const second = path.join(guidesDir(), folder, 'step-02.png');
  const firstBefore = fs.readFileSync(first);
  const secondBefore = fs.readFileSync(second);

  await page.getByTestId('flow-step-edit').first().click();
  // The step opens as a tab of the Editor window.
  const editor = await editorPage(app);
  await expect(editor.getByTestId('editor-view')).toBeVisible({ timeout: 20_000 });
  await expect(editor.getByTestId('editor-save')).toHaveText(/Save changes/);
  await expect(editor.getByTestId('tab-title')).toContainText('(step 1)');
  await editor.getByTestId('tool-rect').click();
  const box = await editor.getByTestId('editor-canvas').boundingBox();
  if (!box) throw new Error('the editor canvas has no box');
  await editor.mouse.move(box.x + 80, box.y + 80);
  await editor.mouse.down();
  await editor.mouse.move(box.x + 260, box.y + 200, { steps: 6 });
  await editor.mouse.up();
  await editor.getByTestId('editor-save').click();
  await editor.getByTestId('confirm-yes').click();
  await expect(editor.getByText(/Changes saved/).first()).toBeVisible();
  await expect.poll(() => fs.readFileSync(first).equals(firstBefore)).toBe(false);
  expect(fs.readFileSync(second).equals(secondBefore)).toBe(true);
  expect(readFlow(folder).steps.map((s) => s.file)).toEqual(['step-01.png', 'step-02.png']);
  expect(fs.readdirSync(path.join(guidesDir(), folder)).sort()).toEqual([
    'flow.json',
    'step-01.png',
    'step-02.png',
  ]);

  // Back out of the editor: History still has the one guide and nothing else.
  await editor.getByTestId('editor-done').click();
  await expectEditorClosed(app);
  const listed = await page.evaluate(() => window.framecapt.invoke('history:list', {}));
  if (!listed.ok) throw new Error('history:list failed');
  expect(listed.data.items.map((item) => item.type)).toEqual(['flow']);
  await nav('History');
  await page.getByTestId('history-open').click();
  await expect(page.getByTestId('flow-view')).toBeVisible();
  await expect(page.getByTestId('flow-step')).toHaveCount(2);
});

test('reorder, delete and undo from the Flow view', async () => {
  const folder = guideFolders()[0] as string;
  await page.getByTestId('flow-step-down').first().click();
  await expect
    .poll(() => readFlow(folder).steps.map((s) => s.file), { timeout: 10_000 })
    .toEqual(['step-02.png', 'step-01.png']);
  await page.getByTestId('flow-step-delete').first().click();
  await expect(page.getByTestId('flow-step')).toHaveCount(1);
  await expect.poll(() => readFlow(folder).steps.length).toBe(1);
  // The last step cannot be deleted.
  await expect(page.getByTestId('flow-step-delete').first()).toBeDisabled();
  await page.getByRole('button', { name: 'Undo' }).click();
  await expect(page.getByTestId('flow-step')).toHaveCount(2);
  await expect.poll(() => readFlow(folder).steps.length).toBe(2);
});

test('History lists the guide with its steps, opens it in the Flow view and filters to Guides', async () => {
  await nav('History');
  await expect(page.getByTestId('history-item')).toHaveCount(1);
  await expect(page.getByTestId('history-type')).toContainText('2 steps');
  await page.getByTestId('history-filter').getByRole('radio', { name: 'Guides' }).click();
  await expect(page.getByTestId('history-item')).toHaveCount(1);
  await page.getByTestId('history-open').click();
  await expect(page.getByTestId('flow-view')).toBeVisible();
  await expect(page.getByTestId('flow-title')).toHaveValue('Set up the thing');
  // Back to History: the guide's page offers Open and Show in folder.
  await page.getByTestId('flow-back').click();
  await page.getByTestId('history-filter').getByRole('radio', { name: 'All' }).click();
  await page.locator('[data-card-main]').first().click();
  await expect(page.getByTestId('history-details')).toBeVisible();
  await expect(page.getByTestId('details-open')).toHaveText('Open guide');
  await expect(page.getByTestId('details-edit')).toHaveCount(0);
  await page.getByTestId('history-back').click();
});

test('while a guide is captured nothing else starts; Cancel asks and discards everything', async () => {
  const before = guideFolders().length;
  await nav('Capture');
  await page.getByTestId('steps-start').click();
  const pill = await pillPage();
  await hooks((h) => h.runAction('stepsCapture'));
  await expect(pill.getByTestId('steps-count')).toHaveText('1 step');

  // A screenshot or a recording shortcut is refused with a message; the guide goes on.
  await hooks((h) => h.runAction('screenshotRegion'));
  await hooks((h) => h.runAction('recordScreen'));
  expect(await hooks((h) => h.stepsState().state)).toBe('active');
  expect(app.windows().filter((w) => w.url().includes('#/overlay'))).toHaveLength(0);
  const second = await page.evaluate(() => window.framecapt.invoke('steps:start'));
  expect(second.ok).toBe(false);
  const menu = await hooks((h) => h.trayMenu());
  expect(menu.find((item) => item.label === 'Finish step capture')).toBeDefined();

  // Auto and Pause are shown and work.
  await pill.getByTestId('steps-auto').click();
  expect((await hooks((h) => h.stepsState())).auto).toBe(false);
  await pill.getByTestId('steps-pause').click();
  await expect(pill.getByTestId('steps-pill')).toHaveAttribute('data-state', 'paused');
  await pill.getByTestId('steps-resume').click();
  await expect(pill.getByTestId('steps-pill')).toHaveAttribute('data-state', 'active');

  // Cancel asks first; keeping goes on, discarding throws everything away.
  await pill.getByTestId('steps-cancel').click();
  await pill.getByTestId('steps-cancel-keep').click();
  expect(await hooks((h) => h.stepsState().state)).toBe('active');
  await pill.getByTestId('steps-cancel').click();
  await pill.getByTestId('steps-cancel-confirm').click();
  await expect.poll(() => hooks((h) => h.stepsState().state)).toBe('idle');
  expect(guideFolders()).toHaveLength(before);
  expect(app.windows().some((w) => w.url().includes('mode=steps') && !w.isClosed())).toBe(false);
  // The main window is back and everything works again.
  await expect(page.getByTestId('steps-start')).toBeEnabled();
});

test('the Steps shortcut starts and finishes a guide; Done with no step saves nothing', async () => {
  const before = guideFolders().length;
  await hooks((h) => h.runAction('stepsToggle'));
  await pillPage();
  await expect.poll(() => hooks((h) => h.stepsState().state)).toBe('active');
  await hooks((h) => h.runAction('stepsToggle'));
  await expect.poll(() => hooks((h) => h.stepsState().state)).toBe('idle');
  expect(guideFolders()).toHaveLength(before);
});
