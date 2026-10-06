import fs from 'node:fs';
import path from 'node:path';
import { withCollisionSuffix } from '../../shared/recording';
import {
  FfmpegError,
  remuxArgs,
  type FfmpegProgress,
  type MediaTools,
  type ProbeResult,
} from '../media/ffmpeg';
import {
  COMPLETED_DIR,
  FINALIZE_LOG_FILE,
  STREAM_FILE,
  type CompletionRecord,
  type SessionManifest,
} from './manifest';
import { freeBytes, type SessionFs } from './session-fs';

/** Free space the output volume must keep beyond the stream itself while remuxing. */
const REMUX_MARGIN_BYTES = 100 * 1024 * 1024;
const PROBE_TIMEOUT_MS = 30_000;
const REMUX_TIMEOUT_MS = 10 * 60_000;

export type RemuxFailureCode = 'LOW_DISK' | 'REMUX_FAILED' | 'ABORTED' | 'FFMPEG_MISSING';

export type RemuxOutcome =
  | { ok: true; outputPath: string; bytes: number; probe: ProbeResult }
  | { ok: false; code: RemuxFailureCode; message: string; stderrTail: string };

export interface RemuxRequest {
  fs: SessionFs;
  tools: MediaTools;
  streamPath: string;
  streamBytes: number;
  outputDir: string;
  /** Preferred final name; a number is added when it exists. */
  fileName: string;
  /** Temporary output, in the output directory (same volume, so the rename is atomic). */
  partialPath: string;
  signal?: AbortSignal;
  onProgress?: (progress: FfmpegProgress) => void;
}

/** Hard facts of a usable recording: a video stream and a real duration. */
export function isPlayable(probe: ProbeResult): boolean {
  return probe.hasVideo && probe.durationSec !== null && probe.durationSec > 0;
}

async function exists(api: SessionFs, file: string): Promise<boolean> {
  return api.stat(file).then(
    () => true,
    () => false,
  );
}

/** The first name that is free: "name.webm", "name (2).webm", ... Never an existing file. */
export async function freeTarget(api: SessionFs, dir: string, fileName: string): Promise<string> {
  for (let attempt = 0; attempt < 1000; attempt += 1) {
    const candidate = path.join(dir, withCollisionSuffix(fileName, attempt));
    if (!(await exists(api, candidate))) return candidate;
  }
  throw new Error('No free output name.');
}

function failure(code: RemuxFailureCode, message: string, stderrTail = ''): RemuxOutcome {
  return { ok: false, code, message, stderrTail };
}

/**
 * Remuxes `stream.webm` with `-c copy` into a partial file next to the final one, checks that it
 * is playable (video stream, duration > 0) and only then renames it to a free final name. The
 * partial file is removed on every failure path. The stream is never modified.
 */
export async function remuxToOutput(request: RemuxRequest): Promise<RemuxOutcome> {
  const { fs: api, tools, partialPath } = request;
  try {
    tools.paths();
  } catch (error) {
    if (error instanceof FfmpegError && error.code === 'FFMPEG_MISSING') {
      return failure('FFMPEG_MISSING', error.message);
    }
    throw error;
  }
  try {
    await api.mkdir(request.outputDir, { recursive: true });
    const free = await freeBytes(api, request.outputDir);
    if (free !== null && free < request.streamBytes + REMUX_MARGIN_BYTES) {
      return failure('LOW_DISK', 'There is not enough free space to finish the recording.');
    }
    await api.rm(partialPath, { force: true });

    let result;
    try {
      result = await tools.run(remuxArgs(request.streamPath, partialPath), {
        timeoutMs: REMUX_TIMEOUT_MS,
        ...(request.signal && { signal: request.signal }),
        ...(request.onProgress && { onProgress: request.onProgress }),
      });
    } catch (error) {
      if (error instanceof FfmpegError && error.code === 'FFMPEG_ABORTED') {
        return failure('ABORTED', 'Finishing the recording was interrupted.', error.stderrTail);
      }
      if (error instanceof FfmpegError) {
        return failure('REMUX_FAILED', 'The recording could not be repaired.', error.stderrTail);
      }
      throw error;
    }
    if (result.code !== 0) {
      return failure('REMUX_FAILED', 'The recording could not be repaired.', result.stderrTail);
    }

    let probe: ProbeResult;
    try {
      probe = await tools.probe(partialPath, {
        timeoutMs: PROBE_TIMEOUT_MS,
        ...(request.signal && { signal: request.signal }),
      });
    } catch (error) {
      if (error instanceof FfmpegError && error.code === 'FFMPEG_ABORTED') {
        return failure('ABORTED', 'Finishing the recording was interrupted.');
      }
      return failure(
        'REMUX_FAILED',
        'The remuxed file could not be read.',
        (error as FfmpegError).stderrTail ?? '',
      );
    }
    if (!isPlayable(probe)) {
      return failure('REMUX_FAILED', 'The remuxed file has no video or no duration.');
    }

    const partialSize = (await api.stat(partialPath)).size;
    const target = await freeTarget(api, request.outputDir, request.fileName);
    await api.rename(partialPath, target);
    const finalSize = (await api.stat(target)).size;
    if (finalSize !== partialSize) {
      return failure('REMUX_FAILED', 'The finished file does not have the expected size.');
    }
    return { ok: true, outputPath: target, bytes: finalSize, probe };
  } finally {
    // Any partial file that is still here belongs to this attempt (success renamed it away).
    await api.rm(partialPath, { force: true }).catch(() => undefined);
  }
}

