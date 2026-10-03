import path from 'node:path';
import { DEFAULT_RECORD_OPTIONS } from '../../shared/recorder-ipc';
import { defaultRecordingFileName } from '../../shared/recording';
import type { RecoveryCandidate } from '../../shared/recovery-ipc';
import { IpcError } from '../ipc-core';
import { log } from '../logger';
import type { MediaTools } from '../media/ffmpeg';
import { isInsideDir } from '../shots/session-store';
import { completeSessionOnDisk, remuxToOutput, writeFinalizeLog } from './finalize';
import {
  COMPLETED_DIR,
  CORRUPT_MANIFEST_FILE,
  freshStats,
  isSessionId,
  MANIFEST_FILE,
  parseManifest,
  partialFileName,
  STREAM_FILE,
  type SessionManifest,
} from './manifest';
import type { SessionFs } from './session-fs';
import type { HistorySink } from '../history/service';

export interface RecoveryDeps {
  rootDir: string;
  fs: SessionFs;
  tools: MediaTools;
  /** Where finished recordings go (`Videos/FrameCapt`). */
  outputDir: () => string;
  /** Sessions main is writing right now: never touched. */
  isActive: (sessionId: string) => boolean;
  now?: () => number;
  appVersion?: string;
  /** Recovered and resumed recordings are added here (a failure never fails the recovery). */
  history?: HistorySink;
}

export type RecoverOutcome =
  | {
      outcome: 'recovered';
      outputPath: string;
      fileName: string;
      durationMs: number;
      bytes: number;
    }
  | { outcome: 'unrecoverable'; keptAt: string };

export interface StartupReport {
  scanned: number;
  candidates: number;
  resumed: number;
  cleaned: number;
}

interface Inspected {
  dir: string;
  manifest: SessionManifest;
  streamBytes: number;
  /** The manifest could not be read and was replaced by a minimal one. */
  adopted: boolean;
}

/**
 * Finds, repairs and discards sessions an earlier run left behind. Everything it deletes is a
 * directory whose name is a session uuid inside `<userData>/recordings` and whose manifest names
 * the same id, or the one temporary remux file the manifest of an interrupted finalization names
 * and whose file name carries that id. Nothing else is ever deleted, and never a user export.
 */
export class RecoveryService {
  private readonly busy = new Set<string>();
  /** Scans repair unreadable manifests: one at a time, so two scans never repair the same one twice. */
  private scanLock: Promise<unknown> = Promise.resolve();
  private readonly now: () => number;

  constructor(private readonly deps: RecoveryDeps) {
    this.now = deps.now ?? Date.now;
  }

  private dirFor(sessionId: string): string | null {
    if (!isSessionId(sessionId)) return null;
    const dir = path.join(this.deps.rootDir, sessionId);
    return isInsideDir(this.deps.rootDir, dir) && dir !== path.resolve(this.deps.rootDir)
      ? dir
      : null;
  }

  /** Reads the manifest of a session directory; null when missing or invalid. */
  private async readManifest(dir: string): Promise<SessionManifest | null> {
    try {
      const parsed = parseManifest(await this.deps.fs.readFile(path.join(dir, MANIFEST_FILE)));
      return parsed.ok ? parsed.manifest : null;
    } catch {
      return null;
    }
  }

  private async writeManifest(dir: string, manifest: SessionManifest): Promise<void> {
    manifest.updatedAt = this.now();
    const target = path.join(dir, MANIFEST_FILE);
    await this.deps.fs.writeFile(`${target}.tmp`, `${JSON.stringify(manifest, null, 2)}\n`);
    await this.deps.fs.rename(`${target}.tmp`, target);
  }

  private async streamBytes(dir: string): Promise<number> {
    return this.deps.fs.stat(path.join(dir, STREAM_FILE)).then(
      (stat) => stat.size,
      () => 0,
    );
  }

