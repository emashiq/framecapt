import fs from 'node:fs';
import path from 'node:path';
import {
  folderPathProblem,
  isInsideFolder,
  joinFolder,
  parentFolder,
  type LibraryFolderInfo,
  type LibraryMoveItemsResponse,
  type LibraryTree,
} from '../../shared/library';
import { samePath } from '../history/files';
import type { HistoryItem } from '../history/store';
import { IpcError } from '../ipc-core';
import { log } from '../logger';
import { freeFileName } from '../shots/free-name';
import {
  distinctRoots,
  JUNK_FILES,
  locateDir,
  replaceDirPrefix,
  resolveFolder,
  type Root,
  type RootKind,
  type Roots,
} from './paths';
import { listSubfolders } from './scan';
import type { LibraryStore } from './store';

export interface LibraryDeps {
  roots: () => Roots;
  history: {
    ready: Promise<void>;
    items(): readonly HistoryItem[];
    rewritePaths(changes: readonly { id: string; path: string }[]): Promise<void>;
  };
  store: LibraryStore;
  /** `general.captureFolder`: where new captures are saved. */
  captureFolder: { get(): string | null; set(folder: string | null): void };
  /** Moves a file to the Recycle Bin (`shell.trashItem`); used only to retire the original after a verified copy. */
  trashItem: (file: string) => Promise<void>;
  onChange?: () => void;
  /** Replaceable in tests (an EXDEV failure). */
  rename?: (from: string, to: string) => Promise<void>;
}

/** One move on disk, kept so a failure part way can put everything back. */
interface Move {
  from: string;
  to: string;
  /** Moved by copy, verify and Recycle Bin (another volume): cannot be undone by a rename. */
  copied: boolean;
}

const refuse = (message: string): IpcError => new IpcError('INVALID_PAYLOAD', message);

async function lstat(target: string): Promise<fs.Stats | null> {
  return fs.promises.lstat(target).catch(() => null);
}

async function treeBytes(target: string): Promise<number> {
  const stat = await fs.promises.lstat(target);
  if (!stat.isDirectory()) return stat.size;
  let total = 0;
  for (const name of await fs.promises.readdir(target))
    total += await treeBytes(path.join(target, name));
  return total;
}

/**
 * The capture library: a tree of real folders mirrored inside the screenshots root and the
 * recordings root. Everything the renderer names is a relative folder (validated) or a history id;
 * main resolves it under the fixed roots, refuses links, and moves files only with a rename (or,
 * across volumes, a verified copy whose original goes to the Recycle Bin). Nothing is overwritten
 * and nothing is deleted: a folder is removed only when it is empty on disk.
 */
export class LibraryService {
  private queue: Promise<unknown> = Promise.resolve();
  private readonly rename: (from: string, to: string) => Promise<void>;

  constructor(private readonly deps: LibraryDeps) {
    this.rename = deps.rename ?? ((from, to) => fs.promises.rename(from, to));
  }

  /** Changes run one at a time: two renames or moves never interleave. */
  private serial<T>(task: () => Promise<T>): Promise<T> {
    const run = this.queue.then(task, task);
    this.queue = run.catch(() => undefined);
    return run;
  }

  private roots(): Root[] {
    return distinctRoots(this.deps.roots());
  }

  private changed(): void {
    this.deps.onChange?.();
  }

  // --- where things are -----------------------------------------------------------------------

  /** For History: the library folder of a directory ('' = root), null when outside both roots. */
  folderOfDir(dir: string): string | null {
    const location = locateDir(this.deps.roots(), dir);
    return location === null ? null : (location.folder ?? '');
  }

  /** Where a capture of this kind is saved: the root, or the chosen folder inside it. */
  saveDir(kind: RootKind): string {
    const roots = this.deps.roots();
    const root = kind === 'screenshots' ? roots.screenshotsDir : roots.recordingsDir;
    const folder = this.deps.captureFolder.get();
    if (folder === null) return root;
    try {
      return resolveFolder(root, folder);
    } catch {
      return root;
    }
  }

