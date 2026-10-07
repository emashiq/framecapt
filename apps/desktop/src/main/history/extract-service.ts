import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type {
  ExportDoneEvent,
  ExportFailedEvent,
  ExportProgressEvent,
  ExtractFcapRequest,
} from '../../shared/history-ipc';
import { layoutSourceRect } from '../../shared/recording-layout';
import { IpcError } from '../ipc-core';
import { log } from '../logger';
import type { Mp4Capability } from '../media/export';
import { extractFromFcap } from '../media/extract';
import type { MediaTools } from '../media/ffmpeg';
import type { JobRunner } from '../media/job-runner';
import { FcapError, readFcapHeaderCached } from '../recording/fcap';
import type { HistoryService } from './service';

export interface ExtractDeps {
  history: Pick<HistoryService, 'get' | 'addVideo'>;
  tools: MediaTools;
  capability: () => Promise<Mp4Capability>;
  /** Shared with the export and compression services: one ffmpeg job at a time. */
  runner: JobRunner;
  emit: {
    progress: (event: ExportProgressEvent) => void;
    done: (event: ExportDoneEvent) => void;
    failed: (event: ExportFailedEvent) => void;
  };
  /** Replaceable in tests. */
  extract?: typeof extractFromFcap;
}

/** How an extract ended: the new history item (null when it failed, with the reason). */
export interface ExtractOutcome {
  itemId: string | null;
  error?: string;
}

/** A free `<name> - Screen 1.mp4` next to the recording (no dialog). */
async function freeExtractPath(
  fcap: string,
  suffix: string,
  extension: '.mp4' | '.webm',
): Promise<string> {
  const dir = path.dirname(fcap);
  const base = path.basename(fcap, path.extname(fcap));
  for (let attempt = 1; attempt < 1000; attempt += 1) {
    const name = `${base} - ${suffix}${attempt === 1 ? '' : ` (${attempt})`}${extension}`;
    const candidate = path.join(dir, name);
    if (!fs.existsSync(candidate)) return candidate;
  }
  throw new Error('No free extract name.');
}

/**
 * "Extract" from a multi-source recording: one source (or the whole picture) between two times,
 * as MP4 or WebM, next to the `.fcap`, as a new history item that remembers where it came from.
 * The recording is resolved from history in main, the output name is made here (never a renderer
 * path), and the `.fcap` is only read. Progress and cancel use the export events and channel.
 */
export class ExtractService {
  /** Callers waiting for a job to end (`startAndWait`), by job id. */
  private readonly waiters = new Map<string, (result: ExtractOutcome) => void>();
  /** The deps' events, also telling whoever waits for the job that just ended. */
  private readonly emit: ExtractDeps['emit'];

  constructor(private readonly deps: ExtractDeps) {
    this.emit = {
      progress: (event) => deps.emit.progress(event),
      done: (event) => {
        deps.emit.done(event);
        this.settle(event.jobId, { itemId: event.itemId });
      },
      failed: (event) => {
        deps.emit.failed(event);
        this.settle(event.jobId, { itemId: null, error: event.message });
      },
    };
  }

  private settle(jobId: string, outcome: ExtractOutcome): void {
    const waiter = this.waiters.get(jobId);
    this.waiters.delete(jobId);
    waiter?.(outcome);
  }

  /** Starts an extract and resolves when it has ended (the events are sent as usual). */
  async startAndWait(request: ExtractFcapRequest): Promise<ExtractOutcome> {
    let settled!: (outcome: ExtractOutcome) => void;
    const ended = new Promise<ExtractOutcome>((resolve) => (settled = resolve));
    await this.start(request, settled);
    return ended;
  }

