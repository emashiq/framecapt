import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type {
  ExportDoneEvent,
  ExportFailedEvent,
  ExportProgressEvent,
  SaveAsRequest,
} from '../../shared/history-ipc';
import {
  GIF_MAX_SECONDS,
  SAVE_FORMAT_LABEL,
  isNoopConversion,
  needsFinalize,
  type Compression,
  type SaveFormat,
} from '../../shared/recording-format';
import type { ToastEvent } from '../../shared/settings-ipc';
import { IpcError } from '../ipc-core';
import { log } from '../logger';
import {
  EXTENSION,
  canConvert,
  convertVideo as realConvertVideo,
  type ConvertSpec,
  type EncoderCapability,
} from '../media/convert';
import type { MediaTools } from '../media/ffmpeg';
import type { FileJobResult, JobRunner } from '../media/job-runner';
import type { HistoryItem } from './store';
import type { HistoryService } from './service';

type Source = { path: string; format: 'webm' | 'mp4' | 'mkv' };

export interface FinalizeDeps {
  history: Pick<HistoryService, 'get' | 'replaceVideoFile' | 'addVideo'>;
  tools: MediaTools;
  encoders: () => Promise<EncoderCapability>;
  /** "Save recordings as" and "Compression" from the settings, read when a recording is saved. */
  settings: () => { saveFormat: SaveFormat; compression: Compression };
  /** A free `<name><suffix>.<extension>` next to the recording. */
  destination: (source: { path: string }, extension: string, suffix: string) => Promise<string>;
  /** Moves a file to the Recycle Bin (`shell.trashItem`). */
  trashItem: (file: string) => Promise<void>;
  /** Shared with the export service: one ffmpeg job at a time. */
  runner: JobRunner;
  emit: {
    progress: (event: ExportProgressEvent) => void;
    done: (event: ExportDoneEvent) => void;
    failed: (event: ExportFailedEvent) => void;
  };
  /** A message for the user that is not a job result (a GIF that is too long stays a WebM). */
  toast?: (event: ToastEvent) => void;
  /** The recording's file was replaced (the clipboard holds the old path: re-copy the new one). */
  onReplaced?: (change: { from: string; to: string }) => void;
  /** Replaceable in tests. */
  convert?: typeof realConvertVideo;
}

/** What a saved recording needs, from the settings and the recording itself; null: nothing. */
export function finalizePlan(
  settings: { saveFormat: SaveFormat; compression: Compression },
  item: Pick<HistoryItem, 'type' | 'format' | 'durationMs'>,
): { spec: ConvertSpec } | { skip: 'gif-too-long' } | null {
  const { saveFormat, compression } = settings;
  if (item.type !== 'recording' || item.format !== 'webm') return null;
  if (!needsFinalize(saveFormat, compression)) return null;
  if (saveFormat === 'gif' && (item.durationMs ?? 0) > GIF_MAX_SECONDS * 1000) {
    return { skip: 'gif-too-long' };
  }
  return { spec: { format: saveFormat, compression } };
}

function isConvertible(item: HistoryItem | undefined): item is HistoryItem & Source {
  return (
    item?.type === 'recording' &&
    (item.format === 'webm' || item.format === 'mp4' || item.format === 'mkv')
  );
}

async function exists(file: string): Promise<boolean> {
  return fs.promises.stat(file).then(
    (stat) => stat.isFile(),
    () => false,
  );
}

const NOT_AVAILABLE = (format: SaveFormat): string =>
  `This FFmpeg build cannot make ${SAVE_FORMAT_LABEL[format]} with that setting.`;

/**
 * The "save format and compression" jobs. After a WebM recording is saved (the settings), the file
 * is converted and the history item is pointed at the result; the WebM goes to the Recycle Bin only
 * after the new file is verified, and any failure or cancel leaves the item exactly as it was.
 * "Save as…" makes the same conversion into a new file and a new history item instead.
 */
export class FinalizeService {
  constructor(private readonly deps: FinalizeDeps) {}

