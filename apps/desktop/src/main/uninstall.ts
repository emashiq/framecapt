import fs from 'node:fs';
import path from 'node:path';
import { isCaptureFileName } from '../shared/capture-names';

/** Media types a history item may point at; the same set `history:open` hands to the shell. */
const MEDIA_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.webm', '.mp4', '.mkv']);
/** Temp files FrameCapt leaves when interrupted, and the folder metadata Windows adds on its own. */
const LEFTOVER_PATTERN = /^(?:\.framecapt-.+|\.FrameCapt .+\.tmp|desktop\.ini|thumbs\.db)$/i;

export interface DirEntry {
  name: string;
  /** A regular file: not a folder, not a link or junction. */
  isFile: boolean;
}

export interface CleanupPlan {
  /** Default capture folders that hold nothing but FrameCapt's own files: trashed as a whole. */
  folders: string[];
  /** Individual files from history items, outside of those folders. */
  files: string[];
}

/** The entries of a real folder; null when it is missing, not a folder or a link (never followed). */
export function listRealDir(dir: string): DirEntry[] | null {
  try {
    if (!fs.lstatSync(dir).isDirectory()) return null;
    return fs
      .readdirSync(dir, { withFileTypes: true })
      .map((entry) => ({ name: entry.name, isFile: entry.isFile() }));
  } catch {
    return null;
  }
}

function isUnder(file: string, folder: string): boolean {
  const relative = path.relative(folder, file).toLowerCase();
  return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative);
}

/** `items[].path` of a history file, read loosely: any damage or oddity just yields fewer paths. */
function historyPaths(historyJson: string | null): string[] {
  if (historyJson === null) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(historyJson);
  } catch {
    return [];
  }
  const items = (parsed as { items?: unknown } | null)?.items;
  if (!Array.isArray(items)) return [];
  const paths: string[] = [];
  for (const item of items) {
    const file = (item as { path?: unknown } | null)?.path;
    if (
      typeof file === 'string' &&
      path.isAbsolute(file) &&
      MEDIA_EXTENSIONS.has(path.extname(file).toLowerCase())
    ) {
      paths.push(path.normalize(file));
    }
  }
  return paths;
}

/**
 * What "also move my screenshots and recordings to the Recycle Bin" would move. A default
 * capture folder goes as a whole only when everything in it is FrameCapt's (so nothing of the
 * user's rides along). Anything else, including custom output folders, is touched only file by
 * file, and only the files history lists. Pure: the folder listing is passed in.
 */
export function planCaptureCleanup(input: {
  historyJson: string | null;
  defaultDirs: readonly string[];
  listDir: (dir: string) => DirEntry[] | null;
}): CleanupPlan {
  const folders: string[] = [];
  for (const dir of input.defaultDirs) {
    const entries = input.listDir(dir);
    const ours = (entry: DirEntry): boolean =>
      entry.isFile && (isCaptureFileName(entry.name) || LEFTOVER_PATTERN.test(entry.name));
    if (entries && entries.length > 0 && entries.every(ours)) folders.push(dir);
  }
  const files = [...new Set(historyPaths(input.historyJson))].filter(
    (file) => !folders.some((folder) => isUnder(file, folder)),
  );
  return { folders, files };
}

/**
 * Moves the planned folders and files to the Recycle Bin until `deadline` (ms since epoch). Only a
 * real folder or a regular file is moved (`kindOf` does not follow links), and a failure of one
 * item does not stop the rest. Returns how many were moved.
 */
export async function executeCleanup(
  plan: CleanupPlan,
  deps: {
    trash: (target: string) => Promise<void>;
    kindOf: (target: string) => 'file' | 'dir' | null;
    now: () => number;
  },
  deadline: number,
): Promise<number> {
  let moved = 0;
  const targets = [
    ...plan.folders.map((target) => ({ target, kind: 'dir' as const })),
    ...plan.files.map((target) => ({ target, kind: 'file' as const })),
  ];
  for (const { target, kind } of targets) {
    if (deps.now() >= deadline) break;
    if (deps.kindOf(target) !== kind) continue;
    try {
      await deps.trash(target);
      moved += 1;
    } catch {
      // Best effort: the user can still remove what is left by hand.
    }
  }
  return moved;
}

/**
 * `lstat`-based: a link or junction is neither a file nor a folder here, and neither is anything
 * reached through one (its real path must be the path itself; an odd case is skipped, not trashed).
 */
export function realKindOf(target: string): 'file' | 'dir' | null {
  try {
    const stat = fs.lstatSync(target);
    const direct =
      path.resolve(fs.realpathSync.native(target)).toLowerCase() ===
      path.resolve(target).toLowerCase();
    if (!direct) return null;
    if (stat.isFile()) return 'file';
    return stat.isDirectory() ? 'dir' : null;
  } catch {
    return null;
  }
}
