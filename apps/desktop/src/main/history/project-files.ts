import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { dialog, nativeImage } from 'electron';
import { z } from 'zod';
import { HistorySourceSchema, MAX_THUMBNAIL_WIDTH } from '../../shared/history-ipc';
import { MAX_ASSET_BYTES, MAX_PROJECT_ASSETS, ProjectDocSchema } from '../../shared/project-ipc';
import {
  MAX_EXPORT_BYTES,
  MAX_FRAME_DIMENSION,
  readImageSize,
  validateImageBytes,
} from '../../shared/shots';
import {
  AUDIO_EXTENSIONS,
  AssetIdSchema,
  MAX_ITEMS,
  VideoProjectSchema,
  normalizeProject,
} from '../../shared/video-edit';
import { handle } from '../ipc';
import { IpcError } from '../ipc-core';
import { log } from '../logger';
import type { ProjectStore } from '../projects/store';
import { writeFileAtomic } from '../shots/atomic-write';
import { freeFileName } from '../shots/free-name';
import type { VideoProjectStore } from '../video-projects/store';
import { MAX_AUDIO_FILE_BYTES } from '../video-projects/service';
import { dialogParent } from '../windows';
import type { HistoryService } from './service';

export const PROJECT_FORMAT = 'framecapt-project';
export const PROJECT_FILE_VERSION = 1;
/** The largest project file read or written (the JSON text is held in memory). */
export const MAX_PROJECT_FILE_BYTES = 400 * 1024 * 1024;

type ProjectKind = 'image' | 'video';
const EXTENSION_OF: Record<ProjectKind, 'fcimage' | 'fcvideo'> = {
  image: 'fcimage',
  video: 'fcvideo',
};

const Header = {
  format: z.literal(PROJECT_FORMAT),
  version: z.literal(PROJECT_FILE_VERSION),
  name: z.string().min(1).max(200),
  createdAt: z.number(),
  appVersion: z.string().max(64),
};

/** A screenshot project: the unedited picture, the editor document and its image-layer pictures (base64 PNGs). */
const ImageProjectFileSchema = z.object({
  ...Header,
  kind: z.literal('image'),
  width: z.number().int().min(1).max(MAX_FRAME_DIMENSION),
  height: z.number().int().min(1).max(MAX_FRAME_DIMENSION),
  original: z.string().min(1),
  /** The exported (edited) picture the Library shows, when there was one. */
  flattened: z.string().optional(),
  doc: ProjectDocSchema,
  assets: z
    .array(z.object({ id: z.string().regex(/^[0-9a-f]{64}$/), png: z.string() }))
    .max(MAX_PROJECT_ASSETS),
});

/** A video project: where the source video is, the recipe and the pictures and audio it uses (base64). */
const VideoProjectFileSchema = z.object({
  ...Header,
  kind: z.literal('video'),
  source: z.object({
    path: z.string().min(1).max(2048),
    format: z.enum(['webm', 'mp4', 'fcap']),
    durationMs: z.number().min(0).nullable(),
    width: z.number().int().min(0),
    height: z.number().int().min(0),
    hasAudio: z.boolean().nullable(),
    fps: z.number().min(1).max(240).optional(),
    origin: HistorySourceSchema,
  }),
  project: VideoProjectSchema,
  assets: z
    .array(
      z.object({
        assetId: AssetIdSchema,
        ext: z.enum(['png', ...AUDIO_EXTENSIONS]),
        data: z.string(),
      }),
    )
    .max(MAX_ITEMS),
});

const ProjectFileSchema = z.discriminatedUnion('kind', [
  ImageProjectFileSchema,
  VideoProjectFileSchema,
]);

const sha256 = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');

