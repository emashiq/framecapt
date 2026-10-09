/**
 * Races in the real RecorderController + SessionService (only Electron, the recorder window and
 * ffmpeg are replaced): stop arriving from several places at once, a stop while chunk writes are in
 * flight, and quitting while the file is being finished.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const hoisted = vi.hoisted(() => {
  const state = {
    commands: [] as { cmd: string; requestId?: string; sessionId?: string }[],
    onCommand: (_command: { cmd: string; requestId?: string; sessionId?: string }): void =>
      undefined,
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
vi.mock('../../src/main/overlay', () => ({ OverlaySet: class {} }));
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

import { MediaRegistry } from '../../src/main/recording/media-protocol';
import { nodeSessionFs } from '../../src/main/recording/session-fs';
import { SessionService, type SessionFileHandle } from '../../src/main/recording/session-service';
import { RecorderController } from '../../src/main/recorder/controller';
import type { EngineEvent } from '../../src/shared/recorder-ipc';
import { grabScreensExact } from '../../src/main/capture/exact-capture';
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
const OPTIONS = {
  mic: { enabled: false },
  systemAudio: false,
  quality: '1080p' as const,
  fps: 30 as const,
  countdown: false,
};

let root: string;
let out: string;
let sessions: SessionService;
let controller: RecorderController;
let addVideo: ReturnType<typeof vi.fn>;
let saved: (string | null)[];
const savedShots: { kind: string; width: number; height: number }[] = [];
let appended: Uint8Array[];
let appendTimer: NodeJS.Timeout | undefined;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'framecapt-race-sessions-'));
  out = fs.mkdtempSync(path.join(os.tmpdir(), 'framecapt-race-out-'));
  state.commands.length = 0;
  state.sent.length = 0;
  appended = [];
  saved = [];
  savedShots.length = 0;
  addVideo = vi.fn(async () => ({ id: 'history-1' }));
});
afterEach(async () => {
  clearInterval(appendTimer);
  await sessions?.closeAll();
  fs.rmSync(root, { recursive: true, force: true });
  fs.rmSync(out, { recursive: true, force: true });
});

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Slow writes (about 25 ms each), so chunk acknowledgements are still pending when a stop arrives. */
function slowFs() {
  return {
    ...nodeSessionFs,
    open: async (file: string, flags: string) => {
      const real = (await nodeSessionFs.open(file, flags)) as SessionFileHandle;
      return {
        write: async (buffer: Uint8Array, offset: number, length: number) => {
          await sleep(25);
          return real.write(buffer, offset, length);
        },
        sync: () => real.sync(),
        close: () => real.close(),
      };
    },
  };
}

/** What the hidden recorder window does, in miniature: prepare, start, stream chunks, stop. */
function installEngine(options: { chunkEveryMs?: number } = {}): void {
  const reply = (event: EngineEvent) => queueMicrotask(() => controller.onEngineEvent(event));
  let sessionId = '';
  let seq = 0;
  const inFlight: Promise<unknown>[] = [];
  const pushChunk = (): void => {
    const bytes = new Uint8Array(64).fill((seq % 250) + 1);
    appended.push(bytes);
    const mine = seq;
    seq += 1;
    // like the uploader: sent at once, acknowledged later
    inFlight.push(
      sessions.append(sessionId, mine, bytes, hoisted.worker.id).catch(() => undefined),
    );
  };
  state.onCommand = (command) => {
    const requestId = command.requestId ?? '';
    switch (command.cmd) {
      case 'prepare':
        reply({
          type: 'prepared',
          requestId,
          mime: 'video/webm;codecs=vp9,opus',
          width: 1920,
          height: 1080,
          audio: { mic: false, system: false },
        });
        return;
      case 'start':
        sessionId = command.sessionId ?? '';
        seq = 0;
        reply({ type: 'started', requestId });
        appendTimer = setInterval(pushChunk, options.chunkEveryMs ?? 10);
        return;
      case 'stop':
        clearInterval(appendTimer);
        void (async () => {
          pushChunk(); // the final chunk the recorder flushes on stop
          await Promise.all(inFlight);
          await sessions.finish(sessionId, seq - 1, hoisted.worker.id);
          controller.onEngineEvent({
            type: 'stopped',
            requestId,
            lastSeq: seq - 1,
            chunks: seq,
            bytes: appended.reduce((sum, chunk) => sum + chunk.byteLength, 0),
          });
        })();
        return;
      default:
        return;
    }
  };
}

