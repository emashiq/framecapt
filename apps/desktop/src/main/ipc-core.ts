import { isAppUrl, type AppOriginConfig } from './app-origin';
import type { ChannelDef } from '../shared/ipc-contract';
import type { IpcErrorCode, IpcFailure, IpcResult, Role } from '../shared/types';

/** What main knows about the caller, extracted from the Electron event. Electron-free. */
export interface SenderInfo {
  /** Role registered for event.sender, or undefined when the webContents is unknown. */
  role: Role | undefined;
  /** event.senderFrame.url, or undefined when the frame is gone. */
  frameUrl: string | undefined;
  /** True only for the top-level frame (senderFrame.parent === null). */
  isTopFrame: boolean;
}

export function ok<T>(data: T): IpcResult<T> {
  return { ok: true, data };
}

export function fail(code: IpcErrorCode, message: string): IpcFailure {
  return { ok: false, error: { code, message } };
}

/** An error whose code and message are safe to show to the renderer. */
export class IpcError extends Error {
  readonly code: IpcErrorCode;
  constructor(code: IpcErrorCode, message: string) {
    super(message);
    this.name = 'IpcError';
    this.code = code;
  }
}

/** Returns a failure when the sender is not allowed to call a channel, otherwise null. */
export function checkSender(
  sender: SenderInfo,
  allowedRoles: readonly Role[],
  origin: AppOriginConfig,
): IpcFailure | null {
  if (sender.role === undefined || !allowedRoles.includes(sender.role)) {
    return fail('FORBIDDEN', 'Caller is not allowed to use this channel.');
  }
  if (!sender.isTopFrame || !isAppUrl(sender.frameUrl, origin)) {
    return fail('FORBIDDEN', 'Caller frame is not trusted.');
  }
  return null;
}

/**
 * Validates the payload with the channel schema, runs the handler and wraps the outcome. Never
 * throws: unexpected errors are reported through `onInternalError` and replaced by a generic
 * message so internal details do not reach the renderer.
 */
export async function runChannel<D extends ChannelDef>(
  def: D,
  rawPayload: unknown,
  handler: (payload: never) => unknown,
  onInternalError: (error: unknown) => void,
): Promise<IpcResult<unknown>> {
  const parsed = def.request.safeParse(rawPayload);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const where = issue?.path.length ? ` (${issue.path.join('.')})` : '';
    return fail('INVALID_PAYLOAD', `Invalid request${where}.`);
  }
  try {
    return ok(await handler(parsed.data as never));
  } catch (error) {
    if (error instanceof IpcError) return fail(error.code, error.message);
    onInternalError(error);
    return fail('INTERNAL', 'Something went wrong.');
  }
}
