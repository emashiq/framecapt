/**
 * Native verification of the screenshot workflow on the real host (production build, real
 * desktopCapturer/getDisplayMedia, real windows). Needs an interactive Windows session. Run with
 * `npm run test:native`. Evidence (redacted JSON, plus PNGs that are gitignored because they show
 * the real desktop) goes to docs/evidence/phase03/.
 *
 * What is NOT physically testable on this host and is covered by unit tests only (see
 * tests/unit/geometry.test.ts): mixed DPI scale factors, negative display origins, rotated
 * displays. Both displays here have scale factor 1 and the primary sits at (0, 0).
 *
 * The overlay pages are driven with Playwright mouse/keyboard events (CDP), not OS-level input.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import {
  _electron as electron,
  expect,
  test,
  type ElectronApplication,
  type Page,
} from '@playwright/test';
import { redactPaths, writeEvidenceJson } from './evidence';

const projectRoot = path.resolve(__dirname, '..', '..');
const evidenceDir = path.join(projectRoot, 'docs', 'evidence', 'phase03');
const electronPath = createRequire(__filename)('electron') as unknown as string;

const MAGENTA: [number, number, number] = [255, 0, 255];

interface Display {
  id: string;
  bounds: { x: number; y: number; width: number; height: number };
  scaleFactor: number;
  physicalSize: { width: number; height: number };
  isPrimary: boolean;
}

let app: ElectronApplication;
let page: Page;
let userDataDir: string;
let outDir: string;
let displays: Display[] = [];
const evidence: Record<string, unknown> = {};
const timings: Record<string, number> = {};
const edgeSharpness: Record<string, unknown>[] = [];

test.describe.configure({ mode: 'serial' });

test.beforeAll(async () => {
  expect(
    fs.existsSync(path.join(projectRoot, '.vite', 'build', 'main.cjs')),
    'Run `electron-forge package` first (npm run test:native does this).',
  ).toBe(true);
  userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'framelet-native-shots-'));
  outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'framelet-native-out-'));
  fs.mkdirSync(evidenceDir, { recursive: true });
  app = await electron.launch({
    args: ['.'],
    cwd: projectRoot,
    env: { ...process.env, FRAMELET_USER_DATA_DIR: userDataDir },
  });
  page = await app.firstWindow();
  await page.waitForLoadState('domcontentloaded');
  await expect(page.getByTestId('shot-region')).toBeVisible();
  const listed = await page.evaluate(() => window.framelet.invoke('capture:listDisplays'));
  if (!listed.ok) throw new Error('capture:listDisplays failed');
  displays = listed.data;
  expect(displays.length).toBeGreaterThan(0);
});

test.afterAll(async () => {
  await app?.close();
  for (const dir of [userDataDir, outDir])
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
});

// --- helpers ---------------------------------------------------------------------------------

function overlayPages(): Page[] {
  return app.windows().filter((candidate) => candidate.url().includes('#/overlay'));
}

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
      { timeout: 20_000 },
    )
    .toBe(true);
  return found as Page;
}

async function expectNoOverlays(): Promise<void> {
  await expect.poll(() => overlayPages().length, { timeout: 10_000 }).toBe(0);
}

function shotDirs(): string[] {
  const dir = path.join(userDataDir, 'shots');
  return fs.existsSync(dir) ? fs.readdirSync(dir).sort() : [];
}

async function pressClosing(overlay: Page, key: string): Promise<void> {
  await overlay.keyboard.press(key).catch((error: unknown) => {
    if (!/closed/i.test(String(error))) throw error;
  });
}

async function drag(overlay: Page, from: [number, number], to: [number, number]): Promise<void> {
  await overlay.mouse.move(from[0], from[1]);
  await overlay.mouse.down();
  await overlay.mouse.move(to[0], to[1], { steps: 8 });
  await overlay.mouse.up();
}

async function stubSaveDialog(filePath: string): Promise<void> {
  await app.evaluate(({ dialog }, target) => {
    dialog.showSaveDialog = (() =>
      Promise.resolve({ canceled: false, filePath: target })) as typeof dialog.showSaveDialog;
  }, filePath);
}

function pngSize(file: string): { width: number; height: number } {
  const header = fs.readFileSync(file).subarray(0, 24);
  expect(header.subarray(1, 4).toString('ascii')).toBe('PNG');
  return { width: header.readUInt32BE(16), height: header.readUInt32BE(20) };
}

interface Region {
  x: number;
  y: number;
  width: number;
  height: number;
}

interface PngStats {
  width: number;
  height: number;
  /** Fraction of the pixels inside `region` within `tolerance` of the color. */
  fraction: number;
  /** For every probe point: is it near the color? */
  probes: boolean[];
  probeColors: number[][];
}

