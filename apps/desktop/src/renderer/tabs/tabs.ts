/**
 * The tab model of the main window: the pinned Home tab (never closes) and one tab per edited
 * item, which one shows, and which hold unsaved work. Pure (no React, no Electron), so the rules
 * are unit tested; App.tsx drives it.
 */

/** The pinned tab shows a section (its kind follows it); the others are edited items. */
export type TabKind = 'home' | 'library' | 'guides' | 'settings' | 'shot' | 'video' | 'flow';

export const HOME_ID = 'home';

export interface Tab<D = unknown> {
  /** Unique for the life of the tab. */
  id: string;
  /** What the tab shows: opening the same thing again focuses its tab instead of adding one. */
  key: string;
  kind: TabKind;
  title: string;
  /** The Home tab: always first, always there, cannot be closed or moved. */
  pinned?: boolean;
  /** Unsaved work (screenshots only: a video saves itself). */
  dirty: boolean;
  /** What the tab renders (the screenshot's session, the recording's history id). */
  data: D;
}

export interface TabsState<D = unknown> {
  tabs: Tab<D>[];
  activeId: string;
}

export type TabsAction<D = unknown> =
  | { type: 'open'; tab: Omit<Tab<D>, 'dirty'> }
  | { type: 'activate'; id: string }
  /** The tab becomes another thing in place (a viewer turns into the editor): same id and position. */
  | { type: 'replace'; id: string; key: string; kind: TabKind; data: D }
  | { type: 'close'; id: string }
  | { type: 'move'; id: string; toIndex: number }
  | { type: 'dirty'; id: string; dirty: boolean }
  | { type: 'title'; id: string; title: string }
  /** The section the pinned tab shows (its icon and label follow it). */
  | { type: 'section'; kind: TabKind; title: string }
  /** Ctrl+Tab (1) and Ctrl+Shift+Tab (-1): wraps around. */
  | { type: 'step'; delta: 1 | -1 }
  /** Alt+1..8 (0-based index); `last` is Alt+9, which always means the last tab. */
  | { type: 'index'; index: number | 'last' };

/** The state a window starts with: Home, shown. */
export function homeTabs<D>(data: D): TabsState<D> {
  return {
    tabs: [
      { id: HOME_ID, key: HOME_ID, kind: 'home', title: 'Home', pinned: true, dirty: false, data },
    ],
    activeId: HOME_ID,
  };
}

export function findByKey<D>(state: TabsState<D>, key: string): Tab<D> | undefined {
  return state.tabs.find((tab) => tab.key === key);
}

export function dirtyTabs<D>(state: TabsState<D>): Tab<D>[] {
  return state.tabs.filter((tab) => tab.dirty);
}

export function tabsReducer<D>(state: TabsState<D>, action: TabsAction<D>): TabsState<D> {
  switch (action.type) {
    case 'open': {
      const existing = findByKey(state, action.tab.key);
      if (existing)
        return state.activeId === existing.id ? state : { ...state, activeId: existing.id };
      const tab: Tab<D> = { ...action.tab, dirty: false };
      return { tabs: [...state.tabs, tab], activeId: tab.id };
    }
    case 'activate':
      return state.tabs.some((tab) => tab.id === action.id) && state.activeId !== action.id
        ? { ...state, activeId: action.id }
        : state;
    case 'replace': {
      // Another tab already shows the new thing: that one is the tab for it.
      if (state.tabs.some((tab) => tab.key === action.key && tab.id !== action.id)) return state;
      return update(state, action.id, (tab) =>
        tab.pinned
          ? tab
          : { ...tab, key: action.key, kind: action.kind, data: action.data, dirty: false },
      );
    }
    case 'close': {
      const index = state.tabs.findIndex((tab) => tab.id === action.id);
      if (index < 0 || state.tabs[index]?.pinned) return state;
      const tabs = state.tabs.filter((tab) => tab.id !== action.id);
      if (state.activeId !== action.id) return { ...state, tabs };
      // The tab that slides into the closed one's place, else the one before it (Home at worst).
      const next = tabs[index] ?? tabs[index - 1];
      return { tabs, activeId: next?.id ?? HOME_ID };
    }
    case 'move': {
      const from = state.tabs.findIndex((tab) => tab.id === action.id);
      if (from < 0 || state.tabs[from]?.pinned) return state;
      // Nothing goes before a pinned tab.
      const first = state.tabs.filter((tab) => tab.pinned).length;
      const to = Math.max(first, Math.min(state.tabs.length - 1, action.toIndex));
      if (from === to) return state;
      const tabs = [...state.tabs];
      const [moved] = tabs.splice(from, 1);
      if (moved) tabs.splice(to, 0, moved);
      return { ...state, tabs };
    }
    case 'dirty':
      return update(state, action.id, (tab) =>
        tab.dirty === action.dirty ? tab : { ...tab, dirty: action.dirty },
      );
    case 'title':
      return update(state, action.id, (tab) =>
        tab.title === action.title ? tab : { ...tab, title: action.title },
      );
    case 'section':
      return update(state, HOME_ID, (tab) =>
        tab.kind === action.kind && tab.title === action.title
          ? tab
          : { ...tab, kind: action.kind, title: action.title },
      );
    case 'step': {
      const { tabs } = state;
      const at = tabs.findIndex((tab) => tab.id === state.activeId);
      if (tabs.length < 2 || at < 0) return state;
      const next = tabs[(at + action.delta + tabs.length) % tabs.length];
      return next ? { ...state, activeId: next.id } : state;
    }
    case 'index': {
      const target = action.index === 'last' ? state.tabs.at(-1) : state.tabs[action.index];
      return target && target.id !== state.activeId ? { ...state, activeId: target.id } : state;
    }
  }
}

function update<D>(state: TabsState<D>, id: string, change: (tab: Tab<D>) => Tab<D>): TabsState<D> {
  let changed = false;
  const tabs = state.tabs.map((tab) => {
    if (tab.id !== id) return tab;
    const next = change(tab);
    changed ||= next !== tab;
    return next;
  });
  return changed ? { ...state, tabs } : state;
}

/** The tab a number key addresses: Alt+1..8 the first eight, Alt+9 the last. Null for other keys. */
export function tabIndexForDigit(digit: string): number | 'last' | null {
  if (!/^[1-9]$/.test(digit)) return null;
  return digit === '9' ? 'last' : Number(digit) - 1;
}