export type RawCopyOutcome =
  { ok: true; outputPath: string; bytes: number } | { ok: false; message: string };

/**
 * Last resort after a failed remux: when the raw stream itself shows a video stream, copy it to
 * the output folder (through a partial file and a rename). It plays, but has no seeking index.
 */
export async function copyRawAsOutput(request: RemuxRequest): Promise<RawCopyOutcome> {
  const { fs: api, tools } = request;
  try {
    const probe = await tools.probe(request.streamPath, {
      timeoutMs: PROBE_TIMEOUT_MS,
      ...(request.signal && { signal: request.signal }),
    });
    if (!probe.hasVideo) return { ok: false, message: 'The raw stream has no video.' };
    await api.mkdir(request.outputDir, { recursive: true });
    await api.rm(request.partialPath, { force: true });
    try {
      await api.copyFile(request.streamPath, request.partialPath, fs.constants.COPYFILE_EXCL);
      const target = await freeTarget(api, request.outputDir, request.fileName);
      await api.rename(request.partialPath, target);
      return { ok: true, outputPath: target, bytes: (await api.stat(target)).size };
    } finally {
      await api.rm(request.partialPath, { force: true }).catch(() => undefined);
    }
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : 'Copy failed.' };
  }
}

/** Keeps the tail of ffmpeg's stderr next to the session, for diagnostics after a failed remux. */
export async function writeFinalizeLog(api: SessionFs, dir: string, text: string): Promise<void> {
  await api.writeFile(path.join(dir, FINALIZE_LOG_FILE), text).catch(() => undefined);
}

export interface CompletionDetails {
  outputPath: string;
  bytes: number;
  durationMs: number | null;
  recovered: boolean;
  unindexed: boolean;
  now: number;
}

/**
 * Records that the output exists, then removes the session: manifest `completed`, a small
 * `completed/<id>.json` record for history linking, then the whole session directory including
 * `stream.webm`. If the record cannot be written, only `stream.webm` (the duplicate) is removed
 * and the manifest stays as the record. Callers verified the output file before calling this.
 */
export async function completeSessionOnDisk(
  api: SessionFs,
  rootDir: string,
  dir: string,
  manifest: SessionManifest,
  details: CompletionDetails,
  writeManifest: (manifest: SessionManifest) => Promise<void>,
): Promise<void> {
  manifest.state = details.recovered ? 'recovered' : 'completed';
  manifest.outputPath = details.outputPath;
  if (details.unindexed) manifest.unindexed = true;
  await writeManifest(manifest).catch(() => undefined);

  const record: CompletionRecord = {
    sessionId: manifest.sessionId,
    completedAt: details.now,
    createdAt: manifest.createdAt,
    outputPath: details.outputPath,
    durationMs: details.durationMs,
    bytes: details.bytes,
    width: manifest.width,
    height: manifest.height,
    source: { kind: manifest.source.kind },
    hasAudio: manifest.options.mic.enabled || manifest.options.systemAudio,
    mime: manifest.mime,
    recovered: details.recovered,
    unindexed: details.unindexed,
    pausedIntervals: manifest.pausedIntervals,
    stats: manifest.stats,
  };
  try {
    const completedDir = path.join(rootDir, COMPLETED_DIR);
    await api.mkdir(completedDir, { recursive: true });
    const target = path.join(completedDir, `${manifest.sessionId}.json`);
    await api.writeFile(`${target}.tmp`, `${JSON.stringify(record, null, 2)}\n`);
    await api.rename(`${target}.tmp`, target);
  } catch {
    await api.rm(path.join(dir, STREAM_FILE), { force: true }).catch(() => undefined);
    return;
  }
  await api.rm(dir, { recursive: true, force: true }).catch(() => undefined);
}