/** Decodes a PNG in the renderer and measures how much of a region is a given color. */
async function measurePng(
  file: string,
  color: [number, number, number],
  options: {
    region?: Region;
    probes?: [number, number][];
    tolerance?: number;
    /** Looser tolerance for probes: video frames are 4:2:0, so hard color edges bleed by a pixel. */
    probeTolerance?: number;
  } = {},
): Promise<PngStats> {
  const base64 = fs.readFileSync(file).toString('base64');
  return page.evaluate(
    async ({ data, wanted, region, probes, tolerance, probeTolerance }) => {
      const bytes = Uint8Array.from(atob(data), (char) => char.charCodeAt(0));
      const bitmap = await createImageBitmap(new Blob([bytes], { type: 'image/png' }));
      const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
      const context = canvas.getContext('2d', {
        willReadFrequently: true,
      }) as OffscreenCanvasRenderingContext2D;
      context.drawImage(bitmap, 0, 0);
      const area = region ?? { x: 0, y: 0, width: bitmap.width, height: bitmap.height };
      const pixels = context.getImageData(area.x, area.y, area.width, area.height).data;
      const nearWithin =
        (limit: number) =>
        (r: number, g: number, b: number): boolean =>
          Math.abs(r - wanted[0]) <= limit &&
          Math.abs(g - wanted[1]) <= limit &&
          Math.abs(b - wanted[2]) <= limit;
      const near = nearWithin(tolerance);
      const nearProbe = nearWithin(probeTolerance);
      let hits = 0;
      for (let i = 0; i < pixels.length; i += 4) {
        if (near(pixels[i] ?? 0, pixels[i + 1] ?? 0, pixels[i + 2] ?? 0)) hits += 1;
      }
      const probeColors = probes.map(([x, y]) => Array.from(context.getImageData(x, y, 1, 1).data));
      const probeHits = probeColors.map(([r, g, b]) => nearProbe(r ?? 0, g ?? 0, b ?? 0));
      return {
        width: bitmap.width,
        height: bitmap.height,
        fraction: hits / (pixels.length / 4),
        probes: probeHits,
        probeColors,
      };
    },
    {
      data: base64,
      wanted: color,
      region: options.region ?? null,
      probes: options.probes ?? [],
      tolerance: options.tolerance ?? 12,
      probeTolerance: options.probeTolerance ?? options.tolerance ?? 12,
    },
  );
}

/** A frameless, always-on-top window of one solid color at an exact DIP rect; returns its id. */
async function openColorWindow(
  rect: Region,
  color = '#FF00FF',
): Promise<{ id: number; bounds: Region }> {
  return app.evaluate(
    async ({ BrowserWindow }, { r, hex }) => {
      const win = new BrowserWindow({
        x: r.x,
        y: r.y,
        width: r.width,
        height: r.height,
        frame: false,
        resizable: false,
        show: false,
        skipTaskbar: true,
        hasShadow: false,
        // No Windows 11 border or rounded corners: the edges must be crisp for exact-inset checks.
        thickFrame: false,
        roundedCorners: false,
        backgroundColor: hex,
        webPreferences: {},
      });
      win.setAlwaysOnTop(true, 'screen-saver');
      await win.loadURL('about:blank');
      await win.webContents.executeJavaScript(
        `document.documentElement.style.background = '${hex}'; document.body.style.cssText = 'margin:0;background:${hex}'`,
      );
      win.setBounds(r);
      win.show();
      await new Promise((resolve) => setTimeout(resolve, 800));
      return { id: win.id, bounds: win.getBounds() };
    },
    { r: rect, hex: color },
  );
}

