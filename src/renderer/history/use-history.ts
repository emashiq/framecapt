import { useCallback, useEffect, useRef, useState } from 'react';
import type { HistoryItemView, HistoryListRequest } from '../../shared/history-ipc';

export interface HistoryList {
  items: HistoryItemView[];
  /** Items in history before the filter and the search. */
  total: number;
  loaded: boolean;
  reload: () => void;
}

/**
 * The history list for a filter and a search text. It reloads when main says something changed
 * (an item was added or removed, a thumbnail became ready) and when the window regains focus
 * (a file may have been moved or deleted meanwhile).
 */
export function useHistory(request: HistoryListRequest): HistoryList {
  const [state, setState] = useState<{ items: HistoryItemView[]; total: number; loaded: boolean }>({
    items: [],
    total: 0,
    loaded: false,
  });
  const key = JSON.stringify(request);
  const sequence = useRef(0);

  const reload = useCallback(() => {
    sequence.current += 1;
    const mine = sequence.current;
    const current = JSON.parse(key) as HistoryListRequest;
    void window.framecapt.invoke('history:list', current).then((response) => {
      if (mine !== sequence.current || !response.ok) return;
      setState({ items: response.data.items, total: response.data.total, loaded: true });
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
