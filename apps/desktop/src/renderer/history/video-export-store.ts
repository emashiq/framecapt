import { useSyncExternalStore } from 'react';
import type { VideoExportFormat, VideoProject } from '../../shared/video-edit';
import { notify } from '../lib/notify';

export type VideoExportState =
  | { status: 'starting' }
  | { status: 'running'; jobId: string; percent: number | null; format: VideoExportFormat }
  | { status: 'done'; path: string; itemId: string | null; format: VideoExportFormat }
  | { status: 'failed'; message: string };

/**
 * Video editor exports in flight or just finished, by history id of the recording. Outside React so
 * an export keeps showing its progress when the user leaves the editor and comes back, and so the
 * result toast appears wherever the user is. (The MP4 conversion has its own store.)
 */
const states = new Map<string, VideoExportState>();
const listeners = new Set<() => void>();
/** The format each recording's latest export was asked for (the progress events do not carry it). */
const formats = new Map<string, VideoExportFormat>();
let version = 0;

function set(historyId: string, state: VideoExportState | null): void {
  if (state === null) states.delete(historyId);
  else states.set(historyId, state);
  version += 1;
  for (const listener of listeners) listener();
}

const subscribe = (listener: () => void): (() => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};

export function useVideoExport(historyId: string): VideoExportState | undefined {
  useSyncExternalStore(subscribe, () => version);
  return states.get(historyId);
}

const FORMAT_LABEL: Record<VideoExportFormat, string> = { mp4: 'MP4', webm: 'WebM', gif: 'GIF' };

/** Subscribes to main's video export events once, for the whole app. Returns the unsubscribe. */
export function listenToVideoExports(): () => void {
  const offs = [
    window.framecapt.on('video:exportProgress', (event) => {
      set(event.historyId, {
        status: 'running',
        jobId: event.jobId,
        percent: event.percent,
        format: formats.get(event.historyId) ?? 'mp4',
      });
    }),
    window.framecapt.on('video:exportDone', (event) => {
      set(event.historyId, {
        status: 'done',
        path: event.path,
        itemId: event.itemId,
        format: event.format,
      });
      const { itemId } = event;
      notify.success(`${FORMAT_LABEL[event.format]} exported`, {
        duration: 10_000,
        ...(itemId && {
          action: {
            label: 'Show in folder',
            onClick: () => void window.framecapt.invoke('history:reveal', { id: itemId }),
          },
        }),
      });
    }),
    window.framecapt.on('video:exportFailed', (event) => {
      set(event.historyId, event.cancelled ? null : { status: 'failed', message: event.message });
      if (event.cancelled) notify.info('Export cancelled. Your recording was not changed.');
      else notify.error(`Export failed. ${event.message}`);
    }),
  ];
  return () => offs.forEach((off) => off());
}

/** Starts an export of the project (the job queues behind any running one). */
export async function startVideoExport(
  historyId: string,
  project: VideoProject,
  format: VideoExportFormat,
): Promise<void> {
  formats.set(historyId, format);
  set(historyId, { status: 'starting' });
  const response = await window.framecapt.invoke('video:export', { historyId, project, format });
  if (!response.ok) {
    set(historyId, null);
    notify.error(response.error);
    return;
  }
  const current = states.get(historyId);
  if (current?.status === 'starting') {
    set(historyId, { status: 'running', jobId: response.data.jobId, percent: null, format });
  }
}

export async function cancelVideoExport(historyId: string): Promise<void> {
  const state = states.get(historyId);
  if (state?.status !== 'running') return;
  const response = await window.framecapt.invoke('export:cancel', { jobId: state.jobId });
  if (!response.ok) notify.error(response.error);
}

export function dismissVideoExport(historyId: string): void {
  set(historyId, null);
}
