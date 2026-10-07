import type { ShotSessionMeta } from '../../shared/shots';
import type { FrameCaptApi } from '../../shared/types';
import { decodeToPng } from './decode';

export type ImportResult =
  | { ok: true; session: ShotSessionMeta; png: ArrayBuffer }
  | { ok: false; error: { code?: string; message?: string } };

/**
 * Turns a picture (an opened file, a dropped file, a pasted image; any format the browser decodes)
 * into an editor session: it is re-encoded as PNG here and main starts the session from that PNG.
 * Nothing is saved: an imported picture is not a capture, so the after-capture settings do not apply.
 */
export async function importPicture(
  api: Pick<FrameCaptApi, 'invoke'>,
  picture: Blob,
): Promise<ImportResult> {
  let png: ArrayBuffer;
  try {
    ({ png } = await decodeToPng(picture));
  } catch {
    return { ok: false, error: { message: 'That picture could not be read.' } };
  }
  const response = await api.invoke('shot:importImage', { png });
  return response.ok
    ? { ok: true, session: response.data.session, png }
    : { ok: false, error: response.error };
}

/** The first picture among the files of a drop or a paste, or undefined. */
export function pictureIn(files: FileList | null | undefined): File | undefined {
  return [...(files ?? [])].find((file) => file.type.startsWith('image/'));
}
