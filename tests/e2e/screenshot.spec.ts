/**
 * Screenshot workflow end to end, against the E2E build (mock capture provider + synthetic frames:
 * see scripts/package-e2e.mjs). Nothing here touches the real screens. The mock has two displays
 * with different scale factors and a negative origin, and display B's frame size (3440 x 1440) is
 * deliberately not bounds * scale (2293 * 1.5 = 3439.5), which exercises the frame-ratio mapping.
 *
 *   A  id 1001  bounds (0, 0) 2560 x 1440, scale 1    -> frame 2560 x 1440
 *   B  id 1002  bounds (-2293, 0) 2293 x 960, scale 1.5 -> frame 3440 x 1440
 *
 * Synthetic frames: R = floor(255 x / (w-1)), G = floor(255 y / (h-1)) (see synthetic-frame.ts).
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
const evidenceDir = path.join(projectRoot, 'docs', 'evidence', 'phase03');

let app: ElectronApplication;
let page: Page;
let userDataDir: string;
let outDir: string;

test.describe.configure({ mode: 'serial' });

test.beforeAll(async () => {
  expect(
    fs.existsSync(path.join(projectRoot, '.vite', 'build', 'main.cjs')),
    'Run `npm run package:e2e` first (npm run test:e2e does this).',
  ).toBe(true);
  userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'framelet-e2e-shots-'));
  outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'framelet-e2e-out-'));
  fs.mkdirSync(evidenceDir, { recursive: true });
  app = await electron.launch({
    args: ['.'],
    cwd: projectRoot,
    env: {
      ...process.env,
      FRAMELET_USER_DATA_DIR: userDataDir,
      FRAMELET_E2E_MOCK_CAPTURE: '1',
    },
  });
  page = await app.firstWindow();
  await page.waitForLoadState('domcontentloaded');
  await expect(page.getByTestId('shot-region')).toBeVisible();
});

test.afterAll(async () => {
  await app?.close();
  if (process.env.FRAMELET_DEBUG_LOG)
    console.log(fs.readFileSync(path.join(userDataDir, 'logs', 'main.log'), 'utf8'));
  for (const dir of [userDataDir, outDir])
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
});

// --- helpers ---------------------------------------------------------------------------------

function overlayPages(): Page[] {
  return app.windows().filter((candidate) => candidate.url().includes('#/overlay'));
}

/** The overlay page of display `displayId`, once its renderer has drawn. */
async function overlayFor(displayId: string, testId: string): Promise<Page> {
  let found: Page | undefined;
  await expect
    .poll(
      async () => {
        for (const candidate of overlayPages()) {
          const root = candidate.locator(`[data-testid="${testId}"]`);
          if ((await root.count()) && (await root.getAttribute('data-display-id')) === displayId) {
            found = candidate;
            return true;
          }
        }
        return false;
      },
      { timeout: 15_000 },
    )
    .toBe(true);
  return found as Page;
}

async function expectNoOverlays(): Promise<void> {
  await expect.poll(() => overlayPages().length, { timeout: 10_000 }).toBe(0);
}

function shotDirs(): string[] {
  const dir = path.join(userDataDir, 'shots');
  return fs.existsSync(dir) ? fs.readdirSync(dir) : [];
}

async function drag(overlay: Page, from: [number, number], to: [number, number]): Promise<void> {
  await overlay.mouse.move(from[0], from[1]);
  await overlay.mouse.down();
  await overlay.mouse.move(to[0], to[1], { steps: 6 });
  await overlay.mouse.up();
}

/** Presses a key that ends the flow: the overlay window may be destroyed before Playwright hears back. */
async function pressClosing(overlay: Page, key: string): Promise<void> {
  await overlay.keyboard.press(key).catch((error: unknown) => {
    if (!/closed/i.test(String(error))) throw error;
  });
}

async function stubSaveDialog(filePath: string): Promise<void> {
  await app.evaluate(({ dialog }, target) => {
    dialog.showSaveDialog = (() =>
      Promise.resolve({ canceled: false, filePath: target })) as typeof dialog.showSaveDialog;
  }, filePath);
}

interface PngInfo {
  width: number;
  height: number;
  pixels: [number, number, number][];
}