  /** Queues the job when the settings ask for one; anything wrong keeps the WebM as the result. */
  async startAfterSave(historyId: string): Promise<void> {
    try {
      const item = this.deps.history.get(historyId);
      if (!item) return;
      const plan = finalizePlan(this.deps.settings(), item);
      if (plan === null) return;
      if ('skip' in plan) {
        this.deps.toast?.({
          level: 'info',
          message: `Recording is longer than ${GIF_MAX_SECONDS} s, so it stays a WebM (a GIF is for short clips).`,
        });
        return;
      }
      if (!canConvert(plan.spec, await this.deps.encoders())) {
        log.info(`Conversion skipped: ${NOT_AVAILABLE(plan.spec.format)}`);
        this.deps.toast?.({
          level: 'info',
          message: `${NOT_AVAILABLE(plan.spec.format)} The recording stays a WebM.`,
        });
        return;
      }
      if (!(await exists(item.path))) return;
      // Same extension (a smaller WebM): a sibling name now, the original name once the original is gone.
      const sameExtension = EXTENSION[plan.spec.format] === path.extname(item.path).toLowerCase();
      const destPath = await this.deps.destination(
        { path: item.path },
        EXTENSION[plan.spec.format],
        sameExtension ? ' (compressed)' : '',
      );
      this.enqueue('compress', historyId, (jobId, signal, onProgress) =>
        this.replaceInPlace(jobId, historyId, plan.spec, destPath, signal, onProgress),
      );
    } catch (error) {
      log.info(`Conversion skipped: ${(error as Error).message}`);
    }
  }

  /** "Save as…": a copy of a recording in another format, a new history item next to the source. */
  async saveAs(request: SaveAsRequest): Promise<{ jobId: string }> {
    const item = this.deps.history.get(request.id);
    if (!item) throw new IpcError('NOT_FOUND', 'That recording is not in history.');
    if (!isConvertible(item)) {
      throw new IpcError(
        'INVALID_PAYLOAD',
        'Only WebM, MP4 and MKV recordings can be saved in another format.',
      );
    }
    const spec: ConvertSpec = {
      format: request.format,
      compression: request.compression,
      ...(request.maxWidth !== undefined && { maxWidth: request.maxWidth }),
    };
    if (isNoopConversion(item.format, spec)) {
      throw new IpcError(
        'INVALID_PAYLOAD',
        'Choose another format, a compression level or a width.',
      );
    }
    if (spec.format === 'gif' && (item.durationMs ?? 0) > GIF_MAX_SECONDS * 1000) {
      throw new IpcError(
        'INVALID_PAYLOAD',
        `A GIF is for clips up to ${GIF_MAX_SECONDS} s. Trim the recording first.`,
      );
    }
    if (!canConvert(spec, await this.deps.encoders())) {
      throw new IpcError('FFMPEG_MISSING', NOT_AVAILABLE(spec.format));
    }
    if (!(await exists(item.path))) {
      throw new IpcError('NOT_FOUND', 'The recording was moved or deleted.');
    }
    const sameExtension = EXTENSION[spec.format] === path.extname(item.path).toLowerCase();
    const destPath = await this.deps.destination(
      { path: item.path },
      EXTENSION[spec.format],
      sameExtension ? ' (compressed)' : '',
    );
    const jobId = this.enqueue('convert', request.id, (id, signal, onProgress) =>
      this.writeCopy(id, item, spec, destPath, signal, onProgress),
    );
    return { jobId };
  }

  private enqueue(
    kind: 'compress' | 'convert',
    historyId: string,
    run: (
      jobId: string,
      signal: AbortSignal,
      onProgress: (percent: number | null) => void,
    ) => Promise<void>,
  ): string {
    const jobId = randomUUID();
    this.deps.runner.enqueue({
      id: jobId,
      label: kind === 'compress' ? 'finalize' : 'save-as',
      onProgress: (percent) => this.deps.emit.progress({ jobId, historyId, percent, kind }),
      run: ({ signal, onProgress }) => run(jobId, signal, onProgress),
    });
    return jobId;
  }

  private async convert(
    item: HistoryItem & Source,
    spec: ConvertSpec,
    destPath: string,
    signal: AbortSignal,
    onProgress: (percent: number | null) => void,
  ) {
    return (this.deps.convert ?? realConvertVideo)({
      tools: this.deps.tools,
      sourcePath: item.path,
      sourceFormat: item.format,
      destPath,
      spec,
      signal,
      onProgress,
    });
  }

  private fail(
    kind: 'compress' | 'convert',
    jobId: string,
    historyId: string,
    result: { code: string; message: string; stderrTail?: string },
  ): void {
    log.warn(`Conversion ended: ${result.code}`);
    if (result.stderrTail) log.warn(`ffmpeg: ${result.stderrTail.slice(-600)}`);
    this.deps.emit.failed({
      jobId,
      historyId,
      code: result.code,
      message: result.message,
      cancelled: result.code === 'CANCELLED',
      kind,
    });
  }

