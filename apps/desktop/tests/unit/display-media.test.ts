/**
 * The place pixels actually leave the OS: the one-shot capture grant and the display-media request
 * handler. A stream is only handed out for a grant main created after validating the source.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const hoisted = vi.hoisted(() => ({
  handlers: new Map<string, (request: unknown, ctx: { webContentsId: number }) => unknown>(),
}));

vi.mock('electron', () => ({
  webContents: { fromFrame: () => ({ id: 7 }) },
}));
vi.mock('../../src/main/ipc', () => ({
  handle: (
    channel: string,
    _options: unknown,
    handler: (request: unknown, ctx: { webContentsId: number }) => unknown,
  ) => hoisted.handlers.set(channel, handler),
}));
vi.mock('../../src/main/logger', () => ({
  log: { info: () => undefined, warn: () => undefined, error: () => undefined },
}));

import { installDisplayMediaGrants } from '../../src/main/capture/display-media';
import type { CaptureProvider } from '../../src/main/capture/types';

const SOURCE = { id: 'screen:1:0', name: 'Screen 1', kind: 'screen' as const, displayId: '1' };

const provider: CaptureProvider = {
  listDisplays: () => [],
  listSources: async () => [SOURCE],
};

describe('capture grant and display-media request', () => {
  let displayMediaHandler: (
    request: {
      frame: unknown;
      videoRequested: boolean;
      audioRequested: boolean;
      userGesture: boolean;
    },
    callback: (streams: unknown) => void,
  ) => void;

  beforeEach(() => {
    hoisted.handlers.clear();
    const session = {
      setDisplayMediaRequestHandler: (handler: typeof displayMediaHandler) => {
        displayMediaHandler = handler;
      },
    };
    installDisplayMediaGrants(
      session as never,
      provider,
      () => ({ production: true, devServerUrl: null }) as never,
    );
  });

  const frame = { parent: null, url: 'app://framecapt/index.html' };
  const request = { frame, videoRequested: true, audioRequested: false, userGesture: true };
  const grant = (sourceId = SOURCE.id): unknown =>
    hoisted.handlers.get('capture:grant')?.({ sourceId, systemAudio: false }, { webContentsId: 7 });

  it('capture:grant creates a grant for a listed source', async () => {
    expect(await grant()).toMatchObject({ grantId: expect.any(String) });
  });

  it('capture:grant refuses a source that is not listed', async () => {
    await expect(Promise.resolve().then(() => grant('screen:99:0'))).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
  });

  it('a stream is only handed out for a grant, once', async () => {
    const withoutGrant = vi.fn();
    displayMediaHandler(request, withoutGrant);
    expect(withoutGrant).toHaveBeenCalledWith({});

    await grant();
    const granted = vi.fn();
    displayMediaHandler(request, granted);
    expect(granted).toHaveBeenCalledWith(expect.objectContaining({ video: expect.anything() }));

    const again = vi.fn();
    displayMediaHandler(request, again);
    expect(again).toHaveBeenCalledWith({});
  });

  it('a request from a subframe or without video is denied', async () => {
    await grant();
    const subframe = vi.fn();
    displayMediaHandler({ ...request, frame: { parent: {}, url: frame.url } }, subframe);
    expect(subframe).toHaveBeenCalledWith({});
    const noVideo = vi.fn();
    displayMediaHandler({ ...request, videoRequested: false }, noVideo);
    expect(noVideo).toHaveBeenCalledWith({});
  });
});
