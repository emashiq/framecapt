import fs from 'node:fs';
import path from 'node:path';
import type { HistoryItem } from './store';
import { IpcError } from '../ipc-core';
import { isOpenableMedia } from './files';

export interface DragDeps {
  /** History items (see HistoryService.get). */
  history: {
    get(id: string): HistoryItem | undefined;
    thumbPathOf(id: string): string | undefined;
  };
}

/** What `webContents.startDrag` needs: the file of an item and the image to drag with. */
export interface DragPlan {
  file: string;
  /** The thumbnail file, or null (the handler then drags with a stock icon). */
  icon: string | null;
}

/**
 * Validates a drag-out request. The path always comes from the history item, never the renderer:
 * a foreign or unknown id is refused, so is a path that is not absolute and normalized (no `..`
 * segments), not an image or video FrameCapt makes, or not an existing file.
 */
export async function planDrag(deps: DragDeps, id: string): Promise<DragPlan> {
  const item = deps.history.get(id);
  if (!item) throw new IpcError('NOT_FOUND', 'That item is not in history.');
  const file = item.path;
  const segments = file.split(/[\\/]/);
  if (!path.isAbsolute(file) || segments.includes('..') || !isOpenableMedia(file)) {
    throw new IpcError('INVALID_PAYLOAD', 'That file cannot be dragged.');
  }
  const present = await fs.promises.stat(file).then(
    (stat) => stat.isFile(),
    () => false,
  );
  if (!present) throw new IpcError('NOT_FOUND', 'The file was moved or deleted.');
  return { file, icon: deps.history.thumbPathOf(id) ?? null };
}