  private async replaceInPlace(
    jobId: string,
    historyId: string,
    spec: ConvertSpec,
    destPath: string,
    signal: AbortSignal,
    onProgress: (percent: number | null) => void,
  ): Promise<void> {
    const item = this.deps.history.get(historyId);
    if (!isConvertible(item)) return;
    try {
      const result = await this.convert(item, spec, destPath, signal, onProgress);
      if (!result.ok) return this.fail('compress', jobId, historyId, result);
      const replaced = await this.deps.history.replaceVideoFile(historyId, {
        path: result.path,
        format: spec.format,
        sizeBytes: result.bytes,
        durationMs: result.durationMs,
        width: result.probe.video?.width ?? item.width,
        height: result.probe.video?.height ?? item.height,
        hasAudio: result.probe.hasAudio,
      });
      if (!replaced) {
        // Removed from history meanwhile: both files stay where they are.
        log.info('The converted video was kept next to the recording (the item left history)');
        this.deps.emit.done({
          jobId,
          historyId,
          path: result.path,
          itemId: null,
          kind: 'compress',
        });
        return;
      }
      let finalPath = result.path;
      try {
        await this.deps.trashItem(item.path);
        finalPath = await this.takeOriginalName(historyId, item, result);
      } catch (error) {
        log.warn(
          `The original recording could not be moved to the Recycle Bin (${(error as Error).message})`,
        );
      }
      log.info(
        `Converted to ${spec.format}/${spec.compression}: ${item.sizeBytes} -> ${result.bytes} bytes`,
      );
      this.deps.onReplaced?.({ from: item.path, to: finalPath });
      this.deps.emit.done({
        jobId,
        historyId,
        path: finalPath,
        itemId: historyId,
        kind: 'compress',
      });
    } catch (error) {
      log.error('Conversion failed unexpectedly', error);
      this.deps.emit.failed({
        jobId,
        historyId,
        code: 'FAILED',
        message: 'The video could not be converted.',
        cancelled: false,
        kind: 'compress',
      });
    }
  }

  /**
   * A smaller WebM was written next to the WebM (same extension): once the original is in the
   * Recycle Bin the new file takes its name. Failing to rename is harmless (it keeps its own).
   */
  private async takeOriginalName(
    historyId: string,
    original: HistoryItem & Source,
    result: Extract<FileJobResult, { ok: true }>,
  ): Promise<string> {
    if (path.extname(original.path).toLowerCase() !== path.extname(result.path).toLowerCase()) {
      return result.path;
    }
    try {
      await fs.promises.rename(result.path, original.path);
      await this.deps.history.replaceVideoFile(historyId, {
        path: original.path,
        format: original.format,
        sizeBytes: result.bytes,
        durationMs: result.durationMs,
        width: result.probe.video?.width ?? original.width,
        height: result.probe.video?.height ?? original.height,
        hasAudio: result.probe.hasAudio,
      });
      return original.path;
    } catch (error) {
      log.warn(`The converted video kept its own name (${(error as Error).message})`);
      return result.path;
    }
  }

  private async writeCopy(
    jobId: string,
    item: HistoryItem & Source,
    spec: ConvertSpec,
    destPath: string,
    signal: AbortSignal,
    onProgress: (percent: number | null) => void,
  ): Promise<void> {
    const historyId = item.id;
    try {
      const result = await this.convert(item, spec, destPath, signal, onProgress);
      if (!result.ok) return this.fail('convert', jobId, historyId, result);
      let itemId: string | null = null;
      try {
        itemId = (
          await this.deps.history.addVideo({
            path: result.path,
            format: spec.format,
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
        log.error('The converted video was saved but could not be added to history', error);
      }
      log.info(`Saved as ${spec.format}: ${result.bytes} bytes`);
      this.deps.emit.done({ jobId, historyId, path: result.path, itemId, kind: 'convert' });
    } catch (error) {
      log.error('Save as failed unexpectedly', error);
      this.deps.emit.failed({
        jobId,
        historyId,
        code: 'FAILED',
        message: 'The video could not be converted.',
        cancelled: false,
        kind: 'convert',
      });
    }
  }
}
