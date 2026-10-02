import type {
  IpcChannel,
  IpcEvent,
  IpcEventPayload,
  IpcRequest,
  IpcResponse,
} from './ipc-contract';

/** Roles a Framelet window can have. One renderer bundle serves every role (see main.tsx). */
export const ROLES = ['main', 'overlay', 'toolbar', 'recorder'] as const;
export type Role = (typeof ROLES)[number];

export type IpcErrorCode =
  'FORBIDDEN' | 'INVALID_PAYLOAD' | 'UNKNOWN_CHANNEL' | 'NOT_FOUND' | 'INTERNAL';

export interface IpcFailure {
  ok: false;
  error: { code: IpcErrorCode; message: string };
}

export interface IpcSuccess<T> {
  ok: true;
  data: T;
}

/** Every IPC call resolves to this shape; raw errors never cross the bridge. */
export type IpcResult<T> = IpcSuccess<T> | IpcFailure;

/** Arguments for `invoke`: channels whose request is `undefined` take no payload. */
export type InvokeArgs<C extends IpcChannel> = [IpcRequest<C>] extends [undefined]
  ? [payload?: undefined]
  : [payload: IpcRequest<C>];

/** The only surface exposed to the renderer as `window.framelet`. */
export interface FrameletApi {
  invoke<C extends IpcChannel>(
    channel: C,
    ...args: InvokeArgs<C>
  ): Promise<IpcResult<IpcResponse<C>>>;
  on<E extends IpcEvent>(event: E, callback: (payload: IpcEventPayload<E>) => void): () => void;
}
