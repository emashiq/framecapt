/**
 * Multi-source recordings in the real RecorderController + SessionService (only Electron, the
 * recorder window and ffmpeg are replaced): every source is checked against a fresh listing, the
 * engine gets all of them, the manifest and the finished `.fcap` carry generic names only, a lost
 * source is reported while the recording goes on, and all sources lost ends it.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const hoisted = vi.hoisted(() => {
  const state = {
    commands: [] as {
      cmd: string;
      requestId?: string;
      sessionId?: string;
      [key: string]: unknown;
    }[],
    onCommand: (_command: {
      cmd: string;
      requestId?: string;
      sessionId?: string;
      [key: string]: unknown;
    }): void => undefined,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    sent: [] as { role: string; event: string; payload: any }[],
  };
  const contents = (role: string, id: number) => ({
    id,
    isDestroyed: () => false,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    send: (event: string, payload: any) => {
      if (event === 'recorder:engineCommand') {
        state.commands.push(payload);
        state.onCommand(payload);
      } else state.sent.push({ role, event, payload });
    },
  });
  return {
    state,
    main: contents('main', 1),
    toolbar: contents('toolbar', 2),
    worker: contents('recorder', 7),
  };
});

vi.mock('electron', () => ({
  globalShortcut: { register: () => true, unregister: () => undefined },
  screen: {
    on: () => undefined,
    removeListener: () => undefined,
    getAllDisplays: () => [
      {
        id: 1,
        bounds: { x: 0, y: 0, width: 1920, height: 1080 },
        workArea: { x: 0, y: 0, width: 1920, height: 1040 },
      },
      {
        id: 2,
        bounds: { x: -1280, y: 0, width: 1280, height: 720 },
        workArea: { x: -1280, y: 0, width: 1280, height: 680 },
      },
    ],
    getPrimaryDisplay: () => ({ id: 1, bounds: { x: 0, y: 0, width: 1920, height: 1080 } }),
    getCursorScreenPoint: () => ({ x: 0, y: 0 }),
    getDisplayNearestPoint: () => ({ id: 1, bounds: { x: 0, y: 0, width: 1920, height: 1080 } }),
  },
  protocol: { handle: () => undefined, registerSchemesAsPrivileged: () => undefined },
}));
vi.mock('../../src/main/windows', () => {
  return {
    getMainWindow: () => undefined,
    webContentsWithRoles: (roles: readonly string[]) =>
      [hoisted.main, hoisted.toolbar].filter((contents) =>
        roles.includes(contents === hoisted.main ? 'main' : 'toolbar'),
      ),
  };
});
vi.mock('../../src/main/logger', () => ({
  log: { info: () => undefined, warn: () => undefined, error: () => undefined },
}));
vi.mock('../../src/main/worker', () => ({ requestFrames: async () => [] }));
vi.mock('../../src/main/capture/exact-capture', () => ({ grabScreensExact: vi.fn() }));
vi.mock('../../src/main/overlay', () => ({
  OverlaySet: class {
    constructor() {
      throw new Error('a multi-source recording opens no overlay');
    }
  },
}));
vi.mock('../../src/main/recorder/windows', () => ({
  createToolbarWindow: () => ({
    win: {
      webContents: hoisted.toolbar,
      isDestroyed: () => false,
      showInactive: () => undefined,
      on: () => undefined,
    },
    setWidth: () => undefined,
    closeQuietly: () => undefined,
  }),
  createCountdownWindow: () => ({ win: {}, reveal: () => undefined, close: () => undefined }),
}));

import { readFcapHeader } from '../../src/main/recording/fcap';
import { MediaRegistry } from '../../src/main/recording/media-protocol';
import { SessionService } from '../../src/main/recording/session-service';
import { RecorderController } from '../../src/main/recorder/controller';
import type { EngineEvent, RecordOptions } from '../../src/shared/recorder-ipc';
import { fakeEnginePool } from './fake-engines';
import { fakeTools } from './fake-tools';

const { state } = hoisted;
const DISPLAYS = [
  {
    id: '1',
    label: 'Display 1',
    bounds: { x: 0, y: 0, width: 1920, height: 1080 },
    scaleFactor: 1,
    rotation: 0,
    physicalSize: { width: 1920, height: 1080 },
    isPrimary: true,
  },
  {
    id: '2',
    label: 'Display 2',
    bounds: { x: -640, y: 0, width: 640, height: 360 },
    scaleFactor: 2,
    rotation: 0,
    physicalSize: { width: 1280, height: 720 },
    isPrimary: false,
  },
];
const SOURCES = [
  { id: 'screen:1:0', name: 'Screen 1', kind: 'screen' as const, displayId: '1' },
  { id: 'screen:2:0', name: 'Screen 2', kind: 'screen' as const, displayId: '2' },
  { id: 'window:123:0', name: 'Secret plan.docx - Word', kind: 'window' as const },
];
const OPTIONS: RecordOptions = {
  mic: { enabled: false },
  systemAudio: false,
  quality: '1080p',
  fps: 30,
  countdown: false,
  follow: { zoom: 2 },
};

let root: string;
let out: string;
let sessions: SessionService;
let controller: RecorderController;
let addVideo: ReturnType<typeof vi.fn>;
let sessionId = '';
/** What the fake engine answers to `prepare` (a test may break it). */
let tiles: (count: number) => { x: number; y: number; width: number; height: number }[] | undefined;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const reply = (event: EngineEvent) => queueMicrotask(() => controller.onEngineEvent(event));

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'framecapt-multi-sessions-'));
  out = fs.mkdtempSync(path.join(os.tmpdir(), 'framecapt-multi-out-'));
  state.commands.length = 0;
  state.sent.length = 0;
  sessionId = '';
  addVideo = vi.fn(async () => ({ id: 'h' }));
  tiles = (count) =>
    Array.from({ length: count }, (_, i) => ({ x: i * 960, y: 0, width: 960, height: 1080 }));
  sessions = new SessionService(root, { diskCheckEveryMs: 0 });
  controller = new RecorderController({
    saveScreenshot: async () => undefined,
    provider: {
      listDisplays: () => DISPLAYS,
      listSources: async ({ types }) => SOURCES.filter((source) => types.includes(source.kind)),
    },
    sessions,
    media: new MediaRegistry(),
    engines: fakeEnginePool(() => hoisted.worker),
    synthetic: false,
    isScreenshotBusy: () => false,
    outputDir: () => out,
    tools: fakeTools(),
    history: { addVideo } as never,
  });
  state.onCommand = (command) => {
    const requestId = command.requestId ?? '';
    if (command.cmd === 'prepare') {
      const count = (command.multi as unknown[] | undefined)?.length ?? 0;
      const rects = tiles(count);
      reply({
        type: 'prepared',
        requestId,
        mime: 'video/webm',
        width: 960 * count,
        height: 1080,
        audio: { mic: false, system: false },
        ...(rects && { tiles: rects }),
      });
    } else if (command.cmd === 'start') {
      sessionId = command.sessionId ?? '';
      reply({ type: 'started', requestId });
    } else if (command.cmd === 'stop') {
      void (async () => {
        await sessions.append(sessionId, 0, new Uint8Array(64).fill(1), hoisted.worker.id);
        await sessions.finish(sessionId, 0, hoisted.worker.id);
        controller.onEngineEvent({ type: 'stopped', requestId, lastSeq: 0, chunks: 1, bytes: 64 });
      })();
    }
  };
});
afterEach(async () => {
  await controller.stop('user');
  await sessions.closeAll();
  fs.rmSync(root, { recursive: true, force: true });
  fs.rmSync(out, { recursive: true, force: true });
});

