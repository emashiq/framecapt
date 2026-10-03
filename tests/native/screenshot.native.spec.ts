/**
 * Native verification of the screenshot workflow on the real host (production build, real
 * desktopCapturer/getDisplayMedia, real windows). Needs an interactive Windows session. Run with
 * `npm run test:native`. Evidence (redacted JSON, plus PNGs that are gitignored because they show
 * the real desktop) goes to docs/evidence/phase04/.
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
import { exitApp } from '../e2e/app-exit';
import { redactPaths, writeEvidenceJson, evidenceDirFor } from './evidence';

const projectRoot = path.resolve(__dirname, '..', '..');
const evidenceDir = evidenceDirFor(projectRoot, 'phase04');
const phase03Evidence = path.join(
  projectRoot,
  'docs',
  'evidence',
  'phase03',
  'screenshots-native.json',
);
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
const edgeExactness: Record<string, unknown>[] = [];

test.describe.configure({ mode: 'serial' });

test.beforeAll(async () => {
  expect(
    fs.existsSync(path.join(projectRoot, '.vite', 'build', 'main.cjs')),
    'Run `electron-forge package` first (npm run test:native does this).',
  ).toBe(true);
  userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'framecapt-native-shots-'));
  outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'framecapt-native-out-'));
  fs.mkdirSync(evidenceDir, { recursive: true });
  app = await electron.launch({
    args: ['.'],
    cwd: projectRoot,
    env: { ...process.env, FRAMECAPT_USER_DATA_DIR: userDataDir },
  });
  page = await app.firstWindow();
  await page.waitForLoadState('domcontentloaded');
  await expect(page.getByTestId('shot-region')).toBeVisible();
  const listed = await page.evaluate(() => window.framecapt.invoke('capture:listDisplays'));
  if (!listed.ok) throw new Error('capture:listDisplays failed');
  displays = listed.data;
  expect(displays.length).toBeGreaterThan(0);
});

test.afterAll(async () => {
  if (app) await exitApp(app);
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

const BACKDROP: [number, number, number] = [42, 42, 42];

/**
 * Pixel-exact edge check. Screens and regions come from desktopCapturer images, not from 4:2:0
 * video frames, so a hard edge must be exact: the first pixel inside the magenta rectangle is
 * (255, 0, 255) and the first pixel outside it is exactly the backdrop color, on all four sides.
 * `rect` is the magenta rectangle in the PNG; every probe is compared with tolerance 0.
 */
async function assertExactEdges(
  file: string,
  rect: Region,
  label: string,
): Promise<Record<string, unknown>> {
  const probes: [number, number][] = [];
  const kinds: ('inside' | 'outside')[] = [];
  const add = (x: number, y: number, kind: 'inside' | 'outside'): void => {
    probes.push([x, y]);
    kinds.push(kind);
  };
  const ys = [0.15, 0.35, 0.5, 0.65, 0.85].map((f) => rect.y + Math.floor(rect.height * f));
  const xs = [0.15, 0.35, 0.5, 0.65, 0.85].map((f) => rect.x + Math.floor(rect.width * f));
  for (const y of ys) {
    add(rect.x - 1, y, 'outside');
    add(rect.x, y, 'inside');
    add(rect.x + rect.width - 1, y, 'inside');
    add(rect.x + rect.width, y, 'outside');
  }
  for (const x of xs) {
    add(x, rect.y - 1, 'outside');
    add(x, rect.y, 'inside');
    add(x, rect.y + rect.height - 1, 'inside');
    add(x, rect.y + rect.height, 'outside');
  }
  const stats = await measurePng(file, MAGENTA, { probes, probeTolerance: 0 });
  const wrong = probes
    .map(([x, y], index) => ({ x, y, kind: kinds[index], color: stats.probeColors[index] ?? [] }))
    .filter(({ kind, color }) => {
      const want = kind === 'inside' ? MAGENTA : BACKDROP;
      return !(color[0] === want[0] && color[1] === want[1] && color[2] === want[2]);
    });
  expect(wrong, `${label}: edge pixels that are not exact`).toEqual([]);
  return { label, probes: probes.length, mismatches: wrong.length, tolerance: 0 };
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
  await page.getByTestId('editor-done').click();
  const confirm = page.getByTestId('confirm-yes');
  if (await confirm.isVisible().catch(() => false)) await confirm.click();
  await expect(page.getByTestId('editor-view')).toHaveCount(0);
  await expect(page.getByTestId('shot-region')).toBeVisible();
}

