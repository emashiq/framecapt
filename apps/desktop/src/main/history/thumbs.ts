import fs from 'node:fs';
import path from 'node:path';
import { writeFileAtomic } from '../shots/atomic-write';
import { HISTORY_ID_PATTERN } from '../../shared/history-ipc';

/** Total size the thumbnail folder may use before the oldest entries lose their thumbnail. */
export const THUMBS_CAP_BYTES = 200 * 1024 * 1024;

const ID = HISTORY_ID_PATTERN.source.slice(1, -1);
/** A thumbnail is always `<history id>.png`; nothing else is ever read or deleted here. */
export const THUMB_NAME = new RegExp(`^${ID}[.]png$`);
/** Leftovers of an interrupted write: `<id>.partial.png` (ffmpeg) and `.<id>.png.<hex>.tmp` (atomic write). */
const LEFTOVER = new RegExp(`^(${ID}[.]partial[.]png|[.]${ID}[.]png[.][0-9a-f]+[.]tmp)$`);

const LEFTOVER_MIN_AGE_MS = 60_000;

export function thumbNameFor(id: string): string {
  return `${id}.png`;
}

export interface ThumbRef {
  name: string;
  createdAt: number;
}

/**
 * The folder of history thumbnails. They are derived data (small PNGs of the final output), kept
 * apart from the user's files, bounded in total size and removed when nothing refers to them.
 */
export class ThumbStore {
  constructor(
    readonly dir: string,
    private readonly capBytes: number = THUMBS_CAP_BYTES,
  ) {}

  /** The absolute path of a thumbnail name, or undefined for anything that is not a thumbnail name. */
  pathOf(name: string): string | undefined {
    return THUMB_NAME.test(name) ? path.join(this.dir, name) : undefined;
  }

  async write(name: string, bytes: Uint8Array): Promise<void> {
    const target = this.pathOf(name);
    if (!target) throw new Error('Invalid thumbnail name.');
    await fs.promises.mkdir(this.dir, { recursive: true });
    await writeFileAtomic(target, bytes);
  }

  /**
   * Deletes thumbnails nothing refers to and interrupted leftovers, then, while the rest exceeds
   * the cap, the thumbnails of the oldest items (LRU by creation time). Returns the referenced
   * names that were deleted for size, so their items can forget them.
   */
  async gc(keep: readonly ThumbRef[], leftoverMinAgeMs = LEFTOVER_MIN_AGE_MS): Promise<string[]> {
    let names: string[];
    try {
      names = await fs.promises.readdir(this.dir);
    } catch {
      return [];
    }
    const wanted = new Map(keep.map((ref) => [ref.name, ref.createdAt]));
    const present: { name: string; size: number; createdAt: number }[] = [];
    for (const name of names) {
      const file = path.join(this.dir, name);
      if (LEFTOVER.test(name)) {
        // A young leftover may be a write that is still running.
        const stat = await fs.promises.stat(file).catch(() => null);
        if (stat && Date.now() - stat.mtimeMs >= leftoverMinAgeMs) {
          await fs.promises.rm(file, { force: true }).catch(() => undefined);
        }
      } else if (THUMB_NAME.test(name) && !wanted.has(name)) {
        await fs.promises.rm(file, { force: true }).catch(() => undefined);
      } else if (THUMB_NAME.test(name)) {
        const stat = await fs.promises.stat(file).catch(() => null);
        if (stat) present.push({ name, size: stat.size, createdAt: wanted.get(name) ?? 0 });
      }
    }
    let total = present.reduce((sum, entry) => sum + entry.size, 0);
    const dropped: string[] = [];
    present.sort((a, b) => a.createdAt - b.createdAt);
    for (const entry of present) {
      if (total <= this.capBytes) break;
      await fs.promises.rm(path.join(this.dir, entry.name), { force: true }).catch(() => undefined);
      total -= entry.size;
      dropped.push(entry.name);
    }
    return dropped;
  }
}
