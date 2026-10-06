import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {
  FLOW_VERSION,
  flowStepUrl,
  safeFileStem,
  STEP_FILE_PATTERN,
  type FlowFile,
  type FlowStep,
} from '../../shared/flow';
import type { FlowExportResponse, FlowGetResponse } from '../../shared/flow-ipc';
import type {
  ExportDoneEvent,
  ExportFailedEvent,
  ExportProgressEvent,
} from '../../shared/history-ipc';
import { readImageSize, validateImageBytes } from '../../shared/shots';
import type { z } from 'zod';
import type { FlowExportRequestSchema, FlowUpdateRequestSchema } from '../../shared/flow-ipc';
import type { HistoryItem } from '../history/store';
import type { HistoryService } from '../history/service';
import { freeFileName } from '../shots/free-name';
import { writeFileAtomic } from '../shots/atomic-write';
import { IpcError } from '../ipc-core';
import { log } from '../logger';
import { MP4_UNAVAILABLE_MESSAGE, type Mp4Capability } from '../media/export';
import type { MediaTools } from '../media/ffmpeg';
import { partialPathFor, type JobRunner } from '../media/job-runner';
import { buildGuideHtml } from './export-html';
import {
  flowBytes,
  readFlowFile,
  writeFlowFile,
  writeGuideFolder,
  type GuideStep,
} from './flow-store';
import {
  frameName,
  gifSlideshowArgs,
  mp4SlideshowArgs,
  SLIDE_SECONDS,
  slideshowSize,
  type SlideshowKind,
} from './slideshow';

/** A deleted step can be put back (Undo) for this long; then its image goes to the Recycle Bin. */
const UNDO_WINDOW_MS = 15_000;
const JOB_TIMEOUT_MS = 10 * 60_000;

type UpdateRequest = z.output<typeof FlowUpdateRequestSchema>;
type ExportRequest = z.output<typeof FlowExportRequestSchema>;

export interface FlowServiceDeps {
  history: Pick<HistoryService, 'get' | 'addFlow' | 'updateFlow' | 'addVideo'>;
  tools: MediaTools;
  runner: JobRunner;
  capability: () => Promise<Mp4Capability>;
  /** The screenshots folder: guides are saved into it. */
  screenshotsDir: () => string;
  /** `<userData>/flows`: scratch space of the video export. */
  scratchDir: string;
  /** PNG of the first step with the pointer ring, at most 480 px wide; undefined if it cannot be made. */
  thumbnail: (
    png: Uint8Array,
    cursor: { x: number; y: number } | null,
    size: { width: number; height: number },
  ) => Uint8Array | undefined;
  /** Moves a file to the Recycle Bin. */
  trashItem: (file: string) => Promise<void>;
  /** Main-process dialogs; null when the person cancels. */
  pickFolder: () => Promise<string | null>;
  pickSave: (options: {
    defaultName: string;
    kind: 'html' | 'mp4' | 'gif';
  }) => Promise<string | null>;
  /** Remembers a file this run wrote (so "Show in folder" accepts it). */
  remember: (file: string) => void;
  emit: {
    progress: (event: ExportProgressEvent) => void;
    done: (event: ExportDoneEvent) => void;
    failed: (event: ExportFailedEvent) => void;
  };
  now?: () => number;
  undoWindowMs?: number;
}

interface Loaded {
  item: HistoryItem;
  dir: string;
  file: string;
  flow: FlowFile;
}

/** Everything about a saved guide: saving a capture, reading and editing it, its exports. */
export class FlowService {
  /** Step file names per guide, for the media route (filled by get/update, always re-read from disk first). */
  private readonly files = new Map<string, string[]>();
  /** Steps deleted a moment ago, so Undo can put them back without trusting the renderer. */
  private readonly removed = new Map<string, Map<string, FlowStep>>();
  private readonly sweeps = new Map<string, NodeJS.Timeout>();

  constructor(private readonly deps: FlowServiceDeps) {}

  private now(): number {
    return (this.deps.now ?? Date.now)();
  }

  // --- saving a capture ---------------------------------------------------------------------

