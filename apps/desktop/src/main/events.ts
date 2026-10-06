import type { WebContents } from 'electron';
import type { IpcEvent, IpcEventPayload } from '../shared/ipc-contract';

/** Typed main -> renderer event. Skips destroyed webContents instead of throwing. */
export function sendEvent<E extends IpcEvent>(
  contents: WebContents,
  event: E,
  payload: IpcEventPayload<E>,
): void {
  if (!contents.isDestroyed()) contents.send(event, payload);
}
