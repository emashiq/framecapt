import type { FrameletApi } from '../shared/types';

declare global {
  interface Window {
    /** Exposed by the preload script via contextBridge. */
    framelet: FrameletApi;
  }
}

export {};
