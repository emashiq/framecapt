import { applyCommand, type VideoCommand, type VideoProject } from './video-edit';

export const MAX_VIDEO_HISTORY = 200;

/**
 * Undo/redo over whole immutable projects (the same approach as the screenshot editor's
 * editor/model/history.ts). `gesture` is the key of the continuous gesture (a drag, a slider) that
 * produced the latest entry: further commands with the same key replace the present instead of
 * adding one undo step per pointer move.
 */
export interface VideoHistory {
  past: VideoProject[];
  present: VideoProject;
  future: VideoProject[];
  gesture: string | null;
}

export function createVideoHistory(project: VideoProject): VideoHistory {
  return { past: [], present: project, future: [], gesture: null };
}

/** No-op commands return the same history; a command with the current gesture key is merged. */
export function commitVideo(
  history: VideoHistory,
  command: VideoCommand,
  gesture?: string,
): VideoHistory {
  const next = applyCommand(history.present, command);
  if (next === history.present) return history;
  if (gesture !== undefined && history.gesture === gesture) {
    return { ...history, present: next };
  }
  const past = [...history.past, history.present];
  if (past.length > MAX_VIDEO_HISTORY) past.splice(0, past.length - MAX_VIDEO_HISTORY);
  return { past, present: next, future: [], gesture: gesture ?? null };
}

/** Ends the current gesture: the next command starts a new undo entry. */
export function endVideoGesture(history: VideoHistory): VideoHistory {
  return history.gesture === null ? history : { ...history, gesture: null };
}

export const canUndoVideo = (history: VideoHistory): boolean => history.past.length > 0;
export const canRedoVideo = (history: VideoHistory): boolean => history.future.length > 0;

export function undoVideo(history: VideoHistory): VideoHistory {
  const previous = history.past[history.past.length - 1];
  if (!previous) return history;
  return {
    past: history.past.slice(0, -1),
    present: previous,
    future: [history.present, ...history.future],
    gesture: null,
  };
}

export function redoVideo(history: VideoHistory): VideoHistory {
  const [next, ...rest] = history.future;
  if (!next) return history;
  return {
    past: [...history.past, history.present],
    present: next,
    future: rest,
    gesture: null,
  };
}
