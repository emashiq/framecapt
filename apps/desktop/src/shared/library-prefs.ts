/** The Library's view options (a convenience kept in the browser storage), and how a stored value is read. */

export type LibraryViewMode = 'grid' | 'list';
export type LibrarySort = 'newest' | 'oldest' | 'name' | 'size';

export interface LibraryPrefs {
  /** The folder sidebar is hidden (Ctrl+B). */
  sidebarCollapsed: boolean;
  /** Width of the sidebar in px, 200..360. */
  sidebarWidth: number;
  view: LibraryViewMode;
  sort: LibrarySort;
  /** A folder also shows what is in its subfolders. */
  includeSubfolders: boolean;
}

export const SIDEBAR_MIN = 200;
export const SIDEBAR_MAX = 360;
export const SIDEBAR_DEFAULT = 240;

export const DEFAULT_PREFS: LibraryPrefs = {
  sidebarCollapsed: false,
  sidebarWidth: SIDEBAR_DEFAULT,
  view: 'grid',
  sort: 'newest',
  includeSubfolders: true,
};

export const clampWidth = (value: number): number =>
  Math.round(Math.max(SIDEBAR_MIN, Math.min(SIDEBAR_MAX, value)));

/** Parses what was stored; anything that is not a valid value falls back to its default. */
export function parsePrefs(raw: string | null): LibraryPrefs {
  if (!raw) return DEFAULT_PREFS;
  try {
    const value = JSON.parse(raw) as Partial<Record<keyof LibraryPrefs, unknown>>;
    return {
      sidebarCollapsed: value.sidebarCollapsed === true,
      sidebarWidth:
        typeof value.sidebarWidth === 'number' && Number.isFinite(value.sidebarWidth)
          ? clampWidth(value.sidebarWidth)
          : DEFAULT_PREFS.sidebarWidth,
      view: value.view === 'list' ? 'list' : 'grid',
      sort:
        value.sort === 'oldest' || value.sort === 'name' || value.sort === 'size'
          ? value.sort
          : 'newest',
      includeSubfolders: value.includeSubfolders !== false,
    };
  } catch {
    return DEFAULT_PREFS;
  }
}
