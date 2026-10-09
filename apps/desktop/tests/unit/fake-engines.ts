import type { BrowserWindow } from 'electron';
import type { EngineWindowPool } from '../../src/main/recorder/engine-pool';

/** The part of a webContents the recorder uses (`send` is where the engine commands arrive). */
export interface FakeContents {
  id: number;
  isDestroyed: () => boolean;
  send: (event: string, payload: never) => void;
}

export interface FakeEngineWindow {
  win: BrowserWindow;
  contents: FakeContents;
  released: boolean;
  /** The window closes by itself (a crash, the user): the recording listens for it. */
  close: () => void;
}

/**
 * A stand-in for the hidden recorder windows: every acquire hands out a new fake window whose
 * webContents is `contentsFor(index)`. Nothing is created, nothing needs Electron.
 */
export function fakeEnginePool(contentsFor: (index: number) => FakeContents): EngineWindowPool & {
  windows: FakeEngineWindow[];
} {
  const windows: FakeEngineWindow[] = [];
  return {
    windows,
    acquire: () => {
      const contents = contentsFor(windows.length);
      const listeners: (() => void)[] = [];
      let closed = false;
      const entry: FakeEngineWindow = {
        contents,
        released: false,
        close: () => {
          closed = true;
          for (const listener of listeners) listener();
        },
        win: {
          webContents: contents,
          isDestroyed: () => closed,
          once: (event: string, listener: () => void) => {
            if (event === 'closed') listeners.push(listener);
          },
        } as unknown as BrowserWindow,
      };
      windows.push(entry);
      return Promise.resolve(entry.win);
    },
    release: (win) => {
      const entry = windows.find((candidate) => candidate.win === win);
      if (entry) entry.released = true;
    },
  };
}