/** Decodes PNG bytes in the renderer and returns the size and the RGB of the requested pixels. */
async function readPng(file: string, points: [number, number][]): Promise<PngInfo> {
  const base64 = fs.readFileSync(file).toString('base64');
  return page.evaluate(
    async ({ data, at }) => {
      const bytes = Uint8Array.from(atob(data), (char) => char.charCodeAt(0));
      const bitmap = await createImageBitmap(new Blob([bytes], { type: 'image/png' }));
      const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
      const context = canvas.getContext('2d') as OffscreenCanvasRenderingContext2D;
      context.drawImage(bitmap, 0, 0);
      const pixels = at.map(([x, y]) => {
        const [r, g, b] = context.getImageData(x, y, 1, 1).data;
        return [r ?? 0, g ?? 0, b ?? 0] as [number, number, number];
      });
      return { width: bitmap.width, height: bitmap.height, pixels };
    },
    { data: base64, at: points },
  );
}

/** Expected synthetic pixel of a frame at (x, y), see synthetic-frame.ts. */
function syntheticPixel(x: number, y: number, frameW: number, frameH: number): number[] {
  return [
    Math.floor((255 * x) / (frameW - 1)),
    Math.floor((255 * y) / (frameH - 1)),
    ((x >> 6) + (y >> 6)) & 1 ? 200 : 60,
  ];
}

function expectPixel(actual: number[], expected: number[]): void {
  actual.forEach((value, index) =>
    expect(Math.abs(value - (expected[index] ?? 0))).toBeLessThanOrEqual(1),
  );
}

async function leaveResult(): Promise<void> {
  await page.getByTestId('result-new').click();
  const confirm = page.getByTestId('confirm-yes');
  if (await confirm.isVisible().catch(() => false)) await confirm.click();
  await expect(page.getByTestId('result-view')).toHaveCount(0);
  await expect(page.getByTestId('shot-region')).toBeVisible();
}

async function expectMainVisible(): Promise<void> {
  const window = await app.browserWindow(page);
  await expect.poll(() => window.evaluate((win) => win.isVisible())).toBe(true);
}

// --- tests -----------------------------------------------------------------------------------

test('Screenshot buttons are enabled and Record buttons stay unavailable with a tooltip', async () => {
  const shots = page.getByTestId('mode-screenshot');
  for (const name of ['Screen', 'Window', 'Region']) {
    await expect(shots.getByRole('button', { name })).not.toHaveAttribute('aria-disabled', 'true');
    await expect(shots.getByRole('button', { name })).toBeEnabled();
  }
  const record = page.getByTestId('mode-record');
  for (const name of ['Screen', 'Window', 'Region']) {
    await expect(record.getByRole('button', { name })).toHaveAttribute('aria-disabled', 'true');
  }
  await record.getByRole('button', { name: 'Screen' }).hover();
  await expect(page.getByRole('tooltip').first()).toContainText(
    'Recording arrives in the next build',
  );
});

