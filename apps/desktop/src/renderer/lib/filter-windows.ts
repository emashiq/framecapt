import type { SourceInfo } from '../../shared/capture-schemas';

/** Case-insensitive title filter for the window picker. An empty query keeps everything. */
export function filterWindows(windows: readonly SourceInfo[], query: string): SourceInfo[] {
  const needle = query.trim().toLowerCase();
  return needle
    ? windows.filter((source) => source.name.toLowerCase().includes(needle))
    : [...windows];
}
