import { useSyncExternalStore } from 'react';
import type { ExtractFcapRequest, SaveAsRequest } from '../../shared/history-ipc';
import { notify } from '../lib/notify';

export type ExportState =
  | { status: 'starting' }
  | {
      status: 'running';
      jobId: string;
      percent: number | null;
      compressing?: boolean;
      extracting?: boolean;
      /** A "Save as…" copy in another format. */
      converting?: boolean;
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

const FORMAT_NAME: Record<string, string> = {
  '.mp4': 'MP4',
  '.webm': 'WebM',
  '.mkv': 'MKV',
  '.gif': 'GIF',
};

/** "Recording saved as MP4" / "Copy saved as GIF" from the new file's extension. */
function savedMessage(file: string, subject: string): string {
  const name = FORMAT_NAME[file.slice(file.lastIndexOf('.')).toLowerCase()];
  return name ? `${subject} saved as ${name}` : `${subject} converted`;
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
        ...(event.kind === 'convert' && { converting: true }),
      });
    }),
    window.framecapt.on('export:done', (event) => {
      const compressed = event.kind === 'compress';
      const converted = event.kind === 'convert';
      const extracted = event.kind === 'extract';
      const guide = event.kind === 'guide';
      // A converted recording replaces its WebM in the list, a "Save as…" copy is a new item: no "MP4 saved" card for either.
      set(
        event.historyId,
        compressed || converted ? null : { status: 'done', path: event.path, itemId: event.itemId },
      );
      notify.success(
        compressed
          ? savedMessage(event.path, 'Recording')
          : converted
            ? savedMessage(event.path, 'Copy')
            : extracted
              ? 'Extract saved'
              : guide
                ? 'Guide video saved'
                : 'MP4 saved',
        {
          action: event.itemId
            ? {
                label: 'Show in folder',
                onClick: () =>
                  void window.framecapt.invoke('history:reveal', { id: event.itemId! }),
              }
            : guide
              ? {
                  label: 'Show in folder',
                  onClick: () =>
                    void window.framecapt.invoke('shell:showItemInFolder', { path: event.path }),
                }
              : undefined,
        },
      );
    }),
    window.framecapt.on('export:failed', (event) => {
      const compressing = event.kind === 'compress';
      const converting = event.kind === 'convert';
      const extracting = event.kind === 'extract';
      const guide = event.kind === 'guide';
      if (event.cancelled) {
        set(event.historyId, null);
        notify.info(
          guide
            ? 'Export cancelled. Your guide was not changed.'
            : `${compressing || converting ? 'Conversion' : extracting ? 'Extract' : 'Export'} cancelled. Your recording was not changed.`,
        );
        return;
      }
      set(
        event.historyId,
        compressing || converting ? null : { status: 'failed', message: event.message },
      );
      notify.error(
        compressing
          ? `Conversion failed. ${event.message} Your recording was kept as it was recorded.`
          : converting
            ? `Save as failed. ${event.message} Your recording was not changed.`
            : extracting
              ? `Extract failed. ${event.message}`
              : guide
                ? `The guide could not be exported. ${event.message}`
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

/** Starts a "Save as…" copy in another format; the progress events arrive like an export's. */
export async function startSaveAs(request: SaveAsRequest): Promise<void> {
  const response = await window.framecapt.invoke('history:saveAs', request);
  if (!response.ok) {
    notify.error(response.error);
    return;
  }
  // The progress event may have arrived first: it already holds the running state.
  if (!states.has(request.id)) {
    set(request.id, {
      status: 'running',
      jobId: response.data.jobId,
      percent: null,
      converting: true,
    });
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
