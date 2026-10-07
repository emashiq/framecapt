import { describe, expect, it } from 'vitest';
import {
  dirtyTabs,
  findByKey,
  HOME_ID,
  homeTabs,
  tabIndexForDigit,
  tabsReducer,
  type TabsAction,
  type TabsState,
} from '../../src/renderer/tabs/tabs';

type State = TabsState<string>;

const open = (id: string, key = id): TabsAction<string> => ({
  type: 'open',
  tab: { id, key, kind: 'shot', title: id.toUpperCase(), data: id },
});

/** Starts from the window's first state: the pinned Home tab, shown. */
function run(...actions: TabsAction<string>[]): State {
  return actions.reduce<State>((state, action) => tabsReducer(state, action), homeTabs('home'));
}
const ids = (state: State): string[] => state.tabs.map((tab) => tab.id);

describe('the pinned Home tab', () => {
  it('is there from the start, first, shown and pinned', () => {
    const state = run();
    expect(ids(state)).toEqual([HOME_ID]);
    expect(state.activeId).toBe(HOME_ID);
    expect(state.tabs[0]).toMatchObject({ pinned: true, kind: 'home', title: 'Home' });
  });

  it('cannot be closed, whether it shows or not', () => {
    const alone = run();
    expect(tabsReducer(alone, { type: 'close', id: HOME_ID })).toBe(alone);
    const withTab = run(open('a'));
    expect(tabsReducer(withTab, { type: 'close', id: HOME_ID })).toBe(withTab);
  });

  it('cannot be moved, and nothing moves in front of it', () => {
    const state = run(open('a'), open('b'));
    expect(tabsReducer(state, { type: 'move', id: HOME_ID, toIndex: 2 })).toBe(state);
    expect(ids(tabsReducer(state, { type: 'move', id: 'b', toIndex: 0 }))).toEqual([
      HOME_ID,
      'b',
      'a',
    ]);
  });

  it('shows the section it is on: icon kind and label follow', () => {
    const state = run({ type: 'section', kind: 'library', title: 'Library' });
    expect(state.tabs[0]).toMatchObject({ kind: 'library', title: 'Library', pinned: true });
    expect(tabsReducer(state, { type: 'section', kind: 'library', title: 'Library' })).toBe(state);
  });
});

describe('opening', () => {
  it('adds a tab after Home and shows it', () => {
    const state = run(open('a'), open('b'));
    expect(ids(state)).toEqual([HOME_ID, 'a', 'b']);
    expect(state.activeId).toBe('b');
    expect(state.tabs.every((tab) => !tab.dirty)).toBe(true);
  });

  it('focuses the existing tab when the same item is opened again', () => {
    const state = run(open('a', 'shot:1'), open('b', 'video:2'), open('c', 'shot:1'));
    expect(ids(state)).toEqual([HOME_ID, 'a', 'b']);
    expect(state.activeId).toBe('a');
  });

  it('finds a tab by its key', () => {
    const state = run(open('a', 'shot:1'));
    expect(findByKey(state, 'shot:1')?.id).toBe('a');
    expect(findByKey(state, 'shot:2')).toBeUndefined();
  });
});

describe('closing', () => {
  it('shows the tab that slides into the closed one, else the one before', () => {
    const three = run(open('a'), open('b'), open('c'), { type: 'activate', id: 'b' });
    const closedMiddle = tabsReducer(three, { type: 'close', id: 'b' });
    expect(ids(closedMiddle)).toEqual([HOME_ID, 'a', 'c']);
    expect(closedMiddle.activeId).toBe('c');
    const closedLast = tabsReducer(closedMiddle, { type: 'close', id: 'c' });
    expect(closedLast.activeId).toBe('a');
  });

  it('keeps the shown tab when another one closes', () => {
    const state = run(open('a'), open('b'), open('c'), { type: 'close', id: 'a' });
    expect(ids(state)).toEqual([HOME_ID, 'b', 'c']);
    expect(state.activeId).toBe('c');
  });

  it('falls back to Home after the last item tab', () => {
    const state = run(open('a'), { type: 'close', id: 'a' });
    expect(ids(state)).toEqual([HOME_ID]);
    expect(state.activeId).toBe(HOME_ID);
  });

  it('ignores a tab that is not open', () => {
    const state = run(open('a'));
    expect(tabsReducer(state, { type: 'close', id: 'zzz' })).toBe(state);
  });
});

