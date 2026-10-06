/** The last few commands run from the command center, newest first. Renderer-only (localStorage). */
const KEY = 'framecapt-command-recents';
export const MAX_RECENTS = 5;

/** The two methods used, so a test can pass a stand-in (the unit tests run without a browser). */
type Store = { getItem(key: string): string | null; setItem(key: string, value: string): void };

function defaultStore(): Store | null {
  try {
    return (globalThis as { localStorage?: Store }).localStorage ?? null;
  } catch {
    return null;
  }
}

/** The remembered command ids; an empty list when storage is missing, blocked or damaged. */
export function loadRecents(store: Store | null = defaultStore()): string[] {
  try {
    const parsed: unknown = JSON.parse(store?.getItem(KEY) ?? '[]');
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((id): id is string => typeof id === 'string').slice(0, MAX_RECENTS);
  } catch {
    return [];
  }
}

/** Puts `id` first (once) and keeps the newest five. Returns the new list, saved when possible. */
export function pushRecent(id: string, store: Store | null = defaultStore()): string[] {
  const next = [id, ...loadRecents(store).filter((known) => known !== id)].slice(0, MAX_RECENTS);
  try {
    store?.setItem(KEY, JSON.stringify(next));
  } catch {
    // Not saved (private window, blocked storage): the list still works for this run.
  }
  return next;
}
