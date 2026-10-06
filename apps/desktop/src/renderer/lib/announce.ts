import { useSyncExternalStore } from 'react';

/**
 * A polite status message for screen readers ("Saved", "Recording stopped"). One live region in the
 * app shell renders it; any code may call `announce`. The counter makes the same text announce again.
 */
let current = { text: '', n: 0 };
const listeners = new Set<() => void>();

export function announce(text: string): void {
  current = { text, n: current.n + 1 };
  for (const listener of listeners) listener();
}

export function useAnnouncement(): { text: string; n: number } {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => current,
  );
}