function build(
  tools = fakeTools(),
  extra: Partial<ConstructorParameters<typeof RecorderController>[0]> = {},
) {
  sessions = new SessionService(root, { fs: slowFs(), diskCheckEveryMs: 0 });
  controller = new RecorderController({
    provider: {
      listDisplays: () => [DISPLAY],
      listSources: async ({ types }) =>
        types.includes('window')
          ? [{ id: 'window:123:0', name: 'Secret plan.docx - Word', kind: 'window' as const }]
          : [{ id: 'screen:1:0', name: 'Screen 1', kind: 'screen' as const, displayId: '1' }],
    },
    sessions,
    media: new MediaRegistry(),
    engines: fakeEnginePool(() => hoisted.worker),
    synthetic: false,
    isScreenshotBusy: () => false,
    saveScreenshot: async (shot) => void savedShots.push(shot),
    outputDir: () => out,
    tools,
    history: { addVideo } as never,
    onSaved: (id) => saved.push(id),
    ...extra,
  });
  return tools;
}

async function waitFor(predicate: () => boolean, what: string, timeoutMs = 5000): Promise<void> {
  const until = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > until) throw new Error(`timed out waiting for ${what}`);
    await sleep(10);
  }
}

async function startRecording(): Promise<string> {
  const { sessionId } = await controller.start({
    target: 'screen',
    displayId: '1',
    options: OPTIONS,
  });
  await waitFor(() => controller.status === 'recording', 'recording');
  return sessionId;
}

const outputs = (): string[] => fs.readdirSync(out).sort();

describe('stop from several places at once', () => {
  it('four simultaneous stops (toolbar, main window, engine closed, app quit) finish the file exactly once', async () => {
    build();
    installEngine();
    const sessionId = await startRecording();
    await sleep(120); // chunks are flowing, writes are in flight

    const all = await Promise.all([
      controller.stop('user'),
      controller.stop('user'),
      controller.stop('engine-closed'),
      controller.stop('app-quit'),
      controller.stop('user'),
    ]);
    expect(all).toHaveLength(5);

    expect(controller.status).toBe('completed');
    expect(state.commands.filter((command) => command.cmd === 'stop')).toHaveLength(1);
    expect(addVideo).toHaveBeenCalledTimes(1);
    expect(saved).toEqual(['history-1']);
    // One finished file, no partial, no session directory left.
    expect(outputs()).toHaveLength(1);
    expect(outputs()[0]).toMatch(/^FrameCapt .*\.webm$/);
    expect(fs.existsSync(path.join(root, sessionId))).toBe(false);
    // ... and every chunk the recorder produced, in order, is in it (the fake remux is a copy).
    const written = fs.readFileSync(path.join(out, outputs()[0] ?? ''));
    expect(Buffer.compare(written, Buffer.concat(appended))).toBe(0);
    expect(appended.length).toBeGreaterThan(3);
    // The first stop's reason stands; later ones changed nothing.
    expect(controller.snapshot().stopReason).toBe('user');
  });

  it('a stop after completion, and a stop that arrives while the file is being finished, are no-ops', async () => {
    const gate: { release?: () => void } = {};
    const hold = new Promise<void>((resolve) => (gate.release = resolve));
    build(fakeTools({ beforeRun: () => hold }));
    installEngine();
    await startRecording();
    const first = controller.stop('user');
    await waitFor(() => controller.status === 'processing', 'processing');
    // While ffmpeg "runs": more stops (they join the running work), a cancel, a pause, a reset.
    const joined = controller.stop('user');
    controller.cancel();
    controller.pause();
    controller.reset();
    expect(controller.status).toBe('processing');
    gate.release?.();
    await Promise.all([first, joined]);
    await controller.stop('user');
    expect(controller.status).toBe('completed');
    expect(state.commands.filter((command) => command.cmd === 'stop')).toHaveLength(1);
    expect(outputs()).toHaveLength(1);
    expect(addVideo).toHaveBeenCalledTimes(1);
  });

  it('the finished file is shown to the main window only: the toolbar never receives its path', async () => {
    build();
    installEngine();
    await startRecording();
    await controller.stop('user');
    const states = state.sent.filter((entry) => entry.event === 'recorder:state');
    const forMain = states.filter((entry) => entry.role === 'main');
    const forToolbar = states.filter((entry) => entry.role === 'toolbar');
    expect(forMain.some((entry) => entry.payload.result?.path)).toBe(true);
    expect(forToolbar.length).toBeGreaterThan(0);
    for (const entry of states.filter((candidate) => candidate.role !== 'main')) {
      expect(entry.payload.result, 'toolbar-side state carries no result').toBeNull();
    }
    expect(controller.snapshotFor('toolbar', hoisted.toolbar.id).result).toBeNull();
    expect(controller.snapshotFor('recorder', hoisted.worker.id).result).toBeNull();
    expect(controller.snapshotFor('countdown').result).toBeNull();
    expect(controller.snapshotFor('main').result?.path).toContain(out);
  });
});

