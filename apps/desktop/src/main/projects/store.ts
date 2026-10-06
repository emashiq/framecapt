import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { HISTORY_ID_PATTERN } from '../../shared/history-ipc';
import {
  EDITOR_TOOL_VERSION,
  MAX_ASSET_BYTES,
  MAX_PROJECT_ASSETS,
  MAX_PROJECT_DOC_BYTES,
  PROJECT_VERSION,
  ProjectDocSchema,
  type ProjectDoc,
} from '../../shared/project-ipc';
import { detectImageFormat, MAX_FRAME_DIMENSION, readImageSize } from '../../shared/shots';
import { writeFileAtomic } from '../shots/atomic-write';

export const PROJECT_ORIGINAL = 'original.png';
export const PROJECT_FILE = 'project.json';
/** The pictures of image layers: `assets/<sha-256 of the PNG>.png`. */
export const PROJECT_ASSETS = 'assets';
const ASSET_NAME = /^([0-9a-f]{64})\.png$/;
/** Projects with no history item stay this long before the startup sweep removes them. */
export const PROJECT_SWEEP_GRACE_MS = 24 * 60 * 60 * 1000;

const ProjectFileSchema = z.object({
  version: z.number().int(),
  width: z.number().int().min(1),
  height: z.number().int().min(1),
  doc: ProjectDocSchema,
  createdAt: z.number(),
  appVersion: z.string().max(64),
  toolVersion: z.number().int(),
  baseSha256: z.string().regex(/^[0-9a-f]{64}$/),
});

export type ProjectFailure =
  'missing' | 'corrupt' | 'newer_version' | 'sha_mismatch' | 'dimension_mismatch';

/** The picture of an image layer: PNG bytes and their SHA-256 (hex), which is the id. */
export interface ProjectAsset {
  id: string;
  png: Buffer;
}

export type ProjectRead =
  | {
      ok: true;
      png: Buffer;
      doc: ProjectDoc;
      width: number;
      height: number;
      assets: ProjectAsset[];
    }
  | { ok: false; reason: ProjectFailure };

export interface ProjectInput {
  png: Buffer;
  doc: ProjectDoc;
  width: number;
  height: number;
  appVersion: string;
  /** Pictures of the document's image layers (none: the project has no image layers). */
  assets?: ProjectAsset[];
}

/** True for a PNG of at most MAX_ASSET_BYTES whose sides are within the frame limit. */
function validAssetPng(png: Buffer): boolean {
  const size = readImageSize(png);
  return (
    png.length <= MAX_ASSET_BYTES &&
    detectImageFormat(png) === 'png' &&
    size !== null &&
    size.width > 0 &&
    size.height > 0 &&
    size.width <= MAX_FRAME_DIMENSION &&
    size.height <= MAX_FRAME_DIMENSION
  );
}

/** True when `candidate` lies strictly inside `root`. */
function isInside(root: string, candidate: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative);
}

const sha256 = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');

/**
 * Editable projects: `<userData>/projects/<history item id>/{original.png, project.json}`. The id is
 * the history item's id, so a project is reachable only through a history item (the
 * history service decides; this store never lists or resolves anything by name). The original is the
 * UNREDACTED base image: it is app data, never placed next to the exported file.
 */