  /** Writes the guide folder into the screenshots folder and adds it to History. */
  async saveSession(input: {
    steps: GuideStep[];
    createdAt: number;
  }): Promise<{ historyId: string }> {
    const written = await writeGuideFolder({
      parentDir: this.deps.screenshotsDir(),
      createdAt: input.createdAt,
      steps: input.steps,
    });
    this.deps.remember(written.file);
    const first = written.flow.steps[0];
    if (!first) throw new IpcError('INTERNAL', 'The guide has no steps.');
    const thumbnail = await this.thumbnailOf(written.dir, written.flow);
    const added = await this.deps.history.addFlow({
      path: written.file,
      width: first.width,
      height: first.height,
      sizeBytes: await flowBytes(written.dir, written.flow),
      stepCount: written.flow.steps.length,
      thumbnail,
      createdAt: this.now(),
    });
    log.info(`Step guide saved: ${written.flow.steps.length} steps`);
    return { historyId: added.id };
  }

  /** The thumbnail of a guide: its first step with the ring (also used by the rescan). */
  async thumbnailOf(dir: string, flow: FlowFile): Promise<Uint8Array | undefined> {
    const first = flow.steps[0];
    if (!first) return undefined;
    try {
      const png = await fs.promises.readFile(path.join(dir, first.file));
      return this.deps.thumbnail(png, first.cursor, { width: first.width, height: first.height });
    } catch {
      return undefined;
    }
  }

  // --- reading ------------------------------------------------------------------------------

  private async load(historyId: string): Promise<Loaded> {
    const item = this.deps.history.get(historyId);
    if (!item || item.type !== 'flow')
      throw new IpcError('NOT_FOUND', 'That guide is not in history.');
    const flow = await readFlowFile(item.path);
    if (!flow) {
      throw new IpcError(
        'NOT_FOUND',
        'The guide was moved, deleted or damaged. Locate it in History.',
      );
    }
    this.files.set(
      historyId,
      flow.steps.map((step) => step.file),
    );
    return { item, dir: path.dirname(item.path), file: item.path, flow };
  }

  async get(historyId: string): Promise<FlowGetResponse> {
    const { flow } = await this.load(historyId);
    return this.response(historyId, flow);
  }

  private response(historyId: string, flow: FlowFile): FlowGetResponse {
    const nonce = this.now().toString(36);
    return { flow, stepUrls: flow.steps.map((_, index) => flowStepUrl(historyId, index, nonce)) };
  }

  /** The image of step `index` for the media route; undefined unless `get` listed it for a guide still in History. */
  stepPathOf(historyId: string, index: number): string | undefined {
    const item = this.deps.history.get(historyId);
    const file = this.files.get(historyId)?.[index];
    if (!item || item.type !== 'flow' || !file || !STEP_FILE_PATTERN.test(file)) return undefined;
    return path.join(path.dirname(item.path), file);
  }

  /** The PNG of a step, for the editor. */
  async readStep(
    historyId: string,
    index: number,
  ): Promise<{ png: Buffer; width: number; height: number }> {
    const { dir, flow } = await this.load(historyId);
    const step = flow.steps[index];
    if (!step) throw new IpcError('NOT_FOUND', 'That step no longer exists.');
    const png = await fs.promises.readFile(path.join(dir, step.file)).catch(() => null);
    if (!png) throw new IpcError('NOT_FOUND', "That step's image was moved or deleted.");
    const size = readImageSize(png);
    if (!size) throw new IpcError('INVALID_PAYLOAD', 'The step image could not be read.');
    return { png, ...size };
  }

  // --- editing ------------------------------------------------------------------------------