async function closeColorWindow(id: number): Promise<void> {
  await app.evaluate(
    ({ BrowserWindow }, windowId) => BrowserWindow.fromId(windowId)?.destroy(),
    id,
  );
}

async function leaveResult(): Promise<void> {
  await page.getByTestId('result-new').click();
  const confirm = page.getByTestId('confirm-yes');
  if (await confirm.isVisible().catch(() => false)) await confirm.click();
  await expect(page.getByTestId('result-view')).toHaveCount(0);
  await expect(page.getByTestId('shot-region')).toBeVisible();
}

async function saveCurrentResult(name: string): Promise<string> {
  const target = path.join(outDir, name);
  await stubSaveDialog(target);
  await page.getByTestId('result-save-png').click();
  await expect.poll(() => fs.existsSync(target), { timeout: 15_000 }).toBe(true);
  return target;
}

function keepEvidence(file: string, name: string): string {
  fs.copyFileSync(file, path.join(evidenceDir, name));
  return `docs/evidence/phase03/${name}`;
}

async function overlayBounds(): Promise<Region[]> {
  return app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()
      .filter((win) => win.webContents.getURL().includes('#/overlay'))
      .map((win) => win.getBounds()),
  );
}

// --- tests -----------------------------------------------------------------------------------

test('(a) Screenshot > Screen: picking each display exports its exact physical size', async () => {
  const rows: Record<string, unknown>[] = [];
  for (const display of displays) {
    const scale = display.physicalSize.width / display.bounds.width;
    const local = { x: 200, y: 150, width: 400, height: 300 };
    const color = await openColorWindow({
      x: display.bounds.x + local.x,
      y: display.bounds.y + local.y,
      width: local.width,
      height: local.height,
    });
    try {
      const started = Date.now();
      await page.getByTestId('shot-screen').click();
      for (const other of displays) await overlayFor(other.id, 'overlay-pick');
      timings[`screenPickOverlaysMs_${display.id}`] = Date.now() - started;

      // Overlay windows sit exactly on their display.
      if (display === displays[0]) {
        const boundsList = await overlayBounds();
        evidence.overlayBoundsPickDisplay = displays.map((d) => ({
          display: d.bounds,
          overlay: boundsList.find(
            (b) =>
              b.x === d.bounds.x &&
              b.y === d.bounds.y &&
              b.width === d.bounds.width &&
              b.height === d.bounds.height,
          ),
        }));
        for (const d of displays) {
          expect(
            boundsList.some(
              (b) =>
                b.x === d.bounds.x &&
                b.y === d.bounds.y &&
                b.width === d.bounds.width &&
                b.height === d.bounds.height,
            ),
            `overlay for display ${d.id} has the display's bounds`,
          ).toBe(true);
        }
      }

      const overlay = await overlayFor(display.id, 'overlay-pick');
      await overlay.mouse.move(300, 300);
      await expect(overlay.getByTestId('overlay-pick')).toHaveAttribute('data-active', 'true');
      const clicked = Date.now();
      await overlay.mouse.click(300, 300);
      await expect(page.getByTestId('result-dimensions')).toHaveText(
        `${display.physicalSize.width} × ${display.physicalSize.height} px`,
        { timeout: 20_000 },
      );
      timings[`screenPickToResultMs_${display.id}`] = Date.now() - clicked;
      await expectNoOverlays();

      const file = await saveCurrentResult(`screen-${display.id}.png`);
      const size = pngSize(file);
      expect(size).toEqual(display.physicalSize);

      // The magenta window must appear at its place, uncontaminated by overlay highlights.
      const region: Region = {
        x: Math.round(local.x * scale),
        y: Math.round(local.y * scale),
        width: Math.round(local.width * scale),
        height: Math.round(local.height * scale),
      };
      const stats = await measurePng(file, MAGENTA, { region });
      expect(stats.fraction).toBeGreaterThanOrEqual(0.98);

      // Copy puts the same image on the clipboard.
      if (display === displays[0]) {
        await page.getByTestId('result-copy').click();
        await expect(page.getByText('Copied to clipboard')).toBeVisible();
        const clip = await app.evaluate(async ({ clipboard, nativeImage }) => {
          const items = await clipboard.read();
          const blob = await items[0]?.getType('image/png');
          if (!blob || !('arrayBuffer' in blob)) return null;
          return nativeImage.createFromBuffer(Buffer.from(await blob.arrayBuffer())).getSize();
        });
        expect(clip).toEqual(display.physicalSize);
        evidence.clipboardSize = clip;
      }

      rows.push({
        displayId: display.id,
        physical: display.physicalSize,
        exported: size,
        equal: true,
        colorWindowBounds: color.bounds,
        magentaFractionInWindowRect: Math.round(stats.fraction * 10000) / 10000,
        evidence: keepEvidence(file, `screen-${display.id}.png`),
      });
      await leaveResult();
    } finally {
      await closeColorWindow(color.id);
    }
  }
  evidence.screenPick = rows;
});

