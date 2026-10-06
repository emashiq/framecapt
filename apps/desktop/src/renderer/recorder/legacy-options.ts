import { RecordOptionsSchema, type RecordOptions } from '../../shared/recorder-ipc';

/** Phase 05 kept the record options in localStorage under this key; settings.json replaced it. */
const KEY = 'framecapt.recordOptions';

/** The old saved options, or null when there are none (or they are unreadable). */
export function loadLegacyRecordOptions(): RecordOptions | null {
  try {
    const raw = window.localStorage.getItem(KEY);
    if (!raw) return null;
    const parsed = RecordOptionsSchema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

export function clearLegacyRecordOptions(): void {
  try {
    window.localStorage.removeItem(KEY);
  } catch {
    // Storage can be unavailable.
  }
}
