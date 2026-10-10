/**
 * Follow-mouse recordings in the real RecorderController: the mouse is sampled (~30 Hz) only while
 * a screen recording with `follow` runs, sent to the engine only when it moved, held when it leaves
 * the recorded display, and the timer is gone after the recording ends.
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
    onCommand: (_command: { cmd: string; requestId?: string; sessionId?: string }): void =>
      undefined,
    cursor: { x: 0, y: 0 },
  };
  const contents = (id: number) => ({
    id,
    isDestroyed: () => false,
    send: (event: string, payload: never) => {
      if (event === 'recorder:engineCommand') {
        state.commands.push(payload);
        state.onCommand(payload);
      }
    },
  });
  return { state, main: contents(1), worker: contents(7) };
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
    ],
    getPrimaryDisplay: () => ({ id: 1, bounds: { x: 0, y: 0, width: 1920, height: 1080 } }),
    getCursorScreenPoint: () => hoisted.state.cursor,
    getDisplayNearestPoint: () => ({ id: 1, bounds: { x: 0, y: 0, width: 1920, height: 1080 } }),
  },
  protocol: { handle: () => undefined, registerSchemesAsPrivileged: () => undefined },
}));
vi.mock('../../src/main/windows', () => {
  return {
    getMainWindow: () => undefined,
    webContentsWithRoles: () => [hoisted.main],
  };
});
vi.mock('../../src/main/logger', () => ({
  log: { info: () => undefined, warn: () => undefined, error: () => undefined },
}));
vi.mock('../../src/main/worker', () => ({ requestFrames: async () => [] }));
vi.mock('../../src/main/overlay', () => ({ OverlaySet: class {} }));
vi.mock('../../src/main/recorder/windows', () => ({
  createToolbarWindow: () => ({
    win: {
      webContents: hoisted.main,
      isDestroyed: () => false,
      showInactive: () => undefined,
      on: () => undefined,
    },
    setWidth: () => undefined,
    closeQuietly: () => undefined,
  }),
  createCountdownWindow: () => ({ win: {}, reveal: () => undefined, close: () => undefined }),
}));

import { MediaRegistry } from '../../src/main/recording/media-protocol';
import { SessionService } from '../../src/main/recording/session-service';
import { RecorderController } from '../../src/main/recorder/controller';
import type { EngineEvent, RecordOptions } from '../../src/shared/recorder-ipc';
import { fakeEnginePool } from './fake-engines';
import { fakeTools } from './fake-tools';

const { state } = hoisted;
const DISPLAY = {
  id: '1',
  label: 'Display 1',
  bounds: { x: 0, y: 0, width: 1920, height: 1080 },
  scaleFactor: 1,
  rotation: 0,
  physicalSize: { width: 1920, height: 1080 },
  isPrimary: true,
};
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
let sessionId = '';

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const cursors = () => state.commands.filter((command) => command.cmd === 'cursor');

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'framecapt-follow-sessions-'));
  out = fs.mkdtempSync(path.join(os.tmpdir(), 'framecapt-follow-out-'));
  state.commands.length = 0;
  state.cursor = { x: 960, y: 540 };
  sessions = new SessionService(root, { diskCheckEveryMs: 0 });
  controller = new RecorderController({
    saveScreenshot: async () => undefined,
    provider: {
      listDisplays: () => [DISPLAY],
      listSources: async ({ types }) =>
        types.includes('window')
          ? [{ id: 'window:123:0', name: 'Word', kind: 'window' as const }]
          : [{ id: 'screen:1:0', name: 'Screen 1', kind: 'screen' as const, displayId: '1' }],
    },
    sessions,
    media: new MediaRegistry(),
    engines: fakeEnginePool(() => hoisted.worker),
    synthetic: false,
    isScreenshotBusy: () => false,
    outputDir: () => out,
    tools: fakeTools(),
    history: { addVideo: async () => ({ id: 'h' }) } as never,
  });
  const reply = (event: EngineEvent) => queueMicrotask(() => controller.onEngineEvent(event));
  state.onCommand = (command) => {
    const requestId = command.requestId ?? '';
    if (command.cmd === 'prepare') {
      reply({
        type: 'prepared',
        requestId,
        mime: 'video/webm',
        width: 1920,
        height: 1080,
        audio: { mic: false, system: false },
      });
    } else if (command.cmd === 'start') {
      sessionId = command.sessionId ?? '';
      reply({ type: 'started', requestId });
    } else if (command.cmd === 'stop') {
      void (async () => {
        await sessions.append(sessionId, 0, new Uint8Array(64).fill(1), hoisted.worker.id);
        await sessions.finish(sessionId, 0, hoisted.worker.id);
        controller.onEngineEvent({
          type: 'stopped',
          requestId,
          lastSeq: 0,
          chunks: 1,
          bytes: 64,
        });
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

async function record(target: 'screen' | 'window', options: RecordOptions): Promise<void> {
  await controller.start({
    target,
    ...(target === 'screen' ? { displayId: '1' } : { sourceId: 'window:123:0' }),
    options,
  });
  const until = Date.now() + 5000;
  while (controller.status !== 'recording') {
    if (Date.now() > until) throw new Error('timed out waiting for recording');
    await sleep(10);
  }
}

describe('follow-mouse cursor timer', () => {
  it('sends the normalized mouse only when it changed, and holds it on another display', async () => {
    await record('screen', OPTIONS);
    await sleep(120);
    expect(cursors().length).toBeGreaterThan(0);
    expect(cursors()[0]).toMatchObject({ nx: 0.5, ny: 0.5 });
    // Unchanged mouse: exactly one command no matter how long it rests.
    expect(cursors()).toHaveLength(1);

    state.cursor = { x: 480, y: 270 };
    await sleep(120);
    expect(cursors()).toHaveLength(2);
    expect(cursors()[1]).toMatchObject({ nx: 0.25, ny: 0.25 });

    // On another display (outside this one's bounds): the last position is held.
    state.cursor = { x: 2500, y: 100 };
    await sleep(120);
    expect(cursors()).toHaveLength(2);
  });

  it('stops sampling when the recording ends', async () => {
    await record('screen', OPTIONS);
    await sleep(80);
    await controller.stop('user');
    expect(controller.status).toBe('completed');
    const sent = cursors().length;
    state.cursor = { x: 100, y: 100 };
    await sleep(150);
    expect(cursors()).toHaveLength(sent);
  });

  it('is off without follow, and ignored for a window recording', async () => {
    const { follow: _follow, ...plain } = OPTIONS;
    await record('screen', plain);
    await sleep(100);
    expect(cursors()).toHaveLength(0);
    await controller.stop('user');
    controller.reset();

    state.commands.length = 0;
    await record('window', OPTIONS);
    state.cursor = { x: 10, y: 10 };
    await sleep(100);
    expect(cursors()).toHaveLength(0);
    const prepare = state.commands.find((command) => command.cmd === 'prepare');
    expect((prepare?.options as RecordOptions).follow).toBeUndefined();
  });
});
