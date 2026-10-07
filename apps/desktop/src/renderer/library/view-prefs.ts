import { useSyncExternalStore } from 'react';
import {
  clampWidth,
  DEFAULT_PREFS,
  parsePrefs,
  type LibraryPrefs,
} from '../../shared/library-prefs';

export {
  SIDEBAR_DEFAULT,
  SIDEBAR_MAX,
  SIDEBAR_MIN,
  type LibraryPrefs,
  type LibrarySort,
  type LibraryViewMode,
} from '../../shared/library-prefs';

const KEY = 'framecapt.library.prefs';

function read(): LibraryPrefs {
  try {
    return parsePrefs(window.localStorage.getItem(KEY));
  } catch {
    return DEFAULT_PREFS;
  }
}

let current: LibraryPrefs = read();
const listeners = new Set<() => void>();

/** The Library's view options: kept in the browser storage, a convenience only (never required). */
export function setLibraryPrefs(patch: Partial<LibraryPrefs>): void {
  const next = { ...current, ...patch };
  if (patch.sidebarWidth !== undefined) next.sidebarWidth = clampWidth(patch.sidebarWidth);
  current = next;
  try {
    window.localStorage.setItem(KEY, JSON.stringify(next));
  } catch {
    /* storage is only a convenience */
  }
  for (const listener of listeners) listener();
}

export function toggleLibrarySidebar(): void {
  setLibraryPrefs({ sidebarCollapsed: !current.sidebarCollapsed });
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useLibraryPrefs(): LibraryPrefs {
  return useSyncExternalStore(subscribe, () => current);
}
