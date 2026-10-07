import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import type {
  ExportDoneEvent,
  ExportFailedEvent,
  ExportProgressEvent,
} from '../../shared/history-ipc';
import { IpcError } from '../ipc-core';
import { log } from '../logger';
import { exportMp4 as realExportMp4, type Mp4Capability } from '../media/export';
import type { MediaTools } from '../media/ffmpeg';
import { JobRunner } from '../media/job-runner';
import type { HistoryService } from './service';

export interface ExportDeps {
  history: Pick<HistoryService, 'get' | 'addVideo'>;
  tools: MediaTools;
  capability: () => Promise<Mp4Capability>;
  /** The save dialog (main process). Null when the user cancels. */
  pickDestination: (source: { path: string }) => Promise<string | null>;
  /** "Export MP4 automatically": a free `<name>.mp4` next to the recording, no dialog. */
  autoDestination?: (source: { path: string }) => Promise<string>;
  emit: {
    progress: (event: ExportProgressEvent) => void;
    done: (event: ExportDoneEvent) => void;
    failed: (event: ExportFailedEvent) => void;
  };
  /** Shared with the compression service so only one ffmpeg job runs at a time. */
  runner?: JobRunner;
  /** Replaceable in tests. */
  exportMp4?: typeof realExportMp4;
}

/**
 * MP4 export jobs. The source is resolved from history in main (never a renderer path), the
 * destination comes from a save dialog in main. One export runs at a time: the encoder uses every
 * core, and a second job on the same source would only fight the first for the same file.
 */
export class ExportService {
  private readonly runner: JobRunner;
  /** True from the request until the dialog answered, so two clicks open one dialog. */
  private choosing = false;

  constructor(private readonly deps: ExportDeps) {
    this.runner = deps.runner ?? new JobRunner();
  }

  get active(): boolean {
    return this.runner.busy || this.choosing;
  }

  async start(historyId: string): Promise<{ jobId: string } | { cancelled: true }> {
    return this.begin(historyId, (source) => this.deps.pickDestination(source));
  }

  /**
   * The automatic export after a recording (settings): starts quietly, or does nothing when an
   * export is already running, MP4 is unavailable or anything else is wrong (the WebM is the
   * deliverable and is already saved).
   */
  async startAuto(historyId: string): Promise<void> {
    const { autoDestination } = this.deps;
    if (!autoDestination) return;
    try {
      await this.begin(historyId, (source) => autoDestination(source));
    } catch (error) {
      log.info(`Automatic MP4 export skipped: ${(error as Error).message}`);
    }
  }

  private async begin(
    historyId: string,
    pick: (source: { path: string }) => Promise<string | null>,
  ): Promise<{ jobId: string } | { cancelled: true }> {
    // The entry point of every MP4 export, including the automatic one after a recording.
    if (this.active) throw new IpcError('BUSY', 'An export is already running.');
    const item = this.deps.history.get(historyId);
    if (!item) throw new IpcError('NOT_FOUND', 'That recording is not in history.');
    if (item.type !== 'recording' || item.format !== 'webm') {
      throw new IpcError('INVALID_PAYLOAD', 'Only WebM recordings can be converted to MP4.');
    }
    const capability = await this.deps.capability();
    if (!capability.available) {
      throw new IpcError('FFMPEG_MISSING', capability.reason ?? 'MP4 export is not available.');
    }
    const present = await fs.promises.stat(item.path).then(
      (stat) => stat.isFile(),
      () => false,
    );
    if (!present) throw new IpcError('NOT_FOUND', 'The recording was moved or deleted.');

    this.choosing = true;
    let destPath: string | null;
    try {
      destPath = await pick({ path: item.path });
    } finally {
      this.choosing = false;
    }
    if (destPath === null) return { cancelled: true };

    const jobId = randomUUID();
    this.runner.enqueue({
      id: jobId,
      label: 'export-mp4',
      onProgress: (percent) => this.deps.emit.progress({ jobId, historyId, percent }),
      run: ({ signal, onProgress }) => this.run(jobId, item, destPath, signal, onProgress),
    });
    return { jobId };
  }

  private async run(
    jobId: string,
    item: NonNullable<ReturnType<ExportDeps['history']['get']>>,
    destPath: string,
    signal: AbortSignal,
    onProgress: (percent: number | null) => void,
  ): Promise<void> {
    const historyId = item.id;
    const exportMp4 = this.deps.exportMp4 ?? realExportMp4;
    try {
      const result = await exportMp4({
        tools: this.deps.tools,
        sourcePath: item.path,
        destPath,
        signal,
        onProgress,
      });
      if (!result.ok) {
        log.warn(`MP4 export ended: ${result.code}`);
        if (result.stderrTail) log.warn(`ffmpeg: ${result.stderrTail.slice(-600)}`);
        this.deps.emit.failed({
          jobId,
          historyId,
          code: result.code,
          message: result.message,
          cancelled: result.code === 'CANCELLED',
        });
        return;
      }
      let itemId: string | null = null;
      try {
        itemId = (
          await this.deps.history.addVideo({
            path: result.path,
            format: 'mp4',
            durationMs: result.durationMs,
            width: result.probe.video?.width ?? item.width,
            height: result.probe.video?.height ?? item.height,
            sizeBytes: result.bytes,
            hasAudio: result.probe.hasAudio,
            source: item.source,
            derivedFrom: item.id,
          })
        ).id;
      } catch (error) {
        log.error('The MP4 was saved but could not be added to history', error);
      }
      log.info(`MP4 exported: ${result.bytes} bytes, ${result.durationMs} ms`);
      this.deps.emit.done({ jobId, historyId, path: result.path, itemId });
    } catch (error) {
      log.error('MP4 export failed unexpectedly', error);
      this.deps.emit.failed({
        jobId,
        historyId,
        code: 'FAILED',
        message: 'The video could not be converted.',
        cancelled: false,
      });
    }
  }

  cancel(jobId: string): void {
    if (!this.runner.cancel(jobId)) throw new IpcError('NOT_FOUND', 'That export is not running.');
  }

  /** Aborts the running export and waits until its partial file is gone (quit path). */
  cancelAll(): Promise<void> {
    return this.runner.cancelAll();
  }

  /** Resolves when the running job (if any) has finished; for tests. */
  settled(): Promise<void> {
    return this.runner.idle();
  }
}
