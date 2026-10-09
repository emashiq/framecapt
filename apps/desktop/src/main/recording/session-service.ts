import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';
import { MAX_CHUNK_BYTES, type RecordOptions } from '../../shared/recorder-ipc';
import { defaultRecordingFileName } from '../../shared/recording';
import type { RecordingLayout } from '../../shared/recording-layout';
import { IpcError } from '../ipc-core';
import { log } from '../logger';
import type { FfmpegProgress, MediaTools } from '../media/ffmpeg';
import { isInsideDir } from '../shots/session-store';
import {
  completeSessionOnDisk,
  copyRawAsOutput,
  remuxToFcap,
  remuxToOutput,
  writeFinalizeLog,
  type RemuxRequest,
} from './finalize';
import {
  freshStats,
  isSessionId,
  MANIFEST_FILE,
  partialNameFor,
  STREAM_FILE,
  type PausedInterval,
  type SessionManifest,
  type SessionState,
} from './manifest';
import {
  freeBytes,
  MIN_FREE_TO_START,
  MIN_FREE_WHILE_RECORDING,
  nodeSessionFs,
  type SessionFileHandle,
  type SessionFs,
} from './session-fs';

export type { PausedInterval, SessionFileHandle, SessionFs, SessionManifest, SessionState };
export { isSessionId, MANIFEST_FILE, STREAM_FILE };

export const MANIFEST_EVERY_MS = 5000;
export const MANIFEST_EVERY_CHUNKS = 10;
export const DISK_CHECK_EVERY_MS = 30_000;

export interface SessionConfig {
  mime: string;
  source: SessionManifest['source'];
  /** Multi-source recordings: where each source sits in the picture (the output is a `.fcap`). */
  layout?: RecordingLayout;
  options: RecordOptions;
  width: number;
  height: number;
}

interface ActiveSession {
  manifest: SessionManifest;
  dir: string;
  file: SessionFileHandle | null;
  /** The recorder window that created the session: the only one allowed to send data for it. */
  owner: number;
  /** Length and SHA-1 of the chunk written last (to recognise an idempotent retry). */
  lastLength: number;
  lastSha1: string;
  lastManifestAt: number;
  chunksSinceManifest: number;
  /** Serializes operations of one session. */
  tail: Promise<unknown>;
  /** Operations queued or running in main. */
  queued: number;
  /** Cached outcome so a second finalize returns the same result. */
  finalized: FinalizeResult | null;
}

export interface FinalizeResult {
  outputPath: string;
  bytes: number;
  /** Container duration of the finished file; null for an unindexed raw copy. */
  durationMs: number | null;
  /** The output is a raw copy without a duration or seek index (the remux failed). */
  unindexed: boolean;
}

export interface FinalizeRequest {
  outputDir: string;
  tools: MediaTools;
  signal?: AbortSignal;
  date?: Date;
  onProgress?: (progress: FfmpegProgress) => void;
}

export interface SessionServiceOptions {
  fs?: SessionFs;
  now?: () => number;
  appVersion?: string;
  /** Called (once per session) when free space drops below the running minimum. */
  onDiskLow?: (sessionId: string, freeBytes: number) => void;
  /** Disk polling period while sessions are recording; 0 disables the timer (tests call checkDisk). */
  diskCheckEveryMs?: number;
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

const ACCEPTING: readonly SessionState[] = ['recording', 'stopping'];

/**
 * Disk-backed recording sessions: `<root>/<sessionId>/{manifest.json, stream.webm}`. The renderer
 * sends sequenced chunks; every chunk is validated (owner, session, size, sequence), appended with
 * a real write and acknowledged only after the write finished. The manifest is rewritten
 * atomically (temp file, fsync, rename) at most every 5 s or 10 chunks and at every state change.
 *
 * MediaRecorder WebM is one continuous stream, not independent clips: chunks are appended in
 * order and never reordered or concatenated blindly. Finalization remuxes the stream with FFmpeg
 * (`-c copy`) into the output folder and then removes the session. See
 * docs/recording-persistence.md.
 */
export class SessionService {
  private readonly sessions = new Map<string, ActiveSession>();
  private readonly fsApi: SessionFs;
  private readonly now: () => number;
  private readonly appVersion: string;
  private readonly onDiskLow: ((sessionId: string, free: number) => void) | undefined;
  private readonly diskCheckEveryMs: number;
  private diskTimer: NodeJS.Timeout | undefined;