test('(b)+(d) Region fidelity on every display: exact size, exact inset, no overlay in the output', async () => {
  const rows: Record<string, unknown>[] = [];
  for (const display of displays) {
    const scale = display.physicalSize.width / display.bounds.width;
    // A solid dark backdrop under the magenta window keeps the surroundings controlled.
    const backdrop = await openColorWindow(
      {
        x: display.bounds.x + 140,
        y: display.bounds.y + 90,
        width: 520,
        height: 420,
      },
      '#2A2A2A',
    );
    const win = await openColorWindow({
      x: display.bounds.x + 200,
      y: display.bounds.y + 150,
      width: 400,
      height: 300,
    });
    try {
      // Exactly the window: 400 x 300 at local (200,150).
      const started = Date.now();
      await page.getByTestId('shot-region').click();
      const overlay = await overlayFor(display.id, 'overlay-region');
      for (const other of displays) await overlayFor(other.id, 'overlay-region');
      timings[`regionOverlaysMs_${display.id}`] = Date.now() - started;
      if (display === displays[0]) {
        const boundsList = await overlayBounds();
        evidence.overlayBoundsRegion = displays.map((d) => ({
          display: d.bounds,
          matched: boundsList.some(
            (b) =>
              b.x === d.bounds.x &&
              b.y === d.bounds.y &&
              b.width === d.bounds.width &&
              b.height === d.bounds.height,
          ),
        }));
      }
      await drag(overlay, [200, 150], [600, 450]);
      await expect(overlay.getByTestId('size-label')).toHaveText('400 × 300');
      const enterAt = Date.now();
      await pressClosing(overlay, 'Enter');
      await expect(page.getByTestId('result-dimensions')).toHaveText('400 × 300 px', {
        timeout: 15_000,
      });
      timings[`regionConfirmToResultMs_${display.id}`] = Date.now() - enterAt;
      await expectNoOverlays();
      const exact = await saveCurrentResult(`region-exact-${display.id}.png`);
      const exactSize = pngSize(exact);
      expect(exactSize).toEqual({ width: 400, height: 300 });
      const exactStats = await measurePng(exact, MAGENTA);
      expect(exactStats.fraction).toBeGreaterThanOrEqual(0.98);
      await leaveResult();

      // Expanded by 20 px on every side: 440 x 340, magenta inset by exactly 20 px.
      await page.getByTestId('shot-region').click();
      const overlay2 = await overlayFor(display.id, 'overlay-region');
      await drag(overlay2, [180, 130], [620, 470]);
      await expect(overlay2.getByTestId('size-label')).toHaveText('440 × 340');
      await pressClosing(overlay2, 'Enter');
      await expect(page.getByTestId('result-dimensions')).toHaveText('440 × 340 px', {
        timeout: 15_000,
      });
      const wide = await saveCurrentResult(`region-expanded-${display.id}.png`);
      expect(pngSize(wide)).toEqual({ width: 440, height: 340 });
      keepEvidence(wide, `region-expanded-${display.id}.png`);
      const xs = [60, 100, 140, 180, 220, 260, 300, 340, 380];
      const ys = [60, 100, 140, 180, 220, 260];
      const probes: [number, number][] = [
        ...ys.flatMap(
          (y) =>
            [
              [19, y],
              [20, y],
              [419, y],
              [420, y],
            ] as [number, number][],
        ),
        ...xs.flatMap(
          (x) =>
            [
              [x, 19],
              [x, 20],
              [x, 319],
              [x, 320],
            ] as [number, number][],
        ),
      ];
      const wideStats = await measurePng(wide, MAGENTA, {
        region: { x: 20, y: 20, width: 400, height: 300 },
        probes,
        probeTolerance: 110,
      });
      const at = (px: number, py: number): boolean | undefined =>
        wideStats.probes[probes.findIndex(([x, y]) => x === px && y === py)];
      const insetOk =
        ys.every(
          (y) =>
            at(19, y) === false &&
            at(20, y) === true &&
            at(419, y) === true &&
            at(420, y) === false,
        ) &&
        xs.every(
          (x) =>
            at(x, 19) === false &&
            at(x, 20) === true &&
            at(x, 319) === true &&
            at(x, 320) === false,
        );
      expect(
        insetOk,
        `magenta starts exactly 20 px in on all four sides; probes: ${JSON.stringify(probes.map(([x, y], i) => [x, y, wideStats.probes[i], wideStats.probeColors[i]?.join('/')]))}`,
      ).toBe(true);
      expect(wideStats.fraction).toBeGreaterThanOrEqual(0.98);

      // Edge sharpness: the getDisplayMedia frame is 4:2:0 video, so a hard magenta edge bleeds by
      // a pixel. For comparison, the same edge from a full-size desktopCapturer thumbnail.
      const colorAt = (px: number, py: number): number[] | undefined =>
        wideStats.probeColors[probes.findIndex(([x, y]) => x === px && y === py)]?.slice(0, 3);
      const thumbnailEdge = await app.evaluate(
        async ({ desktopCapturer }, { id, size, x, y }) => {
          const sources = await desktopCapturer.getSources({
            types: ['screen'],
            thumbnailSize: size,
          });
          const image = sources.find((source) => source.display_id === id)?.thumbnail;
          if (!image) return null;
          const bitmap = image.toBitmap(); // BGRA
          const width = image.getSize().width;
          const at = (px: number): number[] => {
            const i = (y * width + px) * 4;
            return [bitmap[i + 2] ?? 0, bitmap[i + 1] ?? 0, bitmap[i] ?? 0];
          };
          return { size: image.getSize(), outside: at(x - 1), edge: at(x) };
        },
        { id: display.id, size: display.physicalSize, x: 200, y: 230 },
      );
      edgeSharpness.push({
        displayId: display.id,
        magentaTrue: [255, 0, 255],
        getDisplayMediaFrame: { outside: colorAt(19, 100), edge: colorAt(20, 100) },
        desktopCapturerThumbnail: thumbnailEdge,
      });
      await leaveResult();

      rows.push({
        displayId: display.id,
        scaleFactor: display.scaleFactor,
        colorWindowBounds: win.bounds,
        exact: {
          dragLocalDip: [200, 150, 400, 300],
          exportedSize: exactSize,
          magentaFraction: Math.round(exactStats.fraction * 10000) / 10000,
        },
        expanded: {
          dragLocalDip: [180, 130, 440, 340],
          exportedSize: { width: 440, height: 340 },
          insetExactly20px: insetOk,
          innerMagentaFraction: Math.round(wideStats.fraction * 10000) / 10000,
        },
        evidence: [
          keepEvidence(exact, `region-exact-${display.id}.png`),
          keepEvidence(wide, `region-expanded-${display.id}.png`),
        ],
        pixelRatio: scale,
      });
    } finally {
      await closeColorWindow(win.id);
      await closeColorWindow(backdrop.id);
    }
  }
  evidence.regionFidelity = rows;
  evidence.edgeSharpness = edgeSharpness;
});

