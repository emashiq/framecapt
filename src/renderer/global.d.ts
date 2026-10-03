import type { FrameCaptApi } from '../shared/types';

declare global {
  interface Window {
    /** Exposed by the preload script via contextBridge. */
    framecapt: FrameCaptApi;
  }
}

export {};
