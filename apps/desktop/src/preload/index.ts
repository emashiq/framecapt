import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron';
import { isIpcChannel, isIpcEvent } from '../shared/ipc-contract';
import type { FrameCaptApi, IpcResult } from '../shared/types';

/**
 * The only bridge between renderer and main. ipcRenderer itself is never exposed; the renderer can
 * only call channels and subscribe to events that exist in the shared contract. Payload validation
 * and role/origin checks happen in main.
 */
const api: FrameCaptApi = {
  invoke(channel, ...args) {
    if (!isIpcChannel(channel)) {
      const failure: IpcResult<never> = {
        ok: false,
        error: { code: 'UNKNOWN_CHANNEL', message: 'Unknown channel.' },
      };
      return Promise.resolve(failure);
    }
    return ipcRenderer.invoke(channel, args[0]);
  },

  on(event, callback) {
    if (!isIpcEvent(event)) return () => undefined;
    const listener = (_event: IpcRendererEvent, payload: unknown): void =>
      callback(payload as never);
    ipcRenderer.on(event, listener);
    return () => {
      ipcRenderer.removeListener(event, listener);
    };
  },
};

contextBridge.exposeInMainWorld('framecapt', api);
