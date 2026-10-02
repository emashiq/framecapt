import { randomBytes, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { MAX_CHUNK_BYTES, type RecordOptions } from '../../shared/recorder-ipc';
import { defaultRecordingFileName, withCollisionSuffix } from '../../shared/recording';
import { IpcError } from '../ipc-core';
import { isInsideDir } from '../shots/session-store';

/** The slice of node:fs/promises the service uses, so tests can inject failures. */
export interface SessionFileHandle {
  write(buffer: Uint8Array, offset: number, length: number): Promise<{ bytesWritten: number }>;
  sync(): Promise<void>;
  close(): Promise<void>;
}

export interface SessionFs {
  mkdir(dir: string, options: { recursive: true }): Promise<unknown>;
  open(file: string, flags: string): Promise<SessionFileHandle>;
  writeFile(file: string, data: string): Promise<void>;
  rename(from: string, to: string): Promise<void>;
  rm(target: string, options: { recursive?: boolean; force?: boolean }): Promise<void>;
  copyFile(from: string, to: string, mode?: number): Promise<void>;
  stat(file: string): Promise<{ size: number }>;
}

export const STREAM_FILE = 'stream.webm';
export const MANIFEST_FILE = 'manifest.json';
export const MANIFEST_EVERY_MS = 5000;
export const MANIFEST_EVERY_CHUNKS = 10;

export type SessionState = 'recording' | 'stopped' | 'completed' | 'failed';

export interface PausedInterval {
  /** Epoch ms. */
  from: number;
  to: number | null;
}

/** `manifest.json`: everything needed to understand (and later recover) a session directory. */
export interface SessionManifest {
  version: 1;
  sessionId: string;
  createdAt: number;
  state: SessionState;
  mime: string;
  source: { kind: 'screen' | 'window' | 'region'; name: string };
  options: RecordOptions;
  width: number;
  height: number;
  chunksWritten: number;
  bytesWritten: number;
  lastSeq: number;
  pausedIntervals: PausedInterval[];
  updatedAt: number;
  /** Set when the file may be shorter than the recording (write failure, engine lost). */
  truncated?: true;
  /** Why the session ended early, when it did. */
  endReason?: string;
  failureCode?: string;
  outputPath?: string;
}

export interface SessionConfig {
  mime: string;
  source: SessionManifest['source'];
  options: RecordOptions;
  width: number;
  height: number;
}

interface ActiveSession {
  manifest: SessionManifest;
  dir: string;
  file: SessionFileHandle | null;
  /** Length of the chunk written last (to recognise an idempotent retry). */
  lastLength: number;
  lastManifestAt: number;
  chunksSinceManifest: number;
  /** Serializes operations of one session. */
  tail: Promise<unknown>;
}

const ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export function isSessionId(value: string): boolean {
  return ID_PATTERN.test(value);
}

/** Maps a filesystem error to the code the renderer reacts to (it stops the recorder either way). */
export function writeErrorCode(error: unknown): 'DISK_FULL' | 'WRITE_FAILED' {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  return code === 'ENOSPC' || code === 'EDQUOT' ? 'DISK_FULL' : 'WRITE_FAILED';
}

function writeError(error: unknown, what: string): IpcError {
  const code = writeErrorCode(error);
  return new IpcError(
    code,
    code === 'DISK_FULL'
      ? 'The disk is full. The recording was stopped.'
      : `Could not write the recording (${what}).`,
  );
}

/**
 * Disk-backed recording sessions: `<root>/<sessionId>/{manifest.json, stream.webm}`. The renderer
 * sends sequenced chunks; every chunk is validated (session, size, sequence), appended with a
 * real write and acknowledged only after the write finished. The manifest is rewritten atomically
 * (temp file + rename) at most every 5 s or 10 chunks and at every state change.
 *
 * MediaRecorder WebM is one continuous stream, not independent clips: chunks are appended in
 * order and never reordered or concatenated blindly. Phase 06 remuxes the result with FFmpeg.
 */
export class SessionService {
  private readonly sessions = new Map<string, ActiveSession>();
  private readonly fsApi: SessionFs;
  private readonly now: () => number;

  constructor(
    readonly rootDir: string,
    options: { fs?: SessionFs; now?: () => number } = {},
  ) {
    this.fsApi = options.fs ?? (fs.promises as unknown as SessionFs);
    this.now = options.now ?? Date.now;
  }

  /** The session directory for an id, or null when the id is not a plain uuid. */
  dirFor(sessionId: string): string | null {
    if (!isSessionId(sessionId)) return null;
    const dir = path.join(this.rootDir, sessionId);
    return isInsideDir(this.rootDir, dir) && dir !== path.resolve(this.rootDir) ? dir : null;
  }

  has(sessionId: string): boolean {
    return this.sessions.has(sessionId);
  }

  manifestOf(sessionId: string): SessionManifest | undefined {
    const session = this.sessions.get(sessionId);
    return session ? structuredClone(session.manifest) : undefined;
  }

  streamPath(sessionId: string): string | undefined {
    const session = this.sessions.get(sessionId);
    return session ? path.join(session.dir, STREAM_FILE) : undefined;
  }

  async create(config: SessionConfig, sessionId: string = randomUUID()): Promise<string> {
    const dir = this.dirFor(sessionId);
    if (!dir) throw new IpcError('INVALID_PAYLOAD', 'Not a valid session id.');
    if (this.sessions.has(sessionId)) throw new IpcError('BUSY', 'That session already exists.');
    try {
      await this.fsApi.mkdir(dir, { recursive: true });
      const file = await this.fsApi.open(path.join(dir, STREAM_FILE), 'a');
      const now = this.now();
      const session: ActiveSession = {
        manifest: {
          version: 1,
          sessionId,
          createdAt: now,
          state: 'recording',
          mime: config.mime,
          source: config.source,
          options: config.options,
          width: config.width,
          height: config.height,
          chunksWritten: 0,
          bytesWritten: 0,
          lastSeq: -1,
          pausedIntervals: [],
          updatedAt: now,
        },
        dir,
        file,
        lastLength: 0,
        lastManifestAt: now,
        chunksSinceManifest: 0,
        tail: Promise.resolve(),
      };
      this.sessions.set(sessionId, session);
      await this.writeManifest(session);
    } catch (error) {
      this.sessions.delete(sessionId);
      await this.fsApi.rm(dir, { recursive: true, force: true }).catch(() => undefined);
      throw writeError(error, 'create');
    }
    return sessionId;
  }

  /** Runs `task` after the earlier operations of the same session (strictly one at a time). */
  private serial<T>(session: ActiveSession, task: () => Promise<T>): Promise<T> {
    const run = session.tail.then(task, task);
    session.tail = run.catch(() => undefined);
    return run;
  }

  private require(sessionId: string): ActiveSession {
    const session = this.sessions.get(sessionId);
    if (!session) throw new IpcError('NOT_FOUND', 'There is no such recording session.');
    return session;
  }

  /**
   * Appends chunk `seq`. The sequence must be exactly last + 1; the previous chunk sent again with
   * the same length is acknowledged without writing (an idempotent retry); anything else is an
   * error. The returned promise resolves only after the bytes were written.
   */
  async append(
    sessionId: string,
    seq: number,
    bytes: Uint8Array,
  ): Promise<{ duplicate: boolean; lastSeq: number }> {
    const session = this.require(sessionId);
    return this.serial(session, async () => {
      const { manifest } = session;
      if (manifest.state !== 'recording' || !session.file) {
        throw new IpcError('SESSION_INACTIVE', 'That recording is no longer accepting data.');
      }
      if (bytes.byteLength === 0) throw new IpcError('INVALID_PAYLOAD', 'Empty chunk.');
      if (bytes.byteLength > MAX_CHUNK_BYTES) {
        throw new IpcError('CHUNK_TOO_LARGE', 'That chunk is larger than the allowed maximum.');
      }
      if (seq === manifest.lastSeq && bytes.byteLength === session.lastLength) {
        return { duplicate: true, lastSeq: manifest.lastSeq };
      }
      if (seq > manifest.lastSeq + 1) {
        throw new IpcError('SEQ_GAP', `Expected chunk ${manifest.lastSeq + 1}, got ${seq}.`);
      }
      if (seq !== manifest.lastSeq + 1) {
        throw new IpcError('SEQ_CONFLICT', `Chunk ${seq} was already written.`);
      }

      try {
        let offset = 0;
        while (offset < bytes.byteLength) {
          const { bytesWritten } = await session.file.write(
            bytes,
            offset,
            bytes.byteLength - offset,
          );
          if (bytesWritten <= 0) throw new Error('A write made no progress.');
          offset += bytesWritten;
        }
      } catch (error) {
        await this.fail(session, writeErrorCode(error));
        throw writeError(error, 'chunk');
      }

      manifest.lastSeq = seq;
      manifest.chunksWritten += 1;
      manifest.bytesWritten += bytes.byteLength;
      session.lastLength = bytes.byteLength;
      session.chunksSinceManifest += 1;
      if (
        session.chunksSinceManifest >= MANIFEST_EVERY_CHUNKS ||
        this.now() - session.lastManifestAt >= MANIFEST_EVERY_MS
      ) {
        // A failed manifest update must not lose the chunk that was just written; the next
        // update (or the final one) retries.
        await this.writeManifest(session).catch(() => undefined);
      }
      return { duplicate: false, lastSeq: seq };
    });
  }

  /** The session can take no more data: close the file and say why in the manifest. */
  private async fail(session: ActiveSession, code: string): Promise<void> {
    const { manifest } = session;
    manifest.state = 'failed';
    manifest.failureCode = code;
    manifest.truncated = true;
    const file = session.file;
    session.file = null;
    await file?.close().catch(() => undefined);
    await this.writeManifest(session).catch(() => undefined);
  }

  /**
   * The renderer finished: `lastSeq` must equal the last chunk main wrote (a mismatch means data
   * went missing). Flushes the file to disk, closes it and marks the session stopped. Idempotent.
   */
  async finish(sessionId: string, lastSeq: number): Promise<{ chunks: number; bytes: number }> {
    const session = this.require(sessionId);
    return this.serial(session, async () => {
      const { manifest } = session;
      if (manifest.state === 'recording' && manifest.lastSeq !== lastSeq) {
        throw new IpcError(
          'SEQ_GAP',
          `The recorder reports ${lastSeq + 1} chunks but ${manifest.lastSeq + 1} were written.`,
        );
      }
      if (manifest.state === 'recording') await this.closeStopped(session);
      else if (manifest.lastSeq !== lastSeq && manifest.state !== 'failed') {
        throw new IpcError('SEQ_GAP', 'The session already ended with a different length.');
      }
      return { chunks: manifest.chunksWritten, bytes: manifest.bytesWritten };
    });
  }

  /** Main-side stop (the recorder is gone or failed): keep what was written. Idempotent. */
  async markStopped(
    sessionId: string,
    options: { truncated?: boolean; reason?: string } = {},
  ): Promise<void> {
    const session = this.require(sessionId);
    return this.serial(session, async () => {
      if (session.manifest.state !== 'recording') return;
      if (options.truncated) session.manifest.truncated = true;
      if (options.reason) session.manifest.endReason = options.reason;
      await this.closeStopped(session);
    });
  }

  private async closeStopped(session: ActiveSession): Promise<void> {
    const file = session.file;
    session.file = null;
    try {
      await file?.sync();
      await file?.close();
    } catch (error) {
      await file?.close().catch(() => undefined);
      session.manifest.state = 'failed';
      session.manifest.failureCode = writeErrorCode(error);
      await this.writeManifest(session).catch(() => undefined);
      throw writeError(error, 'flush');
    }
    session.manifest.state = 'stopped';
    await this.writeManifest(session).catch((error: unknown) => {
      throw writeError(error, 'manifest');
    });
  }

  /** Records a pause or resume (wall clock) in the manifest. Best effort. */
  async recordPause(sessionId: string, paused: boolean): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    await this.serial(session, async () => {
      const intervals = session.manifest.pausedIntervals;
      const open = intervals[intervals.length - 1];
      if (paused && (!open || open.to !== null)) intervals.push({ from: this.now(), to: null });
      else if (!paused && open && open.to === null) open.to = this.now();
      await this.writeManifest(session).catch(() => undefined);
    });
  }

  /**
   * Publishes the finished stream: copies `stream.webm` to `<outputDir>/Framelet YYYY-MM-DD at
   * HH.mm.ss.webm` (a number is added if the name exists) through a temp file and a rename, so the
   * final name never holds a half-written file. The session directory is kept (phase 06 decides
   * about cleanup). Un-remuxed MediaRecorder WebM has no duration or seek cues until phase 06.
   */
  async publish(
    sessionId: string,
    outputDir: string,
    date: Date = new Date(),
  ): Promise<{ outputPath: string; bytes: number }> {
    const session = this.require(sessionId);
    return this.serial(session, async () => {
      const { manifest } = session;
      if (manifest.state === 'completed' && manifest.outputPath) {
        return { outputPath: manifest.outputPath, bytes: manifest.bytesWritten };
      }
      if (manifest.state !== 'stopped' && manifest.state !== 'failed') {
        throw new IpcError('SESSION_INACTIVE', 'The recording has not been stopped.');
      }
      if (manifest.bytesWritten === 0) {
        throw new IpcError(
          'NOT_FOUND',
          'The recording was too short to save: nothing was captured.',
        );
      }
      const source = path.join(session.dir, STREAM_FILE);
      const baseName = defaultRecordingFileName(date);
      let target = '';
      try {
        await this.fsApi.mkdir(outputDir, { recursive: true });
        for (let attempt = 0; attempt < 1000; attempt += 1) {
          const candidate = path.join(outputDir, withCollisionSuffix(baseName, attempt));
          const exists = await this.fsApi.stat(candidate).then(
            () => true,
            () => false,
          );
          if (!exists) {
            target = candidate;
            break;
          }
        }
        if (!target) throw new Error('No free output name.');
        const temp = path.join(
          outputDir,
          `.${path.basename(target)}.${randomBytes(4).toString('hex')}.tmp`,
        );
        try {
          await this.fsApi.copyFile(source, temp, fs.constants.COPYFILE_EXCL);
          await this.fsApi.rename(temp, target);
        } catch (error) {
          await this.fsApi.rm(temp, { force: true }).catch(() => undefined);
          throw error;
        }
      } catch (error) {
        throw writeError(error, 'publish');
      }
      manifest.state = 'completed';
      manifest.outputPath = target;
      await this.writeManifest(session).catch(() => undefined);
      return { outputPath: target, bytes: manifest.bytesWritten };
    });
  }

  /** Closes every file that is still open (the app is quitting; sessions stay on disk). */
  async closeAll(): Promise<void> {
    await Promise.all(
      [...this.sessions.values()].map(async (session) => {
        const file = session.file;
        session.file = null;
        await file?.close().catch(() => undefined);
      }),
    );
  }

  /** Cancels a session that has no recording worth keeping: closes the file, deletes the directory. */
  async abort(sessionId: string): Promise<void> {
    const session = this.sessions.get(sessionId);
    const dir = this.dirFor(sessionId);
    if (!session || !dir) return;
    await this.serial(session, async () => {
      this.sessions.delete(sessionId);
      const file = session.file;
      session.file = null;
      await file?.close().catch(() => undefined);
      // Only app-owned session directories (an id under the root) are ever deleted.
      await this.fsApi.rm(dir, { recursive: true, force: true }).catch(() => undefined);
    });
  }

  private async writeManifest(session: ActiveSession): Promise<void> {
    session.manifest.updatedAt = this.now();
    session.lastManifestAt = session.manifest.updatedAt;
    session.chunksSinceManifest = 0;
    const target = path.join(session.dir, MANIFEST_FILE);
    const temp = `${target}.tmp`;
    await this.fsApi.writeFile(temp, `${JSON.stringify(session.manifest, null, 2)}\n`);
    await this.fsApi.rename(temp, target);
  }
}
