import type { AudioItem, Item } from '../../../shared/video-edit';

/** The media route of a project's picture or audio file (`<sha256>.<ext>`), served with Range support. */
export const assetUrl = (historyId: string, assetId: string, ext: string): string =>
  `framecapt-media://vproject/${historyId}/${assetId}.${ext}`;

export interface ClipSpec {
  id: string;
  url: string;
  startMs: number;
  endMs: number;
  inMs: number;
  volume: number;
  fadeInMs: number;
  fadeOutMs: number;
}

/** The audible clips of a project for the preview (a muted clip is not played). */
export function clipSpecs(historyId: string, items: readonly Item[]): ClipSpec[] {
  return items
    .filter((item): item is AudioItem => item.kind === 'audio' && !item.muted)
    .map((clip) => ({
      id: clip.id,
      url: assetUrl(historyId, clip.assetId, clip.ext),
      startMs: clip.startMs,
      endMs: clip.endMs,
      inMs: clip.inMs,
      volume: clip.volume,
      fadeInMs: clip.fadeInMs,
      fadeOutMs: clip.fadeOutMs,
    }));
}
