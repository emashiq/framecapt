import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { FfmpegError, type FfmpegProgress, type MediaTools, type ProbeResult } from './ffmpeg';

// --- the queue --------------------------------------------------------------------------------

export interface JobContext {
  signal: AbortSignal;
  /** 0..99 while working, null when unknown. Repeated values are dropped. */
  onProgress: (percent: number | null) => void;
}

export interface JobSpec<T> {
  /** Unique among the jobs that are queued or running. */
  id: string;
  /** For logs only. */
  label: string;
  run: (context: JobContext) => Promise<T>;
  onProgress?: (percent: number | null) => void;
}

export type JobOutcome<T> =
  { ok: true; value: T } | { ok: false; cancelled: boolean; error?: unknown };

interface Entry {
  spec: JobSpec<unknown>;
  controller: AbortController;
  resolve: (outcome: JobOutcome<unknown>) => void;
  done: Promise<unknown>;
}

/**
 * Runs media jobs one at a time, in the order they were enqueued: the encoder uses every core, so
 * two at once would only slow both. A job gets an AbortSignal (cancel) and a progress callback.
 * Jobs report their own result; the runner only turns "threw" and "was cancelled" into an outcome.
 */
export class JobRunner {
  private readonly queue: Entry[] = [];
  private current: Entry | null = null;

  /** True while a job runs or waits. */
  get busy(): boolean {
    return this.current !== null || this.queue.length > 0;
  }

  enqueue<T>(spec: JobSpec<T>): { id: string; done: Promise<JobOutcome<T>> } {
    if (this.has(spec.id)) throw new Error(`A job with id ${spec.id} already exists.`);
    let resolve!: (outcome: JobOutcome<unknown>) => void;
    const done = new Promise<JobOutcome<unknown>>((r) => (resolve = r));
    this.queue.push({
      spec: spec as JobSpec<unknown>,
      controller: new AbortController(),
      resolve,
      done,
    });
    this.pump();
    return { id: spec.id, done: done as Promise<JobOutcome<T>> };
  }

  /** Cancels a queued job (it never starts) or aborts the running one. False when unknown. */
  cancel(id: string): boolean {
    const index = this.queue.findIndex((entry) => entry.spec.id === id);
    if (index >= 0) {
      const [entry] = this.queue.splice(index, 1);
      entry?.resolve({ ok: false, cancelled: true });
      return true;
    }
    if (this.current?.spec.id === id) {
      this.current.controller.abort();
      return true;
    }
    return false;
  }

  /** Cancels everything and waits until the running job has cleaned up (quit path). */
  async cancelAll(): Promise<void> {
    for (const entry of this.queue.splice(0)) entry.resolve({ ok: false, cancelled: true });
    const running = this.current;
    if (!running) return;
    running.controller.abort();
    await running.done;
  }

  /** Resolves when nothing is queued or running; for tests. */
  async idle(): Promise<void> {
    while (this.current) await this.current.done;
  }

  private has(id: string): boolean {
    return this.current?.spec.id === id || this.queue.some((entry) => entry.spec.id === id);
  }

  private pump(): void {
    if (this.current) return;
    const entry = this.queue.shift();
    if (!entry) return;
    this.current = entry;
    const { spec, controller } = entry;
    let last: number | null | undefined;
    const finished = (async () => {
      try {
        const value = await spec.run({
          signal: controller.signal,
          onProgress: (percent) => {
            if (percent === last) return;
            last = percent;
            spec.onProgress?.(percent);
          },
        });
        entry.resolve({ ok: true, value });
      } catch (error) {
        entry.resolve({ ok: false, cancelled: controller.signal.aborted, error });
      } finally {
        this.current = null;
        this.pump();
      }
    })();
    entry.done = finished;
  }
}

// --- an ffmpeg job that produces one file -----------------------------------------------------

const PROBE_TIMEOUT_MS = 30_000;
const MIN_JOB_TIMEOUT_MS = 10 * 60_000;
/** Free space the destination volume must keep beyond the source's size while encoding. */
const FREE_MARGIN_BYTES = 100 * 1024 * 1024;

export type FileJobFailureCode =
  | 'INVALID_DESTINATION'
  | 'SOURCE_UNREADABLE'
  | 'LOW_DISK'
  | 'CANCELLED'
  | 'TIMEOUT'
  | 'FAILED'
  | 'VERIFY_FAILED';

export type FileJobResult =
  | { ok: true; path: string; bytes: number; durationMs: number; probe: ProbeResult }
  | { ok: false; code: FileJobFailureCode; message: string; stderrTail: string };

export interface FileJobRequest {
  tools: MediaTools;
  sourcePath: string;
  destPath: string;
  signal?: AbortSignal;
  /** 0..99 while encoding, null when the length of the source is not known. */
  onProgress?: (percent: number | null) => void;
  /** Builds the ffmpeg arguments (array, no shell) for the partial output path. */
  args: (partialPath: string) => string[];
  /** What is wrong with the finished partial file, or null. Runs before the rename. */
  verify: (output: ProbeResult, source: ProbeResult) => string | null;
  /** "export", "compression": used in the user-facing messages. */
  noun: string;
}