  /**
   * A corrupt or missing manifest: keep the evidence (`manifest.corrupt.json`) and write a minimal
   * valid one so the session is handled like any other. The directory name is the only identity.
   */
  private async adopt(dir: string, sessionId: string, bytes: number): Promise<SessionManifest> {
    const stat = await this.deps.fs.stat(dir).catch(() => ({ mtimeMs: this.now() }));
    await this.deps.fs
      .rename(path.join(dir, MANIFEST_FILE), path.join(dir, CORRUPT_MANIFEST_FILE))
      .catch(() => undefined);
    const now = this.now();
    const manifest: SessionManifest = {
      version: 1,
      sessionId,
      createdAt: Math.round(stat.mtimeMs),
      updatedAt: now,
      state: 'failed',
      mime: 'video/webm',
      source: { kind: 'screen', name: 'unknown' },
      options: DEFAULT_RECORD_OPTIONS,
      width: 0,
      height: 0,
      chunksWritten: 0,
      bytesWritten: bytes,
      lastSeq: -1,
      pausedIntervals: [],
      stats: freshStats(),
      appVersion: this.deps.appVersion ?? '0.0.0',
      truncated: true,
      error: { code: 'MANIFEST_CORRUPT', message: 'The session record was unreadable.' },
    };
    await this.writeManifest(dir, manifest).catch(() => undefined);
    return manifest;
  }

  private inspect(sessionId: string): Promise<Inspected | null> {
    const run = this.scanLock.then(
      () => this.inspectNow(sessionId),
      () => this.inspectNow(sessionId),
    );
    this.scanLock = run.catch(() => undefined);
    return run;
  }

  private async inspectNow(sessionId: string): Promise<Inspected | null> {
    const dir = this.dirFor(sessionId);
    if (!dir) return null;
    if (!(await this.isRealDirectory(dir))) return null;
    const bytes = await this.streamBytes(dir);
    const manifest = await this.readManifest(dir);
    if (manifest && manifest.sessionId === sessionId) {
      return { dir, manifest, streamBytes: bytes, adopted: false };
    }
    return {
      dir,
      manifest: await this.adopt(dir, sessionId, bytes),
      streamBytes: bytes,
      adopted: true,
    };
  }

  /**
   * A directory that is itself a directory: a symbolic link or junction with a session's name is
   * never looked into, repaired or deleted (it could point anywhere), only a real folder is.
   */
  private async isRealDirectory(dir: string): Promise<boolean> {
    return this.deps.fs.lstat(dir).then(
      (stat) => stat.isDirectory() && !stat.isSymbolicLink(),
      () => false,
    );
  }

  private async sessionIds(): Promise<string[]> {
    const names = await this.deps.fs.readdir(this.deps.rootDir).catch(() => [] as string[]);
    return names.filter((name) => name !== COMPLETED_DIR && isSessionId(name));
  }

  private toCandidate(item: Inspected): RecoveryCandidate {
    const { manifest } = item;
    const unknown = item.adopted || manifest.error?.code === 'MANIFEST_CORRUPT';
    const state = unknown
      ? 'unknown'
      : manifest.state === 'recording' ||
          manifest.state === 'stopping' ||
          manifest.state === 'stopped' ||
          manifest.state === 'finalizing'
        ? manifest.state
        : 'failed';
    return {
      sessionId: manifest.sessionId,
      createdAt: manifest.createdAt,
      bytes: item.streamBytes,
      sourceKind: unknown ? 'unknown' : manifest.source.kind,
      chunks: manifest.chunksWritten,
      state,
      errorCode: manifest.error?.code ?? null,
    };
  }

  /** Whether the output of a finished session is really there (so its leftovers may go). */
  private async outputExists(manifest: SessionManifest): Promise<boolean> {
    if (!manifest.outputPath) return false;
    return this.deps.fs.stat(manifest.outputPath).then(
      (stat) => stat.size > 0,
      () => false,
    );
  }

  // --- the scan ----------------------------------------------------------------------------

  /**
   * Startup housekeeping: re-runs interrupted finalizations (one attempt each), removes leftovers
   * of finished/discarded sessions and counts what is left for the user to decide.
   */
  async startup(): Promise<StartupReport> {
    const report: StartupReport = { scanned: 0, candidates: 0, resumed: 0, cleaned: 0 };
    for (const sessionId of await this.sessionIds()) {
      if (this.deps.isActive(sessionId) || this.busy.has(sessionId)) continue;
      const item = await this.inspect(sessionId);
      if (!item) continue;
      report.scanned += 1;
      const { manifest } = item;
      try {
        if (manifest.state === 'finalizing') {
          report.resumed += 1;
          this.busy.add(sessionId); // not offered to the user while it is being finished
          try {
            await this.resumeFinalization(item);
          } finally {
            this.busy.delete(sessionId);
          }
        } else if (manifest.state === 'discarded') {
          await this.deps.fs.rm(item.dir, { recursive: true, force: true });
          report.cleaned += 1;
        } else if (
          (manifest.state === 'completed' || manifest.state === 'recovered') &&
          (await this.outputExists(manifest))
        ) {
          await this.deps.fs.rm(item.dir, { recursive: true, force: true });
          report.cleaned += 1;
        }
      } catch (error) {
        log.error(`Recovery: could not handle session ${sessionId.slice(0, 8)}`, error);
      }
    }
    report.candidates = (await this.list()).length;
    log.info(
      `Recovery scan: ${report.scanned} session(s), ${report.resumed} finalization(s) resumed, ` +
        `${report.cleaned} cleaned, ${report.candidates} recoverable`,
    );
    return report;
  }