  async update(request: UpdateRequest): Promise<FlowGetResponse> {
    const { item, dir, file, flow } = await this.load(request.historyId);
    let steps = flow.steps;
    if (request.steps) {
      const known = new Map<string, FlowStep>(flow.steps.map((step) => [step.file, step]));
      const undo = this.removed.get(item.id);
      const seen = new Set<string>();
      const next: FlowStep[] = [];
      for (const requested of request.steps) {
        const base = known.get(requested.file) ?? undo?.get(requested.file);
        if (!base || !STEP_FILE_PATTERN.test(requested.file) || seen.has(requested.file)) {
          throw new IpcError('INVALID_PAYLOAD', 'The list of steps is not valid.');
        }
        const present = await fs.promises.stat(path.join(dir, requested.file)).then(
          (stat) => stat.isFile(),
          () => false,
        );
        if (!present) throw new IpcError('NOT_FOUND', 'A step image was moved or deleted.');
        seen.add(requested.file);
        next.push({ ...base, caption: requested.caption });
      }
      const gone = flow.steps.filter((step) => !seen.has(step.file));
      if (gone.length > 0) this.rememberRemoved(item.id, gone);
      steps = next;
    }
    const title = request.title !== undefined ? request.title.trim() : flow.title;
    const updated: FlowFile = {
      version: FLOW_VERSION,
      createdAt: flow.createdAt,
      ...(title ? { title } : {}),
      steps,
    };
    await writeFlowFile(file, updated);
    await this.syncHistory(item.id, dir, flow, updated);
    if (steps.length !== flow.steps.length) this.scheduleSweep(item.id, dir, file);
    return this.response(item.id, updated);
  }

  /** The entry follows the guide: first picture, count, size, and a new thumbnail when the first step changed. */
  private async syncHistory(
    id: string,
    dir: string,
    before: FlowFile,
    after: FlowFile,
    forceThumbnail = false,
  ): Promise<void> {
    this.files.set(
      id,
      after.steps.map((step) => step.file),
    );
    const first = after.steps[0];
    if (!first) return;
    const oldFirst = before.steps[0];
    const firstChanged =
      forceThumbnail ||
      oldFirst?.file !== first.file ||
      oldFirst.cursor?.x !== first.cursor?.x ||
      oldFirst.cursor?.y !== first.cursor?.y;
    await this.deps.history.updateFlow(id, {
      width: first.width,
      height: first.height,
      sizeBytes: await flowBytes(dir, after),
      stepCount: after.steps.length,
      thumbnail: firstChanged ? await this.thumbnailOf(dir, after) : undefined,
    });
  }

  private rememberRemoved(id: string, steps: readonly FlowStep[]): void {
    const map = this.removed.get(id) ?? new Map<string, FlowStep>();
    for (const step of steps) map.set(step.file, step);
    this.removed.set(id, map);
  }

  /**
   * After the undo window, step images the guide no longer lists go to the Recycle Bin (never a
   * permanent delete). A step put back in the meantime is listed again and stays.
   */
  private scheduleSweep(id: string, dir: string, file: string): void {
    clearTimeout(this.sweeps.get(id));
    const timer = setTimeout(() => {
      this.sweeps.delete(id);
      void this.sweepOrphans(id, dir, file);
    }, this.deps.undoWindowMs ?? UNDO_WINDOW_MS);
    timer.unref();
    this.sweeps.set(id, timer);
  }

  async sweepOrphans(id: string, dir: string, file: string): Promise<void> {
    this.removed.delete(id);
    const flow = await readFlowFile(file);
    if (!flow) return;
    const listed = new Set(flow.steps.map((step) => step.file));
    const names = await fs.promises.readdir(dir).catch(() => [] as string[]);
    for (const name of names) {
      if (!STEP_FILE_PATTERN.test(name) || listed.has(name)) continue;
      await this.deps.trashItem(path.join(dir, name)).catch((error: unknown) => {
        log.warn(`A deleted step image could not be moved to the Recycle Bin (${String(error)})`);
      });
    }
  }

