import { announce, notify } from '../../lib/notify';
import type { HistoryItemView } from '../../../shared/history-ipc';
import { startMp4Export } from '../../history/export-store';

type Outcome = { ok: boolean; error?: { message: string } };

/** Runs a main-process action by history id and says so when it fails. */
async function run(promise: Promise<Outcome>, done?: string): Promise<boolean> {
  const response = await promise;
  if (!response.ok) {
    notify.error(response.error ?? 'That did not work.');
    return false;
  }
  if (done) notify.success(done);
  return true;
}

export interface ItemActions {
  open(item: HistoryItemView): void;
  reveal(item: HistoryItemView): void;
  /** A screenshot is copied as an image, a recording as its file path. */
  copy(item: HistoryItemView): void;
  /** History only; the file stays. Offers Undo for a few seconds. */
  remove(item: HistoryItemView): void;
  locate(item: HistoryItemView): void;
  exportMp4(item: HistoryItemView): void;
  saveCopy(item: HistoryItemView): void;
}

/**
 * The actions of a history item. All go through main by id. None of them deletes a file: that is
 * a separate, confirmed action (`deleteItemFile`).
 */
export function createItemActions(reload: () => void): ItemActions {
  return {
    open: (item) => void run(window.framecapt.invoke('history:open', { id: item.id })),
    reveal: (item) => void run(window.framecapt.invoke('history:reveal', { id: item.id })),
    copy: (item) =>
      void (item.type === 'screenshot'
        ? run(window.framecapt.invoke('history:copyImage', { id: item.id }), 'Image copied')
        : run(window.framecapt.invoke('history:copyPath', { id: item.id }), 'Path copied')),
    remove: (item) =>
      void window.framecapt.invoke('history:remove', { id: item.id }).then((response) => {
        if (!response.ok) {
          notify.error(response.error);
          return;
        }
        reload();
        notify.info('Removed from history', {
          duration: 5000,
          action: {
            label: 'Undo',
            onClick: () =>
              void window.framecapt
                .invoke('history:undoRemove', { id: item.id })
                .then((undone) => (undone.ok ? reload() : notify.error(undone.error))),
          },
        });
      }),
    locate: (item) =>
      void window.framecapt.invoke('history:relink', { id: item.id }).then((response) => {
        if (!response.ok) notify.error(response.error);
        else if ('relinked' in response.data) notify.success('File linked again');
        reload();
      }),
    exportMp4: (item) => void startMp4Export(item.id),
    saveCopy: (item) =>
      void window.framecapt.invoke('history:saveCopy', { id: item.id }).then((response) => {
        if (!response.ok) notify.error(response.error);
        else if ('path' in response.data) notify.success('Copy saved');
      }),
  };
}

/** Deletes the editable data (unredacted original and annotations) of an item; the image stays. */
export async function deleteItemProject(item: HistoryItemView, reload: () => void): Promise<void> {
  const ok = await run(
    window.framecapt.invoke('history:deleteProject', { id: item.id }),
    'Editable data deleted',
  );
  if (ok) reload();
}

/** The destructive action: the file goes to the Recycle Bin and the entry is removed. */
export async function deleteItemFile(item: HistoryItemView, reload: () => void): Promise<void> {
  const ok = await run(
    window.framecapt.invoke('history:deleteFile', { id: item.id }),
    'Moved to the Recycle Bin',
  );
  if (ok) reload();
}

/**
 * Removes several entries from history (files stay). Each goes through `history:remove`, so main's
 * own undo window applies to every one; one toast offers Undo for all that were removed.
 * Resolves with how many were removed.
 */
export async function removeItems(ids: readonly string[], reload: () => void): Promise<number> {
  const removed: string[] = [];
  let failure: { code?: string; message?: string } | undefined;
  for (const id of ids) {
    const response = await window.framecapt.invoke('history:remove', { id });
    if (response.ok) removed.push(id);
    else failure = response.error;
  }
  reload();
  if (failure) notify.error(failure);
  if (removed.length === 0) return 0;
  const text = `Removed ${removed.length} ${removed.length === 1 ? 'item' : 'items'} from history`;
  announce(text);
  notify.info(text, {
    duration: 6000,
    action: {
      label: 'Undo',
      onClick: () =>
        void Promise.all(
          removed.map((id) => window.framecapt.invoke('history:undoRemove', { id })),
        ).then((answers) => {
          reload();
          const failed = answers.find((answer) => !answer.ok);
          if (failed && !failed.ok) notify.error(failed.error);
          else announce(`Restored ${removed.length} items`);
        }),
    },
  });
  return removed.length;
}

/** Starts an OS file drag of the item's file (main picks the path). */
export function startItemDrag(item: HistoryItemView): void {
  void window.framecapt.invoke('history:startDrag', { id: item.id }).then((response) => {
    if (!response.ok) notify.error(response.error);
  });
}

/** True for what the History "Edit" action can open: a screenshot (image editor) or a WebM/MP4 recording (video editor). */
export function canEditItem(item: HistoryItemView): boolean {
  return (
    item.type === 'screenshot' ||
    (item.type === 'recording' && (item.format === 'webm' || item.format === 'mp4'))
  );
}

/** "Edit" for a screenshot, "Edit video" for a recording. */
export function editLabel(item: HistoryItemView): string {
  return item.type === 'recording' ? 'Edit video' : 'Edit';
}