describe('a screenshot of the running recording (the toolbar button)', () => {
  const frame = (width: number, height: number) => ({
    width,
    height,
    image: { getSize: () => ({ width, height }), toPNG: () => Buffer.from('png') },
  });
  const toasts = () => state.sent.filter((entry) => entry.event === 'recorder:toast');

  it('saves a still of the screen, tells the toolbar, and the recording carries on', async () => {
    build();
    installEngine();
    vi.mocked(grabScreensExact).mockResolvedValue({
      frames: new Map([['1', frame(1920, 1080)]]) as never,
      fallback: [],
      ms: 1,
    });
    await startRecording();
    expect(controller.anyLive).toBe(true);
    await controller.screenshotNow();
    expect(savedShots).toEqual([
      { kind: 'screen', width: 1920, height: 1080, png: expect.anything() },
    ]);
    expect(toasts().map((entry) => entry.payload)).toEqual([
      { level: 'info', message: 'Screenshot saved' },
    ]);
    expect(controller.status).toBe('recording');
    await controller.stop('user');
  });

  it('refuses when nothing is recording', async () => {
    build();
    expect(controller.anyLive).toBe(false);
    await expect(controller.screenshotNow()).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(savedShots).toHaveLength(0);
  });

  it('says so in the toolbar when the capture fails', async () => {
    build();
    installEngine();
    vi.mocked(grabScreensExact).mockRejectedValue(new Error('boom'));
    await startRecording();
    await expect(controller.screenshotNow()).rejects.toThrow();
    expect(toasts().map((entry) => entry.payload.level)).toEqual(['error']);
    expect(controller.status).toBe('recording');
    await controller.stop('user');
  });
});

describe('what a recording leaves on disk', () => {
  it('never the title of the recorded window (only a generic label), also after a failure keeps the session', async () => {
    build();
    installEngine();
    const { sessionId } = await controller.start({
      target: 'window',
      sourceId: 'window:123:0',
      options: OPTIONS,
    });
    await waitFor(() => controller.status === 'recording', 'recording');
    const manifestPath = path.join(root, sessionId, 'manifest.json');
    const during = fs.readFileSync(manifestPath, 'utf8');
    expect(during).not.toContain('Secret');
    expect(JSON.parse(during).source).toEqual({ kind: 'window', name: 'Window' });
    await controller.stop('user');
    for (const file of fs.readdirSync(path.join(root, 'completed'))) {
      expect(fs.readFileSync(path.join(root, 'completed', file), 'utf8')).not.toContain('Secret');
    }
  });
});

