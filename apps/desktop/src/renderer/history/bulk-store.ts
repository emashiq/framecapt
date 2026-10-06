import { useSyncExternalStore } from 'react';
import type { BulkExportDone } from '../../shared/history-ipc';
import { announce, notify } from '../lib/notify';
import { shortPath } from '../lib/short-path';

/**
 * "Save copies" in flight, and the summary of the last run. Kept outside React so the run (and its
 * result toast) survives leaving the History tab, like the MP4 exports.
 */
export type BulkState =
  { status: 'idle' } | { status: 'choosing' } | { status: 'running'; done: number; total: number };

let state: BulkState = { status: 'idle' };
let summary: BulkExportDone | null = null;
let version = 0;
const listeners = new Set<() => void>();

function set(next: BulkState, nextSummary: BulkExportDone | null = summary): void {
  state = next;
  summary = nextSummary;
  version += 1;
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useBulkState(): BulkState {
  useSyncExternalStore(subscribe, () => version);
  return state;
}

/** The per-item summary shown in the results dialog (null once dismissed). */
export function useBulkSummary(): BulkExportDone | null {
  useSyncExternalStore(subscribe, () => version);
  return summary;
}

export function dismissBulkSummary(): void {
  set(state, null);
}

/** Subscribes to main's progress events once, for the whole app. Returns the unsubscribe. */
export function listenToBulk(): () => void {
  return window.framecapt.on('history:bulkProgress', (event) => {
    // An event can arrive after the answer of the run (separate message): it must not revive it.
    if (state.status === 'idle') return;
    set({ status: 'running', done: event.done, total: event.total });
  });
}

export async function cancelBulk(): Promise<void> {
  if (state.status !== 'running') return;
  const response = await window.framecapt.invoke('history:cancelBulk');
  if (!response.ok) notify.error(response.error);
}

/**
 * Asks main to save copies of `ids` into a folder it lets the user pick. Resolves true when the
 * run finished (not cancelled at the dialog), so the caller can clear its selection.
 */
export async function startBulkExport(ids: readonly string[]): Promise<boolean> {
  if (state.status !== 'idle' || ids.length === 0) return false;
  set({ status: 'choosing' });
  const response = await window.framecapt.invoke('history:exportMany', { ids: [...ids] });
  if (!response.ok) {
    set({ status: 'idle' });
    notify.error(response.error);
    return false;
  }
  if (!('results' in response.data)) {
    set({ status: 'idle' });
    return false; // the folder dialog was cancelled
  }
  const done = response.data;
  set({ status: 'idle' }, done);
  const saved = done.results.filter((result) => result.status === 'saved');
  const first = saved[0]?.path;
  const showInFolder = first
    ? {
        label: 'Show in folder',
        onClick: () => void window.framecapt.invoke('shell:showItemInFolder', { path: first }),
      }
    : undefined;
  const total = done.results.length;
  const where = shortPath(done.folder);
  if (saved.length === total) {
    notify.success(`Saved ${saved.length} ${saved.length === 1 ? 'copy' : 'copies'} to ${where}`, {
      action: showInFolder,
    });
    announce(`Saved ${saved.length} copies`);
  } else {
    const text = done.cancelled
      ? `Cancelled. Saved ${saved.length} of ${total} copies to ${where}`
      : `Saved ${saved.length} of ${total} copies to ${where}. See the summary for the others`;
    notify.warning(text, { action: showInFolder });
    announce(text);
  }
  return true;
}
