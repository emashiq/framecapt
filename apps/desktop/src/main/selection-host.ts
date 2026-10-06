import type { Rect } from '../shared/rect';
import type { OverlayInit } from '../shared/shot-ipc';

/**
 * What the overlay windows talk to. Both the screenshot flow and the recorder show overlays; the
 * overlay IPC handlers go to whichever one currently owns them.
 */
export interface SelectionHost {
  overlayInit(webContentsId: number): Promise<OverlayInit | undefined>;
  overlayReady(webContentsId: number): void;
  selectionStarted(webContentsId: number): void;
  cancel(): void;
  confirmRegion(webContentsId: number, displayId: string, rect: Rect): Promise<void>;
  pickDisplay(webContentsId: number, displayId: string): Promise<void>;
}
