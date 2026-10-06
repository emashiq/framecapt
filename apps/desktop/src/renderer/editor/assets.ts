import {
  MAX_ASSETS_TOTAL_BYTES,
  MAX_ASSET_BYTES,
  MAX_PROJECT_ASSETS,
} from '../../shared/project-ipc';
import type { DrawAsset } from './flatten';
import type { EditorDoc } from './model/types';

/**
 * The pictures of image layers. A layer names its picture by `assetId`, the SHA-256 (hex) of the
 * picture's PNG bytes, so the same picture inserted twice is stored once. The editor keeps the
 * decoded bitmap (to draw) and the PNG bytes (to save with the project). Decoding is in decode.ts.
 */
export interface EditorAsset extends DrawAsset {
  id: string;
  png: ArrayBuffer;
  /** The decoded picture (an ImageBitmap in the app). */
  image: { close(): void };
}
export type EditorAssets = ReadonlyMap<string, EditorAsset>;

/** At most this many pictures (and bytes) per screenshot; the same limits main enforces on save. */
export const MAX_ASSETS = MAX_PROJECT_ASSETS;
export const MAX_ASSETS_BYTES = MAX_ASSETS_TOTAL_BYTES;

/** Why a picture cannot be added to `assets`, or null when there is room (or it is already there). */
export function assetLimit(assets: EditorAssets, id: string, byteLength: number): string | null {
  if (assets.has(id)) return null;
  if (byteLength > MAX_ASSET_BYTES) return 'That picture is too large to insert (over 32 MB).';
  if (assets.size >= MAX_ASSETS)
    return `A screenshot can hold up to ${MAX_ASSETS} inserted pictures.`;
  let total = byteLength;
  for (const asset of assets.values()) total += asset.png.byteLength;
  return total > MAX_ASSETS_BYTES
    ? 'The inserted pictures are over 64 MB. Remove one first.'
    : null;
}

/** The ids of the pictures the document's image layers use. */
export function usedAssetIds(doc: EditorDoc): Set<string> {
  const ids = new Set<string>();
  for (const annotation of doc.annotations) {
    if (annotation.type === 'image') ids.add(annotation.assetId);
  }
  return ids;
}

/** The pictures to save with a project: only those the document still uses (the rest are dropped). */
export function assetsToSave(
  doc: EditorDoc,
  assets: EditorAssets,
): { id: string; png: ArrayBuffer }[] {
  const used = usedAssetIds(doc);
  return [...assets.values()]
    .filter((asset) => used.has(asset.id))
    .map((asset) => ({ id: asset.id, png: asset.png }));
}