function failure(code: FileJobFailureCode, message: string, stderrTail = ''): FileJobResult {
  return { ok: false, code, message, stderrTail };
}

/** The temporary output: next to the destination (one volume, so the rename is atomic) and unique. */
export function partialPathFor(destPath: string): string {
  const token = randomBytes(6).toString('hex');
  return path.join(
    path.dirname(destPath),
    `.framecapt-export-${token}.partial${path.extname(destPath)}`,
  );
}

/** Progress 0..99 from ffmpeg's output position; null when the source has no known duration. */
export function percentOf(progress: FfmpegProgress, durationSec: number | null): number | null {
  if (durationSec === null || durationSec <= 0) return null;
  return Math.max(0, Math.min(99, Math.floor((progress.outTimeUs / 1e6 / durationSec) * 100)));
}

/**
 * Probe the source, encode into a partial file, probe and verify the result, then rename it onto
 * `destPath`. On cancel, timeout, failure or a failed check the partial file (the one this call
 * made, nothing else) is deleted. The source is only ever read.
 */
export async function runFileJob(request: FileJobRequest): Promise<FileJobResult> {
  const { tools, sourcePath, destPath, signal, noun } = request;
  const cancelled = (): FileJobResult => failure('CANCELLED', `The ${noun} was cancelled.`);
  if (signal?.aborted) return cancelled();

  let sourceProbe: ProbeResult;
  let sourceBytes: number;
  try {
    sourceBytes = (await fs.promises.stat(sourcePath)).size;
    sourceProbe = await tools.probe(sourcePath, {
      timeoutMs: PROBE_TIMEOUT_MS,
      ...(signal && { signal }),
    });
  } catch (error) {
    if (error instanceof FfmpegError && error.code === 'FFMPEG_ABORTED') return cancelled();
    return failure('SOURCE_UNREADABLE', 'The recording could not be read.');
  }
  if (!sourceProbe.hasVideo) return failure('SOURCE_UNREADABLE', 'The file has no video.');

  const partial = partialPathFor(destPath);
  try {
    const stat = await fs.promises.statfs(path.dirname(destPath)).catch(() => null);
    if (stat && Number(stat.bavail) * Number(stat.bsize) < sourceBytes + FREE_MARGIN_BYTES) {
      return failure('LOW_DISK', `There is not enough free space for the ${noun}.`);
    }

    const timeoutMs = Math.max(MIN_JOB_TIMEOUT_MS, (sourceProbe.durationSec ?? 0) * 4000);
    let last: number | null = -1;
    const run = await tools
      .run(request.args(partial), {
        timeoutMs,
        ...(signal && { signal }),
        onProgress: (progress) => {
          const percent = percentOf(progress, sourceProbe.durationSec);
          if (percent === last) return;
          last = percent;
          request.onProgress?.(percent);
        },
      })
      .catch((error: unknown) => {
        if (error instanceof FfmpegError) return error;
        throw error;
      });
    if (run instanceof FfmpegError) {
      if (run.code === 'FFMPEG_ABORTED') return cancelled();
      if (run.code === 'FFMPEG_TIMEOUT') {
        return failure('TIMEOUT', `The ${noun} took too long and was stopped.`, run.stderrTail);
      }
      return failure('FAILED', 'The video could not be converted.', run.stderrTail);
    }
    if (run.code !== 0) {
      return failure('FAILED', 'The video could not be converted.', run.stderrTail);
    }

    let outputProbe: ProbeResult;
    try {
      outputProbe = await tools.probe(partial, {
        timeoutMs: PROBE_TIMEOUT_MS,
        ...(signal && { signal }),
      });
    } catch (error) {
      if (error instanceof FfmpegError && error.code === 'FFMPEG_ABORTED') return cancelled();
      return failure('VERIFY_FAILED', 'The converted video could not be checked.');
    }
    const problem = request.verify(outputProbe, sourceProbe);
    if (problem) return failure('VERIFY_FAILED', problem);

    await fs.promises.rename(partial, destPath);
    const bytes = (await fs.promises.stat(destPath)).size;
    request.onProgress?.(100);
    return {
      ok: true,
      path: destPath,
      bytes,
      durationMs: Math.round((outputProbe.durationSec ?? 0) * 1000),
      probe: outputProbe,
    };
  } catch (error) {
    if (error instanceof FfmpegError) return failure('FAILED', error.message, error.stderrTail);
    return failure('FAILED', 'The video could not be saved.');
  } finally {
    // Whatever is still named like this belongs to this call (success renamed it away). ffmpeg may
    // need a moment to release the file after it was killed, so retry.
    await fs.promises
      .rm(partial, { force: true, maxRetries: 20, retryDelay: 100 })
      .catch(() => undefined);
  }
}
