import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import {
  HistoryFormatSchema,
  HistoryIdSchema,
  HistorySourceSchema,
  HistoryTypeSchema,
} from '../../shared/history-ipc';
import { log } from '../logger';
import { writeFileAtomic } from '../shots/atomic-write';
import { THUMB_NAME } from './thumbs';

export const HISTORY_FILE = 'history.json';
export const HISTORY_VERSION = 1;
/** The oldest entries beyond this drop out of history only; their files are never touched. */
export const MAX_HISTORY_ITEMS = 1000;

/** What is kept per capture: facts and a pointer to the file, never the file itself. */
export const HistoryItemSchema = z.object({
  id: HistoryIdSchema,
  type: HistoryTypeSchema,
  createdAt: z.number(),
  /** Absolute path of a file FrameCapt produced (or the user re-linked). */
  path: z.string().min(1),
  width: z.number().int().min(0),
  height: z.number().int().min(0),
  durationMs: z.number().min(0).nullable(),
  sizeBytes: z.number().min(0),
  format: HistoryFormatSchema,
  /** `<id>.png` in the thumbnails folder; null when there is none. */
  thumbnail: z.string().regex(THUMB_NAME).nullable(),
  hasAudio: z.boolean().nullable(),
  source: HistorySourceSchema,
  derivedFrom: HistoryIdSchema.nullable(),
  /** The editable project (`<userData>/projects/<id>`) of a screenshot; absent for older items. */
  projectId: HistoryIdSchema.optional(),
});
export type HistoryItem = z.infer<typeof HistoryItemSchema>;

const HistoryFileSchema = z.object({
  version: z.literal(HISTORY_VERSION),
  /** Set once the recordings finished before history existed were added (see the service). */
  backfilled: z.literal(true).optional(),
  items: z.array(HistoryItemSchema),
});

export interface LoadResult {
  /** The file existed (even if it was damaged). */
  existed: boolean;
  /** The file was damaged: it was moved aside and the history starts empty. */
  reset: boolean;
}

/**
 * `history.json`: a versioned list, written atomically (temp file, fsync, rename), newest first.
 * A damaged file is moved to `history.json.corrupt-<time>` and the history starts empty, so it
 * never blocks the app. Writes are serialized; callers await the one that holds their change.
 */
export class HistoryStore {
  private list: HistoryItem[] = [];
  private backfilledFlag = false;
  private writes: Promise<void> = Promise.resolve();

  constructor(
    private readonly dir: string,
    private readonly maxItems: number = MAX_HISTORY_ITEMS,
    private readonly now: () => number = Date.now,
  ) {}

  private get file(): string {
    return path.join(this.dir, HISTORY_FILE);
  }

  async load(): Promise<LoadResult> {
    let text: string;
    try {
      text = await fs.promises.readFile(this.file, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT')
        return { existed: false, reset: false };
      throw error;
    }
    try {
      const parsed = HistoryFileSchema.parse(JSON.parse(text));
      this.list = sortNewestFirst(parsed.items);
      this.backfilledFlag = parsed.backfilled === true;
      return { existed: true, reset: false };
    } catch {
      const aside = `${this.file}.corrupt-${this.now()}`;
      await fs.promises.rename(this.file, aside).catch(() => undefined);
      log.warn('History file was damaged; it was set aside and the history starts empty');
      this.list = [];
      return { existed: true, reset: true };
    }
  }

  get backfilled(): boolean {
    return this.backfilledFlag;
  }

  get count(): number {
    return this.list.length;
  }

  items(): readonly HistoryItem[] {
    return this.list;
  }

  get(id: string): HistoryItem | undefined {
    return this.list.find((item) => item.id === id);
  }

  /** Adds or replaces (same id) an item; returns the items that fell off the end of the cap. */
  async put(item: HistoryItem): Promise<HistoryItem[]> {
    this.list = sortNewestFirst([...this.list.filter((other) => other.id !== item.id), item]);
    const dropped = this.list.splice(this.maxItems);
    await this.save();
    return dropped;
  }

  async update(
    id: string,
    patch: Partial<Omit<HistoryItem, 'id'>>,
  ): Promise<HistoryItem | undefined> {
    const current = this.get(id);
    if (!current) return undefined;
    const next = { ...current, ...patch };
    this.list = sortNewestFirst(this.list.map((item) => (item.id === id ? next : item)));
    await this.save();
    return next;
  }

  async remove(ids: readonly string[]): Promise<HistoryItem[]> {
    const wanted = new Set(ids);
    const removed = this.list.filter((item) => wanted.has(item.id));
    if (removed.length === 0) return [];
    this.list = this.list.filter((item) => !wanted.has(item.id));
    await this.save();
    return removed;
  }

  async markBackfilled(): Promise<void> {
    this.backfilledFlag = true;
    await this.save();
  }

  /** Queues a write of the current state; resolves when it is on disk. */
  private save(): Promise<void> {
    const write = this.writes.then(async () => {
      const body = {
        version: HISTORY_VERSION,
        ...(this.backfilledFlag && { backfilled: true as const }),
        items: this.list,
      };
      await fs.promises.mkdir(this.dir, { recursive: true });
      await writeFileAtomic(this.file, Buffer.from(`${JSON.stringify(body, null, 2)}\n`, 'utf8'));
    });
    // A failed write must not poison the queue; the caller of this save still sees the error.
    this.writes = write.catch(() => undefined);
    return write;
  }
}

function sortNewestFirst(items: readonly HistoryItem[]): HistoryItem[] {
  return [...items].sort((a, b) => b.createdAt - a.createdAt);
}