describe('quitting while the file is being finished', () => {
  it('the quit waits up to the cap, then aborts ffmpeg; the session stays on disk to be finished next start', async () => {
    const tools = build(
      fakeTools({
        // a remux that never ends on its own: it only ends when it is aborted
        beforeRun: (_args, options) =>
          new Promise<void>((resolve) => {
            options.signal?.addEventListener('abort', () => resolve());
          }),
      }),
      { quitCapMs: 1000 },
    );
    installEngine();
    const sessionId = await startRecording();

    const quit = vi.fn();
    const first = { preventDefault: vi.fn() };
    const second = { preventDefault: vi.fn() };
    controller.handleBeforeQuit(first, quit);
    controller.handleBeforeQuit(second, quit); // a second quit request while quitting
    expect(first.preventDefault).toHaveBeenCalledTimes(1);
    expect(controller.isQuitting).toBe(true);

    await waitFor(() => tools.runs.length === 1, 'the remux to start');
    expect(quit).not.toHaveBeenCalled(); // finishing still has time
    await waitFor(() => quit.mock.calls.length > 0, 'the quit after the cap', 6000);
    expect(quit).toHaveBeenCalledTimes(1);

    const manifest = JSON.parse(
      fs.readFileSync(path.join(root, sessionId, 'manifest.json'), 'utf8'),
    ) as { state: string; finalize?: { partialPath: string } };
    expect(manifest.state).toBe('finalizing'); // the next start resumes it
    expect(fs.existsSync(path.join(root, sessionId, 'stream.webm'))).toBe(true);
    expect(fs.statSync(path.join(root, sessionId, 'stream.webm')).size).toBe(
      appended.reduce((sum, chunk) => sum + chunk.byteLength, 0),
    );
    expect(outputs().filter((name) => name.includes('.partial.'))).toEqual([]);

    // The quit then proceeds: the app's second before-quit is let through.
    const third = { preventDefault: vi.fn() };
    controller.handleBeforeQuit(third, quit);
    expect(third.preventDefault).not.toHaveBeenCalled();
  });

  it('a quit during finalization that finishes in time quits once, with the file saved', async () => {
    build(fakeTools(), { quitCapMs: 5000 });
    installEngine();
    await startRecording();
    const quit = vi.fn();
    controller.handleBeforeQuit({ preventDefault: vi.fn() }, quit);
    await waitFor(() => quit.mock.calls.length > 0, 'the quit', 5000);
    expect(quit).toHaveBeenCalledTimes(1);
    expect(controller.status).toBe('completed');
    expect(outputs()).toHaveLength(1);
  });
});

describe('a stop while the engine is still starting', () => {
  it('is a cancel: the recorder goes idle, a late "started" from the slow engine changes nothing, and a new start works', async () => {
    build();
    installEngine();
    const normal = state.onCommand;
    let releaseStart: (() => void) | undefined;
    // A slow PC: the engine answers "start" only when the test lets it.
    state.onCommand = (command) => {
      if (command.cmd !== 'start') return normal(command);
      releaseStart = () => normal(command);
    };
    await controller.start({ target: 'screen', displayId: '1', options: OPTIONS });
    await waitFor(() => releaseStart !== undefined, 'the engine start command');
    expect(controller.status).toBe('starting');

    await controller.stop('user');
    await controller.stop('user'); // a second stop is harmless too
    expect(controller.status).toBe('idle');

    releaseStart?.(); // the slow engine finally reports "started" (and would stream chunks)
    await sleep(100);
    expect(controller.status).toBe('idle');
    expect(outputs()).toEqual([]);

    state.onCommand = normal;
    await startRecording();
    await controller.stop('user');
    await waitFor(() => controller.status === 'completed', 'completed');
  });
});