async function saveCurrentResult(name: string): Promise<string> {
  const target = path.join(outDir, name);
  await stubSaveDialog(target);
  await page.getByTestId('editor-save').click();
  await expect.poll(() => fs.existsSync(target), { timeout: 15_000 }).toBe(true);
  return target;
}

function keepEvidence(file: string, name: string): string {
  fs.copyFileSync(file, path.join(evidenceDir, name));
  return `docs/evidence/phase04/${name}`;
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
    // A solid backdrop under the magenta window: the first pixel outside it has a known color.
    const backdrop = await openColorWindow(
      {
        x: display.bounds.x + 140,
        y: display.bounds.y + 90,
        width: 520,
        height: 420,
      },
      '#2A2A2A',
    );
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
      await expect(page.getByTestId('editor-dimensions')).toHaveText(
        `${display.physicalSize.width} × ${display.physicalSize.height}`,
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
      const stats = await measurePng(file, MAGENTA, { region, tolerance: 0 });
      expect(stats.fraction).toBe(1);
      const edges = await assertExactEdges(file, region, `screen ${display.id}`);
      edgeExactness.push(edges);

      // Copy puts the same image on the clipboard.
      if (display === displays[0]) {
        await page.getByTestId('editor-copy').click();
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
        exactEdges: edges,
        evidence: keepEvidence(file, `screen-${display.id}.png`),
      });
      await leaveResult();
    } finally {
      await closeColorWindow(color.id);
      await closeColorWindow(backdrop.id);
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
      await expect(page.getByTestId('editor-dimensions')).toHaveText('400 × 300', {
        timeout: 15_000,
      });
      timings[`regionConfirmToResultMs_${display.id}`] = Date.now() - enterAt;
      await expectNoOverlays();
      const exact = await saveCurrentResult(`region-exact-${display.id}.png`);
      const exactSize = pngSize(exact);
      expect(exactSize).toEqual({ width: 400, height: 300 });
      const exactStats = await measurePng(exact, MAGENTA, { tolerance: 0 });
      expect(exactStats.fraction).toBe(1);
      await leaveResult();

      // Expanded by 20 px on every side: 440 x 340, magenta inset by exactly 20 px.
      await page.getByTestId('shot-region').click();
      const overlay2 = await overlayFor(display.id, 'overlay-region');
      await drag(overlay2, [180, 130], [620, 470]);
      await expect(overlay2.getByTestId('size-label')).toHaveText('440 × 340');
      await pressClosing(overlay2, 'Enter');
      await expect(page.getByTestId('editor-dimensions')).toHaveText('440 × 340', {
        timeout: 15_000,
      });
      const wide = await saveCurrentResult(`region-expanded-${display.id}.png`);
      expect(pngSize(wide)).toEqual({ width: 440, height: 340 });
      keepEvidence(wide, `region-expanded-${display.id}.png`);
      // The magenta rectangle starts exactly 20 px in on all four sides: the first pixel inside is
      // exactly (255, 0, 255) and the first pixel outside exactly the backdrop color.
      const edges = await assertExactEdges(
        wide,
        { x: 20, y: 20, width: 400, height: 300 },
        `region ${display.id}`,
      );
      edgeExactness.push(edges);
      const wideStats = await measurePng(wide, MAGENTA, {
        region: { x: 20, y: 20, width: 400, height: 300 },
        tolerance: 0,
      });
      expect(wideStats.fraction).toBe(1);
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
          insetExactly20px: true,
          exactEdges: edges,
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
  evidence.edgeExactness = edgeExactness;
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
    await expect(page.getByTestId('editor-dimensions')).toHaveText('600 × 152', {
      timeout: 15_000,
    });
    const file = await saveCurrentResult('region-under-pill.png');
    const stats = await measurePng(file, MAGENTA, { tolerance: 0 });
    expect(stats.fraction).toBe(1);
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
  await expect(page.getByTestId('editor-dimensions')).toHaveText(
    `${display.physicalSize.width} × ${display.physicalSize.height}`,
    { timeout: 20_000 },
  );
  evidence.regionClampedToDisplay = { displayId: display.id, size: display.physicalSize };
  await leaveResult();
});