describe('switching', () => {
  const three = run(open('a'), open('b'), open('c'));

  it('steps forward and back through Home too, wrapping around', () => {
    expect(tabsReducer(three, { type: 'step', delta: 1 }).activeId).toBe(HOME_ID);
    expect(tabsReducer(three, { type: 'step', delta: -1 }).activeId).toBe('b');
    const home = tabsReducer(three, { type: 'activate', id: HOME_ID });
    expect(tabsReducer(home, { type: 'step', delta: -1 }).activeId).toBe('c');
  });

  it('does nothing to step with only Home', () => {
    const alone = run();
    expect(tabsReducer(alone, { type: 'step', delta: 1 })).toBe(alone);
  });

  it('goes to a numbered tab (1 is Home); 9 means the last one', () => {
    expect(tabsReducer(three, { type: 'index', index: 0 }).activeId).toBe(HOME_ID);
    expect(tabsReducer(three, { type: 'index', index: 1 }).activeId).toBe('a');
    expect(tabsReducer(three, { type: 'index', index: 'last' }).activeId).toBe('c');
    // A number beyond the open tabs changes nothing.
    expect(tabsReducer(three, { type: 'index', index: 7 })).toBe(three);
  });

  it('maps the digit keys', () => {
    expect(tabIndexForDigit('1')).toBe(0);
    expect(tabIndexForDigit('8')).toBe(7);
    expect(tabIndexForDigit('9')).toBe('last');
    expect(tabIndexForDigit('0')).toBeNull();
    expect(tabIndexForDigit('a')).toBeNull();
    expect(tabIndexForDigit('')).toBeNull();
  });

  it('activating an unknown id changes nothing', () => {
    expect(tabsReducer(three, { type: 'activate', id: 'zzz' })).toBe(three);
  });
});

describe('reordering', () => {
  it('moves a tab to a place, clamped after Home, without changing which one shows', () => {
    const state = run(open('a'), open('b'), open('c'));
    const moved = tabsReducer(state, { type: 'move', id: 'c', toIndex: 1 });
    expect(ids(moved)).toEqual([HOME_ID, 'c', 'a', 'b']);
    expect(moved.activeId).toBe('c');
    expect(ids(tabsReducer(state, { type: 'move', id: 'a', toIndex: 99 }))).toEqual([
      HOME_ID,
      'b',
      'c',
      'a',
    ]);
    expect(tabsReducer(state, { type: 'move', id: 'b', toIndex: 2 })).toBe(state);
  });
});

describe('unsaved work', () => {
  it('tracks which tabs are dirty and leaves the others as they were', () => {
    const state = run(open('a'), open('b'), { type: 'dirty', id: 'b', dirty: true });
    expect(dirtyTabs(state).map((tab) => tab.id)).toEqual(['b']);
    const clean = tabsReducer(state, { type: 'dirty', id: 'b', dirty: false });
    expect(dirtyTabs(clean)).toEqual([]);
  });

  it('returns the same state when nothing changes', () => {
    const state = run(open('a'), { type: 'dirty', id: 'a', dirty: true });
    expect(tabsReducer(state, { type: 'dirty', id: 'a', dirty: true })).toBe(state);
    expect(tabsReducer(state, { type: 'dirty', id: 'zzz', dirty: true })).toBe(state);
  });

  it('a closed dirty tab no longer counts', () => {
    const state = run(
      open('a'),
      { type: 'dirty', id: 'a', dirty: true },
      { type: 'close', id: 'a' },
    );
    expect(dirtyTabs(state)).toEqual([]);
  });

  it('renames a tab', () => {
    const state = run(open('a'), { type: 'title', id: 'a', title: 'shot.png' });
    expect(state.tabs[1]?.title).toBe('shot.png');
  });
});
