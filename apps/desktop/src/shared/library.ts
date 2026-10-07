import { z } from 'zod';
import { isFlowFolderName } from './flow';
import { HistoryIdSchema } from './history-ipc';

/**
 * The capture library: one logical tree of folders, mirrored as real folders inside the screenshots
 * root and the recordings root. A folder is named by a relative path like `Clients/Acme/Bugs`; this
 * grammar is the only thing the renderer may send, and main resolves it under the fixed roots.
 */

export const LIBRARY_MAX_DEPTH = 8;
export const LIBRARY_MAX_SEGMENT = 80;
/** 8 segments of 80 characters and the 7 separators between them. */
export const LIBRARY_MAX_PATH = LIBRARY_MAX_DEPTH * LIBRARY_MAX_SEGMENT + (LIBRARY_MAX_DEPTH - 1);

const RESERVED_NAMES = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;
// eslint-disable-next-line no-control-regex -- control characters are exactly what is refused
const FORBIDDEN_CHARS = /[<>:"/\\|?*\u0000-\u001f\u007f]/;

/** Why `name` cannot be a folder name, or null when it can. */
export function folderNameProblem(name: string): string | null {
  if (name.length === 0) return 'A folder needs a name.';
  if (name.length > LIBRARY_MAX_SEGMENT) {
    return `A folder name can have at most ${LIBRARY_MAX_SEGMENT} characters.`;
  }
  if (FORBIDDEN_CHARS.test(name)) return 'A folder name cannot contain < > : " / \\ | ? *.';
  if (name === '.' || name === '..') return 'That is not a valid folder name.';
  if (name.startsWith('.')) return 'A folder name cannot start with a dot.';
  if (/[. ]$/.test(name)) return 'A folder name cannot end with a dot or a space.';
  if (/^\s/.test(name)) return 'A folder name cannot start with a space.';
  // Windows reserves the device name even with an extension ("CON.txt").
  if (RESERVED_NAMES.test(name.split('.')[0] ?? '')) return 'Windows reserves that name.';
  if (isFlowFolderName(name)) return 'That name is used for step guides.';
  return null;
}

/** Why `folder` is not a valid library path, or null. The root is not a path: it is `null` elsewhere. */
export function folderPathProblem(folder: string): string | null {
  if (folder.length === 0 || folder.length > LIBRARY_MAX_PATH) {
    return 'That folder path is not valid.';
  }
  const segments = folder.split('/');
  if (segments.length > LIBRARY_MAX_DEPTH) {
    return `Folders can be nested at most ${LIBRARY_MAX_DEPTH} levels deep.`;
  }
  for (const segment of segments) {
    const problem = folderNameProblem(segment);
    if (problem) return problem;
  }
  return null;
}

export const LibraryFolderSchema = z.string().superRefine((value, ctx) => {
  const problem = folderPathProblem(value);
  if (problem) ctx.addIssue({ code: 'custom', message: problem });
});
export const LibraryFolderNameSchema = z.string().superRefine((value, ctx) => {
  const problem = folderNameProblem(value);
  if (problem) ctx.addIssue({ code: 'custom', message: problem });
});
/** A folder, or null for the library root. */
export const LibraryTargetSchema = LibraryFolderSchema.nullable();

export const parentFolder = (folder: string): string | null => {
  const cut = folder.lastIndexOf('/');
  return cut < 0 ? null : folder.slice(0, cut);
};
export const folderBaseName = (folder: string): string => folder.slice(folder.lastIndexOf('/') + 1);
export const joinFolder = (parent: string | null, name: string): string =>
  parent === null ? name : `${parent}/${name}`;
/** True when `folder` is `ancestor` or lies inside it (case-insensitive: Windows names). */
export function isInsideFolder(folder: string, ancestor: string): boolean {
  const a = folder.toLowerCase();
  const b = ancestor.toLowerCase();
  return a === b || a.startsWith(`${b}/`);
}
export const folderDepth = (folder: string): number => folder.split('/').length;

// --- IPC ----------------------------------------------------------------------------------------

export const LibraryFolderInfoSchema = z.object({
  path: LibraryFolderSchema,
  /** The folder exists inside the screenshots root / the recordings root (for "Show in Explorer"). */
  inScreenshots: z.boolean(),
  inRecordings: z.boolean(),
  /** Captures directly in this folder (not in its subfolders). */
  count: z.number().int().min(0),
});
export type LibraryFolderInfo = z.infer<typeof LibraryFolderInfoSchema>;

export const LibraryTreeSchema = z.object({
  /** Every folder, intermediate ones included, sorted by path. */
  folders: z.array(LibraryFolderInfoSchema),
  /** Captures directly in the library root. */
  rootCount: z.number().int().min(0),
  /** Captures outside both roots ("Other locations"). */
  otherCount: z.number().int().min(0),
  /** The folder new captures are saved to; null = the root. */
  captureFolder: LibraryFolderSchema.nullable(),
});
export type LibraryTree = z.infer<typeof LibraryTreeSchema>;

export const LibraryFolderRequestSchema = z.strictObject({ folder: LibraryFolderSchema });
export const LibraryFolderResponseSchema = z.object({ folder: LibraryFolderSchema });
export const LibraryRenameRequestSchema = z.strictObject({
  folder: LibraryFolderSchema,
  /** The new name of the last level; the folder stays where it is. */
  name: LibraryFolderNameSchema,
});
export const LibraryMoveItemsRequestSchema = z.strictObject({
  ids: z.array(HistoryIdSchema).min(1).max(500),
  folder: LibraryTargetSchema,
});
export const LibraryMoveItemsResponseSchema = z.object({
  moved: z.number().int().min(0),
  /** Items that were not moved (an item already in the folder is not a failure). */
  failed: z.array(z.object({ id: HistoryIdSchema, message: z.string() })),
});
export type LibraryMoveItemsResponse = z.infer<typeof LibraryMoveItemsResponseSchema>;
export const LibraryMoveUpResponseSchema = z.object({ moved: z.number().int().min(0) });
export const LibrarySetCaptureFolderRequestSchema = z.strictObject({
  folder: LibraryTargetSchema,
});
export const LibraryRevealRequestSchema = z.strictObject({
  folder: LibraryTargetSchema,
  root: z.enum(['screenshots', 'recordings']),
});
