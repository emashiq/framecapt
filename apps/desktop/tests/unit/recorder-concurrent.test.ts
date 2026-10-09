/**
 * Several recordings at once in the real RecorderController + SessionService (only Electron, the
 * hidden recorder windows and ffmpeg are replaced): each recording has its own engine window and
 * toolbar and is saved as its own file; the cap, the one-start-up-at-a-time rule, the shared
 * system audio, routing by window and quitting.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const hoisted = vi.hoisted(() => {
  type Command = { cmd: string; requestId?: string; sessionId?: string; [key: string]: unknown };
  const state = {
    /** Every engine command with the webContents it was sent to. */
    commands: [] as { id: number; payload: Command }[],
    onCommand: (_id: number, _payload: Command): void => undefined,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    sent: [] as { id: number; event: string; payload: any }[],
    toolbars: [] as {
      id: number;
      contents: unknown;
      blur: () => void;
      userClosed: () => void;
    }[],
  };
  const contents = (id: number) => ({
    id,
    isDestroyed: () => false,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    send: (event: string, payload: any) => {
      if (event === 'recorder:engineCommand') {
        state.commands.push({ id, payload });
        state.onCommand(id, payload);
      } else state.sent.push({ id, event, payload });
    },
  });
  return { state, contents, main: contents(1) };
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
    getCursorScreenPoint: () => ({ x: 0, y: 0 }),
    getDisplayNearestPoint: () => ({ id: 1, bounds: { x: 0, y: 0, width: 1920, height: 1080 } }),
  },
  protocol: { handle: () => undefined, registerSchemesAsPrivileged: () => undefined },
}));
vi.mock('../../src/shared/platform', () => ({
  platformCapabilities: () => ({ systemAudio: true }),
}));
vi.mock('../../src/main/windows', () => ({
  getMainWindow: () => undefined,
  isOwnUiFocused: () => false,
  webContentsWithRoles: (roles: readonly string[]) => [
    ...(roles.includes('main') ? [hoisted.main] : []),
    ...(roles.includes('toolbar') ? hoisted.state.toolbars.map((toolbar) => toolbar.contents) : []),
  ],
}));
vi.mock('../../src/main/logger', () => ({
  log: { info: () => undefined, warn: () => undefined, error: () => undefined },
}));
vi.mock('../../src/main/worker', () => ({ requestFrames: async () => [] }));
vi.mock('../../src/main/capture/exact-capture', () => ({ grabScreensExact: vi.fn() }));
vi.mock('../../src/main/overlay', () => ({ OverlaySet: class {} }));
vi.mock('../../src/main/recorder/windows', () => ({
  createToolbarWindow: (_position: unknown, _width: number, onUserClosed: () => void) => {
    const contents = hoisted.contents(30 + hoisted.state.toolbars.length);
    let blur = (): void => undefined;
    hoisted.state.toolbars.push({
      id: contents.id,
      contents,
      blur: () => blur(),
      userClosed: onUserClosed,
    });
    return {
      win: {
        webContents: contents,
        isDestroyed: () => false,
        showInactive: () => undefined,
        moveTop: () => undefined,
        on: (event: string, listener: () => void) => {
          if (event === 'blur') blur = listener;
        },
      },
      setWidth: () => undefined,
      closeQuietly: () => undefined,
    };
  },
  createCountdownWindow: () => ({ win: {}, reveal: () => undefined, close: () => undefined }),
}));

import { MediaRegistry } from '../../src/main/recording/media-protocol';
import { SessionService } from '../../src/main/recording/session-service';
import { RecorderController, type RecorderDeps } from '../../src/main/recorder/controller';
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
};
/** The first engine window's id (one more per recording). */
const ENGINE_BASE = 7;