  /** Unfinished recordings with data, oldest first. */
  async list(): Promise<RecoveryCandidate[]> {
    const candidates: RecoveryCandidate[] = [];
    for (const sessionId of await this.sessionIds()) {
      if (this.deps.isActive(sessionId) || this.busy.has(sessionId)) continue;
      const item = await this.inspect(sessionId);
      if (!item || item.streamBytes === 0) continue;
      const { state } = item.manifest;
      if (state === 'completed' || state === 'recovered' || state === 'discarded') continue;
      candidates.push(this.toCandidate(item));
    }
    return candidates.sort((a, b) => a.createdAt - b.createdAt);
  }

  // --- finalization (resumed) and recovery -------------------------------------------------

  /**
   * A finalization that never finished: delete the temporary file only when it is exactly the one
   * the manifest names AND its name carries this session's id, then remux again once.
   */
  private async resumeFinalization(item: Inspected): Promise<void> {
    const { manifest } = item;
    const plan = manifest.finalize;
    const expected = plan ? path.join(plan.outputDir, partialFileName(manifest.sessionId)) : null;
    if (
      plan &&
      expected &&
      path.isAbsolute(plan.outputDir) &&
      path.resolve(plan.partialPath) === path.resolve(expected)
    ) {
      await this.deps.fs.rm(expected, { force: true });
    } else if (plan) {
      log.warn(
        `Recovery: ignoring an unexpected partial path in session ${manifest.sessionId.slice(0, 8)}`,
      );
    }
    if (item.streamBytes === 0) return;
    // The plan comes from a file on disk: only a plain file name in an absolute folder is honoured.
    const planOk =
      plan !== undefined &&
      path.isAbsolute(plan.outputDir) &&
      plan.fileName !== '' &&
      plan.fileName === path.basename(plan.fileName);
    const outputDir = planOk ? plan.outputDir : this.deps.outputDir();
    const fileName = planOk
      ? plan.fileName
      : defaultRecordingFileName(new Date(manifest.createdAt));
    await this.remuxAndComplete(item, { outputDir, fileName, recovered: false });
  }

  private async remuxAndComplete(
    item: Inspected,
    target: { outputDir: string; fileName: string; recovered: boolean },
  ): Promise<RecoverOutcome> {
    const { manifest, dir } = item;
    const partialPath = path.join(target.outputDir, partialFileName(manifest.sessionId));
    manifest.state = 'finalizing';
    manifest.finalize = {
      outputDir: target.outputDir,
      fileName: target.fileName,
      partialPath,
      startedAt: this.now(),
    };
    await this.writeManifest(dir, manifest).catch(() => undefined);

    const outcome = await remuxToOutput({
      fs: this.deps.fs,
      tools: this.deps.tools,
      streamPath: path.join(dir, STREAM_FILE),
      streamBytes: item.streamBytes,
      outputDir: target.outputDir,
      fileName: target.fileName,
      partialPath,
    });
    if (outcome.ok) {
      const durationMs = Math.round((outcome.probe.durationSec ?? 0) * 1000);
      await completeSessionOnDisk(
        this.deps.fs,
        this.deps.rootDir,
        dir,
        manifest,
        {
          outputPath: outcome.outputPath,
          bytes: outcome.bytes,
          durationMs,
          recovered: target.recovered,
          unindexed: false,
          now: this.now(),
        },
        (value) => this.writeManifest(dir, value),
      );
      await this.deps.history
        ?.addVideo({
          path: outcome.outputPath,
          format: 'webm',
          durationMs,
          width: manifest.width,
          height: manifest.height,
          sizeBytes: outcome.bytes,
          hasAudio: manifest.options.mic.enabled || manifest.options.systemAudio,
          source: manifest.source.kind,
          createdAt: target.recovered ? manifest.createdAt : this.now(),
        })
        .catch((error: unknown) =>
          log.error('A recovered recording could not be added to history', error),
        );
      return {
        outcome: 'recovered',
        outputPath: outcome.outputPath,
        fileName: path.basename(outcome.outputPath),
        durationMs,
        bytes: outcome.bytes,
      };
    }
    manifest.state = 'failed';
    manifest.error = {
      code: outcome.code === 'REMUX_FAILED' ? 'UNREPAIRABLE' : outcome.code,
      message: outcome.message,
    };
    await writeFinalizeLog(this.deps.fs, dir, outcome.stderrTail);
    await this.writeManifest(dir, manifest).catch(() => undefined);
    log.warn(`Recovery: session ${manifest.sessionId.slice(0, 8)} not repaired (${outcome.code})`);
    if (outcome.code === 'LOW_DISK' || outcome.code === 'FFMPEG_MISSING') {
      throw new IpcError(outcome.code, outcome.message);
    }
    return { outcome: 'unrecoverable', keptAt: path.join(dir, STREAM_FILE) };
  }