test('(c) Window screenshot of a real external window; minimized and vanished windows', async () => {
  const title = `framecapt-native-fixture-${Date.now()}`;
  const primary = displays.find((d) => d.isPrimary) ?? (displays[0] as Display);
  const fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), 'framecapt-fixture-'));
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
    await expect(page.getByTestId('editor-dimensions')).toHaveText(/\d+ × \d+/, {
      timeout: 20_000,
    });
    timings.windowCaptureMs = Date.now() - started;
    const dims = (await page.getByTestId('editor-dimensions').textContent()) ?? '';
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
      const result = page.getByTestId('editor-dimensions');
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
      (id) =>
        window.framecapt.invoke('capture:startScreenshot', { target: 'window', sourceId: id }),
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
  expect(log).not.toContain('framecapt-native-fixture');
  expect(log).not.toMatch(/data:image|base64/i);
  evidence.logLines = log
    .split('\n')
    .filter((line) => /Overlay bounds mismatch|differs from display/.test(line)).length;

  // Which capture path ran (the main log records it, without any content).
  const pathLines = log.split('\n').filter((line) => /Screenshot path:|Freeze-frame:/.test(line));
  const count = (pattern: RegExp): number => pathLines.filter((line) => pattern.test(line)).length;
  const allExact = /Freeze-frame: (\d+)\/\1 screens exact/;
  evidence.capturePaths = {
    freezeFrameAllScreensExact: count(allExact),
    freezeFramePartialOrFallback: count(/Freeze-frame:/) - count(allExact),
    screenExactDesktopCapturer: count(/screen exact \(desktopCapturer\)/),
    screenFellBackToVideoFrame: count(/screen fell back/),
    windowExactThumbnail: count(/window exact/),
    windowVideoFrameSizeMismatch: count(/window from the getDisplayMedia frame/),
    windowPath: pathLines
      .filter((line) => /window/.test(line))
      .map((line) => line.replace(/^\S+\s+/, '')),
    sample: pathLines.slice(0, 6).map((line) => line.replace(/^\S+\s+/, '')),
    selectionReady: log
      .split('\n')
      .filter((line) => /Selection (ready|visible)/.test(line))
      .map((line) => line.replace(/^\S+\s+/, '')),
  };
  expect(count(/screen fell back/)).toBe(0);
  expect(count(allExact)).toBeGreaterThan(0);

  const visibleMs = (mode: string, which: 'first' | 'last'): number[] =>
    log.split('\n').flatMap((line) => {
      const match = new RegExp(`Selection visible \\(${mode}\\): ${which} overlay (\\d+) ms`).exec(
        line,
      );
      return match ? [Number(match[1])] : [];
    });

  // Region click -> overlays, before (phase 03, getDisplayMedia worker) and after (this run).
  const regionKeys = Object.keys(timings).filter((key) => key.startsWith('regionOverlaysMs_'));
  const before = fs.existsSync(phase03Evidence)
    ? (
        JSON.parse(fs.readFileSync(phase03Evidence, 'utf8')) as {
          timingsMs?: Record<string, number>;
        }
      ).timingsMs
    : undefined;
  evidence.regionClickToOverlays = {
    goalMs: 800,
    phase03BeforeMs: Object.fromEntries(
      regionKeys.map((key) => [key.replace('regionOverlaysMs_', ''), before?.[key] ?? null]),
    ),
    afterMs: Object.fromEntries(
      regionKeys.map((key) => [key.replace('regionOverlaysMs_', ''), timings[key]]),
    ),
    measuredBy: 'Playwright: Region button click until the overlay UI of every display has painted',
    // The same flows measured in main: request received -> overlay window shown. Playwright's
    // number is quantized upwards by expect.poll intervals (100/250/500/1000 ms), this one is not.
    mainMeasuredMs: {
      firstOverlay: visibleMs('region', 'first'),
      lastOverlay: visibleMs('region', 'last'),
    },
  };

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
  expect(written).not.toContain('framecapt-native-fixture');
  expect(redactPaths(written)).toBe(written);
});
