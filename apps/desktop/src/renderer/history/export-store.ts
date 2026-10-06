import { useSyncExternalStore } from 'react';
import type { ExtractFcapRequest } from '../../shared/history-ipc';
import { notify } from '../lib/notify';

export type ExportState =
  | { status: 'starting' }
  | {
      status: 'running';
      jobId: string;
      percent: number | null;
      compressing?: boolean;
      extracting?: boolean;
    }
  | { status: 'done'; path: string; itemId: string | null }
  | { status: 'failed'; message: string };

/**
 * MP4 exports in flight or just finished, by history id. Kept outside React so an export keeps
 * showing its progress when the user leaves the History tab and comes back, and so the result
 * toast appears wherever the user is.
 */
const states = new Map<string, ExportState>();
const listeners = new Set<() => void>();
let version = 0;

function set(historyId: string, state: ExportState | null): void {
  if (state === null) states.delete(historyId);
  else states.set(historyId, state);
  version += 1;
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** The export state of one history item (undefined when there is none). */
export function useExportState(historyId: string): ExportState | undefined {
  useSyncExternalStore(subscribe, () => version);
  return states.get(historyId);
}

/** True while any export runs (the encoder uses every core, so only one runs at a time). */
export function useAnyExportActive(): boolean {
  useSyncExternalStore(subscribe, () => version);
  return [...states.values()].some((s) => s.status === 'starting' || s.status === 'running');
}

/** Subscribes to main's export events once, for the whole app. Returns the unsubscribe. */
export function listenToExports(): () => void {
  const offs = [
    window.framecapt.on('export:progress', (event) => {
      set(event.historyId, {
        status: 'running',
        jobId: event.jobId,
        percent: event.percent,
        ...(event.kind === 'compress' && { compressing: true }),
        ...(event.kind === 'extract' && { extracting: true }),
      });
    }),
    window.framecapt.on('export:done', (event) => {
      const compressed = event.kind === 'compress';
      const extracted = event.kind === 'extract';
      // A compressed recording replaces its WebM in the list: no "MP4 saved" card for it.
      set(
        event.historyId,
        compressed ? null : { status: 'done', path: event.path, itemId: event.itemId },
      );
      notify.success(
        compressed ? 'Recording compressed' : extracted ? 'Extract saved' : 'MP4 saved',
        {
          action: event.itemId
            ? {
                label: 'Show in folder',
                onClick: () =>
                  void window.framecapt.invoke('history:reveal', { id: event.itemId! }),
              }
            : undefined,
        },
      );
    }),
    window.framecapt.on('export:failed', (event) => {
      const compressing = event.kind === 'compress';
      const extracting = event.kind === 'extract';
      if (event.cancelled) {
        set(event.historyId, null);
        notify.info(
          `${compressing ? 'Compression' : extracting ? 'Extract' : 'Export'} cancelled. Your recording was not changed.`,
        );
        return;
      }
      set(event.historyId, compressing ? null : { status: 'failed', message: event.message });
      notify.error(
        compressing
          ? `Compression failed. ${event.message} Your recording was kept as WebM.`
          : extracting
            ? `Extract failed. ${event.message}`
            : `MP4 export failed. ${event.message}`,
      );
    }),
  ];
  return () => offs.forEach((off) => off());
}

/** Starts an export: main asks for the destination, then the progress events arrive. */
export async function startMp4Export(historyId: string): Promise<void> {
  set(historyId, { status: 'starting' });
  const response = await window.framecapt.invoke('export:mp4', { historyId });
  if (!response.ok) {
    set(historyId, null);
    notify.error(response.error);
  } else if ('cancelled' in response.data) {
    set(historyId, null);
  } else {
    const current = states.get(historyId);
    if (current?.status === 'starting') {
      set(historyId, { status: 'running', jobId: response.data.jobId, percent: null });
    }
  }
}

/** Starts an extract from a multi-source recording; the progress events arrive like an export's. */
export async function startFcapExtract(request: ExtractFcapRequest): Promise<void> {
  set(request.id, { status: 'starting' });
  const response = await window.framecapt.invoke('history:extractFcap', request);
  if (!response.ok) {
    set(request.id, null);
    notify.error(response.error);
    return;
  }
  if (states.get(request.id)?.status === 'starting') {
    set(request.id, {
      status: 'running',
      jobId: response.data.jobId,
      percent: null,
      extracting: true,
    });
  }
}

export async function cancelMp4Export(historyId: string): Promise<void> {
  const state = states.get(historyId);
  if (state?.status !== 'running') return;
  const response = await window.framecapt.invoke('export:cancel', { jobId: state.jobId });
  if (!response.ok) notify.error(response.error);
}

export function dismissExport(historyId: string): void {
  set(historyId, null);
}
