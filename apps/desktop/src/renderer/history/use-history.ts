import { useCallback, useEffect, useRef, useState } from 'react';
import type { HistoryItemView, HistoryListRequest } from '../../shared/history-ipc';

export interface HistoryList {
  items: HistoryItemView[];
  /** Items in history before the filter and the search. */
  total: number;
  loaded: boolean;
  /** The list could not be read (not a lock: the history service failed). */
  failed: boolean;
  reload: () => void;
}

/**
 * The history list for a filter and a search text. It reloads when main says something changed
 * (an item was added or removed, a thumbnail became ready) and when the window regains focus
 * (a file may have been moved or deleted meanwhile).
 */
export function useHistory(request: HistoryListRequest): HistoryList {
  const [state, setState] = useState<{
    items: HistoryItemView[];
    total: number;
    loaded: boolean;
    failed: boolean;
  }>({ items: [], total: 0, loaded: false, failed: false });
  const key = JSON.stringify(request);
  const sequence = useRef(0);

  const reload = useCallback(() => {
    sequence.current += 1;
    const mine = sequence.current;
    const current = JSON.parse(key) as HistoryListRequest;
    void window.framecapt.invoke('history:list', current).then((response) => {
      if (mine !== sequence.current) return;
      // Refused: show nothing.
      setState(
        response.ok
          ? { items: response.data.items, total: response.data.total, loaded: true, failed: false }
          : { items: [], total: 0, loaded: true, failed: response.error.code === 'INTERNAL' },
      );
    });
  }, [key]);

  useEffect(() => {
    reload();
  }, [reload]);

  useEffect(() => {
    const off = window.framecapt.on('history:changed', reload);
    window.addEventListener('focus', reload);
    return () => {
      off();
      window.removeEventListener('focus', reload);
    };
  }, [reload]);

  return { ...state, reload };
}