  /** The folder on disk in one root, or null when it does not exist (or is a link). */
  async directory(kind: RootKind, folder: string | null): Promise<string | null> {
    const root = this.roots().find((candidate) => candidate.kind === kind);
    if (!root) return null;
    let dir: string;
    try {
      dir = resolveFolder(root.dir, folder);
    } catch {
      return null;
    }
    const stat = await lstat(dir);
    return stat?.isDirectory() && !stat.isSymbolicLink() ? dir : null;
  }

  /** The item's file or folder (a guide is its folder) and the root it belongs to. */
  private entryOf(item: HistoryItem): { entry: string; root: Root } {
    const entry = item.type === 'flow' ? path.dirname(item.path) : item.path;
    const roots = this.roots();
    const location = locateDir(this.deps.roots(), path.dirname(entry));
    if (location) return { entry, root: location.root };
    const wanted: RootKind = item.type === 'recording' ? 'recordings' : 'screenshots';
    const root = roots.find((candidate) => candidate.kind === wanted) ?? (roots[0] as Root);
    return { entry, root };
  }

  // --- the tree -------------------------------------------------------------------------------

  async tree(): Promise<LibraryTree> {
    await this.deps.history.ready;
    const found = new Map<string, LibraryFolderInfo>();
    const ensure = (folder: string): LibraryFolderInfo => {
      const key = folder.toLowerCase();
      let info = found.get(key);
      if (!info) {
        info = { path: folder, inScreenshots: false, inRecordings: false, count: 0 };
        found.set(key, info);
      }
      return info;
    };
    const ensureWithParents = (folder: string): LibraryFolderInfo => {
      const parent = parentFolder(folder);
      if (parent !== null) ensureWithParents(parent);
      return ensure(folder);
    };
    for (const root of this.roots()) {
      for (const folder of await listSubfolders(root.dir)) {
        const info = ensureWithParents(folder);
        if (root.kind === 'screenshots') info.inScreenshots = true;
        else info.inRecordings = true;
      }
    }
    for (const folder of this.deps.store.folders()) ensureWithParents(folder);
    let rootCount = 0;
    let otherCount = 0;
    for (const item of this.deps.history.items()) {
      const dir = path.dirname(item.type === 'flow' ? path.dirname(item.path) : item.path);
      const location = locateDir(this.deps.roots(), dir);
      if (location === null) otherCount += 1;
      else if (location.folder === null) rootCount += 1;
      else ensureWithParents(location.folder).count += 1;
    }
    const folders = [...found.values()].sort((a, b) =>
      a.path.toLowerCase().localeCompare(b.path.toLowerCase()),
    );
    return { folders, rootCount, otherCount, captureFolder: this.deps.captureFolder.get() };
  }

  private async exists(folder: string): Promise<boolean> {
    const tree = await this.tree();
    return tree.folders.some((info) => info.path.toLowerCase() === folder.toLowerCase());
  }

  /** A folder on the way to `folder` that is a link: nothing is created through it. */
  private async assertNoLinks(root: string, folder: string): Promise<void> {
    let current = path.resolve(root);
    for (const segment of folder.split('/')) {
      current = path.join(current, segment);
      const stat = await lstat(current);
      if (!stat) return;
      if (stat.isSymbolicLink())
        throw refuse('That folder is a link, which FrameCapt does not use.');
    }
  }

  // --- folders --------------------------------------------------------------------------------

  /** Makes the folder in every root and records it, so it stays even while it is empty. */
  private async ensureFolder(folder: string): Promise<void> {
    let made = 0;
    for (const root of this.roots()) {
      try {
        await this.assertNoLinks(root.dir, folder);
        await fs.promises.mkdir(resolveFolder(root.dir, folder), { recursive: true });
        made += 1;
      } catch (error) {
        if (error instanceof IpcError) throw error;
        log.warn(`Could not create a library folder in the ${root.kind} folder`);
      }
    }
    if (made === 0) throw new IpcError('INTERNAL', 'The folder could not be created.');
    const chain: string[] = [];
    for (let at: string | null = folder; at !== null; at = parentFolder(at)) chain.push(at);
    await this.deps.store.add(chain.reverse());
  }

