import { BrowserWindow, type NativeImage } from 'electron';
import type { OverlayInit, OverlayMode } from '../shared/shot-ipc';
import type { DisplayInfo } from './capture/types';
import { sendEvent } from './events';
import { log } from './logger';
import { loadRenderer, registerWebContents, securePreferences } from './windows';

/** A frozen screen: the pixels stay a NativeImage in main (crops are made from it). */
export interface FrozenFrame {
  width: number;
  height: number;
  image: NativeImage;
}

interface OverlayEntry {
  win: BrowserWindow;
  display: DisplayInfo;
  frame: FrozenFrame | undefined;
  shown: boolean;
}

export interface OverlayCallbacks {
  /** An overlay became visible; `shown` of `total` are up now. */
  onShown?: (shown: number, total: number) => void;
  /** Every overlay lost keyboard focus (the user switched to another app). */
  onAllBlurred: () => void;
}

/**
 * One frameless, always-on-top overlay window per display, showing the selection UI. Region mode
 * shows the frozen frame full-bleed on an opaque window; pick-display mode uses a transparent
 * window with a highlight. Overlays are excluded from capture (setContentProtection) as a second
 * line of defence; the real guarantee is that frames are grabbed before any overlay exists and
 * that overlays are closed before a later grab.
 */
export class OverlaySet {
  private readonly entries = new Map<number, OverlayEntry>();
  private closed = false;
  private readonly framesReady: Promise<void>;
  private markFramesReady: () => void = () => undefined;

  constructor(
    readonly mode: OverlayMode,
    private readonly callbacks: OverlayCallbacks,
  ) {
    this.framesReady = new Promise<void>((resolve) => {
      this.markFramesReady = resolve;
    });
  }

  get windows(): BrowserWindow[] {
    return [...this.entries.values()].map((entry) => entry.win);
  }

  /**
   * Creates the (hidden) overlay windows. They load their renderer while the screens are still
   * being grabbed, and ask for their content with `overlay:getInit`, which waits for
   * `setFrames`. A window that was never shown cannot be in a capture.
   */
  open(displays: readonly DisplayInfo[]): void {
    for (const display of displays) {
      const entry = this.create(display);
      this.entries.set(entry.win.webContents.id, entry);
    }
  }

  /**
   * The frozen frames are ready (region mode) or not needed (pick-display). The grab is over, so
   * the windows may now exist on screen: they are shown at opacity 0 (a never-shown window's
   * renderer is throttled to ~1 frame per second, which made the "painted" signal take 1-2 s)
   * and become visible in `show` once their content is painted.
   */
  setFrames(frames: ReadonlyMap<string, FrozenFrame>): void {
    for (const entry of this.entries.values()) {
      entry.frame = frames.get(entry.display.id);
      if (!entry.win.isDestroyed()) entry.win.showInactive();
    }
    this.markFramesReady();
  }

  private create(display: DisplayInfo): OverlayEntry {
    const { bounds } = display;
    const win = new BrowserWindow({
      x: bounds.x,
      y: bounds.y,
      width: bounds.width,
      height: bounds.height,
      title: 'Framelet selection',
      frame: false,
      show: false,
      resizable: false,
      movable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      skipTaskbar: true,
      hasShadow: false,
      alwaysOnTop: true,
      ...(this.mode === 'region'
        ? { backgroundColor: '#000000' }
        : { transparent: true, backgroundColor: '#00000000' }),
      webPreferences: securePreferences(),
    });
    // Invisible until the frozen frame is painted (see setFrames and show).
    win.setOpacity(0);
    win.setAlwaysOnTop(true, 'screen-saver');
    // Electron can place a window created on a secondary display with the wrong size/position when
    // display scale factors differ; setting the bounds again after creation fixes it.
    win.setBounds(bounds);
    const actual = win.getBounds();
    if (
      actual.x !== bounds.x ||
      actual.y !== bounds.y ||
      actual.width !== bounds.width ||
      actual.height !== bounds.height
    ) {
      log.warn(
        `Overlay bounds mismatch on display ${display.id}: wanted ` +
          `${bounds.x},${bounds.y} ${bounds.width}x${bounds.height}, got ` +
          `${actual.x},${actual.y} ${actual.width}x${actual.height}`,
      );
    }
    win.setContentProtection(true);

    registerWebContents(win.webContents, 'overlay');
    win.on('blur', () => setTimeout(() => this.checkBlurred(), 150));
    void loadRenderer(win, 'overlay');
    return { win, display, frame: undefined, shown: false };
  }

