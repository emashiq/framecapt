import fs from 'node:fs';
import path from 'node:path';
import { createdAtFromFlowFolder, FLOW_FILE_NAME, type FlowFile } from '../../shared/flow';
import { MAX_THUMBNAIL_WIDTH } from '../../shared/history-ipc';
import { createdAtFromName } from '../../shared/capture-names';
import { detectImageFormat, MAX_EXPORT_BYTES, readImageSize } from '../../shared/shots';
import { flowBytes, readFlowFile } from '../flows/flow-store';
import { log } from '../logger';
import type { MediaTools } from '../media/ffmpeg';
import { readFcapHeader } from '../recording/fcap';
import { samePath } from './files';
import type { HistoryService } from './service';
import { MAX_HISTORY_ITEMS } from './store';

/**
 * File types a rescan adds. Everything here is final, flattened output of FrameCapt (ADR-026), so
 * this is the one place a new format is registered (the multi-source `.fcap` is the latest).
 */
const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg']);
const VIDEO_EXTENSIONS = new Set(['.webm', '.mp4', '.fcap']);

const PROBE_TIMEOUT_MS = 30_000;
const HEADER_BYTES = 64 * 1024;

export interface RescanDeps {
  /** Folders to look in (non-recursive); the screenshot and recording output folders. */
  dirs: readonly string[];
  history: Pick<
    HistoryService,
    'ready' | 'size' | 'findByPath' | 'addScreenshot' | 'addVideo' | 'addFlow'
  >;
  tools: MediaTools;
  /** PNG of the image, `width` px wide; undefined when it cannot be decoded. */
  thumbnail: (file: string, width: number) => Promise<Uint8Array | undefined>;
  /** PNG thumbnail of a guide (its first step with the pointer ring); undefined when it cannot be made. */
  flowThumbnail?: (dir: string, flow: FlowFile) => Promise<Uint8Array | undefined>;
  maxItems?: number;
}

interface Candidate {
  file: string;
  extension: string;
  createdAt: number;
  sizeBytes: number;
}

/** Candidates: files the app would have made, not yet in history. Links and folders are skipped. */
async function findCandidates(deps: RescanDeps): Promise<Candidate[]> {
  const folders = deps.dirs.filter(
    (dir, index) => deps.dirs.findIndex((d) => samePath(d, dir)) === index,
  );
  const found: Candidate[] = [];
  for (const dir of folders) {
    const entries = await fs.promises.readdir(dir, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      // One level deep, and only for the folders the app names itself: a guide is its flow.json.
      if (entry.isDirectory() && !entry.isSymbolicLink()) {
        const folderTime = createdAtFromFlowFolder(entry.name);
        const flowFile = path.join(dir, entry.name, FLOW_FILE_NAME);
        if (folderTime !== null && !deps.history.findByPath(flowFile)) {
          const stat = await fs.promises.stat(flowFile).catch(() => null);
          if (stat?.isFile()) {
            found.push({ file: flowFile, extension: '.json', createdAt: folderTime, sizeBytes: 0 });
          }
        }
        continue;
      }
      const extension = path.extname(entry.name).toLowerCase();
      const known = IMAGE_EXTENSIONS.has(extension) || VIDEO_EXTENSIONS.has(extension);
      if (!entry.isFile() || !known) continue;
      const nameTime = createdAtFromName(entry.name);
      if (nameTime === null) continue;
      const file = path.join(dir, entry.name);
      if (deps.history.findByPath(file)) continue;
      const stat = await fs.promises.stat(file).catch(() => null);
      if (stat?.isFile())
        found.push({ file, extension, createdAt: nameTime, sizeBytes: stat.size });
    }
  }
  return found;
}

