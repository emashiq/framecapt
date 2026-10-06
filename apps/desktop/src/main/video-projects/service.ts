import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type {
  VideoExportDoneEvent,
  VideoExportFailedEvent,
  VideoExportProgressEvent,
} from '../../shared/video-ipc';
import {
  createProject,
  normalizeProject,
  type VideoExportFormat,
  type VideoProject,
} from '../../shared/video-edit';
import type { HistoryService } from '../history/service';
import { IpcError } from '../ipc-core';
import { log } from '../logger';
import { exportEdit as realExportEdit, withProbedSource } from '../media/edit-export';
import type { MediaTools, ProbeResult } from '../media/ffmpeg';
import type { JobRunner } from '../media/job-runner';
import type { VideoProjectStore } from './store';

export interface VideoEditDeps {
  history: Pick<HistoryService, 'get' | 'addVideo'>;
  store: Pick<VideoProjectStore, 'read' | 'write'>;
  tools: MediaTools;
  /** Shared with the MP4 export and compression: one ffmpeg job at a time. */
  runner: JobRunner;
  /** A free `<name> (edited).<ext>` next to the source. */
  destination: (source: { path: string }, extension: string) => Promise<string>;
  emit: {
    progress: (event: VideoExportProgressEvent) => void;
    done: (event: VideoExportDoneEvent) => void;
    failed: (event: VideoExportFailedEvent) => void;
  };
  /** Replaceable in tests. */
  exportEdit?: typeof realExportEdit;
}

type SourceItem = NonNullable<ReturnType<VideoEditDeps['history']['get']>>;

/**
 * The video editor's main side. The source is resolved from history (never a renderer path), the
 * project is only a recipe stored apart from the video, and an export is a job on the shared queue
 * that writes a NEW file next to the source and adds it to history; the source is never changed.
 */
export class VideoEditService {
  /** Recordings with an export queued or running. */
  private readonly exporting = new Set<string>();

  constructor(private readonly deps: VideoEditDeps) {}

  private async sourceOf(historyId: string): Promise<SourceItem> {
    const item = this.deps.history.get(historyId);
    if (!item) throw new IpcError('NOT_FOUND', 'That recording is not in history.');
    if (item.type !== 'recording' || (item.format !== 'webm' && item.format !== 'mp4')) {
      throw new IpcError('INVALID_PAYLOAD', 'Only WebM and MP4 recordings can be edited.');
    }
    const present = await fs.promises.stat(item.path).then(
      (stat) => stat.isFile(),
      () => false,
    );
    if (!present) throw new IpcError('NOT_FOUND', 'The recording was moved or deleted.');
    return item;
  }

  /** The saved project (checked against the file as it is now) or a new one made from the file. */
  async open(
    historyId: string,
  ): Promise<{ project: VideoProject; fileName: string; restored: boolean }> {
    const item = await this.sourceOf(historyId);
    let probe: ProbeResult;
    try {
      probe = await this.deps.tools.probe(item.path, { timeoutMs: 30_000 });
    } catch {
      throw new IpcError('INVALID_PAYLOAD', 'FrameCapt could not read that recording.');
    }
    if (!probe.hasVideo || !probe.video) {
      throw new IpcError('INVALID_PAYLOAD', 'That file has no video.');
    }
    const durationMs =
      probe.durationSec !== null ? Math.round(probe.durationSec * 1000) : item.durationMs;
    if (durationMs === null || durationMs <= 0) {
      throw new IpcError(
        'INVALID_PAYLOAD',
        'FrameCapt could not find the length of that recording.',
      );
    }
    const saved = await this.deps.store.read(historyId);
    if (saved.ok) {
      return {
        project: withProbedSource(saved.project, probe),
        fileName: path.basename(item.path),
        restored: true,
      };
    }
    return {
      project: createProject(historyId, {
        durationMs,
        width: probe.video.width,
        height: probe.video.height,
        hasAudio: probe.hasAudio,
      }),
      fileName: path.basename(item.path),
      restored: false,
    };
  }

  async save(historyId: string, project: VideoProject): Promise<void> {
    if (!this.deps.history.get(historyId) || project.sourceId !== historyId) {
      throw new IpcError('NOT_FOUND', 'That recording is not in history.');
    }
    try {
      await this.deps.store.write(historyId, normalizeProject(project));
    } catch (error) {
      log.warn(`A video project could not be saved (${(error as Error).message})`);
      throw new IpcError('INTERNAL', 'The project could not be saved.');
    }
  }

  async export(
    historyId: string,
    project: VideoProject,
    format: VideoExportFormat,
  ): Promise<{ jobId: string }> {
    const item = await this.sourceOf(historyId);
    if (project.sourceId !== historyId) {
      throw new IpcError('INVALID_PAYLOAD', 'That project belongs to another recording.');
    }
    // Two exports of one recording would pick the same free name.
    if (this.exporting.has(historyId)) {
      throw new IpcError('BUSY', 'This recording is already being exported.');
    }
    const normalized = normalizeProject({ ...project, export: { ...project.export, format } });
    await this.save(historyId, normalized).catch(() => undefined);
    const extension = `.${format}`;
    const destPath = await this.deps.destination({ path: item.path }, extension);
    const jobId = randomUUID();
    this.exporting.add(historyId);
    const { done } = this.deps.runner.enqueue({
      id: jobId,
      label: 'edit-export',
      onProgress: (percent) => this.deps.emit.progress({ jobId, historyId, percent }),
      run: ({ signal, onProgress }) =>
        this.run(jobId, item, normalized, format, destPath, signal, onProgress),
    });
    void done.then(() => this.exporting.delete(historyId));
    return { jobId };
  }

  private async run(
    jobId: string,
    item: SourceItem,
    project: VideoProject,
    format: VideoExportFormat,
    destPath: string,
    signal: AbortSignal,
    onProgress: (percent: number | null) => void,
  ): Promise<void> {
    const historyId = item.id;
    const failed = (code: string, message: string, cancelled = false): void =>
      this.deps.emit.failed({ jobId, historyId, code, message, cancelled });
    try {
      const result = await (this.deps.exportEdit ?? realExportEdit)({
        tools: this.deps.tools,
        sourcePath: item.path,
        destPath,
        project,
        format,
        signal,
        onProgress,
      });
      if (!result.ok) {
        log.warn(`Video export ended: ${result.code}`);
        if (result.stderrTail) log.warn(`ffmpeg: ${result.stderrTail.slice(-600)}`);
        failed(result.code, result.message, result.code === 'CANCELLED');
        return;
      }
      let itemId: string | null = null;
      try {
        itemId = (
          await this.deps.history.addVideo({
            path: result.path,
            format,
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
        log.error('The edited video was saved but could not be added to history', error);
      }
      log.info(`Video exported (${format}): ${result.bytes} bytes, ${result.durationMs} ms`);
      this.deps.emit.done({ jobId, historyId, path: result.path, format, itemId });
    } catch (error) {
      log.error('Video export failed unexpectedly', error);
      failed('FAILED', 'The video could not be exported.');
    }
  }
}

/** A free `<source base> (edited).<ext>` in the source's folder. */
export async function editedDestination(
  source: { path: string },
  extension: string,
  freeName: (dir: string, fileName: string) => Promise<string>,
): Promise<string> {
  const base = path.basename(source.path, path.extname(source.path));
  return freeName(path.dirname(source.path), `${base} (edited)${extension}`);
}