test('(d) The hint pill and dim never reach the output (selection under the pill)', async () => {
  const display = displays.find((d) => d.isPrimary) ?? (displays[0] as Display);
  const width = 900;
  const win = await openColorWindow({
    x: display.bounds.x + Math.round((display.bounds.width - width) / 2),
    y: display.bounds.y,
    width,
    height: 400,
  });
  try {
    await page.getByTestId('shot-region').click();
    const overlay = await overlayFor(display.id, 'overlay-region');
    const centerX = Math.round(display.bounds.width / 2);
    // The pill is visible and lies inside the area we are about to select.
    const hint = overlay.getByTestId('overlay-hint');
    await expect(hint).toBeVisible();
    const hintBox = (await hint.boundingBox()) as Region;
    const from: [number, number] = [centerX - 300, 8];
    const to: [number, number] = [centerX + 300, 160];
    expect(hintBox.y + hintBox.height).toBeGreaterThan(from[1]);
    expect(hintBox.y).toBeLessThan(to[1]);
    expect(hintBox.x).toBeGreaterThan(from[0]);
    expect(hintBox.x + hintBox.width).toBeLessThan(to[0]);

    await drag(overlay, from, to);
    // Handles and the action bar are drawn on top of the selection edges in the overlay.
    await expect(overlay.locator('[data-handle]')).toHaveCount(8);
    // What the user sees on the real desktop (gitignored: it shows real screen content).
    await overlay.screenshot({
      path: path.join(evidenceDir, 'real-overlay-selection.png'),
      clip: { x: centerX - 700, y: 0, width: 1400, height: 420 },
    });
    await pressClosing(overlay, 'Enter');
    await expect(page.getByTestId('result-dimensions')).toHaveText('600 × 152 px', {
      timeout: 15_000,
    });
    const file = await saveCurrentResult('region-under-pill.png');
    const stats = await measurePng(file, MAGENTA);
    expect(stats.fraction).toBeGreaterThanOrEqual(0.98);
    evidence.overlayExclusion = {
      displayId: display.id,
      hintPillBox: hintBox,
      selection: { from, to },
      exportedSize: { width: stats.width, height: stats.height },
      magentaFraction: Math.round(stats.fraction * 10000) / 10000,
      note: 'The output is the frozen frame crop; the 45% dim, selection border, handles, pill and action bar are DOM drawn over it and never part of it.',
    };
    await leaveResult();
  } finally {
    await closeColorWindow(win.id);
  }
});

