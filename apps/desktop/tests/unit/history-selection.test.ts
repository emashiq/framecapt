import { describe, expect, it } from 'vitest';
import {
  clickSelect,
  EMPTY_SELECTION,
  prune,
  selectAll,
  selectionLabel,
  selectRange,
  toggle,
} from '../../src/renderer/views/history/selection';

const ORDER = ['a', 'b', 'c', 'd', 'e'];
const ids = (selection: { ids: ReadonlySet<string> }) => [...selection.ids].sort();

describe('history selection', () => {
  it('toggles one card and remembers it as the anchor', () => {
    const one = toggle(EMPTY_SELECTION, 'b');
    expect(ids(one)).toEqual(['b']);
    expect(one.anchor).toBe('b');
    const two = toggle(one, 'd');
    expect(ids(two)).toEqual(['b', 'd']);
    expect(ids(toggle(two, 'b'))).toEqual(['d']);
  });

  it('shift selects the range from the anchor in either direction and keeps the anchor', () => {
    const start = toggle(EMPTY_SELECTION, 'b');
    const forward = selectRange(start, ORDER, 'd');
    expect(ids(forward)).toEqual(['b', 'c', 'd']);
    expect(forward.anchor).toBe('b');
    expect(ids(selectRange(forward, ORDER, 'a'))).toEqual(['a', 'b']);
    expect(ids(selectRange(toggle(EMPTY_SELECTION, 'd'), ORDER, 'b'))).toEqual(['b', 'c', 'd']);
  });

  it('shift without an anchor selects just that card', () => {
    const result = selectRange(EMPTY_SELECTION, ORDER, 'c');
    expect(ids(result)).toEqual(['c']);
    expect(result.anchor).toBe('c');
  });

  it('ctrl+shift adds the range to what was selected', () => {
    const base = toggle(toggle(EMPTY_SELECTION, 'a'), 'e'); // anchor e
    expect(ids(clickSelect(base, ORDER, 'c', { ctrl: true, shift: true }))).toEqual([
      'a',
      'c',
      'd',
      'e',
    ]);
    expect(ids(clickSelect(base, ORDER, 'c', { ctrl: false, shift: true }))).toEqual([
      'c',
      'd',
      'e',
    ]);
  });

  it('ctrl-click toggles', () => {
    const one = clickSelect(EMPTY_SELECTION, ORDER, 'c', { ctrl: true, shift: false });
    expect(ids(one)).toEqual(['c']);
    expect(ids(clickSelect(one, ORDER, 'c', { ctrl: true, shift: false }))).toEqual([]);
  });

  it('select all takes every listed card; an unknown id changes nothing', () => {
    expect(ids(selectAll(ORDER))).toEqual(ORDER);
    expect(selectAll([]).ids.size).toBe(0);
    const base = toggle(EMPTY_SELECTION, 'a');
    expect(selectRange(base, ORDER, 'zzz')).toBe(base);
  });

  it('prune drops cards that are no longer listed, and keeps the object when nothing changed', () => {
    const picked = selectRange(toggle(EMPTY_SELECTION, 'b'), ORDER, 'd');
    expect(prune(picked, ORDER)).toBe(picked);
    const pruned = prune(picked, ['a', 'c', 'e']);
    expect(ids(pruned)).toEqual(['c']);
    expect(pruned.anchor).toBeNull();
    expect(prune(EMPTY_SELECTION, [])).toBe(EMPTY_SELECTION);
  });

  it('says how many are selected', () => {
    expect(selectionLabel(1)).toBe('1 item selected');
    expect(selectionLabel(4)).toBe('4 items selected');
  });
});
