import fs from 'node:fs';
import { randomUUID } from 'node:crypto';
import type {
  ExportDoneEvent,
  ExportFailedEvent,
  ExportProgressEvent,
} from '../../shared/history-ipc';
import { log } from '../logger';
import { exportMp4 as realExportMp4, type Mp4Capability } from '../media/export';
import type { MediaTools } from '../media/ffmpeg';
import type { JobRunner } from '../media/job-runner';
import type { HistoryService } from './service';

export interface CompressDeps {
  history: Pick<HistoryService, 'get' | 'replaceVideoFile'>;
  tools: MediaTools;
  capability: () => Promise<Mp4Capability>;
  /** "Video storage" from the settings, read when a recording is saved. */
  storage: () => 'original' | 'compressed';
  /** A free `<name>.mp4` next to the recording. */
  destination: (source: { path: string }) => Promise<string>;
  /** Moves a file to the Recycle Bin (`shell.trashItem`). */
  trashItem: (file: string) => Promise<void>;
  /** Shared with the export service: one ffmpeg job at a time. */
  runner: JobRunner;
  emit: {
    progress: (event: ExportProgressEvent) => void;
    done: (event: ExportDoneEvent) => void;
    failed: (event: ExportFailedEvent) => void;
  };
  /** Replaceable in tests. */
  exportMp4?: typeof realExportMp4;
}

/** What happens to a saved recording: compressed storage wins over the automatic MP4 export. */
export function postSaveAction(recording: {
  storage: 'original' | 'compressed';
  autoExportMp4: boolean;
}): 'compress' | 'export' | null {
  if (recording.storage === 'compressed') return 'compress';
  return recording.autoExportMp4 ? 'export' : null;
}

/**
 * Compressed storage: after a WebM recording is saved, re-encode it to a smaller MP4, point the
 * history item at it and only then move the WebM to the Recycle Bin. The WebM is never touched
 * until the MP4 is verified, and any failure or cancel leaves the item exactly as it was.
 */
export class CompressService {
  constructor(private readonly deps: CompressDeps) {}

  /** Queues the job when the setting asks for it; anything wrong keeps the WebM as the result. */
  async startIfEnabled(historyId: string): Promise<void> {
    if (this.deps.storage() !== 'compressed') return;
    try {
      const item = this.deps.history.get(historyId);
      if (item?.type !== 'recording' || item.format !== 'webm') return;
      const capability = await this.deps.capability();
      if (!capability.available) {
        log.info(`Compression skipped: ${capability.reason ?? 'MP4 is not available'}`);
        return;
      }
      const present = await fs.promises.stat(item.path).then(
        (stat) => stat.isFile(),
        () => false,
      );
      if (!present) return;
      const destPath = await this.deps.destination({ path: item.path });
      const jobId = randomUUID();
      this.deps.runner.enqueue({
        id: jobId,
        label: 'compress',
        onProgress: (percent) =>
          this.deps.emit.progress({ jobId, historyId, percent, kind: 'compress' }),
        run: ({ signal, onProgress }) => this.run(jobId, historyId, destPath, signal, onProgress),
      });
    } catch (error) {
      log.info(`Compression skipped: ${(error as Error).message}`);
    }
  }

  private async run(
    jobId: string,
    historyId: string,
    destPath: string,
    signal: AbortSignal,
    onProgress: (percent: number | null) => void,
  ): Promise<void> {
    const item = this.deps.history.get(historyId);
    const failed = (message: string, code = 'FAILED', cancelled = false): void =>
      this.deps.emit.failed({ jobId, historyId, code, message, cancelled, kind: 'compress' });
    if (!item) return;
    try {
      const result = await (this.deps.exportMp4 ?? realExportMp4)({
        tools: this.deps.tools,
        sourcePath: item.path,
        destPath,
        profile: 'compressed',
        signal,
        onProgress,
      });
      if (!result.ok) {
        log.warn(`Compression ended: ${result.code}`);
        if (result.stderrTail) log.warn(`ffmpeg: ${result.stderrTail.slice(-600)}`);
        failed(result.message, result.code, result.code === 'CANCELLED');
        return;
      }
      const replaced = await this.deps.history.replaceVideoFile(historyId, {
        path: result.path,
        sizeBytes: result.bytes,
        durationMs: result.durationMs,
        width: result.probe.video?.width ?? item.width,
        height: result.probe.video?.height ?? item.height,
        hasAudio: result.probe.hasAudio,
      });
      if (!replaced) {
        // Removed from history meanwhile: both files stay where they are.
        log.info('Compressed MP4 kept next to the recording (the item left history)');
        this.deps.emit.done({
          jobId,
          historyId,
          path: result.path,
          itemId: null,
          kind: 'compress',
        });
        return;
      }
      try {
        await this.deps.trashItem(item.path);
      } catch (error) {
        log.warn(
          `The original WebM could not be moved to the Recycle Bin (${(error as Error).message})`,
        );
      }
      log.info(`Compressed: ${item.sizeBytes} -> ${result.bytes} bytes`);
      this.deps.emit.done({
        jobId,
        historyId,
        path: result.path,
        itemId: historyId,
        kind: 'compress',
      });
    } catch (error) {
      log.error('Compression failed unexpectedly', error);
      failed('The video could not be compressed.');
    }
  }
}