test('region selection can be dragged past the screen edge and is clamped to the display', async () => {
  const display = displays[0] as Display;
  await page.getByTestId('shot-region').click();
  const overlay = await overlayFor(display.id, 'overlay-region');
  await drag(overlay, [0, 0], [display.bounds.width + 200, display.bounds.height + 200]);
  await expect(overlay.getByTestId('size-label')).toHaveText(
    `${display.physicalSize.width} × ${display.physicalSize.height}`,
  );
  await expect(overlay.getByTestId('overlay-hint')).toContainText('Selections stay on one screen');
  await pressClosing(overlay, 'Enter');
  await expect(page.getByTestId('result-dimensions')).toHaveText(
    `${display.physicalSize.width} × ${display.physicalSize.height} px`,
    { timeout: 20_000 },
  );
  evidence.regionClampedToDisplay = { displayId: display.id, size: display.physicalSize };
  await leaveResult();
});

test('(c) Window screenshot of a real external window; minimized and vanished windows', async () => {
  const title = `framelet-native-fixture-${Date.now()}`;
  const primary = displays.find((d) => d.isPrimary) ?? (displays[0] as Display);
  const fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), 'framelet-fixture-'));
  const fixture: ChildProcess = spawn(
    electronPath,
    [
      path.join(__dirname, 'fixtures', 'color-window.mjs'),
      title,
      String(primary.bounds.x + 120),
      String(primary.bounds.y + 120),
      fixtureDir,
    ],
    { shell: false, stdio: ['ignore', 'pipe', 'pipe'] },
  );
  try {
    const ready = await new Promise<{ bounds: Region; contentBounds: Region }>(
      (resolve, reject) => {
        let text = '';
        const timer = setTimeout(() => reject(new Error('fixture window did not start')), 30_000);
        fixture.stdout?.on('data', (chunk: Buffer) => {
          text += chunk.toString();
          const line = text.split('\n').find((candidate) => candidate.startsWith('READY '));
          if (line) {
            clearTimeout(timer);
            resolve(
              JSON.parse(line.slice('READY '.length)) as { bounds: Region; contentBounds: Region },
            );
          }
        });
        fixture.once('error', reject);
      },
    );

    // Open the picker, search for the fixture by its (unique) title and pick it.
    await page.getByTestId('shot-window').click();
    const picker = page.getByTestId('source-picker');
    await expect(picker).toBeVisible();
    await picker.getByTestId('window-search').fill(title);
    const card = picker.getByTestId('window-card');
    await expect(card).toHaveCount(1, { timeout: 15_000 });
    const sourceId = (await card.getAttribute('data-source-id')) as string;
    const started = Date.now();
    await card.click();
    await expect(page.getByTestId('result-dimensions')).toHaveText(/\d+ × \d+ px/, {
      timeout: 20_000,
    });
    timings.windowCaptureMs = Date.now() - started;
    const dims = (await page.getByTestId('result-dimensions').textContent()) ?? '';
    const [capturedW, capturedH] = (/(\d+) × (\d+)/.exec(dims) ?? []).slice(1).map(Number) as [
      number,
      number,
    ];
    const file = await saveCurrentResult('window-fixture.png');
    expect(pngSize(file)).toEqual({ width: capturedW, height: capturedH });

    const content = ready.contentBounds;
    const outer = ready.bounds;
    // Whatever Windows includes around the window, the content must be there and sharp.
    expect(capturedW).toBeGreaterThanOrEqual(content.width);
    expect(capturedH).toBeGreaterThanOrEqual(content.height);
    const centerRegion: Region = {
      x: Math.max(0, Math.floor(capturedW / 2) - 150),
      y: Math.max(0, Math.floor(capturedH / 2) - 100),
      width: 300,
      height: 200,
    };
    const stats = await measurePng(file, MAGENTA, { region: centerRegion });
    expect(stats.fraction).toBeGreaterThanOrEqual(0.98);
    const equalsContent = capturedW === content.width && capturedH === content.height;
    const equalsOuter = capturedW === outer.width && capturedH === outer.height;
    evidence.windowCapture = {
      requestedContentSize: { width: 640, height: 400 },
      windowBoundsOuterDip: { width: outer.width, height: outer.height },
      windowContentBoundsDip: { width: content.width, height: content.height },
      capturedSize: { width: capturedW, height: capturedH },
      capturedEqualsContentSize: equalsContent,
      capturedEqualsOuterBounds: equalsOuter,
      frameAndTitleBarIncluded: capturedW > content.width || capturedH > content.height,
      centerMagentaFraction: Math.round(stats.fraction * 10000) / 10000,
      captureMs: timings.windowCaptureMs,
      evidence: keepEvidence(file, 'window-fixture.png'),
    };
    await leaveResult();

    // Minimized: record whether the window is still offered and what the capture does.
    fs.writeFileSync(path.join(fixtureDir, 'command.txt'), 'minimize');
    await new Promise((resolve) => setTimeout(resolve, 1200));
    await page.getByTestId('shot-window').click();
    await expect(picker).toBeVisible();
    await picker.getByTestId('window-search').fill(title);
    await expect(page.getByTestId('window-skeletons')).toHaveCount(0, { timeout: 15_000 });
    const listedWhileMinimized = (await picker.getByTestId('window-card').count()) === 1;
    let minimizedOutcome: string;
    if (listedWhileMinimized) {
      await picker.getByTestId('window-card').click();
      const error = page.getByText(
        "That window is minimized or can't be captured. Restore it and try again.",
      );
      const result = page.getByTestId('result-dimensions');
      await expect
        .poll(async () => (await error.count()) + (await result.count()), { timeout: 20_000 })
        .toBeGreaterThan(0);
      if (await error.count()) minimizedOutcome = 'error shown: minimized or cannot be captured';
      else {
        minimizedOutcome = `a ${(await result.textContent()) ?? ''} image was produced`;
        await leaveResult();
      }
    } else {
      minimizedOutcome = 'not listed by desktopCapturer while minimized, so it cannot be picked';
      await picker.getByRole('button', { name: 'Cancel' }).click();
      await expect(picker).toBeHidden();
    }
    evidence.minimizedWindow = { listedWhileMinimized, outcome: minimizedOutcome };

    // A source that vanished between listing and capture.
    fs.writeFileSync(path.join(fixtureDir, 'command.txt'), 'quit');
    await new Promise<void>((resolve) => {
      fixture.once('exit', () => resolve());
      setTimeout(resolve, 5000);
    });
    const gone = await page.evaluate(
      (id) => window.framelet.invoke('capture:startScreenshot', { target: 'window', sourceId: id }),
      sourceId,
    );
    expect(gone).toMatchObject({ ok: false, error: { code: 'NOT_FOUND' } });
    evidence.vanishedWindow = { code: (gone as { error?: { code?: string } }).error?.code };
    await expect(page.getByTestId('shot-region')).toBeEnabled();
  } finally {
    fixture.kill();
    await new Promise((resolve) => setTimeout(resolve, 1500));
    fs.rmSync(fixtureDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 });
  }
});

