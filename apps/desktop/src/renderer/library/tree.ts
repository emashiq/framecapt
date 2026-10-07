import type { HistoryItemView } from '../../shared/history-ipc';
import {
  folderBaseName,
  isInsideFolder,
  parentFolder,
  type LibraryFolderInfo,
} from '../../shared/library';

/** A folder of the tree with its subfolders. `total` counts captures in it and below. */
export interface FolderNode {
  path: string;
  name: string;
  /** 1 for a top-level folder. */
  depth: number;
  info: LibraryFolderInfo;
  total: number;
  children: FolderNode[];
}

/** What History shows: everything, one folder (and optionally what is below it), or other locations. */
export type FolderSelection =
  { kind: 'all' } | { kind: 'folder'; path: string } | { kind: 'other' };

export const ALL_SELECTION: FolderSelection = { kind: 'all' };

/** The flat folder list of main as a tree (parents are always present, sorted by name). */
export function buildTree(folders: readonly LibraryFolderInfo[]): FolderNode[] {
  const nodes = new Map<string, FolderNode>();
  for (const info of folders) {
    nodes.set(info.path.toLowerCase(), {
      path: info.path,
      name: folderBaseName(info.path),
      depth: info.path.split('/').length,
      info,
      total: info.count,
      children: [],
    });
  }
  const roots: FolderNode[] = [];
  for (const node of nodes.values()) {
    const parent = parentFolder(node.path);
    const holder = parent === null ? undefined : nodes.get(parent.toLowerCase());
    if (holder) holder.children.push(node);
    else roots.push(node);
  }
  const finish = (node: FolderNode): number => {
    node.children.sort((a, b) => a.name.toLowerCase().localeCompare(b.name.toLowerCase()));
    node.total = node.info.count + node.children.reduce((sum, child) => sum + finish(child), 0);
    return node.total;
  };
  roots.sort((a, b) => a.name.toLowerCase().localeCompare(b.name.toLowerCase()));
  for (const root of roots) finish(root);
  return roots;
}

/** The rows to draw, depth first, skipping the children of collapsed folders. */
export function visibleRows(
  roots: readonly FolderNode[],
  expanded: ReadonlySet<string>,
): FolderNode[] {
  const rows: FolderNode[] = [];
  const walk = (node: FolderNode): void => {
    rows.push(node);
    if (expanded.has(node.path)) node.children.forEach(walk);
  };
  roots.forEach(walk);
  return rows;
}

/** Every ancestor of `folder` (not itself), so a selected folder can be shown. */
export function ancestorsOf(folder: string): string[] {
  const list: string[] = [];
  for (let at = parentFolder(folder); at !== null; at = parentFolder(at)) list.push(at);
  return list;
}

export function selectionMatches(
  item: Pick<HistoryItemView, 'folder' | 'outside'>,
  selection: FolderSelection,
  includeSubfolders: boolean,
): boolean {
  switch (selection.kind) {
    case 'all':
      return true;
    case 'other':
      return item.outside === true;
    case 'folder': {
      if (item.outside || item.folder === undefined) return false;
      return includeSubfolders
        ? isInsideFolder(item.folder, selection.path)
        : item.folder.toLowerCase() === selection.path.toLowerCase();
    }
  }
}

/** "Clients / Acme" for a folder; "All captures" for the root. */
export function folderLabel(folder: string | null): string {
  return folder === null ? 'All captures' : folder.split('/').join(' / ');
}
