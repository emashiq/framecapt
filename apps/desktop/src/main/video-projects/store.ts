import fs from 'node:fs';
import path from 'node:path';
import { HISTORY_ID_PATTERN } from '../../shared/history-ipc';
import {
  MAX_VIDEO_PROJECT_BYTES,
  VIDEO_PROJECT_VERSION,
  VideoProjectSchema,
  normalizeProject,
  type VideoProject,
} from '../../shared/video-edit';
import { writeFileAtomic } from '../shots/atomic-write';

export const VIDEO_PROJECT_FILE = 'project.json';
/** Projects with no history item stay this long before the startup sweep removes them. */
export const VIDEO_PROJECT_SWEEP_GRACE_MS = 24 * 60 * 60 * 1000;

export type VideoProjectRead =
  | { ok: true; project: VideoProject }
  | { ok: false; reason: 'missing' | 'corrupt' | 'newer_version' };

/** True when `candidate` lies strictly inside `root`. */
function isInside(root: string, candidate: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative);
}

/**
 * Video editing projects: `<userData>/video-projects/<history item id>/project.json`. The id is the
 * history item's id, so a project is reachable only through a history item. A project is only a
 * recipe (trim, cuts, boxes); the video itself is never copied or changed.
 */
export class VideoProjectStore {
  constructor(
    readonly rootDir: string,
    private readonly now: () => number = Date.now,
  ) {}

  /** The directory of a project id, or null unless it is a plain history id inside the root. */
  dirFor(id: string): string | null {
    if (!HISTORY_ID_PATTERN.test(id)) return null;
    const dir = path.join(this.rootDir, id);
    return isInside(this.rootDir, dir) ? dir : null;
  }

  has(id: string): boolean {
    const dir = this.dirFor(id);
    return dir !== null && fs.existsSync(path.join(dir, VIDEO_PROJECT_FILE));
  }

  /** Writes the project atomically. Throws for an invalid id or an oversized project. */
  async write(id: string, project: VideoProject): Promise<void> {
    const dir = this.dirFor(id);
    if (!dir) throw new Error('Invalid project id.');
    const text = JSON.stringify(project);
    if (text.length > MAX_VIDEO_PROJECT_BYTES) throw new Error('The project is too large.');
    await fs.promises.mkdir(dir, { recursive: true });
    await writeFileAtomic(path.join(dir, VIDEO_PROJECT_FILE), Buffer.from(text, 'utf8'));
  }

  /**
   * Reads a project. A file that cannot be used (damaged, or written by a newer version) is set
   * aside as `project.<reason>-<time>.json` so nothing is lost and the next save starts fresh.
   */
  async read(id: string): Promise<VideoProjectRead> {
    const dir = this.dirFor(id);
    if (!dir) return { ok: false, reason: 'missing' };
    const file = path.join(dir, VIDEO_PROJECT_FILE);
    let text: string;
    try {
      text = await fs.promises.readFile(file, 'utf8');
    } catch {
      return { ok: false, reason: 'missing' };
    }
    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch {
      await this.setAside(file, 'corrupt');
      return { ok: false, reason: 'corrupt' };
    }
    const version = (json as { version?: unknown } | null)?.version;
    if (typeof version === 'number' && version > VIDEO_PROJECT_VERSION) {
      await this.setAside(file, 'newer');
      return { ok: false, reason: 'newer_version' };
    }
    const parsed = VideoProjectSchema.safeParse(json);
    if (!parsed.success || parsed.data.sourceId !== id) {
      await this.setAside(file, 'corrupt');
      return { ok: false, reason: 'corrupt' };
    }
    return { ok: true, project: normalizeProject(parsed.data) };
  }

  private async setAside(file: string, reason: string): Promise<void> {
    const target = path.join(path.dirname(file), `project.${reason}-${this.now()}.json`);
    await fs.promises.rename(file, target).catch(() => undefined);
  }

  /** Deletes one project folder (idempotent). Only plain ids inside the root are ever touched. */
  async remove(id: string): Promise<void> {
    const dir = this.dirFor(id);
    if (!dir) return;
    await fs.promises.rm(dir, { recursive: true, force: true });
  }

  /**
   * Removes project folders no history item refers to and that are older than `graceMs`. Only
   * directories named like history ids are considered; anything else in the root is left alone.
   */
  async sweep(
    known: ReadonlySet<string>,
    graceMs: number = VIDEO_PROJECT_SWEEP_GRACE_MS,
  ): Promise<{ scanned: number; removed: number }> {
    const result = { scanned: 0, removed: 0 };
    let entries: fs.Dirent[];
    try {
      entries = await fs.promises.readdir(this.rootDir, { withFileTypes: true });
    } catch {
      return result;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue; // symlinks and files are never followed or removed
      const dir = this.dirFor(entry.name);
      if (!dir) continue;
      result.scanned += 1;
      if (known.has(entry.name)) continue;
      try {
        const stat = await fs.promises.stat(dir);
        if (this.now() - stat.mtimeMs < graceMs) continue;
        await fs.promises.rm(dir, { recursive: true, force: true });
        result.removed += 1;
      } catch {
        // left for the next start
      }
    }
    return result;
  }
}