test('(e) Cancel leaves no overlay, no session and no dangling window', async () => {
  const display = displays[0] as Display;
  const windowCount = () =>
    app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length);
  const dirsBefore = shotDirs();
  const baseline = await windowCount();

  for (const via of ['Escape', 'button', 'right-click'] as const) {
    await page.getByTestId('shot-region').click();
    const overlay = await overlayFor(display.id, 'overlay-region');
    expect(await windowCount()).toBe(baseline + displays.length);
    if (via === 'Escape') await pressClosing(overlay, 'Escape');
    else if (via === 'right-click')
      await overlay.mouse.click(50, 50, { button: 'right' }).catch(() => undefined);
    else {
      await drag(overlay, [100, 100], [300, 250]);
      await overlay
        .getByTestId('overlay-cancel')
        .click()
        .catch(() => undefined);
    }
    await expectNoOverlays();
    await expect.poll(windowCount).toBe(baseline);
    await expect(page.getByTestId('shot-region')).toBeEnabled();
  }
  expect(shotDirs()).toEqual(dirsBefore);

  // Screen picking too.
  await page.getByTestId('shot-screen').click();
  const pick = await overlayFor(display.id, 'overlay-pick');
  await pressClosing(pick, 'Escape');
  await expectNoOverlays();
  await expect.poll(windowCount).toBe(baseline);
  expect(shotDirs()).toEqual(dirsBefore);

  evidence.cancel = {
    baselineWindows: baseline,
    afterEachCancel: baseline,
    shotsDirectoriesBefore: dirsBefore.length,
    shotsDirectoriesAfter: shotDirs().length,
    paths: ['Escape', 'Cancel button', 'right click', 'Escape in screen picker'],
  };
});

