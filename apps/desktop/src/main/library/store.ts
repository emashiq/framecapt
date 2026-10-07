import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { LibraryFolderSchema } from '../../shared/library';
import { log } from '../logger';
import { writeFileAtomic } from '../shots/atomic-write';

export const LIBRARY_FILE = 'library.json';
const LIBRARY_VERSION = 1;

const LibraryFileSchema = z.object({
  version: z.literal(LIBRARY_VERSION),
  /** Folders the user made, so an empty one survives (the folders on disk are the rest of the tree). */
  folders: z.array(z.unknown()),
});

/**
 * `<userData>/library.json`: the folders recorded by the user, written atomically. Only a hint for
 * empty folders: a damaged or unreadable file is set aside and the tree is still what is on disk.
 */
export class LibraryStore {
  private list: string[] = [];
  private writes: Promise<void> = Promise.resolve();

  constructor(private readonly dir: string) {}

  private get file(): string {
    return path.join(this.dir, LIBRARY_FILE);
  }

  async load(): Promise<void> {
    let text: string;
    try {
      text = await fs.promises.readFile(this.file, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        log.warn(`library.json could not be read (${(error as NodeJS.ErrnoException).code})`);
      }
      return;
    }
    try {
      const parsed = LibraryFileSchema.parse(JSON.parse(text));
      this.list = parsed.folders.flatMap((raw) => {
        const folder = LibraryFolderSchema.safeParse(raw);
        return folder.success ? [folder.data] : [];
      });
    } catch {
      await fs.promises.rename(this.file, `${this.file}.corrupt-${Date.now()}`).catch(() => {});
      log.warn('library.json was damaged; it was set aside');
      this.list = [];
    }
  }

  folders(): readonly string[] {
    return this.list;
  }

  /** Records `folders` (case-insensitive duplicates are kept once). */
  async add(folders: readonly string[]): Promise<void> {
    const known = new Set(this.list.map((folder) => folder.toLowerCase()));
    const fresh = folders.filter((folder) => !known.has(folder.toLowerCase()));
    if (fresh.length === 0) return;
    this.list = [...this.list, ...fresh];
    await this.save();
  }

  /** Rewrites every recorded folder; `change` returns the new path, or null to forget it. */
  async rewrite(change: (folder: string) => string | null): Promise<void> {
    const next: string[] = [];
    for (const folder of this.list) {
      const mapped = change(folder);
      if (mapped !== null && !next.some((n) => n.toLowerCase() === mapped.toLowerCase())) {
        next.push(mapped);
      }
    }
    if (next.length === this.list.length && next.every((f, i) => f === this.list[i])) return;
    this.list = next;
    await this.save();
  }

  private save(): Promise<void> {
    const write = this.writes.then(async () => {
      const body = { version: LIBRARY_VERSION, folders: this.list };
      await fs.promises.mkdir(this.dir, { recursive: true });
      await writeFileAtomic(this.file, Buffer.from(`${JSON.stringify(body, null, 2)}\n`, 'utf8'));
    });
    this.writes = write.catch(() => undefined);
    return write;
  }
}
