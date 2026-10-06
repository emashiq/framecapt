import type { StartRequestEvent } from '../../shared/settings-ipc';

/**
 * Hands a "start this" request from the app root (a tray or shortcut action that needed the main
 * window) to the home view, which owns the window picker and the start buttons. A request that
 * arrives before the home view is on screen waits for it.
 */
type Listener = (request: StartRequestEvent) => void;

let pending: StartRequestEvent | null = null;
let listener: Listener | null = null;

export function requestLaunch(request: StartRequestEvent): void {
  if (listener) listener(request);
  else pending = request;
}

export function subscribeLaunch(next: Listener): () => void {
  listener = next;
  if (pending) {
    const waiting = pending;
    pending = null;
    next(waiting);
  }
  return () => {
    if (listener === next) listener = null;
  };
}