  createFolder(folder: string): Promise<{ folder: string }> {
    return this.serial(async () => {
      const problem = folderPathProblem(folder);
      if (problem) throw refuse(problem);
      if (await this.exists(folder)) throw refuse('A folder with that name already exists.');
      await this.ensureFolder(folder);
      this.changed();
      return { folder };
    });
  }

  setCaptureFolder(folder: string | null): Promise<void> {
    return this.serial(async () => {
      if (folder !== null) {
        const problem = folderPathProblem(folder);
        if (problem) throw refuse(problem);
        await this.ensureFolder(folder);
      }
      this.deps.captureFolder.set(folder);
      this.changed();
    });
  }

  /** Renames the last level of a folder in every root and rewrites the path of every capture in it. */
  renameFolder(folder: string, name: string): Promise<{ folder: string }> {
    return this.serial(async () => {
      const target = joinFolder(parentFolder(folder), name);
      const problem = folderPathProblem(target);
      if (problem) throw refuse(problem);
      if (target === folder) return { folder };
      const caseOnly = target.toLowerCase() === folder.toLowerCase();
      if (!caseOnly && (await this.exists(target))) {
        throw refuse('A folder with that name already exists.');
      }
      const done: Move[] = [];
      try {
        for (const root of this.roots()) {
          const from = resolveFolder(root.dir, folder);
          const stat = await lstat(from);
          if (!stat) continue;
          if (!stat.isDirectory() || stat.isSymbolicLink()) {
            throw refuse('That folder is a link, which FrameCapt does not use.');
          }
          const to = resolveFolder(root.dir, target);
          if (!caseOnly && (await lstat(to))) {
            throw refuse('A folder with that name already exists.');
          }
          await this.rename(from, to);
          done.push({ from, to, copied: false });
        }
        await this.rewriteHistory(done);
      } catch (error) {
        await this.undo(done);
        throw error instanceof IpcError
          ? error
          : new IpcError('INTERNAL', 'The folder could not be renamed. Nothing was changed.');
      }
      await this.deps.store.rewrite((recorded) =>
        isInsideFolder(recorded, folder) ? target + recorded.slice(folder.length) : recorded,
      );
      const capture = this.deps.captureFolder.get();
      if (capture !== null && isInsideFolder(capture, folder)) {
        this.deps.captureFolder.set(target + capture.slice(folder.length));
      }
      this.changed();
      return { folder: target };
    });
  }

  /** The history items inside a moved directory follow it (one write). */
  private async rewriteHistory(moves: readonly Move[]): Promise<void> {
    const changes: { id: string; path: string }[] = [];
    for (const item of this.deps.history.items()) {
      for (const move of moves) {
        const next = replaceDirPrefix(item.path, move.from, move.to);
        if (next !== null) {
          changes.push({ id: item.id, path: next });
          break;
        }
        // An item that is itself the moved file or folder entry.
        if (samePath(item.path, move.from)) {
          changes.push({ id: item.id, path: move.to });
          break;
        }
      }
    }
    await this.deps.history.rewritePaths(changes);
  }

  /** Puts renames back, last first. A copy-and-trash move cannot be undone; it is logged. */
  private async undo(done: readonly Move[]): Promise<void> {
    for (const move of [...done].reverse()) {
      if (move.copied) {
        log.warn('A move across volumes could not be undone; the original is in the Recycle Bin');
        continue;
      }
      await this.rename(move.to, move.from).catch((error: unknown) =>
        log.error(`Could not undo a folder move (${String(error)})`),
      );
    }
  }

