import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  VIDEO_EXPORT_FORMATS,
  normalizeProject,
  outputDurationMs,
  outputGeometry,
  projectSegments,
  type VideoExportFormat,
  type VideoProject,
} from '../../shared/video-edit';
import { buildEditArgs, buildFilterScript } from './edit-graph';
import { FfmpegError, type MediaTools, type ProbeResult } from './ffmpeg';
import { runFileJob, type FileJobResult } from './job-runner';

const PROBE_TIMEOUT_MS = 30_000;

/** The output may differ from the planned length by this much (frame and packet rounding). */
function durationTolerance(expectedSec: number, format: VideoExportFormat): number {
  return format === 'gif' ? Math.max(0.6, expectedSec * 0.05) : 0.5;
}

/** What is wrong with a finished edit, or null: right container and codecs, right size and length. */
export function verifyEdit(
  project: VideoProject,
  format: VideoExportFormat,
  output: ProbeResult,
): string | null {
  const names = output.formatName.split(',');
  const expected = {
    mp4: { container: 'mp4', video: 'h264', audio: 'aac' },
    webm: { container: 'webm', video: 'vp9', audio: 'opus' },
    gif: { container: 'gif', video: 'gif', audio: null },
  }[format];
  if (!names.includes(expected.container))
    return `The output is not a ${format.toUpperCase()} file.`;
  if (!output.hasVideo || output.video?.codec !== expected.video) {
    return 'The output has the wrong video format.';
  }
  if (expected.audio !== null && output.audioCodec !== expected.audio) {
    return 'The output has no audio track.';
  }
  const geometry = outputGeometry({ ...project, export: { ...project.export, format } });
  if (output.video.width !== geometry.width || output.video.height !== geometry.height) {
    return 'The output has a different picture size than planned.';
  }
  if (output.durationSec === null) return 'The output has no duration.';
  const expectedSec = outputDurationMs(projectSegments(project)) / 1000;
  if (Math.abs(output.durationSec - expectedSec) > durationTolerance(expectedSec, format)) {
    return 'The output has a different length than planned.';
  }
  return null;
}

/** The project with the facts of the file as it is now (it may have been re-linked or replaced). */
export function withProbedSource(project: VideoProject, probe: ProbeResult): VideoProject {
  if (!probe.video || probe.durationSec === null) return project;
  const durationMs = Math.round(probe.durationSec * 1000);
  return normalizeProject({
    ...project,
    source: {
      ...project.source,
      durationMs,
      width: probe.video.width,
      height: probe.video.height,
      hasAudio: probe.hasAudio,
    },
  });
}

export interface EditExportRequest {
  tools: MediaTools;
  sourcePath: string;
  destPath: string;
  project: VideoProject;
  format: VideoExportFormat;
  signal?: AbortSignal;
  /** 0..99 while encoding. */
  onProgress?: (percent: number | null) => void;
  /** Where the job's temporary files go; the OS temp folder by default. */
  tempRoot?: string;
}

/**
 * Renders a project: probes the source, writes the filter graph to a script file in a temporary
 * folder, encodes into a partial file, verifies it and renames it onto `destPath` (see
 * runFileJob). The temporary folder is always removed; the source is only ever read.
 */
export async function exportEdit(request: EditExportRequest): Promise<FileJobResult> {
  const { tools, sourcePath, destPath, format, signal } = request;
  if (!VIDEO_EXPORT_FORMATS.includes(format)) {
    return { ok: false, code: 'INVALID_DESTINATION', message: 'Unknown format.', stderrTail: '' };
  }
  let probe: ProbeResult;
  try {
    probe = await tools.probe(sourcePath, {
      timeoutMs: PROBE_TIMEOUT_MS,
      ...(signal && { signal }),
    });
  } catch (error) {
    if (error instanceof FfmpegError && error.code === 'FFMPEG_ABORTED') {
      return { ok: false, code: 'CANCELLED', message: 'The export was cancelled.', stderrTail: '' };
    }
    return {
      ok: false,
      code: 'SOURCE_UNREADABLE',
      message: 'The recording could not be read.',
      stderrTail: '',
    };
  }
  const project = {
    ...withProbedSource(request.project, probe),
    export: { ...request.project.export, format },
  };

  const tempDir = await fs.promises.mkdtemp(
    path.join(request.tempRoot ?? os.tmpdir(), 'framecapt-edit-'),
  );
  try {
    const filterScriptPath = path.join(tempDir, 'graph.txt');
    await fs.promises.writeFile(filterScriptPath, buildFilterScript(project), 'utf8');
    return await runFileJob({
      tools,
      sourcePath,
      destPath,
      ...(signal && { signal }),
      ...(request.onProgress && { onProgress: request.onProgress }),
      args: (partial) => buildEditArgs(project, sourcePath, partial, { filterScriptPath }).args,
      verify: (output) => verifyEdit(project, format, output),
      outputDurationSec: outputDurationMs(projectSegments(project)) / 1000,
      noun: 'export',
    });
  } finally {
    await fs.promises
      .rm(tempDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
      .catch(() => undefined);
  }
}
