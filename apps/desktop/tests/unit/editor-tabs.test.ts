import { describe, expect, it } from 'vitest';
import {
  dirtyTabs,
  emptyTabs,
  findByKey,
  tabIndexForDigit,
  tabsReducer,
  type TabsAction,
  type TabsState,
} from '../../src/renderer/editor-window/tabs';

type State = TabsState<string>;

const open = (id: string, key = id): TabsAction<string> => ({
  type: 'open',
  tab: { id, key, kind: 'shot', title: id.toUpperCase(), data: id },
});

function run(...actions: TabsAction<string>[]): State {
  return actions.reduce<State>((state, action) => tabsReducer(state, action), emptyTabs as State);
}
const ids = (state: State): string[] => state.tabs.map((tab) => tab.id);

describe('opening', () => {
  it('adds a tab and shows it', () => {
    const state = run(open('a'), open('b'));
    expect(ids(state)).toEqual(['a', 'b']);
    expect(state.activeId).toBe('b');
    expect(state.tabs.every((tab) => !tab.dirty)).toBe(true);
  });

  it('focuses the existing tab when the same item is opened again', () => {
    const state = run(open('a', 'shot:1'), open('b', 'video:2'), open('c', 'shot:1'));
    expect(ids(state)).toEqual(['a', 'b']);
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
    expect(ids(closedMiddle)).toEqual(['a', 'c']);
    expect(closedMiddle.activeId).toBe('c');
    const closedLast = tabsReducer(closedMiddle, { type: 'close', id: 'c' });
    expect(closedLast.activeId).toBe('a');
  });

  it('keeps the shown tab when another one closes', () => {
    const state = run(open('a'), open('b'), open('c'), { type: 'close', id: 'a' });
    expect(ids(state)).toEqual(['b', 'c']);
    expect(state.activeId).toBe('c');
  });

  it('ends with nothing shown after the last tab', () => {
    const state = run(open('a'), { type: 'close', id: 'a' });
    expect(state).toEqual({ tabs: [], activeId: null });
  });

  it('ignores a tab that is not open', () => {
    const state = run(open('a'));
    expect(tabsReducer(state, { type: 'close', id: 'zzz' })).toBe(state);
  });
});

describe('switching', () => {
  const three = run(open('a'), open('b'), open('c'));

  it('steps forward and back, wrapping around', () => {
    expect(tabsReducer(three, { type: 'step', delta: 1 }).activeId).toBe('a');
    expect(tabsReducer(three, { type: 'step', delta: -1 }).activeId).toBe('b');
  });

  it('does nothing to step with fewer than two tabs', () => {
    const one = run(open('a'));
    expect(tabsReducer(one, { type: 'step', delta: 1 })).toBe(one);
    expect(tabsReducer(emptyTabs as State, { type: 'step', delta: 1 }).activeId).toBeNull();
  });

  it('goes to a numbered tab; 9 means the last one', () => {
    expect(tabsReducer(three, { type: 'index', index: 0 }).activeId).toBe('a');
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
  it('moves a tab to a place, clamped, without changing which one shows', () => {
    const state = run(open('a'), open('b'), open('c'));
    const moved = tabsReducer(state, { type: 'move', id: 'c', toIndex: 0 });
    expect(ids(moved)).toEqual(['c', 'a', 'b']);
    expect(moved.activeId).toBe('c');
    expect(ids(tabsReducer(state, { type: 'move', id: 'a', toIndex: 99 }))).toEqual([
      'b',
      'c',
      'a',
    ]);
    expect(tabsReducer(state, { type: 'move', id: 'b', toIndex: 1 })).toBe(state);
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
    expect(state.tabs[0]?.title).toBe('shot.png');
  });
});
