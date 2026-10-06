import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {
  MAX_THUMBNAIL_BYTES,
  MAX_THUMBNAIL_WIDTH,
  type HistoryFormat,
  type HistoryItemView,
  type HistoryListRequest,
  type HistoryListResponse,
  type HistorySource,
} from '../../shared/history-ipc';
import { detectImageFormat, validateImageBytes } from '../../shared/shots';
import { IpcError } from '../ipc-core';
import { log } from '../logger';
import { thumbnailArgs, type MediaTools } from '../media/ffmpeg';
import type { ProjectAsset, ProjectInput, ProjectStore } from '../projects/store';
import type { ProjectDoc } from '../../shared/project-ipc';
import { writeFileAtomic } from '../shots/atomic-write';
import { CompletionRecordSchema, COMPLETED_DIR } from '../recording/manifest';
import { HistoryStore, type HistoryItem } from './store';
import { mapLimit, samePath } from './files';
import { matchesQuery } from './query';
import { ThumbStore, thumbNameFor, THUMBS_CAP_BYTES } from './thumbs';

const STAT_CONCURRENCY = 8;
const THUMB_TIMEOUT_MS = 20_000;
/** An entry removed by mistake can be put back for this long (the UI offers 5 s). */
const UNDO_WINDOW_MS = 15_000;
/** At most this many recordings of earlier runs are added when history starts. */
const BACKFILL_LIMIT = 200;

const IMAGE_EXTENSIONS: Record<'png' | 'jpeg', readonly string[]> = {
  png: ['.png'],
  jpeg: ['.jpg', '.jpeg'],
};
const VIDEO_EXTENSION: Record<'webm' | 'mp4', string> = { webm: '.webm', mp4: '.mp4' };

export interface HistoryDeps {
  /** `<userData>/history`: `history.json` and `thumbs/`. */
  dir: string;
  tools: MediaTools;
  /** Editable projects of screenshots (`<userData>/projects`). Absent: none are kept. */
  projects?: Pick<ProjectStore, 'write' | 'updateDoc' | 'remove' | 'sweep'>;
  /** Moves a file to the Recycle Bin (`shell.trashItem`); never a permanent delete. */
  trashItem: (file: string) => Promise<void>;
  /** Called after every change a list may show (add, remove, thumbnail ready). */
  onChange?: () => void;
  now?: () => number;
  maxItems?: number;
  thumbCapBytes?: number;
  undoWindowMs?: number;
}

export interface NewScreenshot {
  path: string;
  width: number;
  height: number;
  sizeBytes: number;
  format: 'png' | 'jpeg';
  source: HistorySource;
  /** PNG of the FLATTENED image, at most 480 px wide, from the editor. Never made in main. */
  thumbnail?: Uint8Array | undefined;
  createdAt?: number;
  /** The history item this one was saved from (a re-edited copy). */
  derivedFrom?: string;
  /** The editable project to store with it (id = the item's id). It is written before the item is listed. */
  project?: ProjectInput;
}

/** What `overwriteScreenshot` replaces. */
export interface ScreenshotOverwrite {
  bytes: Uint8Array;
  format: 'png' | 'jpeg';
  width: number;
  height: number;
  thumbnail?: Uint8Array | undefined;
  /** The document to keep; `base` creates the project when the item has none yet. */
  project?: {
    doc: ProjectDoc;
    appVersion: string;
    /** The pictures of the document's image layers. */
    assets?: ProjectAsset[];
    base?: Omit<ProjectInput, 'doc' | 'appVersion' | 'assets'>;
  };
}

export interface NewVideo {
  path: string;
  format: 'webm' | 'mp4';
  durationMs: number | null;
  width: number;
  height: number;
  sizeBytes: number;
  hasAudio: boolean | null;
  source: HistorySource;
  derivedFrom?: string;
  createdAt?: number;
}

function formatOfVideoPath(file: string): 'webm' | 'mp4' {
  return path.extname(file).toLowerCase() === '.mp4' ? 'mp4' : 'webm';
}

/** What the recorder and recovery need of history: adding a finished video. */
export type HistorySink = Pick<HistoryService, 'addVideo'>;

/**
 * Local history. Metadata only: the files are the user's. Items are added by main when it
 * produces an output, never from a renderer-supplied path. Removing an item never touches its
 * file; deleting the file is a separate action that goes through the Recycle Bin.
 */