let root: string;
let out: string;
let sessions: SessionService;
let controller: RecorderController;
let pool: ReturnType<typeof fakeEnginePool>;
/** `prepare` requests of these engine windows are not answered. */
const held = new Set<number>();
let onSaved: ReturnType<typeof vi.fn<(historyId: string | null) => void>>;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function build(extra: Partial<RecorderDeps> = {}): void {
  controller = new RecorderController({
    provider: {
      listDisplays: () => [DISPLAY],
      listSources: async ({ types }) =>
        types.includes('window')
          ? [
              { id: 'window:123:0', name: 'Word', kind: 'window' as const },
              { id: 'window:456:0', name: 'Notes', kind: 'window' as const },
            ]
          : [{ id: 'screen:1:0', name: 'Screen 1', kind: 'screen' as const, displayId: '1' }],
    },
    sessions,
    media: new MediaRegistry(),
    engines: pool,
    synthetic: false,
    isScreenshotBusy: () => false,
    saveScreenshot: async () => undefined,
    outputDir: () => out,
    tools: fakeTools(),
    history: { addVideo: async () => ({ id: 'h' }) } as never,
    onSaved,
    ...extra,
  });
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'framecapt-conc-sessions-'));
  out = fs.mkdtempSync(path.join(os.tmpdir(), 'framecapt-conc-out-'));
  state.commands.length = 0;
  state.sent.length = 0;
  state.toolbars.length = 0;
  held.clear();
  onSaved = vi.fn<(historyId: string | null) => void>();
  sessions = new SessionService(root, { diskCheckEveryMs: 0 });
  pool = fakeEnginePool((index) => hoisted.contents(ENGINE_BASE + index));
  build();
  // What each hidden recorder window does, in miniature (every window answers for itself).
  const recording = new Map<number, string>();
  state.onCommand = (id, command) => {
    const requestId = command.requestId ?? '';
    const reply = (event: EngineEvent) => queueMicrotask(() => controller.onEngineEvent(event, id));
    if (command.cmd === 'prepare') {
      if (held.has(id)) return;
      reply({
        type: 'prepared',
        requestId,
        mime: 'video/webm',
        width: 1920,
        height: 1080,
        audio: { mic: false, system: false },
      });
    } else if (command.cmd === 'start') {
      recording.set(id, command.sessionId ?? '');
      reply({ type: 'started', requestId });
    } else if (command.cmd === 'stop') {
      const sessionId = recording.get(id) ?? '';
      void (async () => {
        await sessions.append(sessionId, 0, new Uint8Array(64).fill(id), id);
        await sessions.finish(sessionId, 0, id);
        controller.onEngineEvent(
          { type: 'stopped', requestId, lastSeq: 0, chunks: 1, bytes: 64 },
          id,
        );
      })();
    }
  };
});
afterEach(async () => {
  await controller.stopAll();
  await sessions.closeAll();
  fs.rmSync(root, { recursive: true, force: true });
  fs.rmSync(out, { recursive: true, force: true });
});

async function waitFor(predicate: () => boolean, what: string, timeoutMs = 5000): Promise<void> {
  const until = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > until) throw new Error(`timed out waiting for ${what}`);
    await sleep(10);
  }
}

const statusOf = (sessionId: string) =>
  controller.sessions().find((session) => session.sessionId === sessionId)?.status;

async function startScreen(options: RecordOptions = OPTIONS): Promise<string> {
  const { sessionId } = await controller.start({ target: 'screen', displayId: '1', options });
  await waitFor(() => statusOf(sessionId) === 'recording', 'recording');
  return sessionId;
}

async function startWindow(sourceId = 'window:123:0', options = OPTIONS): Promise<string> {
  const { sessionId } = await controller.start({ target: 'window', sourceId, options });
  await waitFor(() => statusOf(sessionId) === 'recording', 'recording');
  return sessionId;
}

const toasts = (toolbarId?: number) =>
  state.sent.filter(
    (entry) =>
      entry.event === 'recorder:toast' && (toolbarId === undefined || entry.id === toolbarId),
  );

