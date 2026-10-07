import type { IpcResult } from '../../shared/types';
import { notify } from '../lib/notify';
import { folderLabel } from './tree';

/** A refusal from the library carries its own explanation; show it as it is. */
function fail(error: { code: string; message: string }): void {
  notify.error(error.code === 'INVALID_PAYLOAD' ? error.message : error);
}

function ok<T>(response: IpcResult<T>): response is { ok: true; data: T } {
  if (!response.ok) fail(response.error);
  return response.ok;
}

export async function createFolder(folder: string): Promise<boolean> {
  return ok(await window.framecapt.invoke('library:createFolder', { folder }));
}

/** The new path of the folder, or null when it could not be renamed. */
export async function renameFolder(folder: string, name: string): Promise<string | null> {
  const response = await window.framecapt.invoke('library:renameFolder', { folder, name });
  return ok(response) ? response.data.folder : null;
}

export async function deleteFolder(folder: string): Promise<boolean> {
  const response = await window.framecapt.invoke('library:deleteFolder', { folder });
  if (ok(response)) notify.success(`Deleted the folder “${folderLabel(folder)}”`);
  return response.ok;
}

export async function moveContentsUp(folder: string): Promise<boolean> {
  const response = await window.framecapt.invoke('library:moveContentsUp', { folder });
  if (!ok(response)) return false;
  notify.success(
    response.data.moved === 1
      ? 'Moved 1 item to the parent folder'
      : `Moved ${response.data.moved} items to the parent folder`,
  );
  return true;
}

export async function setCaptureFolder(folder: string | null): Promise<boolean> {
  const response = await window.framecapt.invoke('library:setCaptureFolder', { folder });
  if (!ok(response)) return false;
  notify.success(
    folder === null
      ? 'New captures are saved in the main capture folders'
      : `New captures are saved to “${folderLabel(folder)}”`,
  );
  return true;
}

export async function revealFolder(
  folder: string | null,
  root: 'screenshots' | 'recordings',
): Promise<void> {
  ok(await window.framecapt.invoke('library:reveal', { folder, root }));
}

/** Moves history items to a folder (null = the root) and says what happened. */
export async function moveItemsTo(ids: readonly string[], folder: string | null): Promise<boolean> {
  if (ids.length === 0) return false;
  const response = await window.framecapt.invoke('library:moveItems', { ids: [...ids], folder });
  if (!ok(response)) return false;
  const { moved, failed } = response.data;
  const where = folderLabel(folder);
  if (moved > 0) {
    notify.success(
      `Moved ${moved} ${moved === 1 ? 'item' : 'items'} to “${where}”${
        failed.length > 0 ? `; ${failed.length} could not be moved` : ''
      }`,
    );
  } else if (failed.length > 0) {
    notify.error(failed[0]?.message ?? 'The items could not be moved.');
  } else {
    notify.info(`Already in “${where}”`);
  }
  return moved > 0;
}