export class HistoryService {
  private readonly store: HistoryStore;
  private readonly thumbs: ThumbStore;
  private readonly now: () => number;
  private readonly undoWindowMs: number;
  /** Items removed a moment ago, so `undoRemove` can restore them without trusting the renderer. */
  private readonly removed = new Map<string, { item: HistoryItem; timer: NodeJS.Timeout }>();
  private thumbQueue: Promise<void> = Promise.resolve();
  private readonly pending = new Set<Promise<unknown>>();
  private resetNotice = false;
  private existedAtLoad = false;
  readonly ready: Promise<void>;

  constructor(private readonly deps: HistoryDeps) {
    this.now = deps.now ?? Date.now;
    this.undoWindowMs = deps.undoWindowMs ?? UNDO_WINDOW_MS;
    this.store = new HistoryStore(deps.dir, deps.maxItems, this.now);
    this.thumbs = new ThumbStore(
      path.join(deps.dir, 'thumbs'),
      deps.thumbCapBytes ?? THUMBS_CAP_BYTES,
    );
    this.ready = this.init();
    // A history that cannot be read (permissions, a locked disk) fails its own calls; it must not
    // surface as an unhandled rejection, and it never overwrites a file it could not read.
    this.ready.catch((error: unknown) => log.error('History could not be loaded', error));
  }

  private async init(): Promise<void> {
    const loaded = await this.store.load();
    this.resetNotice = loaded.reset;
    this.existedAtLoad = loaded.existed;
    await this.collectThumbs();
    await this.sweepProjects();
  }

  /** Startup housekeeping: projects no history item refers to (older than the grace period) are removed. */
  private async sweepProjects(): Promise<void> {
    const projects = this.deps.projects;
    if (!projects) return;
    try {
      const known = new Set(this.store.items().map((item) => item.id));
      const result = await projects.sweep(known);
      if (result.removed > 0)
        log.info(`Project sweep: removed ${result.removed} orphaned projects`);
    } catch (error) {
      log.warn(`Project sweep failed (${(error as Error).message})`);
    }
  }

  /** True once after a damaged file was reset; the UI shows a one-time notice. */
  async consumeResetNotice(): Promise<boolean> {
    await this.ready;
    const value = this.resetNotice;
    this.resetNotice = false;
    return value;
  }

  /** Waits for background work (thumbnails) to finish; for tests and orderly shutdown. */
  async idle(): Promise<void> {
    await this.ready;
    while (this.pending.size > 0) await Promise.allSettled([...this.pending]);
  }

  private track<T>(promise: Promise<T>): Promise<T> {
    this.pending.add(promise);
    const done = (): void => void this.pending.delete(promise);
    promise.then(done, done);
    return promise;
  }

  private changed(): void {
    this.deps.onChange?.();
  }

  // --- reading ----------------------------------------------------------------------------

  /** An item of the history. */
  get(id: string): HistoryItem | undefined {
    return this.store.get(id);
  }

  /** The item that points at `file` (same path, any case on Windows), if any. */
  findByPath(file: string): HistoryItem | undefined {
    return this.existingFor(file);
  }

  /** Items in the list; unlisted items of a newer build are not counted here. */
  get size(): number {
    return this.store.count;
  }

  /** True when `history.json` did not exist at load and nothing was backfilled yet (a fresh start). */
  get isFirstRun(): boolean {
    return !this.existedAtLoad && !this.store.backfilled;
  }

  /** The file of an item, for the media protocol (history items only). */
  filePathOf(id: string): string | undefined {
    return this.get(id)?.path;
  }

  /** The thumbnail file of an item, for the media protocol. */
  thumbPathOf(id: string): string | undefined {
    const name = this.get(id)?.thumbnail;
    return name ? this.thumbs.pathOf(name) : undefined;
  }

  async list(request: HistoryListRequest = {}): Promise<HistoryListResponse> {
    await this.ready;
    const query = request.query?.trim() ?? '';
    const owned = this.store.items();
    const matching = owned
      .filter((item) => request.filter === undefined || item.type === request.filter)
      .filter((item) => matchesQuery(item, query))
      .slice(0, request.limit);
    const items = await mapLimit(matching, STAT_CONCURRENCY, (item) => this.view(item));
    return { items, total: owned.length };
  }

