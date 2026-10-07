import { useCallback, useEffect, useRef, useState } from 'react';
import type { LibraryTree } from '../../shared/library';

/**
 * The folder tree from main. It reloads when main says the tree changed, when History changed
 * (the counts) and when the window regains focus (folders may have been made in Explorer).
 */
export function useLibrary(): { tree: LibraryTree | null; reload: () => void } {
  const [tree, setTree] = useState<LibraryTree | null>(null);
  const sequence = useRef(0);

  const reload = useCallback(() => {
    sequence.current += 1;
    const mine = sequence.current;
    void window.framecapt.invoke('library:tree').then((response) => {
      if (mine === sequence.current && response.ok) setTree(response.data);
    });
  }, []);

  useEffect(() => {
    reload();
    const offLibrary = window.framecapt.on('library:changed', reload);
    const offHistory = window.framecapt.on('history:changed', reload);
    window.addEventListener('focus', reload);
    return () => {
      offLibrary();
      offHistory();
      window.removeEventListener('focus', reload);
    };
  }, [reload]);

  return { tree, reload };
}
