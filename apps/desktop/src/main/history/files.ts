import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

/** Runs `task` over `items` with at most `limit` in flight; results keep the input order. */
export async function mapLimit<T, R>(
  items: readonly T[],
  limit: number,
  task: (item: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < items.length) {
      const index = next;
      next += 1;
      results[index] = await task(items[index] as T);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

/**
 * What `history:open` may hand to the shell: only the media types FrameCapt itself produces. A
 * history entry that points at anything else (an edited history file, a re-linked odd file) is
 * never launched, whatever program Windows would pick for it.
 */
const OPENABLE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.webm', '.mp4', '.gif']);
export function isOpenableMedia(file: string): boolean {
  return OPENABLE_EXTENSIONS.has(path.extname(file).toLowerCase());
}

/** Case-insensitive path equality (Windows file names). */
export function samePath(a: string, b: string): boolean {
  return path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();
}

/**
 * Copies `source` to `target` through a temporary file next to the target and a rename, so a
 * cancelled or failed copy never leaves a half-written file under the final name. The temporary
 * file is the only thing deleted on failure.
 */
export async function copyFileAtomic(source: string, target: string): Promise<void> {
  if (samePath(source, target)) throw new Error('The copy would overwrite the original.');
  const temp = path.join(
    path.dirname(target),
    `.framecapt-copy-${randomBytes(6).toString('hex')}.partial`,
  );
  try {
    await fs.promises.copyFile(source, temp, fs.constants.COPYFILE_EXCL);
    await fs.promises.rename(temp, target);
  } catch (error) {
    await fs.promises
      .rm(temp, { force: true, maxRetries: 5, retryDelay: 50 })
      .catch(() => undefined);
    throw error;
  }
}

/**
 * Copies `source` to `target` and refuses (EEXIST) when `target` already exists, so a copy can never
 * replace a file. A copy that fails part way removes the half-written file it created.
 */
export async function copyFileNoOverwrite(source: string, target: string): Promise<void> {
  if (samePath(source, target)) throw new Error('The copy would overwrite the original.');
  try {
    await fs.promises.copyFile(source, target, fs.constants.COPYFILE_EXCL);
  } catch (error) {
    // EEXIST means the file there is not ours: leave it. Anything else may have left a partial copy.
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
      await fs.promises.rm(target, { force: true }).catch(() => undefined);
    }
    throw error;
  }
}