  private async view(item: HistoryItem): Promise<HistoryItemView> {
    const stat = await fs.promises.stat(item.path).catch(() => null);
    const exists = stat?.isFile() ?? false;
    return {
      id: item.id,
      type: item.type,
      createdAt: item.createdAt,
      path: item.path,
      fileName: path.basename(item.path),
      width: item.width,
      height: item.height,
      durationMs: item.durationMs,
      sizeBytes: exists && stat ? stat.size : item.sizeBytes,
      format: item.format,
      hasThumb: item.thumbnail !== null,
      hasAudio: item.hasAudio,
      source: item.source,
      derivedFrom: item.derivedFrom,
      exists,
      editable: item.type === 'screenshot' && item.projectId !== undefined,
    };
  }

  // --- adding -----------------------------------------------------------------------------

  /** Same file again (saved twice under one name): the entry is refreshed, not duplicated. */
  private existingFor(file: string): HistoryItem | undefined {
    return this.store.items().find((item) => samePath(item.path, file));
  }

  private async put(item: HistoryItem): Promise<void> {
    const dropped = await this.store.put(item);
    if (dropped.length > 0) {
      log.info(`History is full: ${dropped.length} oldest entries left the list (files untouched)`);
      await this.dropProjects(dropped.map((entry) => entry.id));
    }
    await this.collectThumbs();
    this.changed();
  }

  async addScreenshot(input: NewScreenshot): Promise<{ id: string }> {
    await this.ready;
    const existing = this.existingFor(input.path);
    const id = existing?.id ?? randomUUID();
    let thumbnail: string | null = null;
    if (input.thumbnail && validThumbnail(input.thumbnail)) {
      try {
        await this.thumbs.write(thumbNameFor(id), input.thumbnail);
        thumbnail = thumbNameFor(id);
      } catch (error) {
        log.warn(`Could not store a screenshot thumbnail (${(error as Error).message})`);
      }
    }
    let projectId: string | undefined;
    if (input.project && this.deps.projects) {
      try {
        await this.deps.projects.write(id, input.project);
        projectId = id;
      } catch (error) {
        log.warn(`Could not store an editable project (${(error as Error).message})`);
      }
    }
    // A refreshed entry whose new export has no project must not keep an older, stale one.
    if (!projectId && existing?.projectId) await this.dropProjects([existing.id]);
    await this.put({
      id,
      type: 'screenshot',
      createdAt: input.createdAt ?? this.now(),
      path: input.path,
      width: input.width,
      height: input.height,
      durationMs: null,
      sizeBytes: input.sizeBytes,
      format: input.format,
      thumbnail,
      hasAudio: null,
      source: input.source,
      derivedFrom: input.derivedFrom ?? null,
      ...(projectId && { projectId }),
    });
    return { id };
  }

  /**
   * Replaces the image of a screenshot ("Save" in a re-edit): the file is rewritten atomically
   * (temp file, fsync, rename), so a failure leaves the previous image untouched. The entry's thumbnail,
   * size and dimensions follow; the editable project is updated after the image.
   */
  async overwriteScreenshot(
    id: string,
    input: ScreenshotOverwrite,
  ): Promise<{ path: string; editable: boolean }> {
    await this.ready;
    const item = this.get(id);
    if (!item || item.type !== 'screenshot') {
      throw new IpcError('NOT_FOUND', 'That screenshot is not in history.');
    }
    if (item.format !== input.format) {
      throw new IpcError(
        'INVALID_PAYLOAD',
        `Save it as ${item.format.toUpperCase()} to replace it.`,
      );
    }
    const extension = path.extname(item.path).toLowerCase();
    if (!IMAGE_EXTENSIONS[item.format].includes(extension)) {
      throw new IpcError('INVALID_PAYLOAD', 'That file cannot be replaced. Use Save as copy.');
    }
    const present = await fs.promises.stat(item.path).then(
      (stat) => stat.isFile(),
      () => false,
    );
    if (!present)
      throw new IpcError('NOT_FOUND', 'The file was moved or deleted. Use Save as copy.');
    const head = await readHead(item.path, 16);
    if (detectImageFormat(head) !== item.format) {
      throw new IpcError(
        'INVALID_PAYLOAD',
        'That file is not the image FrameCapt saved. Use Save as copy.',
      );
    }
    await writeFileAtomic(item.path, input.bytes);
    let thumbnail = item.thumbnail;
    if (input.thumbnail && validThumbnail(input.thumbnail)) {
      try {
        await this.thumbs.write(thumbNameFor(id), input.thumbnail);
        thumbnail = thumbNameFor(id);
      } catch (error) {
        log.warn(`Could not store a screenshot thumbnail (${(error as Error).message})`);
      }
    }
    let projectId = item.projectId;
    const projects = this.deps.projects;
    if (input.project && projects) {
      try {
        const updated =
          projectId !== undefined &&
          (await projects.updateDoc(
            id,
            input.project.doc,
            input.project.appVersion,
            input.project.assets,
          ));
        if (!updated && input.project.base) {
          await projects.write(id, {
            ...input.project.base,
            doc: input.project.doc,
            appVersion: input.project.appVersion,
            ...(input.project.assets && { assets: input.project.assets }),
          });
          projectId = id;
        }
      } catch (error) {
        log.warn(`Could not update an editable project (${(error as Error).message})`);
      }
    }
    await this.store.update(id, {
      sizeBytes: input.bytes.byteLength,
      width: input.width,
      height: input.height,
      thumbnail,
      projectId,
    });
    await this.collectThumbs();
    this.changed();
    return { path: item.path, editable: projectId !== undefined };
  }

