import type { BrowserWindow } from 'electron';
import { createEngineWindow, getWorkerWindow } from '../windows';
import { whenReady } from '../worker';

/** How long a new recorder window gets to announce itself. */
const READY_TIMEOUT_MS = 10_000;

/**
 * The hidden recorder windows that run the engines. Every recording has one of its own (a
 * renderer records one thing at a time, and a capture grant belongs to its window).
 */
export interface EngineWindowPool {
  /** A hidden recorder window whose renderer is ready; rejects when it does not become ready. */
  acquire(): Promise<BrowserWindow>;
  /** The recording that used the window is over. */
  release(win: BrowserWindow): void;
}

/**
 * The first recording uses the worker window (it also serves screenshot frame grabs and lives as
 * long as the app); a recording that runs beside it gets an extra window, destroyed on release.
 */
export class HiddenWindowPool implements EngineWindowPool {
  private readonly inUse = new Set<BrowserWindow>();
  private readonly extras = new Set<BrowserWindow>();

  async acquire(): Promise<BrowserWindow> {
    const worker = getWorkerWindow();
    let win = worker;
    if (this.inUse.has(worker)) {
      win = createEngineWindow();
      this.extras.add(win);
    }
    this.inUse.add(win);
    win.once('closed', () => {
      this.inUse.delete(win);
      this.extras.delete(win);
    });
    let timer: NodeJS.Timeout | undefined;
    try {
      await Promise.race([
        whenReady(win),
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new Error('The recorder window did not start.')),
            READY_TIMEOUT_MS,
          );
        }),
      ]);
    } catch (error) {
      this.release(win);
      throw error;
    } finally {
      if (timer) clearTimeout(timer);
    }
    return win;
  }

  release(win: BrowserWindow): void {
    this.inUse.delete(win);
    if (this.extras.delete(win) && !win.isDestroyed()) win.destroy();
  }
}