/** A file-name-safe version of a name (no path separators or characters Windows refuses). */
function safeName(name: string): string {
  const cleaned = [...name]
    .filter((char) => (char.codePointAt(0) ?? 0) > 31)
    .join('')
    .replace(/[<>:"/\\|?*]/g, '_')
    .trim()
    .replace(/[. ]+$/, '');
  return cleaned.slice(0, 120) || 'Project';
}

function invalid(message: string): never {
  throw new IpcError('INVALID_PAYLOAD', message);
}

export interface ProjectFileDeps {
  history: Pick<
    HistoryService,
    'get' | 'findByPath' | 'addScreenshot' | 'addVideo' | 'markProjectFile'
  >;
  projects: Pick<ProjectStore, 'read' | 'write'>;
  videoProjects: Pick<VideoProjectStore, 'read' | 'write' | 'assetPath'>;
  /** Where a project opened from a file puts its picture. */
  screenshotsDir: () => string;
  appVersion: string;
}

/**
 * Project files: one JSON file (`.fcimage` or `.fcvideo`) holding what the editor needs to
 * continue later. Saving reads an item's stored edits; opening imports them into history as an
 * item of its own. Paths of files come from main-process dialogs only.
 */
export class ProjectFileService {
  constructor(private readonly deps: ProjectFileDeps) {}

  /**
   * Builds the project file of an item, asks `pick` where to write it (a save dialog), writes it and
   * marks the item. Resolves to the path, or null when `pick` was cancelled.
   */
  async save(
    id: string,
    pick: (suggested: string, extension: 'fcimage' | 'fcvideo') => Promise<string | null>,
  ): Promise<string | null> {
    const item = this.deps.history.get(id);
    if (!item) throw new IpcError('NOT_FOUND', 'That item is not in history.');
    const base = path.basename(item.path, path.extname(item.path));
    const header = {
      format: PROJECT_FORMAT,
      version: PROJECT_FILE_VERSION,
      name: base,
      createdAt: Date.now(),
      appVersion: this.deps.appVersion,
    } as const;
    let kind: ProjectKind;
    let body: unknown;
    if (item.type === 'screenshot') {
      kind = 'image';
      body = { ...header, ...(await this.imageBody(item)) };
    } else if (
      item.type === 'recording' &&
      (item.format === 'webm' || item.format === 'mp4' || item.format === 'fcap')
    ) {
      kind = 'video';
      body = { ...header, ...(await this.videoBody(item, item.format)) };
    } else {
      return invalid('Only screenshots and WebM, MP4 or multi-source recordings have a project.');
    }
    const text = JSON.stringify(body);
    if (text.length > MAX_PROJECT_FILE_BYTES) invalid('The project is too large to save.');
    const extension = EXTENSION_OF[kind];
    const chosen = await pick(
      path.join(path.dirname(item.path), `${base}.${extension}`),
      extension,
    );
    if (chosen === null) return null;
    const target =
      path.extname(chosen).toLowerCase() === `.${extension}` ? chosen : `${chosen}.${extension}`;
    try {
      await writeFileAtomic(target, Buffer.from(text, 'utf8'));
    } catch (error) {
      log.warn(`A project file could not be saved (${(error as Error).message})`);
      throw new IpcError('INTERNAL', 'The project file could not be saved.');
    }
    await this.deps.history.markProjectFile(id);
    return target;
  }

  private async imageBody(item: NonNullable<ReturnType<ProjectFileDeps['history']['get']>>) {
    const read = await this.deps.projects.read(item.id);
    if (!read.ok) {
      return invalid(
        'This screenshot has no editable data. Open it in the editor and save it first.',
      );
    }
    let flattened: string | undefined;
    if (item.format === 'png') {
      const stat = await fs.promises.stat(item.path).catch(() => null);
      if (stat?.isFile() && stat.size <= MAX_EXPORT_BYTES) {
        flattened = (await fs.promises.readFile(item.path)).toString('base64');
      }
    }
    return {
      kind: 'image' as const,
      width: read.width,
      height: read.height,
      original: read.png.toString('base64'),
      ...(flattened && { flattened }),
      doc: read.doc,
      assets: read.assets.map((asset) => ({ id: asset.id, png: asset.png.toString('base64') })),
    };
  }

  private async videoBody(
    item: NonNullable<ReturnType<ProjectFileDeps['history']['get']>>,
    format: 'webm' | 'mp4' | 'fcap',
  ) {
    const read = await this.deps.videoProjects.read(item.id);
    if (!read.ok) {
      return invalid('This recording has not been edited yet. Open it in the video editor first.');
    }
    const assets: {
      assetId: string;
      ext: (typeof AUDIO_EXTENSIONS)[number] | 'png';
      data: string;
    }[] = [];
    const seen = new Set<string>();
    for (const entry of read.project.items) {
      if (entry.kind !== 'image' && entry.kind !== 'audio') continue;
      const ext = entry.kind === 'image' ? 'png' : entry.ext;
      if (seen.has(`${entry.assetId}.${ext}`)) continue;
      seen.add(`${entry.assetId}.${ext}`);
      const file = this.deps.videoProjects.assetPath(item.id, entry.assetId, ext);
      const bytes = file ? await fs.promises.readFile(file).catch(() => null) : null;
      // A missing file stays missing: its item shows a placeholder, as in the editor.
      if (bytes) assets.push({ assetId: entry.assetId, ext, data: bytes.toString('base64') });
    }
    return {
      kind: 'video' as const,
      source: {
        path: item.path,
        format,
        durationMs: item.durationMs,
        width: item.width,
        height: item.height,
        hasAudio: item.hasAudio,
        ...(item.fps !== undefined && { fps: item.fps }),
        origin: item.source,
      },
      project: read.project,
      assets,
    };
  }

  /** Imports a project file into history; resolves to the history id to open in the editor. */
  async open(file: string): Promise<string> {
    const stat = await fs.promises.stat(file).catch(() => null);
    if (!stat?.isFile()) throw new IpcError('NOT_FOUND', 'That file could not be found.');
    if (stat.size > MAX_PROJECT_FILE_BYTES) invalid('That project file is too large.');
    let json: unknown;
    try {
      json = JSON.parse(await fs.promises.readFile(file, 'utf8'));
    } catch {
      return invalid('That is not a FrameCapt project file.');
    }
    const head = json as { format?: unknown; version?: unknown } | null;
    if (head?.format !== PROJECT_FORMAT) invalid('That is not a FrameCapt project file.');
    if (typeof head.version === 'number' && head.version > PROJECT_FILE_VERSION) {
      invalid('That project was made by a newer version of FrameCapt.');
    }
    const parsed = ProjectFileSchema.safeParse(json);
    if (!parsed.success) return invalid('That project file is damaged.');
    try {
      return parsed.data.kind === 'image'
        ? await this.openImage(parsed.data)
        : await this.openVideo(parsed.data);
    } catch (error) {
      if (error instanceof IpcError) throw error;
      log.warn(`A project file could not be opened (${(error as Error).message})`);
      throw new IpcError('INVALID_PAYLOAD', 'That project file could not be opened.');
    }
  }

  private async openImage(project: z.infer<typeof ImageProjectFileSchema>): Promise<string> {
    const png = (data: string): Buffer => {
      const bytes = Buffer.from(data, 'base64');
      if (!validateImageBytes('png', bytes, MAX_EXPORT_BYTES).ok)
        invalid('That project file is damaged.');
      return bytes;
    };
    const original = png(project.original);
    const size = readImageSize(original);
    if (size?.width !== project.width || size.height !== project.height) {
      invalid('That project file is damaged.');
    }
    const picture = project.flattened ? png(project.flattened) : original;
    const pictureSize = readImageSize(picture);
    if (!pictureSize) return invalid('That project file is damaged.');
    const assets = project.assets.map((asset) => ({
      id: asset.id,
      png: Buffer.from(asset.png, 'base64'),
    }));
    const dir = this.deps.screenshotsDir();
    await fs.promises.mkdir(dir, { recursive: true });
    const target = await freeFileName(dir, `${safeName(project.name)}.png`);
    await writeFileAtomic(target, picture);
    const thumb = nativeImage.createFromBuffer(picture);
    const { id } = await this.deps.history.addScreenshot({
      path: target,
      width: pictureSize.width,
      height: pictureSize.height,
      sizeBytes: picture.length,
      format: 'png',
      source: 'unknown',
      ...(!thumb.isEmpty() && {
        thumbnail: thumb
          .resize({ width: Math.min(MAX_THUMBNAIL_WIDTH, pictureSize.width) })
          .toPNG(),
      }),
      project: {
        png: original,
        doc: project.doc,
        width: project.width,
        height: project.height,
        appVersion: project.appVersion,
        assets,
      },
      projectFile: true,
    });
    if (this.deps.history.get(id)?.projectId === undefined) {
      invalid('The editable data of that project could not be restored.');
    }
    return id;
  }

  private async openVideo(project: z.infer<typeof VideoProjectFileSchema>): Promise<string> {
    const source = project.source;
    const stat = await fs.promises.stat(source.path).catch(() => null);
    if (!stat?.isFile()) {
      throw new IpcError('NOT_FOUND', `The video of this project is missing: ${source.path}`);
    }
    const known = this.deps.history.findByPath(source.path);
    const historyId =
      known?.type === 'recording'
        ? known.id
        : (
            await this.deps.history.addVideo({
              path: source.path,
              format: source.format,
              durationMs: source.durationMs,
              width: source.width,
              height: source.height,
              sizeBytes: stat.size,
              hasAudio: source.hasAudio,
              source: source.origin,
              ...(source.fps !== undefined && { fps: source.fps }),
            })
          ).id;
    // The pictures and sounds first, so the recipe never points at a missing file.
    for (const asset of project.assets) {
      const bytes = Buffer.from(asset.data, 'base64');
      const limit = asset.ext === 'png' ? MAX_ASSET_BYTES : MAX_AUDIO_FILE_BYTES;
      if (bytes.length > limit || sha256(bytes) !== asset.assetId)
        invalid('That project file is damaged.');
      if (asset.ext === 'png' && !validateImageBytes('png', bytes, MAX_ASSET_BYTES).ok) {
        invalid('That project file is damaged.');
      }
      const target = this.deps.videoProjects.assetPath(historyId, asset.assetId, asset.ext);
      if (!target) invalid('That project file is damaged.');
      await fs.promises.mkdir(path.dirname(target), { recursive: true });
      await writeFileAtomic(target, bytes);
    }
    await this.deps.videoProjects.write(
      historyId,
      normalizeProject({ ...project.project, sourceId: historyId }),
    );
    await this.deps.history.markProjectFile(historyId);
    return historyId;
  }
}

/** Duplicate and project-file channels. Dialogs run in main; the renderer only sends history ids. */
export function registerProjectFileHandlers(
  history: HistoryService,
  files: ProjectFileService,
): void {
  handle('history:duplicate', { roles: ['main'] }, (request) => history.duplicate(request.id));

  handle('history:saveProjectFile', { roles: ['main'] }, async (request) => {
    const saved = await files.save(request.id, async (suggested, extension) => {
      const options: Electron.SaveDialogOptions = {
        title: 'Save project file',
        defaultPath: suggested,
        filters: [
          {
            name: extension === 'fcimage' ? 'FrameCapt image project' : 'FrameCapt video project',
            extensions: [extension],
          },
        ],
        properties: ['showOverwriteConfirmation'],
      };
      const parent = dialogParent();
      const result = parent
        ? await dialog.showSaveDialog(parent, options)
        : await dialog.showSaveDialog(options);
      return result.canceled || !result.filePath ? null : result.filePath;
    });
    return saved === null ? { cancelled: true as const } : { path: saved };
  });

  handle('history:openProjectFile', { roles: ['main'] }, async () => {
    const options: Electron.OpenDialogOptions = {
      title: 'Open project',
      filters: [{ name: 'FrameCapt projects', extensions: ['fcimage', 'fcvideo'] }],
      properties: ['openFile'],
    };
    const parent = dialogParent();
    const result = parent
      ? await dialog.showOpenDialog(parent, options)
      : await dialog.showOpenDialog(options);
    const picked = result.filePaths[0];
    if (result.canceled || !picked) return { cancelled: true as const };
    return { historyId: await files.open(picked) };
  });
}