  /** Deletes the editable project of an item; the exported image and the entry stay. */
  async deleteProject(id: string): Promise<void> {
    await this.ready;
    const item = this.get(id);
    if (!item) throw new IpcError('NOT_FOUND', 'That item is not in history.');
    await this.deps.projects?.remove(id);
    if (item.projectId !== undefined) {
      await this.store.update(id, { projectId: undefined });
      this.changed();
    }
  }

  private async dropProjects(ids: readonly string[]): Promise<void> {
    const projects = this.deps.projects;
    if (!projects) return;
    for (const id of ids) await projects.remove(id).catch(() => undefined);
  }

  /**
   * Adds a recording (or an MP4 made from one). The entry exists at once; its thumbnail (one
   * frame from the file, via ffmpeg) follows in the background and the list reloads when ready.
   */
  async addVideo(input: NewVideo): Promise<{ id: string }> {
    await this.ready;
    const existing = this.existingFor(input.path);
    const id = existing?.id ?? randomUUID();
    const item: HistoryItem = {
      id,
      type: 'recording',
      createdAt: input.createdAt ?? this.now(),
      path: input.path,
      width: input.width,
      height: input.height,
      durationMs: input.durationMs,
      sizeBytes: input.sizeBytes,
      format: input.format,
      thumbnail: existing?.thumbnail ?? null,
      hasAudio: input.hasAudio,
      source: input.source,
      derivedFrom: input.derivedFrom ?? null,
    };
    await this.put(item);
    this.queueThumbnail(item);
    return { id };
  }

  /**
   * Points a recording at its compressed MP4 (compressed storage): same id, thumbnail and
   * creation time, new path, format and size. False when the item is gone.
   */
  async replaceVideoFile(
    id: string,
    input: Pick<NewVideo, 'path' | 'durationMs' | 'width' | 'height' | 'sizeBytes' | 'hasAudio'>,
  ): Promise<boolean> {
    await this.ready;
    const updated = await this.store.update(id, { ...input, format: 'mp4' });
    if (updated) this.changed();
    return updated !== undefined;
  }

  private queueThumbnail(item: HistoryItem): void {
    const task = this.thumbQueue.then(() => this.makeVideoThumbnail(item));
    this.thumbQueue = task.catch(() => undefined);
    void this.track(task.catch(() => undefined));
  }

  /** `-ss` into the file, one frame, at most 480 px wide, through a partial file and a rename. */
  private async makeVideoThumbnail(item: HistoryItem): Promise<void> {
    const name = thumbNameFor(item.id);
    const final = this.thumbs.pathOf(name);
    if (!final || !this.store.get(item.id)) return;
    const partial = path.join(this.thumbs.dir, `${item.id}.partial.png`);
    const seek = item.durationMs === null ? 0 : Math.min(1, item.durationMs / 2000);
    try {
      await fs.promises.mkdir(this.thumbs.dir, { recursive: true });
      const result = await this.deps.tools.run(
        thumbnailArgs(item.path, partial, seek, MAX_THUMBNAIL_WIDTH),
        { timeoutMs: THUMB_TIMEOUT_MS },
      );
      const size = result.code === 0 ? (await fs.promises.stat(partial)).size : 0;
      if (size === 0) {
        log.warn('A recording thumbnail could not be made');
        return;
      }
      await fs.promises.rename(partial, final);
      // The item may have been removed while ffmpeg ran: then the collector removes the file.
      if (await this.store.update(item.id, { thumbnail: name })) this.changed();
      else await this.collectThumbs();
    } catch (error) {
      log.warn(`A recording thumbnail could not be made (${(error as Error).message})`);
    } finally {
      await fs.promises.rm(partial, { force: true }).catch(() => undefined);
    }
  }

