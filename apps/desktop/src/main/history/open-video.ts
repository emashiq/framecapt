import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { dialog } from 'electron';
import type { EditorOpenTabEvent } from '../../shared/editor-ipc';
import { handle } from '../ipc';
import { IpcError } from '../ipc-core';
import { log } from '../logger';
import { convertVideo, type EncoderCapability } from '../media/convert';
import type { MediaTools } from '../media/ffmpeg';
import type { JobRunner } from '../media/job-runner';
import { dialogParent } from '../windows';
import type { HistoryService } from './service';

const PROBE_TIMEOUT_MS = 30_000;
const VIDEO_FILTERS: Electron.FileFilter[] = [
  { name: 'Video', extensions: ['mp4', 'webm', 'mov', 'mkv'] },
];

export interface OpenVideoDeps {
  history: Pick<HistoryService, 'addVideo' | 'findByPath'>;
  tools: MediaTools;
  /** Shared with the exports: one ffmpeg job at a time. */
  runner: JobRunner;
  /** Where a converted copy (a MOV or MKV, which the editor cannot open as it is) is saved. */
  recordingsDir: () => string;
  encoders: () => Promise<EncoderCapability>;
  /** Opens the video as a tab of the main window. */
  openTab: (event: EditorOpenTabEvent) => void;
}

/** A free `<name>.mp4` in `dir` (no dialog). */
async function freeMp4Path(dir: string, source: string): Promise<string> {
  await fs.promises.mkdir(dir, { recursive: true });
  const base = path.basename(source, path.extname(source));
  for (let attempt = 1; attempt < 1000; attempt += 1) {
    const candidate = path.join(dir, `${base}${attempt === 1 ? '' : ` (${attempt})`}.mp4`);
    if (!fs.existsSync(candidate)) return candidate;
  }
  throw new Error('No free MP4 name.');
}

/**
 * File > Open video: a main-process dialog, then the file is added to history as a recording and
 * opens in the video editor. The path never comes from a renderer. The editor reads MP4 and WebM;
 * a MOV or MKV is converted to an MP4 copy in the recordings folder first (the original is only read).
 */
export class OpenVideoService {
  constructor(private readonly deps: OpenVideoDeps) {}

  async run(): Promise<{ cancelled: true } | { opened: true }> {
    const options: Electron.OpenDialogOptions = {
      title: 'Open video',
      filters: VIDEO_FILTERS,
      properties: ['openFile'],
    };
    const parent = dialogParent();
    const result = parent
      ? await dialog.showOpenDialog(parent, options)
      : await dialog.showOpenDialog(options);
    const file = result.filePaths[0];
    if (result.canceled || !file) return { cancelled: true };
    const id = await this.add(file);
    this.deps.openTab({ kind: 'video', historyId: id, title: path.basename(file) });
    return { opened: true };
  }

  /** The history id of the video at `file` (added when it is new). */
  private async add(file: string): Promise<string> {
    const { history, tools } = this.deps;
    const stat = await fs.promises.stat(file).catch(() => null);
    if (!stat?.isFile()) throw new IpcError('NOT_FOUND', 'The file could not be opened.');
    const extension = path.extname(file).toLowerCase();
    const direct = extension === '.mp4' || extension === '.webm';
    const known = direct ? history.findByPath(file) : undefined;
    if (known) return known.id;

    let probe;
    try {
      probe = await tools.probe(file, { timeoutMs: PROBE_TIMEOUT_MS });
    } catch (error) {
      log.warn(`Open video: could not read the file (${String(error)})`);
      throw new IpcError('INVALID_PAYLOAD', 'FrameCapt could not read that video.');
    }
    if (!probe.hasVideo || !probe.video) {
      throw new IpcError('INVALID_PAYLOAD', 'That file has no video.');
    }
    if (direct) {
      const added = await history.addVideo({
        path: file,
        format: extension === '.mp4' ? 'mp4' : 'webm',
        durationMs: probe.durationSec === null ? null : Math.round(probe.durationSec * 1000),
        width: probe.video.width,
        height: probe.video.height,
        sizeBytes: stat.size,
        hasAudio: probe.hasAudio,
        source: 'unknown',
        ...(probe.frameRate !== undefined && { fps: probe.frameRate }),
      });
      return added.id;
    }
    return this.convertAndAdd(file, extension);
  }

  private async convertAndAdd(file: string, extension: string): Promise<string> {
    const { history, tools, runner } = this.deps;
    if (runner.busy) throw new IpcError('BUSY', 'An export is already running.');
    if (!(await this.deps.encoders()).h264) {
      throw new IpcError(
        'FFMPEG_MISSING',
        'This video needs MP4 conversion, which is not available.',
      );
    }
    const destPath = await freeMp4Path(this.deps.recordingsDir(), file);
    const { done } = runner.enqueue({
      id: randomUUID(),
      label: 'open-video',
      run: ({ signal, onProgress }) =>
        convertVideo({
          tools,
          sourcePath: file,
          sourceFormat: extension === '.mkv' ? 'mkv' : 'mp4',
          destPath,
          spec: { format: 'mp4', compression: 'light' },
          signal,
          onProgress,
        }),
    });
    const outcome = await done;
    if (!outcome.ok || !outcome.value.ok) {
      const message = outcome.ok && !outcome.value.ok ? outcome.value.message : undefined;
      throw new IpcError('INTERNAL', message ?? 'The video could not be converted.');
    }
    const converted = outcome.value;
    const added = await history.addVideo({
      path: converted.path,
      format: 'mp4',
      durationMs: converted.durationMs,
      width: converted.probe.video?.width ?? 0,
      height: converted.probe.video?.height ?? 0,
      sizeBytes: converted.bytes,
      hasAudio: converted.probe.hasAudio,
      source: 'unknown',
    });
    return added.id;
  }
}

export function registerOpenVideoHandler(service: OpenVideoService): void {
  handle('editor:openVideo', { roles: ['main'] }, () => service.run());
}