test('region flow: overlays on both displays, drag, Enter, result size, save PNG', async () => {
  const before = shotDirs().length;
  await page.getByTestId('shot-region').click();
  await expect(page.getByTestId('flow-status')).toContainText('Select an area');

  const a = await overlayFor('1001', 'overlay-region');
  const b = await overlayFor('1002', 'overlay-region');
  expect(overlayPages()).toHaveLength(2);
  // The main window is hidden while the overlays are up.
  const main = await app.browserWindow(page);
  expect(await main.evaluate((win) => win.isVisible())).toBe(false);

  // Drag 640x360 DIP at (200,150) on display A (scale 1, frame == bounds).
  await drag(a, [200, 150], [840, 510]);
  await expect(a.getByTestId('size-label')).toHaveText('640 × 360');
  await expect(a.locator('[data-handle]')).toHaveCount(8);
  await expect(a.getByTestId('action-bar')).toBeVisible();

  // Display B's selection is untouched; starting a drag on B clears A.
  await drag(b, [100, 100], [160, 140]);
  await expect(a.getByTestId('overlay-region')).toHaveAttribute('data-selection', '');
  // 60 x 40 DIP: x ratio 3440/2293 rounds outward (150.02 -> 150, 240.03 -> 241), y ratio is 1.5.
  await expect(b.getByTestId('size-label')).toHaveText('91 × 60');
  await b.mouse.click(1000, 800); // outside the selection: starts and ends a click -> too small
  await expect(b.getByTestId('overlay-region')).toHaveAttribute('data-selection', '');

  await drag(a, [200, 150], [840, 510]);
  await pressClosing(a, 'Enter');

  await expect(page.getByTestId('result-dimensions')).toHaveText('640 × 360 px');
  await expectNoOverlays();
  await expectMainVisible();
  expect(shotDirs().length).toBe(before + 1);

  const target = path.join(outDir, 'region-a.png');
  await stubSaveDialog(target);
  await page.getByTestId('result-save-png').click();
  await expect.poll(() => fs.existsSync(target)).toBe(true);
  const png = await readPng(target, [
    [0, 0],
    [639, 359],
    [320, 180],
  ]);
  expect({ w: png.width, h: png.height }).toEqual({ w: 640, h: 360 });
  expectPixel(png.pixels[0] ?? [], syntheticPixel(200, 150, 2560, 1440));
  expectPixel(png.pixels[1] ?? [], syntheticPixel(839, 509, 2560, 1440));
  expectPixel(png.pixels[2] ?? [], syntheticPixel(520, 330, 2560, 1440));
  await expect(page.getByText(/Saved to/)).toBeVisible();

  // Saved: leaving needs no confirmation.
  await page.getByTestId('result-new').click();
  await expect(page.getByTestId('result-view')).toHaveCount(0);
  await expect(page.getByTestId('confirm-dialog')).toBeHidden();
});

test('region on display B uses the actual frame ratio (2293 DIP -> 3440 px)', async () => {
  await page.getByTestId('shot-region').click();
  const b = await overlayFor('1002', 'overlay-region');
  // 600 x 300 DIP at (300, 200). x ratio 3440/2293, y ratio 1.5.
  await drag(b, [300, 200], [900, 500]);
  const rx = 3440 / 2293;
  const x0 = Math.floor(300 * rx + 1e-6);
  const x1 = Math.ceil(900 * rx - 1e-6);
  const expectedW = x1 - x0;
  await expect(b.getByTestId('size-label')).toHaveText(`${expectedW} × 450`);
  await pressClosing(b, 'Enter');
  await expect(page.getByTestId('result-dimensions')).toHaveText(`${expectedW} × 450 px`);

  const target = path.join(outDir, 'region-b.png');
  await stubSaveDialog(target);
  await page.getByTestId('result-save-png').click();
  await expect.poll(() => fs.existsSync(target)).toBe(true);
  const png = await readPng(target, [[0, 0]]);
  expect({ w: png.width, h: png.height }).toEqual({ w: expectedW, h: 450 });
  expectPixel(png.pixels[0] ?? [], syntheticPixel(x0, 300, 3440, 1440));
  await leaveResult();
});

test('region: keyboard nudge, resize and double click', async () => {
  await page.getByTestId('shot-region').click();
  const a = await overlayFor('1001', 'overlay-region');
  await drag(a, [400, 300], [500, 380]); // 100 x 80
  await expect(a.getByTestId('size-label')).toHaveText('100 × 80');

  const selection = async () =>
    JSON.parse((await a.getByTestId('overlay-region').getAttribute('data-selection')) ?? 'null');
  await a.keyboard.press('ArrowRight');
  await a.keyboard.press('ArrowDown');
  expect(await selection()).toMatchObject({ x: 401, y: 301 });
  await a.keyboard.press('Shift+ArrowLeft');
  expect(await selection()).toMatchObject({ x: 391, y: 301 });

  // Resize with the south-east handle: drag it 20 px right and 10 px down.
  const handle = a.locator('[data-handle="se"]');
  const box = (await handle.boundingBox()) as {
    x: number;
    y: number;
    width: number;
    height: number;
  };
  await a.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await a.mouse.down();
  await a.mouse.move(box.x + box.width / 2 + 20, box.y + box.height / 2 + 10, { steps: 4 });
  await a.mouse.up();
  await expect(a.getByTestId('size-label')).toHaveText('120 × 90');

  // Double click inside the selection confirms.
  const current = await selection();
  await a.mouse.dblclick(current.x + 30, current.y + 30);
  await expect(page.getByTestId('result-dimensions')).toHaveText('120 × 90 px');
  await leaveResult();
});

