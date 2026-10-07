import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { HISTORY_ID_PATTERN } from '../../shared/history-ipc';
import { MAX_ASSET_BYTES } from '../../shared/project-ipc';
import { detectImageFormat, MAX_FRAME_DIMENSION, readImageSize } from '../../shared/shots';
import {
  AUDIO_EXTENSIONS,
  MAX_VIDEO_PROJECT_BYTES,
  VIDEO_PROJECT_VERSION,
  VideoProjectSchema,
  normalizeProject,
  type VideoProject,
} from '../../shared/video-edit';
import { writeFileAtomic } from '../shots/atomic-write';

export const VIDEO_PROJECT_FILE = 'project.json';
export const VIDEO_ASSET_DIR = 'assets';
/** `<sha256 hex>.<extension>`: the only names an asset file may have. */
const ASSET_NAME = new RegExp(`^([0-9a-f]{64})\\.(png|${AUDIO_EXTENSIONS.join('|')})$`);
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

  // --- assets: the pictures and audio files a project's items use -------------------------------

  private assetDirOf(id: string): string | null {
    const dir = this.dirFor(id);
    return dir ? path.join(dir, VIDEO_ASSET_DIR) : null;
  }

  /**
   * The file of an asset, or null when the id or extension is not a valid one. An asset is
   * `assets/<sha256 hex>.<ext>` and nothing else: no name or path of a renderer is ever used.
   */
  assetPath(id: string, assetId: string, ext: string): string | null {
    const dir = this.assetDirOf(id);
    const name = `${assetId}.${ext}`;
    return dir && ASSET_NAME.test(name) ? path.join(dir, name) : null;
  }

  /** The file behind a `vproject` media URL name (`<sha256>.<ext>`), or undefined. */
  assetPathByName(id: string, name: string): string | undefined {
    const match = ASSET_NAME.exec(name);
    return (match && this.assetPath(id, match[1] ?? '', match[2] ?? '')) || undefined;
  }

  /**
   * Stores a picture: a PNG of at most MAX_ASSET_BYTES whose sides are within the frame limit and
   * whose SHA-256 is its id. Returns the id (the same picture twice is stored once).
   */
  async writePicture(id: string, png: Uint8Array): Promise<string> {
    const size = readImageSize(png);
    if (
      png.length > MAX_ASSET_BYTES ||
      detectImageFormat(png) !== 'png' ||
      !size ||
      size.width > MAX_FRAME_DIMENSION ||
      size.height > MAX_FRAME_DIMENSION
    ) {
      throw new Error('That picture cannot be used.');
    }
    const assetId = createHash('sha256').update(png).digest('hex');
    const file = this.assetPath(id, assetId, 'png');
    if (!file) throw new Error('Invalid project id.');
    await fs.promises.mkdir(path.dirname(file), { recursive: true });
    await writeFileAtomic(file, Buffer.from(png));
    return assetId;
  }

  /**
   * Copies an audio file into the project's assets as `<sha256>.<ext>` (hashing it as it is read;
   * the copy goes through a temporary file and a rename). Returns the id and the copy's path.
   */
  async importAudio(
    id: string,
    sourceFile: string,
    ext: string,
  ): Promise<{ assetId: string; file: string }> {
    const dir = this.assetDirOf(id);
    if (!dir || !AUDIO_EXTENSIONS.some((known) => known === ext)) throw new Error('Invalid asset.');
    await fs.promises.mkdir(dir, { recursive: true });
    const hash = createHash('sha256');
    for await (const chunk of fs.createReadStream(sourceFile)) hash.update(chunk as Buffer);
    const assetId = hash.digest('hex');
    const file = path.join(dir, `${assetId}.${ext}`);
    const partial = path.join(dir, `.${assetId}.${ext}.partial`);
    try {
      await fs.promises.copyFile(sourceFile, partial);
      await fs.promises.rename(partial, file);
    } finally {
      await fs.promises.rm(partial, { force: true }).catch(() => undefined);
    }
    return { assetId, file };
  }

  /** Deletes an asset (idempotent), e.g. an audio file that failed its checks. */
  async removeAsset(id: string, assetId: string, ext: string): Promise<void> {
    const file = this.assetPath(id, assetId, ext);
    if (file) await fs.promises.rm(file, { force: true });
  }

  /**
   * Deletes the assets no item of the project uses any more and that are older than `minAgeMs`
   * (an item that was just removed can still come back with Undo, a picture that was just added
   * may be waiting for its item). Files that are not named like assets are left alone.
   */
  async pruneAssets(id: string, project: VideoProject, minAgeMs: number): Promise<number> {
    const dir = this.assetDirOf(id);
    if (!dir) return 0;
    const used = new Set<string>();
    for (const item of project.items) {
      if (item.kind === 'image') used.add(`${item.assetId}.png`);
      else if (item.kind === 'audio') used.add(`${item.assetId}.${item.ext}`);
    }
    let names: string[];
    try {
      names = await fs.promises.readdir(dir);
    } catch {
      return 0;
    }
    let removed = 0;
    for (const name of names) {
      if (!ASSET_NAME.test(name) || used.has(name)) continue;
      const file = path.join(dir, name);
      const stat = await fs.promises.stat(file).catch(() => null);
      if (!stat || this.now() - stat.mtimeMs < minAgeMs) continue;
      await fs.promises.rm(file, { force: true }).catch(() => undefined);
      removed += 1;
    }
    return removed;
  }

  /**
   * Copies a project and its assets to another history id (the copy's `sourceId` is rewritten).
   * False when `fromId` has no usable project.
   */
  async copy(fromId: string, toId: string): Promise<boolean> {
    const from = this.dirFor(fromId);
    const to = this.dirFor(toId);
    if (!from || !to) return false;
    const current = await this.read(fromId);
    if (!current.ok) return false;
    await fs.promises
      .cp(path.join(from, VIDEO_ASSET_DIR), path.join(to, VIDEO_ASSET_DIR), {
        recursive: true,
      })
      .catch(() => undefined);
    await this.write(toId, { ...current.project, sourceId: toId });
    return true;
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