  constructor(
    readonly rootDir: string,
    options: SessionServiceOptions = {},
  ) {
    this.fsApi = options.fs ?? nodeSessionFs;
    this.now = options.now ?? Date.now;
    this.appVersion = options.appVersion ?? '0.0.0';
    this.onDiskLow = options.onDiskLow;
    this.diskCheckEveryMs = options.diskCheckEveryMs ?? DISK_CHECK_EVERY_MS;
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

  /** Ids of sessions that main is writing right now (recovery must not touch them). */
  activeIds(): string[] {
    return [...this.sessions.entries()]
      .filter(([, session]) => session.manifest.state !== 'completed')
      .map(([id]) => id);
  }

  manifestOf(sessionId: string): SessionManifest | undefined {
    const session = this.sessions.get(sessionId);
    return session ? structuredClone(session.manifest) : undefined;
  }

  streamPath(sessionId: string): string | undefined {
    const session = this.sessions.get(sessionId);
    return session ? path.join(session.dir, STREAM_FILE) : undefined;
  }

  /** Free bytes of the volume that holds the sessions, or null when unknown. */
  async freeBytes(): Promise<number | null> {
    await this.fsApi.mkdir(this.rootDir, { recursive: true }).catch(() => undefined);
    return freeBytes(this.fsApi, this.rootDir);
  }

  /**
   * A recording must not start with less than 1 GB free; with other recordings running (they keep
   * writing) the headroom grows with each: `running` is how many there are.
   */
  async ensureSpaceToStart(running = 0): Promise<void> {
    const free = await this.freeBytes();
    if (free !== null && free < MIN_FREE_TO_START * (running + 1)) {
      throw new IpcError(
        'LOW_DISK',
        running === 0
          ? 'There is not enough free disk space to record (FrameCapt needs at least 1 GB).'
          : `There is not enough free disk space to record another video (FrameCapt needs at least ${running + 1} GB with ${running} already recording).`,
      );
    }
  }

  async create(
    config: SessionConfig,
    sessionId: string = randomUUID(),
    owner = -1,
  ): Promise<string> {
    const dir = this.dirFor(sessionId);
    if (!dir) throw new IpcError('INVALID_PAYLOAD', 'Not a valid session id.');
    if (this.sessions.has(sessionId)) throw new IpcError('BUSY', 'That session already exists.');
    await this.ensureSpaceToStart();
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
          ...(config.layout && { layout: config.layout }),
          options: config.options,
          width: config.width,
          height: config.height,
          chunksWritten: 0,
          bytesWritten: 0,
          lastSeq: -1,
          pausedIntervals: [],
          stats: freshStats(),
          appVersion: this.appVersion,
          updatedAt: now,
        },
        dir,
        file,
        owner,
        lastLength: 0,
        lastSha1: '',
        lastManifestAt: now,
        chunksSinceManifest: 0,
        tail: Promise.resolve(),
        queued: 0,
        finalized: null,
      };
      this.sessions.set(sessionId, session);
      await this.writeManifest(session);
      this.startDiskWatch();
    } catch (error) {
      this.sessions.delete(sessionId);
      await this.fsApi.rm(dir, { recursive: true, force: true }).catch(() => undefined);
      throw writeError(error, 'create');
    }
    return sessionId;
  }

  /** Runs `task` after the earlier operations of the same session (strictly one at a time). */
  private serial<T>(session: ActiveSession, task: () => Promise<T>): Promise<T> {
    session.queued += 1;
    const stats = session.manifest.stats;
    stats.mainQueueHighWater = Math.max(stats.mainQueueHighWater, session.queued);
    const run = session.tail.then(task, task);
    session.tail = run.then(
      () => undefined,
      () => undefined,
    );
    void session.tail.then(() => {
      session.queued -= 1;
    });
    return run;
  }

  private require(sessionId: string, owner?: number): ActiveSession {
    const session = this.sessions.get(sessionId);
    if (!session) throw new IpcError('NOT_FOUND', 'There is no such recording session.');
    if (owner !== undefined && session.owner !== owner) {
      log.warn(`Session ${sessionId.slice(0, 8)}: rejected a request from another window`);
      throw new IpcError('FORBIDDEN', 'That recording belongs to another window.');
    }
    return session;
  }

  private reject(session: ActiveSession, seq: number, code: IpcError['code'], text: string): never {
    log.warn(`Session ${session.manifest.sessionId.slice(0, 8)}: chunk ${seq} rejected (${code})`);
    throw new IpcError(code, text);
  }

  /**
   * Appends chunk `seq`. The sequence must be exactly last + 1; the previous chunk sent again with
   * identical length and SHA-1 is acknowledged without writing (an idempotent retry); any other
   * duplicate is `DUPLICATE_MISMATCH`, a jump is `SEQ_GAP`. The returned promise resolves only
   * after the bytes were written.
   */
  async append(
    sessionId: string,
    seq: number,
    bytes: Uint8Array,
    owner?: number,
    queued?: { chunks: number; bytes: number },
  ): Promise<{ duplicate: boolean; lastSeq: number }> {
    const session = this.require(sessionId, owner);
    if (queued) {
      const stats = session.manifest.stats;
      stats.queueHighWaterChunks = Math.max(stats.queueHighWaterChunks, queued.chunks);
      stats.queueHighWaterBytes = Math.max(stats.queueHighWaterBytes, queued.bytes);
    }
    return this.serial(session, async () => {
      const { manifest } = session;
      if (!ACCEPTING.includes(manifest.state) || !session.file) {
        return this.reject(
          session,
          seq,
          'SESSION_INACTIVE',
          'That recording is no longer accepting data.',
        );
      }
      if (!(bytes instanceof Uint8Array)) {
        return this.reject(session, seq, 'INVALID_PAYLOAD', 'Chunk data must be binary.');
      }
      if (bytes.byteLength === 0)
        return this.reject(session, seq, 'INVALID_PAYLOAD', 'Empty chunk.');
      if (bytes.byteLength > MAX_CHUNK_BYTES) {
        return this.reject(
          session,
          seq,
          'CHUNK_TOO_LARGE',
          'That chunk is larger than the allowed maximum.',
        );
      }
      const sha1 = createHash('sha1').update(bytes).digest('hex');
      if (seq === manifest.lastSeq) {
        if (bytes.byteLength === session.lastLength && sha1 === session.lastSha1) {
          return { duplicate: true, lastSeq: manifest.lastSeq };
        }
        return this.reject(
          session,
          seq,
          'DUPLICATE_MISMATCH',
          `Chunk ${seq} was already written with different data.`,
        );
      }
      if (seq < manifest.lastSeq) {
        return this.reject(session, seq, 'DUPLICATE_MISMATCH', `Chunk ${seq} was already written.`);
      }
      if (seq > manifest.lastSeq + 1) {
        return this.reject(
          session,
          seq,
          'SEQ_GAP',
          `Expected chunk ${manifest.lastSeq + 1}, got ${seq}.`,
        );
      }

      const started = performance.now();
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
        const code = writeErrorCode(error);
        log.error(`Session ${sessionId.slice(0, 8)}: write failed (${code})`);
        await this.fail(session, code, writeError(error, 'chunk').message);
        throw writeError(error, 'chunk');
      }
      manifest.stats.maxWriteMs = Math.max(manifest.stats.maxWriteMs, performance.now() - started);

      manifest.lastSeq = seq;
      manifest.chunksWritten += 1;
      manifest.bytesWritten += bytes.byteLength;
      session.lastLength = bytes.byteLength;
      session.lastSha1 = sha1;
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
  private async fail(session: ActiveSession, code: string, message: string): Promise<void> {
    const { manifest } = session;
    manifest.state = 'failed';
    manifest.error = { code, message };
    manifest.truncated = true;
    const file = session.file;
    session.file = null;
    await file?.close().catch(() => undefined);
    await this.writeManifest(session).catch(() => undefined);
  }

  /** The stop was requested: the last chunks may still arrive. Idempotent. */
  async markStopping(sessionId: string): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    await this.serial(session, async () => {
      if (session.manifest.state !== 'recording') return;
      session.manifest.state = 'stopping';
      await this.writeManifest(session).catch(() => undefined);
    });
  }

  /**
   * The renderer finished: `lastSeq` must equal the last chunk main wrote (a mismatch means data
   * went missing). Flushes the file to disk, closes it and marks the session stopped. Idempotent.
   */
  async finish(
    sessionId: string,
    lastSeq: number,
    owner?: number,
  ): Promise<{ chunks: number; bytes: number }> {
    const session = this.require(sessionId, owner);
    return this.serial(session, async () => {
      const { manifest } = session;
      const accepting = ACCEPTING.includes(manifest.state);
      if (accepting && manifest.lastSeq !== lastSeq) {
        throw new IpcError(
          'SEQ_GAP',
          `The recorder reports ${lastSeq + 1} chunks but ${manifest.lastSeq + 1} were written.`,
        );
      }
      if (accepting) await this.closeStopped(session);
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
      if (!ACCEPTING.includes(session.manifest.state)) return;
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
      session.manifest.error = {
        code: writeErrorCode(error),
        message: 'Flushing the recording failed.',
      };
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

  // --- finalization ------------------------------------------------------------------------

  /**
   * Publishes the finished stream: ffmpeg remux (`-c copy`, adds Duration and Cues) into a
   * partial file in `outputDir`, probe, atomic rename to a free `FrameCapt YYYY-MM-DD at
   * HH.mm.ss.webm`, then the session (including `stream.webm`) is deleted. On a failed remux the
   * stream is kept (manifest `failed`) and, when it shows a video stream, copied raw as a last
   * resort (`unindexed`). Idempotent. An aborted run leaves the manifest `finalizing` so the next
   * start can clean the partial file and run it again.
   */
  async finalize(sessionId: string, request: FinalizeRequest): Promise<FinalizeResult> {
    const session = this.require(sessionId);
    return this.serial(session, async () => {
      const { manifest } = session;
      if (session.finalized) return session.finalized;
      if (!['stopped', 'failed', 'finalizing'].includes(manifest.state)) {
        throw new IpcError('SESSION_INACTIVE', 'The recording has not been stopped.');
      }
      if (manifest.bytesWritten === 0) {
        await this.discardEmpty(session);
        throw new IpcError(
          'NOT_FOUND',
          'The recording was too short to save: nothing was captured.',
        );
      }

      const date = request.date ?? new Date();
      const fileName = defaultRecordingFileName(date, manifest.layout ? 'fcap' : 'webm');
      const partialPath = path.join(request.outputDir, partialNameFor(manifest));
      manifest.state = 'finalizing';
      manifest.finalize = {
        outputDir: request.outputDir,
        fileName,
        partialPath,
        startedAt: this.now(),
      };
      await this.writeManifest(session).catch(() => undefined);

      const remux: RemuxRequest = {
        fs: this.fsApi,
        tools: request.tools,
        streamPath: path.join(session.dir, STREAM_FILE),
        streamBytes: manifest.bytesWritten,
        outputDir: request.outputDir,
        fileName,
        partialPath,
        ...(request.signal && { signal: request.signal }),
        ...(request.onProgress && { onProgress: request.onProgress }),
      };
      const outcome = manifest.layout
        ? await remuxToFcap(remux, manifest.layout, manifest.createdAt)
        : await remuxToOutput(remux);

      if (outcome.ok) {
        const durationMs = Math.round((outcome.probe.durationSec ?? 0) * 1000);
        await completeSessionOnDisk(
          this.fsApi,
          this.rootDir,
          session.dir,
          manifest,
          {
            outputPath: outcome.outputPath,
            bytes: outcome.bytes,
            durationMs,
            recovered: false,
            unindexed: false,
            now: this.now(),
          },
          (value) => this.writeManifestOf(session.dir, value),
        );
        session.finalized = {
          outputPath: outcome.outputPath,
          bytes: outcome.bytes,
          durationMs,
          unindexed: false,
        };
        return session.finalized;
      }

      if (outcome.code === 'ABORTED') {
        // manifest stays 'finalizing': the next start cleans the partial file and retries
        throw new IpcError('FINALIZE_FAILED', 'Finishing the recording was interrupted.');
      }

      log.error(`Session ${sessionId.slice(0, 8)}: remux failed (${outcome.code})`);
      manifest.state = 'failed';
      manifest.error = { code: outcome.code, message: outcome.message };
      await writeFinalizeLog(this.fsApi, session.dir, outcome.stderrTail);
      if (outcome.code === 'FFMPEG_MISSING' || outcome.code === 'LOW_DISK') {
        await this.writeManifest(session).catch(() => undefined);
        throw new IpcError(
          outcome.code === 'LOW_DISK' ? 'LOW_DISK' : 'FFMPEG_MISSING',
          `${outcome.message} The recorded data was kept and can be recovered on the next start.`,
        );
      }

      // A multi-source recording has no use for a raw copy (it needs its `.fcap` header): its data stays.
      const raw = manifest.layout ? { ok: false as const } : await copyRawAsOutput(remux);
      if (raw.ok) {
        manifest.outputPath = raw.outputPath;
        manifest.unindexed = true;
        await this.writeManifest(session).catch(() => undefined);
        session.finalized = {
          outputPath: raw.outputPath,
          bytes: raw.bytes,
          durationMs: null,
          unindexed: true,
        };
        return session.finalized;
      }
      await this.writeManifest(session).catch(() => undefined);
      throw new IpcError(
        'FINALIZE_FAILED',
        'The recording could not be finished. The recorded data was kept; you can try to recover it the next time FrameCapt starts.',
      );
    });
  }

  /** A session with no data: nothing to keep. Only this session's own directory goes. */
  private async discardEmpty(session: ActiveSession): Promise<void> {
    this.sessions.delete(session.manifest.sessionId);
    await this.fsApi.rm(session.dir, { recursive: true, force: true }).catch(() => undefined);
  }

  // --- disk pressure -----------------------------------------------------------------------

  private startDiskWatch(): void {
    if (this.diskTimer || this.diskCheckEveryMs <= 0) return;
    this.diskTimer = setInterval(() => void this.checkDisk(), this.diskCheckEveryMs);
    this.diskTimer.unref();
  }

  private stopDiskWatchIfIdle(): void {
    const recording = [...this.sessions.values()].some((session) =>
      ACCEPTING.includes(session.manifest.state),
    );
    if (!recording && this.diskTimer) {
      clearInterval(this.diskTimer);
      this.diskTimer = undefined;
    }
  }

  /**
   * Compares the free space with the 500 MB minimum for every session still recording and
   * reports each affected session once through `onDiskLow`. Returns the free bytes (null: unknown).
   */
  async checkDisk(): Promise<number | null> {
    const free = await freeBytes(this.fsApi, this.rootDir);
    this.stopDiskWatchIfIdle();
    if (free === null || free >= MIN_FREE_WHILE_RECORDING) return free;
    for (const session of this.sessions.values()) {
      const { manifest } = session;
      if (manifest.state !== 'recording' || manifest.error?.code === 'DISK_LOW') continue;
      manifest.error = {
        code: 'DISK_LOW',
        message: 'Your disk is almost full, so the recording was stopped to keep what was saved.',
      };
      log.warn(`Session ${manifest.sessionId.slice(0, 8)}: free space below 500 MB`);
      this.onDiskLow?.(manifest.sessionId, free);
    }
    return free;
  }

  // --- teardown ----------------------------------------------------------------------------

  /** Closes every file that is still open (the app is quitting; sessions stay on disk). */
  async closeAll(): Promise<void> {
    if (this.diskTimer) clearInterval(this.diskTimer);
    this.diskTimer = undefined;
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
    await this.writeManifestOf(session.dir, session.manifest);
  }

  /** temp file + fsync + rename: a reader sees the old or the new manifest, never half of one. */
  private async writeManifestOf(dir: string, manifest: SessionManifest): Promise<void> {
    const target = path.join(dir, MANIFEST_FILE);
    const temp = `${target}.tmp`;
    await this.fsApi.writeFile(temp, `${JSON.stringify(manifest, null, 2)}\n`);
    await this.fsApi.rename(temp, target);
  }
}
