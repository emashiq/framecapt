/**
 * Multi-selection of history cards. Pure functions over an ordered list of ids (the grid order), so
 * the rules are unit tested without a DOM. `anchor` is the card a shift-range starts from: the one
 * last clicked or toggled.
 */
export interface Selection {
  readonly ids: ReadonlySet<string>;
  readonly anchor: string | null;
}

export const EMPTY_SELECTION: Selection = { ids: new Set(), anchor: null };

export interface ClickModifiers {
  ctrl: boolean;
  shift: boolean;
}

/** Adds or removes one id; it becomes the anchor of later ranges. */
export function toggle(selection: Selection, id: string): Selection {
  const ids = new Set(selection.ids);
  if (!ids.delete(id)) ids.add(id);
  return { ids, anchor: id };
}

/**
 * The cards between the anchor and `id`, both included. Without an anchor (or when it is no longer
 * listed) it selects just `id`. `additive` keeps what was selected (Ctrl+Shift), else the range replaces it.
 */
export function selectRange(
  selection: Selection,
  order: readonly string[],
  id: string,
  additive = false,
): Selection {
  const to = order.indexOf(id);
  if (to < 0) return selection;
  const from = selection.anchor === null ? -1 : order.indexOf(selection.anchor);
  const start = from < 0 ? to : Math.min(from, to);
  const end = from < 0 ? to : Math.max(from, to);
  const ids = new Set(additive ? selection.ids : []);
  for (const picked of order.slice(start, end + 1)) ids.add(picked);
  // The anchor stays, so a second shift-click re-draws the range from the same card.
  return { ids, anchor: from < 0 ? id : selection.anchor };
}

export function selectAll(order: readonly string[]): Selection {
  return { ids: new Set(order), anchor: order[0] ?? null };
}

/** What a click on a card with a modifier key does: Shift = range, Ctrl = toggle. */
export function clickSelect(
  selection: Selection,
  order: readonly string[],
  id: string,
  modifiers: ClickModifiers,
): Selection {
  if (modifiers.shift) return selectRange(selection, order, id, modifiers.ctrl);
  return toggle(selection, id);
}

/** Drops ids that are no longer listed (removed, filtered out). Returns the same object when nothing changed. */
export function prune(selection: Selection, order: readonly string[]): Selection {
  if (selection.ids.size === 0) return selection;
  const listed = new Set(order);
  const kept = [...selection.ids].filter((id) => listed.has(id));
  if (kept.length === selection.ids.size) return selection;
  return {
    ids: new Set(kept),
    anchor: selection.anchor !== null && listed.has(selection.anchor) ? selection.anchor : null,
  };
}

/** "3 items selected" for the bar and the screen reader. */
export function selectionLabel(count: number): string {
  return `${count} ${count === 1 ? 'item' : 'items'} selected`;
}
