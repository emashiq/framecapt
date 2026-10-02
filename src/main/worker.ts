import { randomUUID } from 'node:crypto';
import { handle } from './ipc';
import { IpcError } from './ipc-core';
import { sendEvent } from './events';
import { log } from './logger';
import { getWorkerWindow } from './windows';
import { WORKER_TIMEOUT_MS } from '../shared/shots';
import type { GrabFramesEvent } from '../shared/shot-ipc';

export interface WorkerFrame {
  sourceId: string;
  width: number;
  height: number;
  png: Buffer;
}

export class WorkerError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'WorkerError';
  }
}

interface Pending {
  resolve: (frames: WorkerFrame[]) => void;
  reject: (error: WorkerError) => void;
  timer: NodeJS.Timeout;
  sourceIds: string[];
}

const pending = new Map<string, Pending>();
let ready: Promise<void> | undefined;
let markReady: (() => void) | undefined;

/** Waits until the worker renderer has subscribed to its events (it announces itself). */
function whenWorkerReady(): Promise<void> {
  const win = getWorkerWindow();
  if (!ready) {
    ready = new Promise<void>((resolve) => {
      markReady = resolve;
    });
    win.once('closed', () => {
      ready = undefined;
      markReady = undefined;
      failAll('WORKER_CLOSED', 'The capture worker closed unexpectedly.');
    });
  }
  return ready;
}

function failAll(code: string, message: string): void {
  for (const [id, entry] of pending) {
    clearTimeout(entry.timer);
    entry.reject(new WorkerError(code, message));
    pending.delete(id);
  }
}

export function registerWorkerHandlers(): void {
  handle('worker:ready', { roles: ['recorder'] }, () => {
    markReady?.();
  });

  handle('worker:frameResult', { roles: ['recorder'] }, (result) => {
    const entry = pending.get(result.requestId);
    if (!entry) return; // timed out or cancelled meanwhile
    // The worker may only answer for the sources that were asked for.
    const unexpected = result.frames.find((frame) => !entry.sourceIds.includes(frame.sourceId));
    pending.delete(result.requestId);
    clearTimeout(entry.timer);
    if (unexpected) {
      entry.reject(
        new WorkerError('WORKER_BAD_RESULT', 'The worker returned an unexpected frame.'),
      );
      return;
    }
    entry.resolve(
      result.frames.map((frame) => ({
        sourceId: frame.sourceId,
        width: frame.width,
        height: frame.height,
        png: Buffer.from(frame.png),
      })),
    );
  });

  handle('worker:frameError', { roles: ['recorder'] }, (error) => {
    const entry = pending.get(error.requestId);
    if (!entry) throw new IpcError('NOT_FOUND', 'No such frame request.');
    pending.delete(error.requestId);
    clearTimeout(entry.timer);
    entry.reject(new WorkerError(error.code, error.message));
  });
}

/**
 * Asks the hidden worker to grab one full-resolution frame per source. Rejects with a
 * WorkerError after 10 s, when the worker reports an error, or when it closes.
 */
export async function requestFrames(
  sources: GrabFramesEvent['sources'],
  options: { synthetic?: boolean } = {},
): Promise<WorkerFrame[]> {
  await Promise.race([
    whenWorkerReady(),
    new Promise<never>((_, reject) =>
      setTimeout(
        () => reject(new WorkerError('WORKER_TIMEOUT', 'The capture worker did not start.')),
        WORKER_TIMEOUT_MS,
      ).unref(),
    ),
  ]);
  const requestId = randomUUID();
  return new Promise<WorkerFrame[]>((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(requestId);
      log.warn('Capture worker timed out');
      reject(new WorkerError('WORKER_TIMEOUT', 'Capturing took too long.'));
    }, WORKER_TIMEOUT_MS);
    pending.set(requestId, {
      resolve,
      reject,
      timer,
      sourceIds: sources.map((source) => source.sourceId),
    });
    sendEvent(getWorkerWindow().webContents, 'worker:grabFrames', {
      requestId,
      sources,
      ...(options.synthetic && { synthetic: true }),
    });
  });
}