  /** Deletes thumbnails nothing refers to; items whose thumbnail fell to the size cap forget it. */
  private async collectThumbs(): Promise<void> {
    const refs = [...this.store.items(), ...[...this.removed.values()].map((entry) => entry.item)]
      .filter((item) => item.thumbnail !== null)
      .map((item) => ({ name: item.thumbnail as string, createdAt: item.createdAt }));
    const dropped = new Set(await this.thumbs.gc(refs));
    for (const item of this.store.items()) {
      if (item.thumbnail !== null && dropped.has(item.thumbnail)) {
        await this.store.update(item.id, { thumbnail: null });
      }
    }
    if (dropped.size > 0) this.changed();
  }

  // --- removing ---------------------------------------------------------------------------

  /** History only; the file stays. The entry can be restored with `undoRemove` for a while. */
  async remove(id: string): Promise<void> {
    await this.ready;
    if (!this.get(id)) throw new IpcError('NOT_FOUND', 'That item is not in history.');
    const [item] = await this.store.remove([id]);
    if (!item) throw new IpcError('NOT_FOUND', 'That item is not in history.');
    const timer = setTimeout(() => {
      this.removed.delete(id);
      void this.dropProjects([id]);
      void this.collectThumbs();
    }, this.undoWindowMs);
    timer.unref();
    this.removed.set(id, { item, timer });
    this.changed();
  }

  async undoRemove(id: string): Promise<void> {
    await this.ready;
    const entry = this.removed.get(id);
    if (!entry) {
      throw new IpcError('NOT_FOUND', 'That item can no longer be restored.');
    }
    clearTimeout(entry.timer);
    this.removed.delete(id);
    await this.put(entry.item);
  }

  /**
   * Moves the file to the Recycle Bin (never a permanent delete), then removes the entry. A file
   * that is already gone just removes the entry. If the Recycle Bin refuses, nothing changes.
   */
  async deleteFile(id: string): Promise<void> {
    await this.ready;
    const item = this.get(id);
    if (!item) throw new IpcError('NOT_FOUND', 'That item is not in history.');
    const present = await fs.promises.stat(item.path).then(
      (stat) => stat.isFile(),
      () => false,
    );
    if (present) {
      try {
        await this.deps.trashItem(item.path);
      } catch (error) {
        log.warn(`Could not move a file to the Recycle Bin (${(error as Error).message})`);
        throw new IpcError('INTERNAL', 'The file could not be moved to the Recycle Bin.');
      }
    }
    await this.store.remove([id]);
    await this.dropProjects([id]);
    await this.collectThumbs();
    this.changed();
  }

  /** Removes every entry whose file no longer exists. Files are never touched. */
  async clearMissing(): Promise<number> {
    await this.ready;
    const checks = await mapLimit(this.store.items(), STAT_CONCURRENCY, async (item) => ({
      id: item.id,
      exists: await fs.promises.stat(item.path).then(
        (stat) => stat.isFile(),
        () => false,
      ),
    }));
    const missing = checks.filter((check) => !check.exists).map((check) => check.id);
    const removed = await this.store.remove(missing);
    if (removed.length > 0) {
      await this.dropProjects(removed.map((entry) => entry.id));
      await this.collectThumbs();
      this.changed();
    }
    return removed.length;
  }

  // --- re-linking a moved file ------------------------------------------------------------

