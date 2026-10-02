import { useCallback, useEffect, useState } from 'react';
import type { DisplayInfo, SourceInfo } from '../../../shared/capture-schemas';

export interface SourcesState {
  status: 'loading' | 'ready' | 'error';
  displays: DisplayInfo[];
  sources: SourceInfo[];
  message?: string;
}

/** Loads displays and sources (with small thumbnails) from main. */
export function useCaptureSources(): { state: SourcesState; reload: () => void } {
  const [state, setState] = useState<SourcesState>({
    status: 'loading',
    displays: [],
    sources: [],
  });
  const [nonce, setNonce] = useState(0);
  const reload = useCallback(() => {
    setState((prev) => ({ ...prev, status: 'loading' }));
    setNonce((n) => n + 1);
  }, []);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const displays = await window.framelet.invoke('capture:listDisplays');
      const sources = await window.framelet.invoke('capture:listSources', {
        types: ['screen', 'window'],
        thumbnailWidth: 320,
      });
      if (cancelled) return;
      if (!displays.ok || !sources.ok) {
        const message = !displays.ok
          ? displays.error.message
          : !sources.ok
            ? sources.error.message
            : '';
        setState({ status: 'error', displays: [], sources: [], message });
        return;
      }
      setState({ status: 'ready', displays: displays.data, sources: sources.data });
    })().catch((error: unknown) => {
      if (!cancelled) {
        setState({
          status: 'error',
          displays: [],
          sources: [],
          message: error instanceof Error ? error.message : String(error),
        });
      }
    });
    return () => {
      cancelled = true;
    };
  }, [nonce]);

  return { state, reload };
}