async function waitFor(predicate: () => boolean, what: string): Promise<void> {
  const until = Date.now() + 5000;
  while (!predicate()) {
    if (Date.now() > until) throw new Error(`timed out waiting for ${what}`);
    await sleep(10);
  }
}

const multi = (...ids: string[]) => ({
  target: 'multi' as const,
  sources: ids.map((sourceId) => ({ sourceId })),
  options: OPTIONS,
});

describe('starting', () => {
  it('an unknown source is refused before anything starts', async () => {
    await expect(controller.start(multi('screen:1:0', 'screen:9:0'))).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
    expect(controller.status).toBe('idle');
    expect(state.commands).toHaveLength(0);
    // A window that is gone, too.
    await expect(controller.start(multi('screen:1:0', 'window:999:0'))).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
  });

  it('gives the engine every source with its physical place, and ignores follow-mouse', async () => {
    await controller.start(multi('screen:2:0', 'screen:1:0', 'window:123:0'));
    await waitFor(() => controller.status === 'recording', 'recording');
    const prepare = state.commands.find((command) => command.cmd === 'prepare');
    expect(prepare?.multi).toEqual([
      // The primary is the FIRST source the user picked, not the primary display.
      {
        sourceId: 'screen:2:0',
        kind: 'screen',
        rect: { x: -1280, y: 0, width: 1280, height: 720 },
      },
      { sourceId: 'screen:1:0', kind: 'screen', rect: { x: 0, y: 0, width: 1920, height: 1080 } },
      { sourceId: 'window:123:0', kind: 'window', rect: null },
    ]);
    expect(prepare?.sourceId).toBe('screen:2:0');
    expect((prepare?.options as RecordOptions).follow).toBeUndefined();
    expect(controller.snapshot()).toMatchObject({ target: 'multi', width: 2880, height: 1080 });
    expect(state.commands.filter((command) => command.cmd === 'cursor')).toHaveLength(0);
  });

  it('the manifest has generic names and the engine tiles, never a window title', async () => {
    await controller.start(multi('screen:1:0', 'window:123:0'));
    await waitFor(() => controller.status === 'recording', 'recording');
    const text = fs.readFileSync(path.join(root, sessionId, 'manifest.json'), 'utf8');
    expect(text).not.toContain('Secret');
    expect(text).not.toContain('docx');
    const manifest = JSON.parse(text);
    expect(manifest.source).toMatchObject({ kind: 'multi', name: 'Multiple sources' });
    expect(manifest.source.displayId).toBeUndefined();
    expect(manifest.layout).toEqual({
      width: 1920,
      height: 1080,
      sources: [
        { name: 'Screen 1', kind: 'screen', rect: { x: 0, y: 0, width: 960, height: 1080 } },
        { name: 'Window 2', kind: 'window', rect: { x: 960, y: 0, width: 960, height: 1080 } },
      ],
    });
  });

  it('an engine that reports the wrong number of tiles fails the start', async () => {
    tiles = () => [{ x: 0, y: 0, width: 100, height: 100 }];
    await controller.start(multi('screen:1:0', 'screen:2:0'));
    await waitFor(() => controller.status === 'error', 'error');
    expect(controller.snapshot().error?.code).toBe('PREPARE_FAILED');
    expect(fs.readdirSync(root)).toEqual([]);
  });
});

