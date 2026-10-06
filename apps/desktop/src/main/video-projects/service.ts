import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type {
  VideoExportDoneEvent,
  VideoExportFailedEvent,
  VideoExportProgressEvent,
} from '../../shared/video-ipc';
import {
  AUDIO_EXTENSIONS,
  MAX_CLIP_MS,
  createProject,
  normalizeProject,
  type AudioExtension,
  type VideoExportFormat,
  type VideoProject,
} from '../../shared/video-edit';
import { detectImageFormat, readImageSize } from '../../shared/shots';
import type { RecordingLayout } from '../../shared/recording-layout';
import type { HistoryService } from '../history/service';
import { IpcError } from '../ipc-core';
import { log } from '../logger';
import { exportEdit as realExportEdit, withProbedSource } from '../media/edit-export';
import type { MediaTools, ProbeResult } from '../media/ffmpeg';
import type { JobRunner } from '../media/job-runner';
import { readFcapHeaderCached } from '../recording/fcap';
import type { VideoProjectStore } from './store';

export interface VideoEditDeps {
  history: Pick<HistoryService, 'get' | 'addVideo'>;
  store: Pick<
    VideoProjectStore,
    'read' | 'write' | 'writePicture' | 'importAudio' | 'removeAsset' | 'pruneAssets' | 'assetPath'
  >;
  /** The Open dialog (main process) for an audio file; null when it is cancelled. */
  pickAudioFile: () => Promise<string | null>;
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

/** An unused asset is deleted by a save only when it is older than this (Undo, a file just added). */
const ASSET_GRACE_MS = 10 * 60 * 1000;
/** The largest audio file that may be added. */
export const MAX_AUDIO_FILE_BYTES = 100 * 1024 * 1024;

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
    if (
      item.type !== 'recording' ||
      (item.format !== 'webm' && item.format !== 'mp4' && item.format !== 'fcap')
    ) {
      throw new IpcError(
        'INVALID_PAYLOAD',
        'Only WebM, MP4 and multi-source recordings can be edited.',
      );
    }
    const present = await fs.promises.stat(item.path).then(
      (stat) => stat.isFile(),
      () => false,
    );
    if (!present) throw new IpcError('NOT_FOUND', 'The recording was moved or deleted.');
    return item;
  }

  /** The saved project (checked against the file as it is now) or a new one made from the file. */
  async open(historyId: string): Promise<{
    project: VideoProject;
    fileName: string;
    restored: boolean;
    /** The sources of a multi-source recording (the editor's "Source" choice); null for any other. */
    layout: RecordingLayout | null;
  }> {
    const item = await this.sourceOf(historyId);
    let probe: ProbeResult;
    let layout: RecordingLayout | null = null;
    try {
      if (item.format === 'fcap') {
        const { width, height, sources } = await readFcapHeaderCached(item.path);
        layout = { width, height, sources };
      }
      probe = await this.deps.tools.probe(item.path, { timeoutMs: 30_000, format: item.format });
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
    // The frame rate the recorder was asked for; else what the file reports when believable.
    const fps = item.fps ?? probe.frameRate;
    const saved = await this.deps.store.read(historyId);
    if (saved.ok) {
      const refreshed = withProbedSource(saved.project, probe);
      // Nothing else is editing this project yet: assets no item uses can go.
      void this.deps.store.pruneAssets(historyId, refreshed, 0).catch(() => undefined);
      return {
        project:
          fps === undefined ? refreshed : { ...refreshed, source: { ...refreshed.source, fps } },
        fileName: path.basename(item.path),
        restored: true,
        layout,
      };
    }
    return {
      project: createProject(historyId, {
        durationMs,
        width: probe.video.width,
        height: probe.video.height,
        hasAudio: probe.hasAudio,
        ...(fps !== undefined && { fps }),
      }),
      fileName: path.basename(item.path),
      restored: false,
      layout,
    };
  }

  async save(historyId: string, project: VideoProject): Promise<void> {
    if (!this.deps.history.get(historyId) || project.sourceId !== historyId) {
      throw new IpcError('NOT_FOUND', 'That recording is not in history.');
    }
    try {
      const normalized = normalizeProject(project);
      await this.deps.store.write(historyId, normalized);
      // A picture or sound that no item uses goes after a while (an item just removed can come
      // back with Undo, a file just added may be waiting for its item).
      void this.deps.store
        .pruneAssets(historyId, normalized, ASSET_GRACE_MS)
        .catch(() => undefined);
    } catch (error) {
      log.warn(`A video project could not be saved (${(error as Error).message})`);
      throw new IpcError('INTERNAL', 'The project could not be saved.');
    }
  }

  /** Stores a picture for an image item; the id is its SHA-256. */
  async addImage(historyId: string, png: Uint8Array): Promise<{ assetId: string }> {
    if (!this.deps.history.get(historyId)) {
      throw new IpcError('NOT_FOUND', 'That recording is not in history.');
    }
    try {
      return { assetId: await this.deps.store.writePicture(historyId, png) };
    } catch {
      throw new IpcError('INVALID_PAYLOAD', 'That picture cannot be used.');
    }
  }

  /**
   * An audio file chosen in a dialog in main, copied into the project's assets and checked with
   * ffprobe: it must have an audio stream and be at most two hours long.
   */
  async pickAudio(
    historyId: string,
  ): Promise<
    { cancelled: true } | { assetId: string; ext: AudioExtension; name: string; durationMs: number }
  > {
    if (!this.deps.history.get(historyId)) {
      throw new IpcError('NOT_FOUND', 'That recording is not in history.');
    }
    const file = await this.deps.pickAudioFile();
    if (file === null) return { cancelled: true };
    const ext = path.extname(file).slice(1).toLowerCase();
    const known = AUDIO_EXTENSIONS.find((candidate) => candidate === ext);
    if (!known)
      throw new IpcError(
        'INVALID_PAYLOAD',
        'Choose an MP3, WAV, M4A, AAC, OGG, Opus or FLAC file.',
      );
    const stat = await fs.promises.stat(file).catch(() => null);
    if (!stat?.isFile()) throw new IpcError('NOT_FOUND', 'The file could not be opened.');
    if (stat.size > MAX_AUDIO_FILE_BYTES) {
      throw new IpcError('INVALID_PAYLOAD', 'That audio file is too large (the limit is 100 MB).');
    }
    let imported: { assetId: string; file: string };
    try {
      imported = await this.deps.store.importAudio(historyId, file, known);
    } catch (error) {
      log.warn(`An audio file could not be added (${(error as Error).message})`);
      throw new IpcError('INTERNAL', 'The audio file could not be added.');
    }
    const reject = async (message: string): Promise<never> => {
      await this.deps.store.removeAsset(historyId, imported.assetId, known).catch(() => undefined);
      throw new IpcError('INVALID_PAYLOAD', message);
    };
    let probe: ProbeResult;
    try {
      probe = await this.deps.tools.probe(imported.file, { timeoutMs: 30_000 });
    } catch {
      return reject('FrameCapt could not read that audio file.');
    }
    if (!probe.hasAudio) return reject('That file has no audio.');
    const durationMs = probe.durationSec === null ? 0 : Math.round(probe.durationSec * 1000);
    if (durationMs < 1) return reject('FrameCapt could not find the length of that audio file.');
    if (durationMs > MAX_CLIP_MS) return reject('That audio file is longer than two hours.');
    return {
      assetId: imported.assetId,
      ext: known,
      // A label only: control characters are dropped.
      name: [...path.basename(file)]
        .filter((char) => (char.codePointAt(0) ?? 0) > 31 && char !== '\u007f')
        .join('')
        .slice(0, 120),
      durationMs,
    };
  }

  /**
   * The picture of every text item must be there, be a PNG and be as large as the item's box:
   * checked here because the renderer made them. Returns them by item id.
   */
  private textPngsOf(
    project: VideoProject,
    overlays: readonly { itemId: string; png: Uint8Array }[],
  ): Record<string, Uint8Array> {
    const byId = new Map(overlays.map((overlay) => [overlay.itemId, overlay.png]));
    const result: Record<string, Uint8Array> = {};
    for (const item of project.items) {
      if (item.kind !== 'text') continue;
      const png = byId.get(item.id);
      const size = png ? readImageSize(png) : null;
      if (
        !png ||
        detectImageFormat(png) !== 'png' ||
        !size ||
        size.width !== item.rect.width ||
        size.height !== item.rect.height
      ) {
        throw new IpcError('INVALID_PAYLOAD', 'A text picture is missing or has the wrong size.');
      }
      result[item.id] = png;
    }
    return result;
  }

  async export(
    historyId: string,
    project: VideoProject,
    format: VideoExportFormat,
    overlays: readonly { itemId: string; png: Uint8Array }[] = [],
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
    const textPngs = this.textPngsOf(normalized, overlays);
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
        this.run(jobId, item, normalized, format, destPath, textPngs, signal, onProgress),
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
    textPngs: Record<string, Uint8Array>,
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
        sourceFormat: item.format,
        destPath,
        project,
        format,
        signal,
        onProgress,
        textPngs,
        assetPath: (assetId, ext) => this.deps.store.assetPath(historyId, assetId, ext),
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
            ...(result.probe.frameRate !== undefined && { fps: result.probe.frameRate }),
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
