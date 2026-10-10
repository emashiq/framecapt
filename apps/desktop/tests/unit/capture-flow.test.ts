/**
 * CaptureFlow during a recording (saved directly, main window untouched, no editor), the window
 * refusal, and the all-screens screenshot (every display joined at its place on the desktop).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const hoisted = vi.hoisted(() => {
  const main = {
    isVisible: () => true,
    isMinimized: () => false,
    hide: vi.fn(),
    show: vi.fn(),
    focus: vi.fn(),
    restore: vi.fn(),
    once: (_event: string, callback: () => void) => callback(),
    webContents: { id: 1 },
  };
  return {
    main,
    events: [] as string[],
    frames: new Map<string, { width: number; height: number }>(),
  };
});

/** A fake "PNG": the JSON of the size, so the mocks below can read it back. */
const fakePng = (width: number, height: number): Buffer =>
  Buffer.from(JSON.stringify({ width, height }));
const sizeOf = (png: Buffer): { width: number; height: number } =>
  JSON.parse(png.toString()) as { width: number; height: number };

vi.mock('electron', () => ({
  nativeImage: {
    createFromBuffer: (png: Buffer) => {
      const { width, height } = sizeOf(png);
      return {
        getSize: () => ({ width, height }),
        toBitmap: () => Buffer.alloc(width * height * 4, 7),
        toPNG: () => png,
      };
    },
    createFromBitmap: (bitmap: Buffer, options: { width: number; height: number }) => ({
      toPNG: () => fakePng(options.width, options.height),
      opaque: bitmap.every((byte) => byte === 7),
    }),
  },
  screen: {
    on: vi.fn(),
    removeListener: vi.fn(),
    dipToScreenRect: (_window: unknown, rect: { x: number; y: number }) => ({ ...rect }),
  },
}));
vi.mock('../../src/main/logger', () => ({
  log: { info: () => undefined, warn: () => undefined, error: () => undefined },
}));
vi.mock('../../src/main/windows', () => ({ getMainWindow: () => hoisted.main }));
vi.mock('../../src/main/events', () => ({
  sendEvent: (_contents: unknown, event: string) => hoisted.events.push(event),
}));
vi.mock('../../src/main/overlay', () => ({ OverlaySet: class {} }));
vi.mock('../../src/main/capture/exact-capture', () => ({
  grabScreensExact: vi.fn(),
  grabWindowExact: vi.fn(),
}));
vi.mock('../../src/main/worker', () => ({
  WorkerError: class extends Error {},
  requestFrames: async (sources: { sourceId: string; displayId?: string }[]) =>
    sources.map((source) => {
      const size = hoisted.frames.get(source.displayId ?? '') ?? { width: 4, height: 3 };
      return { sourceId: source.sourceId, ...size, png: fakePng(size.width, size.height) };
    }),
}));

import { CaptureFlow, type CaptureFlowDeps } from '../../src/main/capture-flow';
import type { DisplayInfo } from '../../src/main/capture/types';
import { MAX_FRAME_DIMENSION } from '../../src/shared/shots';

function display(id: string, x: number, y: number, width: number, height: number): DisplayInfo {
  return {
    id,
    label: `Display ${id}`,
    bounds: { x, y, width, height },
    scaleFactor: 1,
    rotation: 0,
    physicalSize: { width, height },
    isPrimary: id === '1',
  };
}

function setup(displays: DisplayInfo[], extra: Partial<CaptureFlowDeps> = {}) {
  const saveDirect = vi.fn(async () => ({ savedPath: 'C:\\shots\\a.png' }));
  const toast = vi.fn();
  const openEditor = vi.fn();
  const create = vi.fn(async () => ({ id: 's1' }));
  const deps: CaptureFlowDeps = {
    provider: {
      listDisplays: () => displays,
      listSources: async () =>
        displays.map((item) => ({
          id: `screen:${item.id}:0`,
          name: item.label,
          kind: 'screen' as const,
          displayId: item.id,
        })),
    },
    store: { create, meta: (session: unknown) => session, discard: vi.fn() } as never,
    synthetic: true,
    saveDirect,
    toast,
    openEditor,
    ...extra,
  };
  const flow = new CaptureFlow(deps);
  return { flow, saveDirect, toast, create, openEditor };
}

const ended = async (flow: CaptureFlow): Promise<void> => {
  await vi.waitFor(() => expect(flow.state.active).toBe(false));
};