export class ProjectStore {
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
    return dir !== null && fs.existsSync(path.join(dir, PROJECT_FILE));
  }

  /** Writes the original and then the project file (each atomically). Verifies the PNG size first. */
  async write(id: string, input: ProjectInput): Promise<void> {
    const dir = this.dirFor(id);
    if (!dir) throw new Error('Invalid project id.');
    const size = readImageSize(input.png);
    if (!size || size.width !== input.width || size.height !== input.height) {
      throw new Error('The project image does not match its size.');
    }
    await fs.promises.mkdir(dir, { recursive: true });
    await writeFileAtomic(path.join(dir, PROJECT_ORIGINAL), input.png);
    await this.writeAssets(dir, input.assets ?? []);
    await this.writeFile(dir, {
      ...input,
      baseSha256: sha256(input.png),
      createdAt: this.now(),
    });
  }

  /**
   * Writes the pictures of image layers (before project.json, so a document never points at a
   * missing file), then removes the ones the document no longer uses. Every picture must be a
   * valid PNG whose SHA-256 is its id; anything else rejects the whole write.
   */
  private async writeAssets(dir: string, assets: readonly ProjectAsset[]): Promise<void> {
    if (assets.length > MAX_PROJECT_ASSETS) throw new Error('Too many image layers.');
    for (const asset of assets) {
      if (sha256(asset.png) !== asset.id || !validAssetPng(asset.png)) {
        throw new Error('An image layer picture is not valid.');
      }
    }
    const assetDir = path.join(dir, PROJECT_ASSETS);
    if (assets.length === 0) {
      await fs.promises.rm(assetDir, { recursive: true, force: true });
      return;
    }
    await fs.promises.mkdir(assetDir, { recursive: true });
    for (const asset of assets) {
      await writeFileAtomic(path.join(assetDir, `${asset.id}.png`), asset.png);
    }
    const keep = new Set(assets.map((asset) => `${asset.id}.png`));
    for (const name of await fs.promises.readdir(assetDir)) {
      if (ASSET_NAME.test(name) && !keep.has(name)) {
        await fs.promises.rm(path.join(assetDir, name), { force: true });
      }
    }
  }

  /** The pictures of a project: only valid, correctly named PNGs (a bad file is skipped: its layer shows a placeholder). */
  private async readAssets(dir: string): Promise<ProjectAsset[]> {
    const assetDir = path.join(dir, PROJECT_ASSETS);
    let names: string[];
    try {
      names = await fs.promises.readdir(assetDir);
    } catch {
      return [];
    }
    const assets: ProjectAsset[] = [];
    for (const name of names.filter((candidate) => ASSET_NAME.test(candidate))) {
      if (assets.length >= MAX_PROJECT_ASSETS) break;
      const png = await fs.promises.readFile(path.join(assetDir, name)).catch(() => null);
      const id = name.slice(0, -4);
      if (png && sha256(png) === id && validAssetPng(png)) assets.push({ id, png });
    }
    return assets;
  }

  /**
   * Replaces the editor document and the pictures of its image layers; the original stays as it is.
   * False when there is no valid project.
   */
  async updateDoc(
    id: string,
    doc: ProjectDoc,
    appVersion: string,
    assets: readonly ProjectAsset[] = [],
  ): Promise<boolean> {
    const dir = this.dirFor(id);
    if (!dir) return false;
    const current = await this.read(id);
    if (!current.ok) return false;
    await this.writeAssets(dir, assets);
    await this.writeFile(dir, {
      doc,
      width: current.width,
      height: current.height,
      appVersion,
      baseSha256: sha256(current.png),
      createdAt: this.now(),
    });
    return true;
  }

  private async writeFile(
    dir: string,
    file: Pick<ProjectInput, 'doc' | 'width' | 'height' | 'appVersion'> & {
      baseSha256: string;
      createdAt: number;
    },
  ): Promise<void> {
    const body = {
      version: PROJECT_VERSION,
      width: file.width,
      height: file.height,
      doc: file.doc,
      createdAt: file.createdAt,
      appVersion: file.appVersion,
      toolVersion: EDITOR_TOOL_VERSION,
      baseSha256: file.baseSha256,
    };
    const text = JSON.stringify(body);
    if (text.length > MAX_PROJECT_DOC_BYTES + 4096) throw new Error('The project is too large.');
    await writeFileAtomic(path.join(dir, PROJECT_FILE), Buffer.from(text, 'utf8'));
  }

  /** Reads and verifies a project: known version, readable JSON, original present with the recorded hash and size. */
  async read(id: string): Promise<ProjectRead> {
    const dir = this.dirFor(id);
    if (!dir) return { ok: false, reason: 'missing' };
    let text: string;
    try {
      text = await fs.promises.readFile(path.join(dir, PROJECT_FILE), 'utf8');
    } catch {
      return { ok: false, reason: 'missing' };
    }
    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch {
      return { ok: false, reason: 'corrupt' };
    }
    const version = (json as { version?: unknown } | null)?.version;
    if (typeof version === 'number' && version > PROJECT_VERSION) {
      return { ok: false, reason: 'newer_version' };
    }
    const parsed = ProjectFileSchema.safeParse(json);
    if (!parsed.success || parsed.data.version !== PROJECT_VERSION) {
      return { ok: false, reason: 'corrupt' };
    }
    let png: Buffer;
    try {
      png = await fs.promises.readFile(path.join(dir, PROJECT_ORIGINAL));
    } catch {
      return { ok: false, reason: 'missing' };
    }
    if (sha256(png) !== parsed.data.baseSha256) return { ok: false, reason: 'sha_mismatch' };
    const size = readImageSize(png);
    if (!size || size.width !== parsed.data.width || size.height !== parsed.data.height) {
      return { ok: false, reason: 'dimension_mismatch' };
    }
    return {
      ok: true,
      png,
      doc: parsed.data.doc,
      width: size.width,
      height: size.height,
      assets: await this.readAssets(dir),
    };
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
    graceMs: number = PROJECT_SWEEP_GRACE_MS,
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
