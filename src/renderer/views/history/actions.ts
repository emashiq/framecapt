import { toast } from 'sonner';
import type { HistoryItemView } from '../../../shared/history-ipc';
import { startMp4Export } from '../../history/export-store';

type Outcome = { ok: boolean; error?: { message: string } };

/** Runs a main-process action by history id and says so when it fails. */
async function run(promise: Promise<Outcome>, done?: string): Promise<boolean> {
  const response = await promise;
  if (!response.ok) {
    toast.error(response.error?.message ?? 'That did not work.');
    return false;
  }
  if (done) toast.success(done);
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
    open: (item) => void run(window.framelet.invoke('history:open', { id: item.id })),
    reveal: (item) => void run(window.framelet.invoke('history:reveal', { id: item.id })),
    copy: (item) =>
      void (item.type === 'screenshot'
        ? run(window.framelet.invoke('history:copyImage', { id: item.id }), 'Image copied')
        : run(window.framelet.invoke('history:copyPath', { id: item.id }), 'Path copied')),
    remove: (item) =>
      void window.framelet.invoke('history:remove', { id: item.id }).then((response) => {
        if (!response.ok) {
          toast.error(response.error.message);
          return;
        }
        reload();
        toast('Removed from history', {
          duration: 5000,
          action: {
            label: 'Undo',
            onClick: () =>
              void window.framelet
                .invoke('history:undoRemove', { id: item.id })
                .then((undone) => (undone.ok ? reload() : toast.error(undone.error.message))),
          },
        });
      }),
    locate: (item) =>
      void window.framelet.invoke('history:relink', { id: item.id }).then((response) => {
        if (!response.ok) toast.error(response.error.message);
        else if ('relinked' in response.data) toast.success('File linked again');
        reload();
      }),
    exportMp4: (item) => void startMp4Export(item.id),
    saveCopy: (item) =>
      void window.framelet.invoke('history:saveCopy', { id: item.id }).then((response) => {
        if (!response.ok) toast.error(response.error.message);
        else if ('path' in response.data) toast.success('Copy saved');
      }),
  };
}

/** The destructive action: the file goes to the Recycle Bin and the entry is removed. */
export async function deleteItemFile(item: HistoryItemView, reload: () => void): Promise<void> {
  const ok = await run(
    window.framelet.invoke('history:deleteFile', { id: item.id }),
    'Moved to the Recycle Bin',
  );
  if (ok) reload();
}