describe('finishing', () => {
  it('stops into ONE .fcap named like a recording, and history gets fcap + multi', async () => {
    await controller.start(multi('screen:1:0', 'screen:2:0'));
    await waitFor(() => controller.status === 'recording', 'recording');
    await controller.stop('user');
    expect(controller.status).toBe('completed');
    const names = fs.readdirSync(out);
    expect(names).toHaveLength(1);
    expect(names[0]).toMatch(/^FrameCapt \d{4}-\d{2}-\d{2} at \d{2}\.\d{2}\.\d{2}\.fcap$/);
    const header = await readFcapHeader(path.join(out, names[0]!));
    expect(header).toMatchObject({ width: 1920, height: 1080, hasAudio: true });
    expect(header.sources.map((source) => source.name)).toEqual(['Screen 1', 'Screen 2']);
    expect(addVideo).toHaveBeenCalledTimes(1);
    expect(addVideo.mock.calls[0]![0]).toMatchObject({
      format: 'fcap',
      source: 'multi',
      width: 1920,
      height: 1080,
    });
    const result = controller.snapshot().result;
    expect(result?.fileName).toMatch(/\.fcap$/);
    // No session directory and no temporary files are left.
    expect(fs.existsSync(path.join(root, sessionId))).toBe(false);
  });
});

describe('losing sources', () => {
  it('a lost source is reported and the recording goes on; the last one ends it', async () => {
    await controller.start(multi('screen:1:0', 'screen:2:0'));
    await waitFor(() => controller.status === 'recording', 'recording');
    controller.onEngineEvent({ type: 'tileLost', index: 1 });
    expect(controller.status).toBe('recording');
    expect(controller.snapshot().lostTiles).toEqual([1]);
    // Reported once; the toolbar and the main window both see it.
    controller.onEngineEvent({ type: 'tileLost', index: 1 });
    expect(controller.snapshot().lostTiles).toEqual([1]);
    const states = state.sent.filter((entry) => entry.event === 'recorder:state');
    expect(
      states.some((entry) => entry.role === 'toolbar' && entry.payload.lostTiles.length === 1),
    ).toBe(true);

    // Every source gone: the engine says so and the recording is saved as it is.
    controller.onEngineEvent({ type: 'tileLost', index: 0 });
    controller.onEngineEvent({ type: 'sourceLost' });
    await waitFor(() => controller.status === 'completed', 'completed');
    expect(controller.snapshot().stopReason).toBe('source-lost');
    expect(fs.readdirSync(out)).toHaveLength(1);
  });

  it('the lost sources are forgotten with the next recording', async () => {
    await controller.start(multi('screen:1:0', 'screen:2:0'));
    await waitFor(() => controller.status === 'recording', 'recording');
    controller.onEngineEvent({ type: 'tileLost', index: 0 });
    await controller.stop('user');
    controller.reset();
    await controller.start(multi('screen:1:0', 'screen:2:0'));
    await waitFor(() => controller.status === 'recording', 'recording');
    expect(controller.snapshot().lostTiles).toEqual([]);
  });
});