describe('two recordings at once', () => {
  it('record and stop independently, each into its own file with its own engine window', async () => {
    const a = await startScreen();
    const b = await startWindow();
    expect(pool.windows).toHaveLength(2);
    expect(pool.windows[0]?.contents.id).not.toBe(pool.windows[1]?.contents.id);

    const snapshot = controller.snapshot();
    expect(snapshot.sessions.map((session) => [session.label, session.status])).toEqual([
      ['Recording 1', 'recording'],
      ['Recording 2', 'recording'],
    ]);
    expect(snapshot.sessions.every((session) => session.panels === 0)).toBe(true);
    expect(snapshot.canStartAnother).toBe(true);
    expect(snapshot.sessionId).toBe(b); // the newest live recording is the primary one

    await controller.stop('user', b);
    expect(statusOf(b)).toBe('completed');
    expect(statusOf(a)).toBe('recording');
    expect(fs.readdirSync(out)).toHaveLength(1);
    expect(state.commands.filter((entry) => entry.payload.cmd === 'stop')).toHaveLength(1);

    await controller.stop('user', a);
    expect(statusOf(a)).toBe('completed');
    expect(fs.readdirSync(out)).toHaveLength(2);
    expect(onSaved).toHaveBeenCalledTimes(2);
    // Both engine windows are given back; the recordings left nothing on disk.
    expect(pool.windows.every((entry) => entry.released)).toBe(true);
    expect(fs.existsSync(path.join(root, a))).toBe(false);
    expect(fs.existsSync(path.join(root, b))).toBe(false);
  });

  it('the single-recording API follows the primary recording, and reset takes one result at a time', async () => {
    const a = await startScreen();
    expect(controller.status).toBe('recording');
    const b = await startWindow();
    controller.pause(); // no id: the primary one (the newest live)
    expect(statusOf(b)).toBe('paused');
    expect(statusOf(a)).toBe('recording');
    controller.resume(b);
    controller.pause(a);
    expect(statusOf(a)).toBe('paused');
    expect(controller.anyLive).toBe(true);

    await controller.stop('user', b);
    await controller.stop('user', a);
    expect(controller.status).toBe('completed');
    expect(controller.snapshot().result?.path).toContain(out);
    controller.reset();
    expect(controller.sessions()).toHaveLength(1); // the other result is still there
    controller.reset();
    expect(controller.sessions()).toHaveLength(0);
    expect(controller.status).toBe('idle');
  });

  it('windows are told about their own recording, levels and toasts go to its toolbar only', async () => {
    const a = await startScreen();
    const b = await startWindow();
    const [toolbarA, toolbarB] = state.toolbars;
    expect(controller.sessionIdOf(toolbarA?.id ?? -1)).toBe(a);
    expect(controller.sessionIdOf(toolbarB?.id ?? -1)).toBe(b);
    expect(controller.sessionIdOf(pool.windows[1]?.contents.id ?? -1)).toBe(b);
    expect(controller.sessionIdOf(9999)).toBeUndefined();

    // Each window's own state, and the main window's (the primary one).
    expect(controller.snapshotFor('toolbar', toolbarA?.id).sessionId).toBe(a);
    expect(controller.snapshotFor('toolbar', toolbarB?.id).sessionId).toBe(b);
    expect(controller.snapshotFor('main').sessionId).toBe(b);
    expect(controller.snapshotFor('toolbar', toolbarA?.id).sessions).toHaveLength(2);
    expect(controller.snapshotFor('toolbar', toolbarA?.id).result).toBeNull();

    controller.onEngineEvent(
      { type: 'levels', mic: 0.5, system: 0.25 },
      pool.windows[0]?.contents.id,
    );
    expect(state.sent.filter((e) => e.event === 'recorder:levels').map((e) => e.id)).toEqual([
      toolbarA?.id,
    ]);
    controller.toastToolbar({ level: 'info', message: 'hello' }, b);
    expect(toasts(toolbarB?.id)).toHaveLength(1);
    expect(toasts(toolbarA?.id)).toHaveLength(0);

    // A failed screenshot of recording A is reported in toolbar A.
    await controller.screenshotNow(a).catch(() => undefined);
    expect(toasts(toolbarA?.id)).toHaveLength(1);
    expect(toasts(toolbarB?.id)).toHaveLength(1);
  });

  it('an engine event is for the recording of the window it came from', async () => {
    const a = await startScreen();
    const b = await startWindow();
    controller.onEngineEvent({ type: 'sourceLost' }, pool.windows[1]?.contents.id);
    await waitFor(() => statusOf(b) === 'completed', 'B to end');
    expect(statusOf(a)).toBe('recording');
    controller.onEngineEvent({ type: 'sourceLost' }, 4242); // no recording has that window
    expect(statusOf(a)).toBe('recording');
  });
});

describe('losing one engine window', () => {
  it('ends only that recording; the other goes on and is saved', async () => {
    const a = await startScreen();
    const b = await startWindow();
    pool.windows[1]?.close(); // the second window crashes
    await waitFor(() => statusOf(b) === 'completed' || statusOf(b) === 'error', 'B to end');
    expect(statusOf(a)).toBe('recording');
    expect(controller.snapshot().canStartAnother).toBe(true);
    await controller.stop('user', a);
    expect(statusOf(a)).toBe('completed');
    expect(fs.readdirSync(out)).toHaveLength(1);
  });
});