  /**
   * The editor saved a step: its image is replaced atomically (PNG only). When the picture's size
   * changed (a crop), the pointer position no longer fits and is dropped.
   */
  async replaceStep(
    historyId: string,
    index: number,
    bytes: Uint8Array,
  ): Promise<{ path: string }> {
    const { item, dir, file, flow } = await this.load(historyId);
    const step = flow.steps[index];
    if (!step) throw new IpcError('NOT_FOUND', 'That step no longer exists.');
    const check = validateImageBytes('png', bytes);
    const size = readImageSize(bytes);
    if (!check.ok || !size)
      throw new IpcError('INVALID_PAYLOAD', 'The edited step is not a valid PNG image.');
    const target = path.join(dir, step.file);
    await writeFileAtomic(target, bytes);
    const resized = size.width !== step.width || size.height !== step.height;
    const steps = flow.steps.map((entry, position) =>
      position === index
        ? {
            ...entry,
            width: size.width,
            height: size.height,
            cursor: resized ? null : entry.cursor,
          }
        : entry,
    );
    const updated: FlowFile = { ...flow, steps };
    await writeFlowFile(file, updated);
    await this.syncHistory(item.id, dir, flow, updated, index === 0);
    log.info('A step guide image was replaced from the editor');
    return { path: target };
  }

  // --- exporting ----------------------------------------------------------------------------

  async export(request: ExportRequest): Promise<FlowExportResponse> {
    const { item, flow } = await this.load(request.historyId);
    if (request.frames.length !== flow.steps.length) {
      throw new IpcError('INVALID_PAYLOAD', 'The pictures do not match the steps. Try again.');
    }
    const frames = request.frames.map((buffer) => new Uint8Array(buffer));
    for (const frame of frames) {
      const check = validateImageBytes('png', frame, Number.MAX_SAFE_INTEGER);
      if (!check.ok || !readImageSize(frame)) {
        throw new IpcError('INVALID_PAYLOAD', 'A picture of the export is not a valid PNG image.');
      }
    }
    const title = flow.title?.trim() || 'Step guide';
    switch (request.kind) {
      case 'images':
        return this.exportImages(frames);
      case 'html':
        return this.exportHtml(title, flow, frames);
      default:
        return this.exportSlideshow(request.kind, item, title, frames);
    }
  }

  private async exportImages(frames: readonly Uint8Array[]): Promise<FlowExportResponse> {
    const folder = await this.deps.pickFolder();
    if (folder === null) return { cancelled: true };
    let first = '';
    for (const [index, frame] of frames.entries()) {
      const name = `step-${String(index + 1).padStart(2, '0')}.png`;
      const target = await freeFileName(folder, name);
      await writeFileAtomic(target, frame);
      this.deps.remember(target);
      first ||= target;
    }
    return { path: first };
  }

  private async exportHtml(
    title: string,
    flow: FlowFile,
    frames: readonly Uint8Array[],
  ): Promise<FlowExportResponse> {
    const target = await this.deps.pickSave({
      defaultName: `${safeFileStem(title)}.html`,
      kind: 'html',
    });
    if (target === null) return { cancelled: true };
    const html = buildGuideHtml({
      title,
      generated: new Date(this.now()).toLocaleDateString('en-US', {
        year: 'numeric',
        month: 'long',
        day: 'numeric',
      }),
      steps: flow.steps.map((step, index) => ({
        caption: step.caption,
        png: frames[index] ?? new Uint8Array(),
      })),
    });
    await writeFileAtomic(target, Buffer.from(html, 'utf8'));
    this.deps.remember(target);
    return { path: target };
  }

  private async exportSlideshow(
    kind: SlideshowKind,
    item: HistoryItem,
    title: string,
    frames: readonly Uint8Array[],
  ): Promise<FlowExportResponse> {
    if (kind === 'mp4') {
      const capability = await this.deps.capability();
      if (!capability.available) {
        throw new IpcError('FFMPEG_MISSING', capability.reason ?? MP4_UNAVAILABLE_MESSAGE);
      }
    }
    const destPath = await this.deps.pickSave({
      defaultName: `${safeFileStem(title)}.${kind}`,
      kind,
    });
    if (destPath === null) return { cancelled: true };
    const jobId = randomUUID();
    const historyId = item.id;
    this.deps.runner.enqueue({
      id: jobId,
      label: `guide-${kind}`,
      onProgress: (percent) =>
        this.deps.emit.progress({ kind: 'guide', jobId, historyId, percent }),
      run: async ({ signal, onProgress }) => {
        try {
          const done = await this.encode({ kind, destPath, frames, signal, onProgress });
          const itemId = await this.addSlideshow(kind, item, done).catch((error: unknown) => {
            log.error('The guide video was saved but could not be added to history', error);
            return null;
          });
          this.deps.remember(destPath);
          this.deps.emit.done({ kind: 'guide', jobId, historyId, path: destPath, itemId });
        } catch (error) {
          const cancelled = signal.aborted;
          if (!cancelled) log.warn(`Guide ${kind} export failed: ${(error as Error).message}`);
          this.deps.emit.failed({
            kind: 'guide',
            jobId,
            historyId,
            code: cancelled ? 'CANCELLED' : 'FAILED',
            message: cancelled ? 'The export was cancelled.' : 'The guide could not be exported.',
            cancelled,
          });
        }
      },
    });
    return { jobId };
  }

