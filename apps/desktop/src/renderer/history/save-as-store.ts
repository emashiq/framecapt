import { useSyncExternalStore } from 'react';
import type { HistoryItemView } from '../../shared/history-ipc';

/**
 * The recording the "Save as…" dialog is open for (null: closed). Kept outside React so the card
 * menu, the context menu and the details view all open the one dialog the History view hosts.
 */
let target: HistoryItemView | null = null;
const listeners = new Set<() => void>();

function set(next: HistoryItemView | null): void {
  target = next;
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function openSaveAs(item: HistoryItemView): void {
  set(item);
}

export function closeSaveAs(): void {
  set(null);
}

export function useSaveAsTarget(): HistoryItemView | null {
  return useSyncExternalStore(subscribe, () => target);
}