test('Esc cancels: overlays close, no session is created, focus returns to the trigger', async () => {
  const before = shotDirs().length;
  await page.getByTestId('shot-region').focus();
  await page.getByTestId('shot-region').press('Enter');
  const a = await overlayFor('1001', 'overlay-region');
  await pressClosing(a, 'Escape');
  await expectNoOverlays();
  await expectMainVisible();
  expect(shotDirs().length).toBe(before);
  await expect(page.getByTestId('shot-region')).toBeEnabled();
  await expect
    .poll(() => page.evaluate(() => document.activeElement?.getAttribute('data-testid')))
    .toBe('shot-region');
  await expect(page.getByTestId('flow-status')).toBeEmpty();
});

test('a second capture while overlays are open is rejected with BUSY', async () => {
  await page.getByTestId('shot-region').click();
  const a = await overlayFor('1001', 'overlay-region');
  const second = await page.evaluate(() =>
    window.framelet.invoke('capture:startScreenshot', { target: 'region' }),
  );
  expect(second).toMatchObject({ ok: false, error: { code: 'BUSY' } });
  // The original flow is still alive and cancellable.
  await pressClosing(a, 'Escape');
  await expectNoOverlays();
  // Idempotent cancel: nothing breaks and a new flow can start.
  const third = await page.evaluate(() =>
    window.framelet.invoke('capture:startScreenshot', { target: 'region' }),
  );
  expect(third).toMatchObject({ ok: true });
  const again = await overlayFor('1001', 'overlay-region');
  await pressClosing(again, 'Escape');
  await expectNoOverlays();
});

test('screens changing while overlays are open cancels with a message', async () => {
  const before = shotDirs().length;
  await page.getByTestId('shot-region').click();
  await overlayFor('1001', 'overlay-region');
  await app.evaluate(({ screen }) => {
    screen.emit('display-metrics-changed', {}, screen.getPrimaryDisplay(), ['bounds']);
  });
  await expectNoOverlays();
  await expect(page.getByText('Your screens changed — please try again.')).toBeVisible();
  expect(shotDirs().length).toBe(before);
  await expectMainVisible();
});

test('screen flow with two displays: click the highlight on display B', async () => {
  await page.getByTestId('shot-screen').click();
  const a = await overlayFor('1001', 'overlay-pick');
  const b = await overlayFor('1002', 'overlay-pick');
  await b.mouse.move(400, 300);
  await expect(b.getByTestId('overlay-pick')).toHaveAttribute('data-active', 'true');
  await expect(b.getByText('Click to capture this screen')).toBeVisible();
  void a;
  await b.mouse.click(400, 300);
  await expect(page.getByTestId('result-dimensions')).toHaveText('3440 × 1440 px');
  await expectNoOverlays();
  await expectMainVisible();
  await leaveResult();
});

test('window picker: grid, search, keyboard navigation and Enter to capture', async () => {
  const trigger = page.getByTestId('shot-window');
  await trigger.click();
  const picker = page.getByTestId('source-picker');
  await expect(picker).toBeVisible();
  const cards = picker.getByTestId('window-card');
  await expect(cards).toHaveCount(5);
  // The long title is truncated visually but available in full as the tooltip.
  await expect(
    picker.locator('[data-testid="window-card"][title*="must be truncated"]'),
  ).toHaveCount(1);

  await picker.getByTestId('window-search').fill('terminal');
  await expect(cards).toHaveCount(1);
  await picker.getByTestId('window-search').fill('zzz');
  await expect(picker.getByText('No windows to capture')).toBeVisible();
  await picker.getByTestId('window-search').fill('');
  await expect(cards).toHaveCount(5);

  // Keyboard: ArrowDown from the search box lands on the first card, arrows move the focus.
  await picker.getByTestId('window-search').focus();
  await page.keyboard.press('ArrowDown');
  await expect(cards.nth(0)).toBeFocused();
  await page.keyboard.press('ArrowRight');
  await expect(cards.nth(1)).toBeFocused();
  await page.keyboard.press('ArrowLeft');
  await expect(cards.nth(0)).toBeFocused();
  await page.keyboard.press('End');
  await expect(cards.nth(4)).toBeFocused();
  await page.keyboard.press('Home');
  await page.keyboard.press('Enter');

  await expect(page.getByTestId('result-dimensions')).toHaveText('1280 × 720 px');
  await expectMainVisible();
  await leaveResult();
});

