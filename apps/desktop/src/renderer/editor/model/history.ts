import { apply, type Command } from './commands';
import type { EditorDoc } from './types';

export const MAX_HISTORY = 200;

/**
 * Undo/redo over whole immutable documents (cheap: unchanged parts are shared). `gesture` is the
 * key of the continuous gesture (a drag) that produced the latest entry, so further commands with
 * the same key replace the present instead of adding one undo step per pointer move.
 */
export interface History {
  past: EditorDoc[];
  present: EditorDoc;
  future: EditorDoc[];
  gesture: string | null;
}

export function createHistory(doc: EditorDoc): History {
  return { past: [], present: doc, future: [], gesture: null };
}

/**
 * Applies a command. No-op commands return the same history. A command with a `gesture` key equal
 * to the history's current gesture is merged into the existing undo entry.
 */
export function commit(history: History, command: Command, gesture?: string): History {
  const next = apply(history.present, command);
  if (next === history.present) return history;
  if (gesture !== undefined && history.gesture === gesture) {
    return { ...history, present: next };
  }
  const past = [...history.past, history.present];
  if (past.length > MAX_HISTORY) past.splice(0, past.length - MAX_HISTORY);
  return { past, present: next, future: [], gesture: gesture ?? null };
}

/** Ends the current gesture: the next command starts a new undo entry. */
export function endGesture(history: History): History {
  return history.gesture === null ? history : { ...history, gesture: null };
}

export function canUndo(history: History): boolean {
  return history.past.length > 0;
}

export function canRedo(history: History): boolean {
  return history.future.length > 0;
}

export function undo(history: History): History {
  const previous = history.past[history.past.length - 1];
  if (!previous) return history;
  return {
    past: history.past.slice(0, -1),
    present: previous,
    future: [history.present, ...history.future],
    gesture: null,
  };
}

export function redo(history: History): History {
  const [next, ...rest] = history.future;
  if (!next) return history;
  return {
    past: [...history.past, history.present],
    present: next,
    future: rest,
    gesture: null,
  };
}
