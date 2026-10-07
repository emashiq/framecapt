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
import { buildEditArgs, buildFilterScript, plannedInputs } from './edit-graph';
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
      // What the project already knows (the recorder's setting) wins over a guess from the file.
      ...(project.source.fps === undefined && probe.frameRate !== undefined
        ? { fps: probe.frameRate }
        : {}),
    },
  });
}

export interface EditExportRequest {
  tools: MediaTools;
  sourcePath: string;
  /** The history format of the source; a `.fcap` is read from its payload. */
  sourceFormat?: string;
  destPath: string;
  project: VideoProject;
  format: VideoExportFormat;
  signal?: AbortSignal;
  /** 0..99 while encoding. */
  onProgress?: (percent: number | null) => void;
  /** Where the job's temporary files go; the OS temp folder by default. */
  tempRoot?: string;
  /** The PNG of every text item, by item id (made by the renderer, validated by main). */
  textPngs?: Readonly<Record<string, Uint8Array>>;
  /** The file of a project asset (a picture or an audio file), or null when it is gone. */
  assetPath?: (assetId: string, ext: string) => string | null;
}

/** The files behind the extra inputs of a project; null when one is missing. */
async function inputFilesFor(
  project: VideoProject,
  request: EditExportRequest,
  tempDir: string,
): Promise<Record<string, string> | null> {
  const files: Record<string, string> = {};
  for (const { item, index } of plannedInputs(project)) {
    let file: string | null;
    if (item.kind === 'text') {
      const png = request.textPngs?.[item.id];
      if (!png) return null;
      file = path.join(tempDir, `text-${index}.png`);
      await fs.promises.writeFile(file, png);
    } else {
      file = request.assetPath?.(item.assetId, item.kind === 'image' ? 'png' : item.ext) ?? null;
      if (file === null || !fs.existsSync(file)) return null;
    }
    files[item.id] = file;
  }
  return files;
}

/**
 * Renders a project: probes the source, writes the filter graph to a script file in a temporary
 * folder, encodes into a partial file, verifies it and renames it onto `destPath` (see
 * runFileJob). The temporary folder is always removed; the source is only ever read.
 */
export async function exportEdit(request: EditExportRequest): Promise<FileJobResult> {
  const { tools, sourcePath, sourceFormat, destPath, format, signal } = request;
  if (!VIDEO_EXPORT_FORMATS.includes(format)) {
    return { ok: false, code: 'INVALID_DESTINATION', message: 'Unknown format.', stderrTail: '' };
  }
  let probe: ProbeResult;
  try {
    probe = await tools.probe(sourcePath, {
      timeoutMs: PROBE_TIMEOUT_MS,
      ...(signal && { signal }),
      ...(sourceFormat && { format: sourceFormat }),
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
    const inputFiles = await inputFilesFor(project, request, tempDir);
    if (!inputFiles) {
      return {
        ok: false,
        code: 'FAILED',
        message: 'A picture or sound file of the project is missing.',
        stderrTail: '',
      };
    }
    return await runFileJob({
      tools,
      sourcePath,
      ...(sourceFormat && { sourceFormat }),
      destPath,
      ...(signal && { signal }),
      ...(request.onProgress && { onProgress: request.onProgress }),
      args: (partial) =>
        buildEditArgs(project, sourcePath, partial, {
          filterScriptPath,
          inputFiles,
          ...(sourceFormat && { sourceFormat }),
        }).args,
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