beforeEach(() => {
  hoisted.events.length = 0;
  hoisted.frames.clear();
  for (const fn of [hoisted.main.hide, hoisted.main.show, hoisted.main.focus]) fn.mockClear();
});

describe('a screenshot during a recording', () => {
  it('is saved directly and never touches the main window or opens the editor', async () => {
    const { flow, saveDirect, toast, create, openEditor } = setup([display('1', 0, 0, 4, 3)], {
      isRecording: () => true,
    });
    await flow.start({ target: 'screen' });
    expect(flow.duringRecording).toBe(true);
    await ended(flow);
    expect(saveDirect).toHaveBeenCalledWith(expect.objectContaining({ kind: 'screen' }));
    expect(toast).toHaveBeenCalledWith({ level: 'info', message: 'Screenshot saved' });
    expect(create).not.toHaveBeenCalled();
    expect(hoisted.main.hide).not.toHaveBeenCalled();
    expect(hoisted.main.show).not.toHaveBeenCalled();
    expect(hoisted.main.focus).not.toHaveBeenCalled();
    expect(openEditor).not.toHaveBeenCalled();
    expect(flow.duringRecording).toBe(false);
  });

  it('says so and ends the flow when the file cannot be saved', async () => {
    const { flow, toast } = setup([display('1', 0, 0, 4, 3)], {
      isRecording: () => true,
      saveDirect: async () => {
        throw new Error('disk full');
      },
    });
    await flow.start({ target: 'screen' });
    await ended(flow);
    expect(toast).toHaveBeenCalledWith(expect.objectContaining({ level: 'error' }));
    expect(hoisted.main.show).not.toHaveBeenCalled();
  });


  it('a cancelled flow leaves the main window alone and frees the flow', async () => {
    const { flow } = setup([display('1', 0, 0, 4, 3)], { isRecording: () => true });
    await flow.start({ target: 'screen' });
    flow.cancel();
    expect(flow.state.active).toBe(false);
    expect(hoisted.main.show).not.toHaveBeenCalled();
  });
});

describe('without a recording', () => {
  it('hides the main window, opens the session in the Editor window and shows the window again', async () => {
    const { flow, saveDirect, create, openEditor } = setup([display('1', 0, 0, 4, 3)]);
    await flow.start({ target: 'screen' });
    await ended(flow);
    expect(create).toHaveBeenCalled();
    expect(saveDirect).not.toHaveBeenCalled();
    expect(hoisted.main.show).toHaveBeenCalled();
    expect(openEditor).toHaveBeenCalledTimes(1);
    expect(openEditor).toHaveBeenCalledWith(expect.objectContaining({ kind: 'session' }));
  });
});

describe('all screens', () => {
  it('joins the displays into one image at their desktop positions', async () => {
    hoisted.frames.set('1', { width: 4, height: 3 });
    hoisted.frames.set('2', { width: 2, height: 5 });
    const { flow, create } = setup([display('1', 0, 0, 4, 3), display('2', -2, 0, 2, 5)]);
    await flow.start({ target: 'screen', allScreens: true });
    await ended(flow);
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'screen', width: 6, height: 5 }),
    );
  });

  it('saves directly when started during a recording', async () => {
    hoisted.frames.set('1', { width: 4, height: 3 });
    hoisted.frames.set('2', { width: 4, height: 3 });
    const { flow, saveDirect, create } = setup(
      [display('1', 0, 0, 4, 3), display('2', 4, 0, 4, 3)],
      { isRecording: () => true },
    );
    await flow.start({ target: 'screen', allScreens: true });
    await ended(flow);
    expect(saveDirect).toHaveBeenCalledWith(expect.objectContaining({ width: 8, height: 3 }));
    expect(create).not.toHaveBeenCalled();
  });

  it('fails with a clear message when the joined image would be too large', async () => {
    hoisted.frames.set('1', { width: 4, height: 3 });
    hoisted.frames.set('2', { width: 4, height: 3 });
    const events: unknown[] = [];
    const { flow, create } = setup(
      [display('1', 0, 0, 4, 3), display('2', MAX_FRAME_DIMENSION, 0, 4, 3)],
      {
        isRecording: () => true,
        toast: (event) => events.push(event),
      },
    );
    await flow.start({ target: 'screen', allScreens: true });
    await ended(flow);
    expect(create).not.toHaveBeenCalled();
    expect(events).toEqual([
      expect.objectContaining({ level: 'error', message: expect.stringContaining('limit') }),
    ]);
  });
});