  /** Deletes a folder only when it is empty on disk in every root (desktop.ini and Thumbs.db aside). */
  deleteFolder(folder: string): Promise<void> {
    return this.serial(async () => {
      const problem = folderPathProblem(folder);
      if (problem) throw refuse(problem);
      const dirs: string[] = [];
      for (const root of this.roots()) {
        const dir = resolveFolder(root.dir, folder);
        const stat = await lstat(dir);
        if (!stat) continue;
        if (!stat.isDirectory() || stat.isSymbolicLink()) {
          throw refuse('That folder is a link, which FrameCapt does not use.');
        }
        const names = await fs.promises.readdir(dir);
        if (names.some((name) => !JUNK_FILES.has(name.toLowerCase()))) {
          throw refuse(
            'The folder is not empty. Move its captures and subfolders out first, or use "Move contents to parent".',
          );
        }
        dirs.push(dir);
      }
      const tree = await this.tree();
      if (
        tree.folders.some((info) => info.path.toLowerCase().startsWith(`${folder.toLowerCase()}/`))
      ) {
        throw refuse('The folder has subfolders. Delete or move them first.');
      }
      const listed = this.deps.history.items().filter((item) => {
        const location = locateDir(
          this.deps.roots(),
          path.dirname(item.type === 'flow' ? path.dirname(item.path) : item.path),
        );
        return location?.folder != null && isInsideFolder(location.folder, folder);
      });
      if (listed.length > 0) {
        throw refuse(
          'History still lists captures in this folder (their files are missing). Clear them first.',
        );
      }
      for (const dir of dirs) {
        for (const name of await fs.promises.readdir(dir)) {
          await fs.promises.rm(path.join(dir, name), { force: true });
        }
        await fs.promises.rmdir(dir);
      }
      await this.deps.store.rewrite((recorded) =>
        isInsideFolder(recorded, folder) ? null : recorded,
      );
      if (
        this.deps.captureFolder.get() !== null &&
        isInsideFolder(this.deps.captureFolder.get() ?? '', folder)
      ) {
        this.deps.captureFolder.set(null);
      }
      this.changed();
    });
  }

  /** Moves everything directly in the folder up one level (names kept, " (2)" on a clash), then removes the empty folder. */
  moveContentsUp(folder: string): Promise<{ moved: number }> {
    return this.serial(async () => {
      const problem = folderPathProblem(folder);
      if (problem) throw refuse(problem);
      const parent = parentFolder(folder);
      const done: Move[] = [];
      const renamed = new Map<string, string>();
      try {
        for (const root of this.roots()) {
          const dir = resolveFolder(root.dir, folder);
          const stat = await lstat(dir);
          if (!stat) continue;
          if (!stat.isDirectory() || stat.isSymbolicLink()) {
            throw refuse('That folder is a link, which FrameCapt does not use.');
          }
          const upDir = resolveFolder(root.dir, parent);
          if (parent !== null) await this.assertNoLinks(root.dir, parent);
          for (const name of await fs.promises.readdir(dir)) {
            if (JUNK_FILES.has(name.toLowerCase())) continue;
            const to = await freeFileName(upDir, name);
            const move = await this.moveEntry(path.join(dir, name), to);
            done.push(move);
            renamed.set(name.toLowerCase(), path.basename(to));
          }
        }
        await this.rewriteHistory(done);
      } catch (error) {
        await this.undo(done);
        throw error instanceof IpcError
          ? error
          : new IpcError('INTERNAL', 'The contents could not be moved. Nothing was changed.');
      }
      await this.deps.store.rewrite((recorded) => {
        if (recorded.toLowerCase() === folder.toLowerCase()) return null;
        if (!isInsideFolder(recorded, folder)) return recorded;
        const rest = recorded.slice(folder.length + 1).split('/');
        const first = rest[0] ?? '';
        return joinFolder(
          parent,
          [renamed.get(first.toLowerCase()) ?? first, ...rest.slice(1)].join('/'),
        );
      });
      const capture = this.deps.captureFolder.get();
      if (capture !== null && isInsideFolder(capture, folder)) {
        const rest = capture.slice(folder.length + 1).split('/');
        const first = rest[0] ?? '';
        this.deps.captureFolder.set(
          capture.toLowerCase() === folder.toLowerCase()
            ? parent
            : joinFolder(
                parent,
                [renamed.get(first.toLowerCase()) ?? first, ...rest.slice(1)].join('/'),
              ),
        );
      }
      // What is left is only desktop.ini / Thumbs.db: the emptied folder goes (it stays if anything remains).
      for (const root of this.roots()) {
        const dir = resolveFolder(root.dir, folder);
        const names = await fs.promises.readdir(dir).catch(() => null);
        if (names && names.every((name) => JUNK_FILES.has(name.toLowerCase()))) {
          for (const name of names) await fs.promises.rm(path.join(dir, name), { force: true });
          await fs.promises.rmdir(dir).catch(() => undefined);
        }
      }
      this.changed();
      return { moved: done.length };
    });
  }

