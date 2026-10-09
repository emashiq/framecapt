/**
 * "Ready" is per recorder window: each recording has a hidden window of its own, and one window
 * announcing itself must not make another one look ready.
 */
import { beforeAll, describe, expect, it, vi } from 'vitest';

const hoisted = vi.hoisted(() => ({
  handlers: new Map<string, (request: unknown, ctx: { webContentsId: number }) => void>(),
}));

vi.mock('../../src/main/ipc', () => ({
  handle: (
    channel: string,
    _options: unknown,
    handler: (request: unknown, ctx: { webContentsId: number }) => void,
  ) => void hoisted.handlers.set(channel, handler),
}));
vi.mock('../../src/main/windows', () => ({ getWorkerWindow: () => undefined }));
vi.mock('../../src/main/logger', () => ({
  log: { info: () => undefined, warn: () => undefined, error: () => undefined },
}));
vi.mock('../../src/main/events', () => ({ sendEvent: () => undefined }));

import type { BrowserWindow } from 'electron';
import { registerWorkerHandlers, whenReady } from '../../src/main/worker';

function fakeWindow(id: number) {
  const listeners: (() => void)[] = [];
  const win = {
    webContents: { id },
    once: (_event: string, listener: () => void) => void listeners.push(listener),
  } as unknown as BrowserWindow;
  return { win, close: () => listeners.forEach((listener) => listener()) };
}

const announce = (webContentsId: number) =>
  hoisted.handlers.get('worker:ready')?.(undefined, { webContentsId });
const settled = async (promise: Promise<void>): Promise<'ready' | 'pending' | 'rejected'> =>
  Promise.race([
    promise.then(
      () => 'ready' as const,
      () => 'rejected' as const,
    ),
    new Promise<'pending'>((resolve) => setTimeout(() => resolve('pending'), 20)),
  ]);

beforeAll(() => registerWorkerHandlers());

describe('whenReady', () => {
  it('a window is ready when it announces itself, and only that window', async () => {
    const a = fakeWindow(101);
    const b = fakeWindow(102);
    const ready = whenReady(a.win);
    const other = whenReady(b.win);
    expect(await settled(ready)).toBe('pending');
    announce(102);
    expect(await settled(other)).toBe('ready');
    expect(await settled(ready)).toBe('pending');
    announce(101);
    expect(await settled(ready)).toBe('ready');
  });

  it('a window that announced itself before anyone asked is ready at once', async () => {
    announce(103);
    expect(await settled(whenReady(fakeWindow(103).win))).toBe('ready');
  });

  it('a window that closes before it is ready rejects', async () => {
    const a = fakeWindow(104);
    const ready = whenReady(a.win);
    a.close();
    expect(await settled(ready)).toBe('rejected');
  });
});
