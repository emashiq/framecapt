import { ipcMain, type IpcMainInvokeEvent } from 'electron';
import {
  ipcContract,
  type IpcChannel,
  type IpcParsedRequest,
  type IpcResponse,
} from '../shared/ipc-contract';
import type { Role } from '../shared/types';
import { checkSender, fail, runChannel } from './ipc-core';
import { log } from './logger';
import { getOriginConfig, getRole } from './windows';

export interface HandlerContext {
  role: Role;
  webContentsId: number;
}

export type Handler<C extends IpcChannel> = (
  payload: IpcParsedRequest<C>,
  context: HandlerContext,
) => IpcResponse<C> | Promise<IpcResponse<C>>;

/**
 * Registers a typed invoke handler. Every call is checked for (1) a registered sender with an
 * allowed role, (2) a top-level frame on the app origin, (3) a payload matching the contract
 * schema. The renderer always receives an IpcResult and never a raw error.
 */
export function handle<C extends IpcChannel>(
  channel: C,
  options: { roles: readonly Role[] },
  handler: Handler<C>,
): void {
  const def = ipcContract[channel];
  const contractRoles: readonly Role[] = def.roles;
  if (options.roles.some((role) => !contractRoles.includes(role))) {
    throw new Error(`Handler for ${channel} allows roles outside the contract`);
  }

  ipcMain.handle(channel, async (event: IpcMainInvokeEvent, rawPayload: unknown) => {
    const role = getRole(event.sender.id);
    const frame = event.senderFrame;
    const denied = checkSender(
      { role, frameUrl: frame?.url, isTopFrame: frame != null && frame.parent === null },
      options.roles,
      getOriginConfig(),
    );
    if (denied || role === undefined) {
      log.warn(`Rejected IPC ${channel} from webContents ${event.sender.id}`);
      return denied ?? fail('FORBIDDEN', 'Caller is not allowed to use this channel.');
    }
    return runChannel(
      def,
      rawPayload,
      (payload) =>
        handler(payload as IpcParsedRequest<C>, { role, webContentsId: event.sender.id }),
      (error) => log.error(`IPC ${channel} handler failed`, error),
    );
  });
}