  // --- captures -------------------------------------------------------------------------------

  /** Moves a file or a folder; across volumes a copy is verified by size before the original goes to the Recycle Bin. */
  private async moveEntry(from: string, to: string): Promise<Move> {
    try {
      await this.rename(from, to);
      return { from, to, copied: false };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EXDEV') throw error;
    }
    try {
      await fs.promises.cp(from, to, { recursive: true, errorOnExist: true, force: false });
      if ((await treeBytes(from)) !== (await treeBytes(to)))
        throw new Error('The copy is incomplete.');
    } catch (error) {
      await fs.promises.rm(to, { recursive: true, force: true }).catch(() => undefined);
      throw error;
    }
    try {
      await this.deps.trashItem(from);
    } catch (error) {
      // The original stays where it is; only our copy is removed.
      await fs.promises.rm(to, { recursive: true, force: true }).catch(() => undefined);
      throw error;
    }
    return { from, to, copied: true };
  }

  moveItems(ids: readonly string[], folder: string | null): Promise<LibraryMoveItemsResponse> {
    return this.serial(async () => {
      if (folder !== null) {
        const problem = folderPathProblem(folder);
        if (problem) throw refuse(problem);
      }
      await this.deps.history.ready;
      const failed: LibraryMoveItemsResponse['failed'] = [];
      const done: Move[] = [];
      const changes: { id: string; path: string }[] = [];
      const unique = [...new Set(ids)];
      for (const id of unique) {
        const item = this.deps.history.items().find((candidate) => candidate.id === id);
        if (!item) {
          failed.push({ id, message: 'That item is not in history.' });
          continue;
        }
        try {
          const { entry, root } = this.entryOf(item);
          const stat = await lstat(entry);
          if (!stat) {
            failed.push({ id, message: 'The file was moved or deleted.' });
            continue;
          }
          const target = resolveFolder(root.dir, folder);
          if (samePath(path.dirname(entry), target)) continue; // already there
          if (folder !== null) await this.assertNoLinks(root.dir, folder);
          await fs.promises.mkdir(target, { recursive: true });
          const to = await freeFileName(target, path.basename(entry));
          done.push(await this.moveEntry(entry, to));
          changes.push({
            id,
            path: item.type === 'flow' ? path.join(to, path.basename(item.path)) : to,
          });
        } catch (error) {
          failed.push({
            id,
            message: error instanceof IpcError ? error.message : 'The file could not be moved.',
          });
        }
      }
      if (changes.length > 0) {
        try {
          await this.deps.history.rewritePaths(changes);
        } catch (error) {
          await this.undo(done);
          log.error(`Moving captures: history could not be saved (${String(error)})`);
          throw new IpcError('INTERNAL', 'The captures could not be moved. Nothing was changed.');
        }
        if (folder !== null) await this.deps.store.add([folder]).catch(() => undefined);
      }
      this.changed();
      return { moved: changes.length, failed };
    });
  }
}