test('main log has no capture content and no window titles; evidence is redacted', async () => {
  const log = fs.readFileSync(path.join(userDataDir, 'logs', 'main.log'), 'utf8');
  expect(log).not.toContain('framelet-native-fixture');
  expect(log).not.toMatch(/data:image|base64/i);
  evidence.logLines = log
    .split('\n')
    .filter((line) => /Overlay bounds mismatch|differs from display/.test(line)).length;

  writeEvidenceJson(evidenceDir, 'screenshots-native.json', {
    date: new Date().toISOString(),
    host: {
      os: `${os.type()} ${os.release()} ${os.arch()}`,
      cpu: os.cpus()[0]?.model?.trim(),
      electron: await app.evaluate(() => process.versions.electron),
    },
    displays: displays.map((d) => ({
      id: d.id,
      bounds: d.bounds,
      scaleFactor: d.scaleFactor,
      physicalSize: d.physicalSize,
      isPrimary: d.isPrimary,
    })),
    timingsMs: timings,
    ...evidence,
  });

  const written = fs.readFileSync(path.join(evidenceDir, 'screenshots-native.json'), 'utf8');
  expect(written).not.toContain(os.homedir());
  expect(written).not.toContain('framelet-native-fixture');
  expect(redactPaths(written)).toBe(written);
});
