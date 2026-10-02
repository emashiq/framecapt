import { useCallback, useState } from 'react';
import {
  DEFAULT_RECORD_OPTIONS,
  RecordOptionsSchema,
  type RecordOptions,
} from '../../shared/recorder-ipc';

const KEY = 'framelet.recordOptions';

/** Reads the saved options; anything missing or invalid falls back to the defaults. */
export function loadRecordOptions(): RecordOptions {
  try {
    const raw = window.localStorage.getItem(KEY);
    if (!raw) return DEFAULT_RECORD_OPTIONS;
    const parsed = RecordOptionsSchema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : DEFAULT_RECORD_OPTIONS;
  } catch {
    return DEFAULT_RECORD_OPTIONS;
  }
}

function saveRecordOptions(options: RecordOptions): void {
  try {
    window.localStorage.setItem(KEY, JSON.stringify(options));
  } catch {
    // Storage can be unavailable; the options then last for this session only.
  }
}

/** Record options kept in renderer localStorage until settings (phase 08) take over. */
export function useRecordOptions(): [RecordOptions, (next: RecordOptions) => void] {
  const [options, setOptions] = useState<RecordOptions>(loadRecordOptions);
  const update = useCallback((next: RecordOptions) => {
    setOptions(next);
    saveRecordOptions(next);
  }, []);
  return [options, update];
}