  /**
   * Points an entry at a file the user picked. The file must look like what the entry says it
   * is: the extension, and the content (image magic bytes, or ffprobe for videos). Nothing is
   * copied or moved.
   */
  async relink(id: string, file: string): Promise<void> {
    await this.ready;
    const item = this.get(id);
    if (!item) throw new IpcError('NOT_FOUND', 'That item is not in history.');
    const resolved = path.resolve(file);
    const extension = path.extname(resolved).toLowerCase();
    const other = this.store.items().find((entry) => samePath(entry.path, resolved));
    if (other && other.id !== id) {
      throw new IpcError('INVALID_PAYLOAD', 'That file is already in history.');
    }
    const stat = await fs.promises.stat(resolved).catch(() => null);
    if (!stat?.isFile()) throw new IpcError('NOT_FOUND', 'That file could not be found.');

    if (item.format === 'png' || item.format === 'jpeg') {
      if (!IMAGE_EXTENSIONS[item.format].includes(extension)) {
        throw new IpcError('INVALID_PAYLOAD', `Pick a ${item.format.toUpperCase()} image.`);
      }
      const head = await readHead(resolved, 16);
      if (detectImageFormat(head) !== item.format) {
        throw new IpcError(
          'INVALID_PAYLOAD',
          `That file is not a ${item.format.toUpperCase()} image.`,
        );
      }
      await this.store.update(id, { path: resolved, sizeBytes: stat.size });
    } else {
      if (extension !== VIDEO_EXTENSION[item.format]) {
        throw new IpcError('INVALID_PAYLOAD', `Pick a ${item.format.toUpperCase()} video.`);
      }
      const probe = await this.deps.tools.probe(resolved, { timeoutMs: 30_000 }).catch(() => null);
      if (!probe?.hasVideo || !probe.formatName.split(',').includes(item.format)) {
        throw new IpcError(
          'INVALID_PAYLOAD',
          `That file is not a ${item.format.toUpperCase()} video.`,
        );
      }
      await this.store.update(id, {
        path: resolved,
        sizeBytes: stat.size,
        durationMs: probe.durationSec === null ? null : Math.round(probe.durationSec * 1000),
        width: probe.video?.width ?? item.width,
        height: probe.video?.height ?? item.height,
        hasAudio: probe.hasAudio,
      });
    }
    this.changed();
  }

  // --- recordings finished before history existed ----------------------------------------

  /**
   * First run with history: adds the recordings the finalizer left `completed/<id>.json` records
   * for, when their files still exist. Only when `history.json` did not exist at all (a reset
   * after damage starts empty on purpose) and only once.
   */
  async backfillFromCompleted(recordingsDir: string): Promise<number> {
    await this.ready;
    if (this.existedAtLoad || this.store.backfilled) return 0;
    const dir = path.join(recordingsDir, COMPLETED_DIR);
    const names = await fs.promises.readdir(dir).catch(() => [] as string[]);
    const records = [];
    for (const name of names.filter((entry) => entry.endsWith('.json'))) {
      try {
        const parsed = CompletionRecordSchema.safeParse(
          JSON.parse(await fs.promises.readFile(path.join(dir, name), 'utf8')),
        );
        if (parsed.success) records.push(parsed.data);
      } catch {
        // an unreadable record is skipped
      }
    }
    records.sort((a, b) => b.completedAt - a.completedAt);
    let added = 0;
    for (const record of records.slice(0, BACKFILL_LIMIT)) {
      const stat = await fs.promises.stat(record.outputPath).catch(() => null);
      if (!stat?.isFile()) continue;
      await this.addVideo({
        path: record.outputPath,
        format: formatOfVideoPath(record.outputPath),
        durationMs: record.durationMs,
        width: record.width,
        height: record.height,
        sizeBytes: stat.size,
        hasAudio: record.hasAudio,
        source: record.source.kind,
        createdAt: record.completedAt,
      });
      added += 1;
    }
    await this.store.markBackfilled();
    return added;
  }
}

async function readHead(file: string, bytes: number): Promise<Uint8Array> {
  const handle = await fs.promises.open(file, 'r');
  try {
    const buffer = Buffer.alloc(bytes);
    const { bytesRead } = await handle.read(buffer, 0, bytes, 0);
    return buffer.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
}

/** PNG magic, at most 2 MB and at most 480 px wide (the IHDR width), else it is not stored. */
export function validThumbnail(bytes: Uint8Array): boolean {
  if (!validateImageBytes('png', bytes, MAX_THUMBNAIL_BYTES).ok) return false;
  const view = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return view.length >= 24 && view.readUInt32BE(16) <= MAX_THUMBNAIL_WIDTH;
}

/** Format of an exported image or recording file, for callers that only have a path. */
export function formatOfPath(file: string): HistoryFormat {
  const extension = path.extname(file).toLowerCase();
  if (extension === '.png') return 'png';
  if (extension === '.jpg' || extension === '.jpeg') return 'jpeg';
  return formatOfVideoPath(file);
}
