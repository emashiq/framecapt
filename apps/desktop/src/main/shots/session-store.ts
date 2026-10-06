import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { ShotKind, ShotSessionMeta } from '../../shared/shots';

/** Internal view of a session: the original's path never reaches the renderer. */
export interface ShotSession extends ShotSessionMeta {
  originalPath: string;
}

export const KEEP_MARKER = 'keep';
export const ORIGINAL_NAME = 'original.png';
export const SWEEP_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** True when `candidate` is `root` itself or lies inside it, after resolving `.` and `..`. */
export function isInsideDir(root: string, candidate: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

export interface SweepResult {
  scanned: number;
  removed: number;
  kept: number;
}

/**
 * Screenshot editing sessions. The original of every capture is written to
 * `<userData>/shots/<id>/original.png` (app-owned, never a user folder); the renderer only knows
 * the id. Deleting is limited to directories inside the shots root.
 */
export class ShotSessionStore {
  private readonly sessions = new Map<string, ShotSession>();

  constructor(
    readonly rootDir: string,
    private readonly now: () => number = Date.now,
  ) {}

  /** Resolves the directory of a session id, or null when the id is not a plain session id. */
  dirFor(id: string): string | null {
    if (!ID_PATTERN.test(id)) return null;
    const dir = path.join(this.rootDir, id);
    return isInsideDir(this.rootDir, dir) && dir !== path.resolve(this.rootDir) ? dir : null;
  }

  async create(input: {
    kind: ShotKind;
    width: number;
    height: number;
    png: Buffer;
  }): Promise<ShotSession> {
    const id = randomUUID();
    const dir = this.dirFor(id);
    if (!dir) throw new Error('Could not derive a session directory.');
    await fs.promises.mkdir(dir, { recursive: true });
    const originalPath = path.join(dir, ORIGINAL_NAME);
    try {
      await fs.promises.writeFile(originalPath, input.png, { flag: 'wx' });
    } catch (error) {
      await fs.promises.rm(dir, { recursive: true, force: true });
      throw error;
    }
    const session: ShotSession = {
      id,
      kind: input.kind,
      width: input.width,
      height: input.height,
      createdAt: this.now(),
      originalPath,
    };
    this.sessions.set(id, session);
    return session;
  }

  get(id: string): ShotSession | undefined {
    return this.sessions.get(id);
  }

  meta(session: ShotSession): ShotSessionMeta {
    const { originalPath: _path, ...meta } = session;
    return meta;
  }

  async readOriginal(id: string): Promise<Buffer | undefined> {
    const session = this.sessions.get(id);
    return session ? fs.promises.readFile(session.originalPath) : undefined;
  }

  /** Deletes the session's directory. Returns false for an unknown id. Idempotent. */
  async discard(id: string): Promise<boolean> {
    const session = this.sessions.get(id);
    this.sessions.delete(id);
    const dir = this.dirFor(id);
    if (!dir) return false;
    // Containment is re-verified against the real path of the stored original as well.
    if (session && !isInsideDir(dir, session.originalPath)) return false;
    await fs.promises.rm(dir, { recursive: true, force: true });
    return session !== undefined;
  }

  /** Same as discard, synchronously: used while the app is closing and cannot await. */
  discardSync(id: string): boolean {
    const session = this.sessions.get(id);
    this.sessions.delete(id);
    const dir = this.dirFor(id);
    if (!dir) return false;
    if (session && !isInsideDir(dir, session.originalPath)) return false;
    fs.rmSync(dir, { recursive: true, force: true });
    return session !== undefined;
  }

  /**
   * Removes session directories older than `maxAgeMs` that have no `keep` marker. Only directories
   * whose names are session ids are touched. Never logs names or content; returns counts.
   */
  async sweep(maxAgeMs: number = SWEEP_MAX_AGE_MS): Promise<SweepResult> {
    const result: SweepResult = { scanned: 0, removed: 0, kept: 0 };
    let entries: fs.Dirent[];
    try {
      entries = await fs.promises.readdir(this.rootDir, { withFileTypes: true });
    } catch {
      return result;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const dir = this.dirFor(entry.name);
      if (!dir) continue;
      result.scanned += 1;
      try {
        const stat = await fs.promises.stat(dir);
        const hasKeep = fs.existsSync(path.join(dir, KEEP_MARKER));
        if (hasKeep || this.now() - stat.mtimeMs <= maxAgeMs) {
          result.kept += 1;
          continue;
        }
        await fs.promises.rm(dir, { recursive: true, force: true });
        result.removed += 1;
      } catch {
        result.kept += 1;
      }
    }
    return result;
  }
}