  private checkBlurred(): void {
    if (this.closed) return;
    const anyShown = [...this.entries.values()].some((entry) => entry.shown);
    if (!anyShown) return;
    const anyFocused = this.windows.some((win) => !win.isDestroyed() && win.isFocused());
    if (!anyFocused) this.callbacks.onAllBlurred();
  }

  has(webContentsId: number): boolean {
    return this.entries.has(webContentsId);
  }

  displayIdOf(webContentsId: number): string | undefined {
    return this.entries.get(webContentsId)?.display.id;
  }

  /**
   * The init payload for an overlay's renderer, or undefined for an unknown webContents. Waits
   * until the frames are ready.
   */
  async initFor(webContentsId: number): Promise<OverlayInit | undefined> {
    await this.framesReady;
    const entry = this.entries.get(webContentsId);
    if (!entry || this.closed) return undefined;
    const { display, frame } = entry;
    // Raw BGRA pixels: encoding the frame as PNG took ~110 ms per 3440x1440 screen in main, and
    // decoding it again in the overlay renderer cost more. The overlay paints them onto a canvas.
    const bitmap = frame ? frame.image.toBitmap() : null;
    const pixels = bitmap
      ? (bitmap.buffer.slice(
          bitmap.byteOffset,
          bitmap.byteOffset + bitmap.byteLength,
        ) as ArrayBuffer)
      : null;
    return {
      mode: this.mode,
      displayId: display.id,
      display: {
        id: display.id,
        bounds: display.bounds,
        scaleFactor: display.scaleFactor,
        rotation: display.rotation,
      },
      frameSize: frame ? { width: frame.width, height: frame.height } : { ...display.physicalSize },
      image: pixels,
      imageFormat: 'bgra',
    };
  }

  /** Shows an overlay once its renderer painted. The first one also takes keyboard focus. */
  show(webContentsId: number): void {
    const entry = this.entries.get(webContentsId);
    if (!entry || entry.shown || this.closed || entry.win.isDestroyed()) return;
    entry.shown = true;
    const first = [...this.entries.values()].filter((other) => other.shown).length === 1;
    entry.win.setOpacity(1);
    if (first) {
      entry.win.focus();
      entry.win.webContents.focus();
    }
    this.callbacks.onShown?.(
      [...this.entries.values()].filter((other) => other.shown).length,
      this.entries.size,
    );
  }

  frameFor(displayId: string): FrozenFrame | undefined {
    for (const entry of this.entries.values()) {
      if (entry.display.id === displayId) return entry.frame;
    }
    return undefined;
  }

  /** Tells every overlay except the one on `exceptDisplayId` to clear its selection. */
  clearSelectionsExcept(exceptDisplayId: string | undefined): void {
    for (const entry of this.entries.values()) {
      if (entry.display.id !== exceptDisplayId) {
        sendEvent(entry.win.webContents, 'overlay:clearSelection', {});
      }
    }
  }

  /** Destroys every overlay window and drops the frozen frames. Idempotent. */
  close(): void {
    this.closed = true;
    this.markFramesReady(); // releases overlays still waiting for their init (they get "none")
    for (const entry of this.entries.values()) {
      entry.frame = undefined;
      if (!entry.win.isDestroyed()) entry.win.destroy();
    }
    this.entries.clear();
  }
}
