import path from 'node:path';
import type { HistoryFormat, HistorySource, HistoryType } from '../../shared/history-ipc';

export interface Searchable {
  type: HistoryType;
  createdAt: number;
  path: string;
  format: HistoryFormat;
  source: HistorySource;
}

const two = (value: number): string => String(value).padStart(2, '0');

/** Everything a person might type to find an item: its name, kind, format and the date in a few spellings. */
export function searchText(item: Searchable): string {
  const date = new Date(item.createdAt);
  const iso = `${date.getFullYear()}-${two(date.getMonth() + 1)}-${two(date.getDate())}`;
  const long = date.toLocaleDateString('en-US', {
    weekday: 'long',
    month: 'long',
    day: 'numeric',
    year: 'numeric',
  });
  const kind = item.type === 'screenshot' ? 'screenshot image' : 'recording video';
  return [path.basename(item.path), kind, item.format, item.source, iso, long]
    .join(' ')
    .toLowerCase();
}

/** Every whitespace-separated word of `query` must appear (case-insensitive); an empty query matches. */
export function matchesQuery(item: Searchable, query: string): boolean {
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (terms.length === 0) return true;
  const text = searchText(item);
  return terms.every((term) => text.includes(term));
}
