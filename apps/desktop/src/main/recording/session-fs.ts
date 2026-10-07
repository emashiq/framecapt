import fs from 'node:fs';

/** The slice of an open file the service uses, so tests can inject failures. */
export interface SessionFileHandle {
  write(buffer: Uint8Array, offset: number, length: number): Promise<{ bytesWritten: number }>;
  sync(): Promise<void>;
  close(): Promise<void>;
}

/** The slice of node:fs/promises the recording code uses, so tests can inject failures. */
export interface SessionFs {
  mkdir(dir: string, options: { recursive: true }): Promise<unknown>;
  open(file: string, flags: string): Promise<SessionFileHandle>;
  /** Replaces a file's content and flushes it to disk (fsync) before returning. */
  writeFile(file: string, data: string): Promise<void>;
  readFile(file: string): Promise<string>;
  readdir(dir: string): Promise<string[]>;
  rename(from: string, to: string): Promise<void>;
  rm(target: string, options: { recursive?: boolean; force?: boolean }): Promise<void>;
  copyFile(from: string, to: string, mode?: number): Promise<void>;
  stat(file: string): Promise<{ size: number; mtimeMs: number; isDirectory(): boolean }>;
  /** Like stat, but a symbolic link or junction is reported as itself (never followed). */
  lstat(file: string): Promise<{ isDirectory(): boolean; isSymbolicLink(): boolean }>;
  statfs(dir: string): Promise<{ bavail: number; bsize: number }>;
}

/** Writes through a handle and fsyncs, so a power cut cannot leave an empty manifest. */
async function writeFileDurable(file: string, data: string): Promise<void> {
  const handle = await fs.promises.open(file, 'w');
  try {
    await handle.writeFile(data, 'utf8');
    await handle.sync();
  } finally {
    await handle.close();
  }
}

/** Windows refuses to rename over a file another process has open for a moment (a virus scanner, the indexer). */
const TRANSIENT_RENAME_CODES = new Set(['EPERM', 'EBUSY', 'EACCES']);
const RENAME_ATTEMPTS = 6;
const RENAME_BACKOFF_MS = 25;

/**
 * `fs.rename`, retried a few times (25, 50, ... ms) on those transient errors, like graceful-fs does.
 * Without it a manifest or output file left behind by a scanner's brief lock is silently stale or
 * the finalization fails; any other error, or a lock that does not clear, is thrown as before.
 */
export async function renameWithRetry(from: string, to: string): Promise<void> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      await fs.promises.rename(from, to);
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code ?? '';
      if (attempt >= RENAME_ATTEMPTS || !TRANSIENT_RENAME_CODES.has(code)) throw error;
      await new Promise((resolve) => setTimeout(resolve, RENAME_BACKOFF_MS * attempt));
    }
  }
}

export const nodeSessionFs: SessionFs = {
  mkdir: (dir, options) => fs.promises.mkdir(dir, options),
  open: (file, flags) => fs.promises.open(file, flags) as unknown as Promise<SessionFileHandle>,
  writeFile: writeFileDurable,
  readFile: (file) => fs.promises.readFile(file, 'utf8'),
  readdir: (dir) => fs.promises.readdir(dir),
  rename: renameWithRetry,
  rm: (target, options) => fs.promises.rm(target, options),
  copyFile: (from, to, mode) => fs.promises.copyFile(from, to, mode),
  stat: (file) => fs.promises.stat(file),
  lstat: (file) => fs.promises.lstat(file),
  statfs: (dir) => fs.promises.statfs(dir),
};

/** Free bytes of the volume holding `dir`, or null when it cannot be determined. */
export async function freeBytes(api: SessionFs, dir: string): Promise<number | null> {
  try {
    const { bavail, bsize } = await api.statfs(dir);
    return Number(bavail) * Number(bsize);
  } catch {
    return null;
  }
}

export const MIN_FREE_TO_START = 1024 * 1024 * 1024;
export const MIN_FREE_WHILE_RECORDING = 500 * 1024 * 1024;