test('window picker: Esc closes it and focus returns to the Window button', async () => {
  const trigger = page.getByTestId('shot-window');
  await trigger.click();
  await expect(page.getByTestId('source-picker')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('source-picker')).toBeHidden();
  await expect(trigger).toBeFocused();
});

test('a window that cannot be captured shows the minimized/protected error and restores focus', async () => {
  const before = shotDirs();
  const trigger = page.getByTestId('shot-window');
  await trigger.click();
  const picker = page.getByTestId('source-picker');
  await picker.locator('[data-testid="window-card"][data-source-id="window:1005:0"]').click();
  await expect(
    page.getByText("That window is minimized or can't be captured. Restore it and try again."),
  ).toBeVisible();
  await expectMainVisible();
  await expect(trigger).toBeFocused();
  await expect(page.getByTestId('flow-status')).toBeEmpty();
  expect(shotDirs()).toEqual(before);
});

test('copy puts a PNG on the clipboard; discard asks first when nothing was saved', async () => {
  await page.getByTestId('shot-screen').click();
  const b = await overlayFor('1002', 'overlay-pick');
  await b.mouse.click(300, 300);
  await expect(page.getByTestId('result-view')).toBeVisible();

  await page.getByTestId('result-copy').click();
  await expect(page.getByText('Copied to clipboard')).toBeVisible();
  const size = await app.evaluate(async ({ clipboard, nativeImage }) => {
    const items = await clipboard.read();
    const blob = await items[0]?.getType('image/png');
    if (!blob || (typeof blob === 'object' && !('arrayBuffer' in blob))) return null;
    const image = nativeImage.createFromBuffer(Buffer.from(await blob.arrayBuffer()));
    return image.getSize();
  });
  expect(size).toEqual({ width: 3440, height: 1440 });
  await leaveResult(); // copied counts as safe: no confirmation
});

test('discarding an unsaved screenshot asks for confirmation and deletes the session', async () => {
  const before = shotDirs().length;
  await page.getByTestId('shot-screen').click();
  const b = await overlayFor('1002', 'overlay-pick');
  await b.mouse.click(300, 300);
  await expect(page.getByTestId('result-view')).toBeVisible();
  expect(shotDirs().length).toBe(before + 1);

  await page.getByTestId('result-discard').click();
  await expect(page.getByTestId('confirm-dialog')).toBeVisible();
  await page.getByRole('button', { name: 'Keep it' }).click();
  await expect(page.getByTestId('confirm-dialog')).toBeHidden();
  expect(shotDirs().length).toBe(before + 1);

  await page.getByTestId('result-discard').click();
  await page.getByTestId('confirm-yes').click();
  await expect(page.getByTestId('result-view')).toHaveCount(0);
  await expect.poll(() => shotDirs().length).toBe(before);
});

test('saving JPEG writes a real JPEG with the right size', async () => {
  await page.getByTestId('shot-region').click();
  const a = await overlayFor('1001', 'overlay-region');
  await drag(a, [100, 100], [420, 340]); // 320 x 240
  await pressClosing(a, 'Enter');
  await expect(page.getByTestId('result-dimensions')).toHaveText('320 × 240 px');

  const target = path.join(outDir, 'shot.jpg');
  await stubSaveDialog(target);
  await page.getByTestId('result-save-jpeg').click();
  await expect.poll(() => fs.existsSync(target)).toBe(true);
  const bytes = fs.readFileSync(target);
  expect([...bytes.subarray(0, 3)]).toEqual([0xff, 0xd8, 0xff]);
  await leaveResult();
});