  async start(
    request: ExtractFcapRequest,
    onSettled?: (outcome: ExtractOutcome) => void,
  ): Promise<{ jobId: string }> {
    const { runner, history } = this.deps;
    if (runner.busy) throw new IpcError('BUSY', 'An export is already running.');
    const item = history.get(request.id);
    if (!item) throw new IpcError('NOT_FOUND', 'That recording is not in history.');
    if (item.type !== 'recording' || item.format !== 'fcap') {
      throw new IpcError('INVALID_PAYLOAD', 'Only multi-source recordings can be extracted.');
    }
    const present = await fs.promises.stat(item.path).then(
      (stat) => stat.isFile(),
      () => false,
    );
    if (!present) throw new IpcError('NOT_FOUND', 'The recording was moved or deleted.');
    let header;
    try {
      header = await readFcapHeaderCached(item.path);
    } catch (error) {
      if (error instanceof FcapError) throw new IpcError('INVALID_PAYLOAD', error.message);
      throw error;
    }
    const crop =
      request.sourceIndex === null ? null : layoutSourceRect(header, request.sourceIndex);
    if (request.sourceIndex !== null && !crop) {
      throw new IpcError('INVALID_PAYLOAD', 'That source is not in the recording.');
    }
    const endMs =
      header.durationMs > 0 ? Math.min(request.endMs, header.durationMs) : request.endMs;
    if (endMs - request.startMs < 100) {
      throw new IpcError('INVALID_PAYLOAD', 'Choose a longer part of the recording.');
    }
    if (request.format === 'mp4') {
      const capability = await this.deps.capability();
      if (!capability.available) {
        throw new IpcError('FFMPEG_MISSING', capability.reason ?? 'MP4 export is not available.');
      }
    }
    const suffix =
      request.sourceIndex === null
        ? 'All'
        : (header.sources[request.sourceIndex]?.name ?? 'Source');
    const destPath = await freeExtractPath(
      item.path,
      suffix,
      request.format === 'mp4' ? '.mp4' : '.webm',
    );

    const jobId = randomUUID();
    if (onSettled) this.waiters.set(jobId, onSettled);
    const historyId = item.id;
    const sourceKind =
      request.sourceIndex === null
        ? ('multi' as const)
        : (header.sources[request.sourceIndex]?.kind ?? 'screen');
    runner.enqueue({
      id: jobId,
      label: 'extract-fcap',
      onProgress: (percent) => this.emit.progress({ jobId, historyId, percent, kind: 'extract' }),
      run: async ({ signal, onProgress }) => {
        const failed = (message: string, code = 'FAILED', cancelled = false): void =>
          this.emit.failed({ jobId, historyId, code, message, cancelled, kind: 'extract' });
        try {
          const result = await (this.deps.extract ?? extractFromFcap)({
            tools: this.deps.tools,
            spec: {
              input: { path: item.path, format: 'fcap' },
              startMs: request.startMs,
              endMs,
              crop,
              format: request.format,
            },
            picture: header,
            destPath,
            signal,
            onProgress,
          });
          if (!result.ok) {
            log.warn(`Extract ended: ${result.code}`);
            if (result.stderrTail) log.warn(`ffmpeg: ${result.stderrTail.slice(-600)}`);
            failed(result.message, result.code, result.code === 'CANCELLED');
            return;
          }
          let itemId: string | null = null;
          try {
            itemId = (
              await history.addVideo({
                path: result.path,
                format: request.format,
                durationMs: result.durationMs,
                width: result.probe.video?.width ?? header.width,
                height: result.probe.video?.height ?? header.height,
                sizeBytes: result.bytes,
                hasAudio: result.probe.hasAudio,
                source: sourceKind,
                derivedFrom: item.id,
              })
            ).id;
          } catch (error) {
            log.error('The extract was saved but could not be added to history', error);
          }
          log.info(`Extracted ${suffix}: ${result.bytes} bytes, ${result.durationMs} ms`);
          this.emit.done({ jobId, historyId, path: result.path, itemId, kind: 'extract' });
        } catch (error) {
          log.error('Extract failed unexpectedly', error);
          failed('The video could not be extracted.');
        }
      },
    });
    return { jobId };
  }
}
