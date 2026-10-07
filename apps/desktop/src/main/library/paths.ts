import path from 'node:path';
import { folderPathProblem } from '../../shared/library';

/** The two capture roots the library tree is mirrored in. */
export interface Roots {
  screenshotsDir: string;
  recordingsDir: string;
}

export type RootKind = 'screenshots' | 'recordings';

export interface Root {
  kind: RootKind;
  dir: string;
}

const same = (a: string, b: string): boolean =>
  path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();

/** The roots as a list; a recordings folder equal to the screenshots folder is the same root once. */
export function distinctRoots(roots: Roots): Root[] {
  const list: Root[] = [{ kind: 'screenshots', dir: roots.screenshotsDir }];
  if (!same(roots.screenshotsDir, roots.recordingsDir)) {
    list.push({ kind: 'recordings', dir: roots.recordingsDir });
  }
  return list;
}

/**
 * The absolute folder of a library folder (`null` = the root itself) under `root`. The renderer
 * only ever sends a relative name checked against the grammar; this still refuses anything that
 * resolves outside the root (`path.relative` must not climb out or be absolute).
 */
export function resolveFolder(root: string, folder: string | null): string {
  if (folder === null) return path.resolve(root);
  if (folderPathProblem(folder) !== null) throw new Error('Not a valid library folder.');
  const base = path.resolve(root);
  const target = path.resolve(base, ...folder.split('/'));
  const relative = path.relative(base, target);
  if (relative === '' || relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error('The folder is outside the capture folder.');
  }
  return target;
}

export interface Location {
  root: Root;
  /** Library folder of the directory; null = directly in the root. */
  folder: string | null;
}

/**
 * Where a directory sits in the library: inside which root and in which folder. Null when it is
 * outside both roots, or deeper or oddly named than the grammar allows ("Other locations").
 */
export function locateDir(roots: Roots, dir: string): Location | null {
  // The deepest root wins when one root lies inside the other.
  const candidates = distinctRoots(roots).sort(
    (a, b) => path.resolve(b.dir).length - path.resolve(a.dir).length,
  );
  for (const root of candidates) {
    const relative = path.relative(path.resolve(root.dir), path.resolve(dir));
    if (relative === '') return { root, folder: null };
    if (relative.startsWith('..') || path.isAbsolute(relative)) continue;
    const folder = relative.split(path.sep).join('/');
    return folderPathProblem(folder) === null ? { root, folder } : null;
  }
  return null;
}

/** `file` with the directory prefix `from` replaced by `to`; null when `file` is not inside `from`. */
export function replaceDirPrefix(file: string, from: string, to: string): string | null {
  const relative = path.relative(path.resolve(from), path.resolve(file));
  if (relative === '' || relative.startsWith('..') || path.isAbsolute(relative)) return null;
  return path.join(to, relative);
}

/** Files Explorer drops into a folder; they do not make a folder "not empty". */
export const JUNK_FILES = new Set(['desktop.ini', 'thumbs.db']);