test('export and clipboard channels validate their input in main', async () => {
  const wrongMagic = await page.evaluate(async () => {
    const bytes = new Uint8Array([1, 2, 3, 4, 5]).buffer;
    return window.framelet.invoke('shot:copy', { sessionId: 'x', bytes });
  });
  expect(wrongMagic).toMatchObject({ ok: false });

  // shell:showItemInFolder only accepts paths Framelet exported itself.
  const showForeign = await page.evaluate(() =>
    window.framelet.invoke('shell:showItemInFolder', {
      path: 'C:\\Windows\\System32\\notepad.exe',
    }),
  );
  expect(showForeign).toMatchObject({ ok: false, error: { code: 'FORBIDDEN' } });

  // Overlay and worker channels are closed to the main window.
  const overlayFromMain = await page.evaluate(() =>
    (window.framelet.invoke as (c: string) => Promise<unknown>)('overlay:getInit'),
  );
  expect(overlayFromMain).toMatchObject({ ok: false, error: { code: 'FORBIDDEN' } });
  const workerFromMain = await page.evaluate(() =>
    (window.framelet.invoke as (c: string) => Promise<unknown>)('worker:ready'),
  );
  expect(workerFromMain).toMatchObject({ ok: false, error: { code: 'FORBIDDEN' } });
});

test('UI evidence: overlay, picker and result in both themes', async () => {
  const snap = async (
    target: Page,
    name: string,
    clip?: { x: number; y: number; width: number; height: number },
  ) => {
    // Colors transition for 150 ms after a theme change; wait so the shot shows the settled state.
    await target.waitForTimeout(400);
    await target.screenshot({ path: path.join(evidenceDir, name), ...(clip ? { clip } : {}) });
  };

  // Region overlay with a selection.
  await page.getByTestId('shot-region').click();
  const a = await overlayFor('1001', 'overlay-region');
  for (const scheme of ['dark', 'light'] as const) {
    await a.emulateMedia({ colorScheme: scheme });
    await a.mouse.move(60, 60);
    await snap(a, `ui-overlay-hint-${scheme}.png`, { x: 480, y: 0, width: 1600, height: 160 });
  }
  await drag(a, [300, 200], [940, 560]);
  await expect(a.getByTestId('action-bar')).toBeVisible();
  for (const scheme of ['dark', 'light'] as const) {
    await a.emulateMedia({ colorScheme: scheme });
    await snap(a, `ui-overlay-selection-${scheme}.png`, { x: 0, y: 0, width: 1280, height: 800 });
  }
  await pressClosing(a, 'Enter');
  await expect(page.getByTestId('result-view')).toBeVisible();

  for (const scheme of ['dark', 'light'] as const) {
    await page.emulateMedia({ colorScheme: scheme });
    await snap(page, `ui-result-${scheme}.png`);
  }
  await leaveResult();

  for (const scheme of ['dark', 'light'] as const) {
    await page.emulateMedia({ colorScheme: scheme });
    await snap(page, `ui-home-${scheme}.png`);
  }

  // Display picker overlay.
  await page.getByTestId('shot-screen').click();
  const pickA = await overlayFor('1001', 'overlay-pick');
  await overlayFor('1002', 'overlay-pick');
  await pickA.mouse.move(600, 400);
  for (const scheme of ['dark', 'light'] as const) {
    await pickA.emulateMedia({ colorScheme: scheme });
    await snap(pickA, `ui-overlay-pick-${scheme}.png`, {
      x: 640,
      y: 320,
      width: 1280,
      height: 800,
    });
  }
  await pressClosing(pickA, 'Escape');
  await expectNoOverlays();

  // Window picker dialog.
  await page.getByTestId('shot-window').click();
  await expect(page.getByTestId('window-card')).toHaveCount(5);
  for (const scheme of ['dark', 'light'] as const) {
    await page.emulateMedia({ colorScheme: scheme });
    await snap(page, `ui-picker-${scheme}.png`);
  }
  await page.keyboard.press('Escape');
  await page.emulateMedia({ colorScheme: null });
});

test.describe('single display', () => {
  test('Screenshot > Screen skips the overlays and captures immediately', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'framelet-e2e-single-'));
    const single = await electron.launch({
      args: ['.'],
      cwd: projectRoot,
      env: {
        ...process.env,
        FRAMELET_USER_DATA_DIR: dir,
        FRAMELET_E2E_MOCK_CAPTURE: '1',
        FRAMELET_E2E_MOCK_DISPLAYS: '1',
      },
    });
    try {
      const main = await single.firstWindow();
      await main.waitForLoadState('domcontentloaded');
      await main.getByTestId('shot-screen').click();
      await expect(main.getByTestId('result-dimensions')).toHaveText('2560 × 1440 px');
      expect(single.windows().filter((w) => w.url().includes('#/overlay'))).toHaveLength(0);
    } finally {
      await single.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