  private async addSlideshow(
    kind: SlideshowKind,
    item: HistoryItem,
    done: { path: string; bytes: number; width: number; height: number; durationMs: number },
  ): Promise<string> {
    const added = await this.deps.history.addVideo({
      path: done.path,
      format: kind,
      durationMs: done.durationMs,
      width: done.width,
      height: done.height,
      sizeBytes: done.bytes,
      hasAudio: false,
      source: 'screen',
      derivedFrom: item.id,
    });
    return added.id;
  }

  /**
   * Writes the numbered pictures to a scratch folder and encodes them into a partial file next to
   * the destination checks it and renames it into
   * place. Everything but the final file is removed afterwards.
   */
  private async encode(input: {
    kind: SlideshowKind;
    destPath: string;
    frames: readonly Uint8Array[];
    signal: AbortSignal;
    onProgress: (percent: number | null) => void;
  }): Promise<{ path: string; bytes: number; width: number; height: number; durationMs: number }> {
    const { kind, destPath, frames, signal } = input;
    const scratch = path.join(this.deps.scratchDir, `export-${randomUUID()}`);
    // The sequence reader takes "%" in the folder name for part of its pattern.
    if (scratch.includes('%')) throw new Error('The scratch folder name has a "%" in it.');
    const partial = partialPathFor(destPath);
    await fs.promises.mkdir(scratch, { recursive: true });
    try {
      for (const [index, frame] of frames.entries()) {
        await fs.promises.writeFile(path.join(scratch, frameName(index)), frame);
      }
      const first = readImageSize(frames[0] ?? new Uint8Array());
      if (!first) throw new Error('The first picture could not be read.');
      const size = slideshowSize(kind, first);
      const totalSec = frames.length * SLIDE_SECONDS;
      const pass = async (args: string[]): Promise<void> => {
        const run = await this.deps.tools.run(args, {
          timeoutMs: JOB_TIMEOUT_MS,
          signal,
          onProgress: (progress) => {
            const fraction = Math.max(0, Math.min(1, progress.outTimeUs / 1e6 / totalSec));
            input.onProgress(Math.min(99, Math.floor(fraction * 100)));
          },
        });
        if (run.code !== 0) {
          throw new Error(`ffmpeg ended with ${run.code}: ${run.stderrTail.slice(-400)}`);
        }
      };
      const args = kind === 'gif' ? gifSlideshowArgs : mp4SlideshowArgs;
      await pass(args({ dir: scratch, size, output: partial }));
      const probe = await this.deps.tools.probe(partial, { timeoutMs: 30_000, signal });
      if (!probe.hasVideo || (kind === 'mp4' && probe.video?.codec !== 'h264')) {
        throw new Error('The slideshow could not be checked.');
      }
      await fs.promises.rename(partial, destPath);
      const bytes = (await fs.promises.stat(destPath)).size;
      input.onProgress(100);
      return {
        path: destPath,
        bytes,
        width: probe.video?.width ?? size.width,
        height: probe.video?.height ?? size.height,
        durationMs: Math.round((probe.durationSec ?? totalSec) * 1000),
      };
    } finally {
      await fs.promises
        .rm(partial, { force: true, maxRetries: 20, retryDelay: 100 })
        .catch(() => undefined);
      await fs.promises.rm(scratch, { recursive: true, force: true }).catch(() => undefined);
    }
  }
}
