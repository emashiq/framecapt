import { HISTORY_ID_PATTERN } from '../../shared/history-ipc';

/** The drag payload of history cards dropped on a folder: history ids only. */
export const ITEMS_MIME = 'application/x-framecapt-items';

export function startItemsDrag(transfer: DataTransfer, ids: readonly string[]): void {
  transfer.setData(ITEMS_MIME, JSON.stringify(ids));
  transfer.setData('text/plain', `${ids.length} FrameCapt ${ids.length === 1 ? 'item' : 'items'}`);
  transfer.effectAllowed = 'move';
}

/** True while a drag carries history cards (only the type list is readable before the drop). */
export function hasItemsDrag(transfer: DataTransfer): boolean {
  return [...transfer.types].includes(ITEMS_MIME);
}

export function readDraggedIds(transfer: DataTransfer): string[] {
  try {
    const parsed: unknown = JSON.parse(transfer.getData(ITEMS_MIME));
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (id): id is string => typeof id === 'string' && HISTORY_ID_PATTERN.test(id),
    );
  } catch {
    return [];
  }
}