describe('limits', () => {
  it('a fourth recording is refused (BUSY) and canStartAnother says so', async () => {
    await startScreen();
    await startWindow();
    expect(controller.snapshot().canStartAnother).toBe(true);
    await startWindow('window:456:0');
    expect(controller.snapshot().canStartAnother).toBe(false);
    await expect(
      controller.start({ target: 'window', sourceId: 'window:123:0', options: OPTIONS }),
    ).rejects.toMatchObject({ code: 'BUSY' });
    expect(controller.sessions()).toHaveLength(3);
    expect(pool.windows).toHaveLength(3);
  });

  it('a start while another is still starting is refused', async () => {
    await startScreen();
    held.add(ENGINE_BASE + 1);
    const { sessionId } = await controller.start({
      target: 'window',
      sourceId: 'window:123:0',
      options: OPTIONS,
    });
    await waitFor(() => statusOf(sessionId) === 'preflight', 'preflight');
    expect(controller.startupInProgress).toBe(true);
    expect(controller.snapshot().canStartAnother).toBe(false);
    await expect(
      controller.start({ target: 'window', sourceId: 'window:456:0', options: OPTIONS }),
    ).rejects.toMatchObject({ code: 'BUSY' });

    // Cancelling the one that starts frees the slot and gives its window back.
    controller.cancel();
    expect(controller.sessions().map((s) => s.sessionId)).not.toContain(sessionId);
    expect(pool.windows[1]?.released).toBe(true);
    expect(controller.snapshot().canStartAnother).toBe(true);
    held.clear();
    await startWindow('window:456:0');
  });

  it('two starts at the same moment: one wins, the other is refused', async () => {
    const results = await Promise.allSettled([
      controller.start({ target: 'screen', displayId: '1', options: OPTIONS }),
      controller.start({ target: 'window', sourceId: 'window:123:0', options: OPTIONS }),
    ]);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1);
  });
});

describe('system audio is held by one recording', () => {
  it('a later recording that asks for it gets it dropped, and the user is told', async () => {
    const withAudio = { ...OPTIONS, systemAudio: true };
    await startScreen(withAudio);
    expect(toasts()).toHaveLength(0);
    await startWindow('window:456:0', withAudio);

    const prepares = state.commands.filter((entry) => entry.payload.cmd === 'prepare');
    const systemAudio = (index: number) =>
      (prepares[index]?.payload.options as RecordOptions | undefined)?.systemAudio;
    expect(systemAudio(0)).toBe(true); // the first recording keeps it
    expect(systemAudio(1)).toBe(false); // the later one does not
    expect(toasts().map((entry) => entry.payload.message)).toEqual([
      'System audio is already being recorded by another recording.',
    ]);
    // It goes to the toolbar of the recording that is on screen (the main window is hidden).
    expect(toasts()[0]?.id).toBe(state.toolbars[0]?.id);
  });
});

describe('quitting', () => {
  it('stops every recording together and quits once, with all files saved', async () => {
    await startScreen();
    await startWindow();
    await startWindow('window:456:0');
    const quit = vi.fn();
    const event = { preventDefault: vi.fn() };
    controller.handleBeforeQuit(event, quit);
    controller.handleBeforeQuit({ preventDefault: vi.fn() }, quit);
    expect(event.preventDefault).toHaveBeenCalledTimes(1);
    expect(controller.isQuitting).toBe(true);
    expect(controller.snapshot().quitting).toBe(true);
    await waitFor(() => quit.mock.calls.length > 0, 'the quit');
    expect(quit).toHaveBeenCalledTimes(1);
    expect(controller.sessions().map((s) => s.status)).toEqual([
      'completed',
      'completed',
      'completed',
    ]);
    expect(fs.readdirSync(out)).toHaveLength(3);
  });

  it('a recording that is only starting is cancelled and does not hold the quit', async () => {
    held.add(ENGINE_BASE);
    await controller.start({ target: 'screen', displayId: '1', options: OPTIONS });
    await waitFor(() => controller.startupInProgress, 'start-up');
    const event = { preventDefault: vi.fn() };
    controller.handleBeforeQuit(event, vi.fn());
    expect(event.preventDefault).not.toHaveBeenCalled();
    expect(controller.sessions()).toHaveLength(0);
  });
});

describe('the toolbar of a recording', () => {
  it('closing it by hand stops that recording only', async () => {
    const a = await startScreen();
    const b = await startWindow();
    state.toolbars[1]?.userClosed();
    await waitFor(() => statusOf(b) === 'completed', 'B saved');
    expect(statusOf(a)).toBe('recording');
  });

  it('losing focus re-checks an open selection (and tells the app)', async () => {
    const onToolbarBlur = vi.fn();
    build({ onToolbarBlur });
    await startScreen();
    state.toolbars[0]?.blur();
    expect(onToolbarBlur).toHaveBeenCalledTimes(1);
  });
});
