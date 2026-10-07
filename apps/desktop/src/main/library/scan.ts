import fs from 'node:fs';
import path from 'node:path';
import { isFlowFolderName } from '../../shared/flow';
import { folderNameProblem, LIBRARY_MAX_DEPTH } from '../../shared/library';

/** A scan never lists more folders than this (a root pointed at a huge tree stays bounded). */
const MAX_FOLDERS = 5000;
const SYSTEM_FOLDERS = new Set(['$recycle.bin', 'system volume information']);

/** True for a folder name the library lists: valid, not hidden or system, not a step guide. */
export function isLibraryFolderName(name: string): boolean {
  return (
    folderNameProblem(name) === null &&
    !SYSTEM_FOLDERS.has(name.toLowerCase()) &&
    !isFlowFolderName(name)
  );
}

/**
 * Every real subfolder of `root` as a relative path (`A`, `A/B`), at most 8 levels deep. Links and
 * junctions are never listed or entered (S-07), and neither are hidden folders, system folders and
 * step guides (those are items). Parents come before their children.
 */
export async function listSubfolders(root: string): Promise<string[]> {
  const found: string[] = [];
  const walk = async (dir: string, prefix: string[]): Promise<void> => {
    const entries = await fs.promises.readdir(dir, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (found.length >= MAX_FOLDERS) return;
      if (!entry.isDirectory() || entry.isSymbolicLink() || !isLibraryFolderName(entry.name)) {
        continue;
      }
      const parts = [...prefix, entry.name];
      found.push(parts.join('/'));
      if (parts.length < LIBRARY_MAX_DEPTH) await walk(path.join(dir, entry.name), parts);
    }
  };
  await walk(root, []);
  return found;
}

/** `root` and the absolute paths of all its library subfolders (what a rescan looks into). */
export async function listScanDirs(root: string): Promise<string[]> {
  const folders = await listSubfolders(root);
  return [root, ...folders.map((folder) => path.join(root, ...folder.split('/')))];
}
