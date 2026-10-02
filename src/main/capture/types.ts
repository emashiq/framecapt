import type { DisplayInfo, SourceInfo, SourceKind } from '../../shared/capture-schemas';

export type { DisplayInfo, SourceInfo, SourceKind };

export interface ListSourcesOptions {
  types: SourceKind[];
  /** 0 disables thumbnails (cheaper). Capped at THUMBNAIL_MAX_WIDTH. */
  thumbnailWidth?: number;
}

/**
 * Where capture sources come from. The production implementation wraps Electron's `screen` and
 * `desktopCapturer`; a future native backend can implement the same interface. Capture itself
 * (getDisplayMedia) stays in the renderer and is authorized separately (authorization.ts).
 */
export interface CaptureProvider {
  listDisplays(): DisplayInfo[];
  listSources(options: ListSourcesOptions): Promise<SourceInfo[]>;
}
