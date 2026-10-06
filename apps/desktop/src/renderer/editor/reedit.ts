import type { ImageFormat, ShotSessionMeta } from '../../shared/shots';
import type { FrameCaptApi } from '../../shared/types';
import { migrateDoc } from './model/migrate';
import type { EditorDoc } from './model/types';

/** What the editor knows about a screenshot opened from History. */
export interface ReeditInfo {
  historyId: string;
  /** The format of the history file: "Save changes" keeps it. */
  format: ImageFormat;
  mode: 'project' | 'flattened';
  /** The stored annotations, validated and migrated (project mode), else null. */
  doc: EditorDoc | null;
  /** One sentence for the user above the canvas, or null. */
  notice: string | null;
}

export interface ReeditShot {
  session: ShotSessionMeta;
  png: ArrayBuffer;
  edit: ReeditInfo;
}

export const FLATTENED_LABEL = 'Editing a flattened copy: earlier annotations cannot be changed.';

export type OpenResult =
  { ok: true; shot: ReeditShot } | { ok: false; error: { code?: string; message?: string } };

/**
 * Opens a history screenshot in a new editor session. When main hands over an editable project the
 * annotations are validated here; if this build cannot read them (damaged, a newer version) the
 * session is dropped and the saved image is opened instead, so the unredacted original is never
 * shown without the redactions that were drawn on it.
 */
export async function openFromHistory(
  api: Pick<FrameCaptApi, 'invoke'>,
  historyId: string,
): Promise<OpenResult> {
  let response = await api.invoke('shot:openFromHistory', { historyId });
  if (!response.ok) return { ok: false, error: response.error };
  let reason: string | null = response.data.edit.notice;
  let doc: EditorDoc | null = null;

  if (response.data.edit.mode === 'project' && response.data.edit.doc) {
    const { width, height } = response.data.session;
    const migrated = migrateDoc(response.data.edit.doc, { width, height });
    // A mark that cannot be read could be a redaction: the saved image is opened instead of a
    // project with parts missing.
    if (migrated.ok && migrated.dropped === 0) {
      doc = migrated.doc;
    } else {
      void api.invoke('shot:discard', { sessionId: response.data.session.id });
      reason =
        !migrated.ok && migrated.reason === 'newer_schema'
          ? 'This screenshot was edited with a newer FrameCapt.'
          : 'The editable data of this screenshot could not be used.';
      response = await api.invoke('shot:openFromHistory', {
        historyId,
        flattened: true,
      });
      if (!response.ok) return { ok: false, error: response.error };
    }
  }
  const { session, png, edit } = response.data;
  const flattened = doc === null;
  return {
    ok: true,
    shot: {
      session,
      png,
      edit: {
        historyId: edit.historyId,
        format: edit.format,
        mode: flattened ? 'flattened' : 'project',
        doc,
        notice: flattened ? [reason, FLATTENED_LABEL].filter(Boolean).join(' ') : reason,
      },
    },
  };
}