  /** User asked to recover: remux what the stream holds into `FrameCapt ... (recovered).webm`. */
  async recover(sessionId: string): Promise<RecoverOutcome> {
    if (this.deps.isActive(sessionId))
      throw new IpcError('BUSY', 'That recording is still running.');
    if (this.busy.has(sessionId))
      throw new IpcError('BUSY', 'That recording is already being recovered.');
    this.busy.add(sessionId);
    try {
      const item = await this.inspect(sessionId);
      if (!item) throw new IpcError('NOT_FOUND', 'That unfinished recording no longer exists.');
      const { state } = item.manifest;
      if (
        item.streamBytes === 0 ||
        state === 'completed' ||
        state === 'recovered' ||
        state === 'discarded'
      ) {
        throw new IpcError('NOT_FOUND', 'There is nothing to recover for that recording.');
      }
      const created = new Date(item.manifest.createdAt);
      return await this.remuxAndComplete(item, {
        outputDir: this.deps.outputDir(),
        fileName: defaultRecordingFileName(created, 'webm', ' (recovered)'),
        recovered: true,
      });
    } finally {
      this.busy.delete(sessionId);
    }
  }

  /**
   * Deletes one unfinished session. Refuses anything that is not provably an app-owned session:
   * a plain uuid, inside the recordings root, with a manifest naming the same id.
   */
  async discard(sessionId: string): Promise<void> {
    const dir = this.dirFor(sessionId);
    if (!dir) throw new IpcError('INVALID_PAYLOAD', 'Not a valid recording id.');
    if (this.deps.isActive(sessionId) || this.busy.has(sessionId)) {
      throw new IpcError('BUSY', 'That recording is in use.');
    }
    if (!(await this.isRealDirectory(dir))) {
      throw new IpcError('NOT_FOUND', 'That unfinished recording could not be verified.');
    }
    const manifest = await this.readManifest(dir);
    if (!manifest || manifest.sessionId !== sessionId) {
      throw new IpcError('NOT_FOUND', 'That unfinished recording could not be verified.');
    }
    manifest.state = 'discarded';
    await this.writeManifest(dir, manifest).catch(() => undefined);
    const plan = manifest.finalize;
    if (plan) {
      const expected = path.join(plan.outputDir, partialFileName(sessionId));
      if (
        path.isAbsolute(plan.outputDir) &&
        path.resolve(plan.partialPath) === path.resolve(expected)
      ) {
        await this.deps.fs.rm(expected, { force: true }).catch(() => undefined);
      }
    }
    await this.deps.fs.rm(dir, { recursive: true, force: true });
    log.info(`Recovery: discarded session ${sessionId.slice(0, 8)}`);
  }

  /** The raw stream of a session, for "show in folder" (verified like a discard). */
  async streamPathOf(sessionId: string): Promise<string> {
    const dir = this.dirFor(sessionId);
    if (!dir) throw new IpcError('INVALID_PAYLOAD', 'Not a valid recording id.');
    const manifest = await this.readManifest(dir);
    if (!manifest || manifest.sessionId !== sessionId) {
      throw new IpcError('NOT_FOUND', 'That unfinished recording could not be verified.');
    }
    return path.join(dir, STREAM_FILE);
  }
}