async function readHeader(file: string): Promise<Uint8Array> {
  const handle = await fs.promises.open(file, 'r');
  try {
    const buffer = Buffer.alloc(HEADER_BYTES);
    const { bytesRead } = await handle.read(buffer, 0, HEADER_BYTES, 0);
    return buffer.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
}

async function addImage(deps: RescanDeps, candidate: Candidate): Promise<boolean> {
  if (candidate.sizeBytes > MAX_EXPORT_BYTES) return false;
  const head = await readHeader(candidate.file);
  const format = detectImageFormat(head);
  const size = readImageSize(head);
  if (format === null || size === null || size.width === 0 || size.height === 0) return false;
  const thumbnail = await deps.thumbnail(candidate.file, Math.min(MAX_THUMBNAIL_WIDTH, size.width));
  await deps.history.addScreenshot({
    path: candidate.file,
    width: size.width,
    height: size.height,
    sizeBytes: candidate.sizeBytes,
    format,
    source: 'unknown',
    thumbnail,
    createdAt: candidate.createdAt,
  });
  return true;
}

/** A multi-source recording: the facts come from its own header, no ffprobe. */
async function addFcapFile(deps: RescanDeps, candidate: Candidate): Promise<boolean> {
  const header = await readFcapHeader(candidate.file);
  await deps.history.addVideo({
    path: candidate.file,
    format: 'fcap',
    durationMs: header.durationMs,
    width: header.width,
    height: header.height,
    sizeBytes: candidate.sizeBytes,
    hasAudio: header.hasAudio,
    source: 'multi',
    createdAt: candidate.createdAt,
  });
  return true;
}

async function addFlowFolder(deps: RescanDeps, candidate: Candidate): Promise<boolean> {
  const flow = await readFlowFile(candidate.file);
  const first = flow?.steps[0];
  if (!flow || !first) return false;
  const dir = path.dirname(candidate.file);
  const thumbnail = await deps.flowThumbnail?.(dir, flow).catch(() => undefined);
  await deps.history.addFlow({
    path: candidate.file,
    width: first.width,
    height: first.height,
    sizeBytes: await flowBytes(dir, flow),
    stepCount: flow.steps.length,
    thumbnail,
    createdAt: candidate.createdAt,
  });
  return true;
}

async function addVideoFile(deps: RescanDeps, candidate: Candidate): Promise<boolean> {
  if (candidate.extension === '.fcap') return addFcapFile(deps, candidate);
  const probe = await deps.tools.probe(candidate.file, { timeoutMs: PROBE_TIMEOUT_MS });
  if (!probe.hasVideo) return false;
  const format = candidate.extension === '.mp4' ? 'mp4' : 'webm';
  // An MP4 next to a WebM of the same name is that recording's export.
  const webm =
    format === 'mp4'
      ? deps.history.findByPath(candidate.file.slice(0, -candidate.extension.length) + '.webm')
      : undefined;
  await deps.history.addVideo({
    path: candidate.file,
    format,
    durationMs: probe.durationSec === null ? null : Math.round(probe.durationSec * 1000),
    width: probe.video?.width ?? 0,
    height: probe.video?.height ?? 0,
    sizeBytes: candidate.sizeBytes,
    hasAudio: probe.hasAudio,
    source: 'unknown',
    createdAt: candidate.createdAt,
    ...(webm && { derivedFrom: webm.id }),
  });
  return true;
}

/**
 * Adds captures that exist in the output folders but not in history (a reinstall, lost app data).
 * Only files named like the app's own are considered, newest first, within the free room of the
 * history. Files are only read, never moved or changed. Returns how many were added.
 */
export async function rescanLibrary(deps: RescanDeps): Promise<number> {
  await deps.history.ready;
  const room = (deps.maxItems ?? MAX_HISTORY_ITEMS) - deps.history.size;
  if (room <= 0) return 0;
  const candidates = (await findCandidates(deps))
    .sort((a, b) => b.createdAt - a.createdAt)
    .slice(0, room);
  // WebM before MP4, so an export finds the recording it came from.
  const ordered = [
    ...candidates.filter((c) => c.extension !== '.mp4'),
    ...candidates.filter((c) => c.extension === '.mp4'),
  ];
  let added = 0;
  // One at a time: each probe is an ffprobe process and each add rewrites history.json.
  for (const candidate of ordered) {
    try {
      const done =
        candidate.extension === '.json'
          ? await addFlowFolder(deps, candidate)
          : IMAGE_EXTENSIONS.has(candidate.extension)
            ? await addImage(deps, candidate)
            : await addVideoFile(deps, candidate);
      if (done) added += 1;
    } catch (error) {
      log.warn(`Rescan skipped a file (${(error as Error).message})`);
    }
  }
  return added;
}
