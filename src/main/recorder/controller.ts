import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { globalShortcut, screen, type BrowserWindow } from 'electron';
import {
  framePixelsToDip,
  overlayRectToFramePixels,
  type DisplayGeom,
} from '../../shared/geometry';
import { checkPixelRect, type Rect } from '../../shared/rect';
import { platformCapabilities } from '../../shared/platform';
import type {
  EngineCommand,
  EngineEvent,
  RecordOptions,
  RecorderSnapshot,
  RecorderStartRequest,
  RecordingResult,
  RecordTarget,
} from '../../shared/recorder-ipc';
import {
  activeDurationAt,
  createInitialState,
  isFinished,
  isPreRecording,
  reduce,
  type AudioFlags,
  type AudioSource,
  type RecorderEvent,
  type RecorderMachineState,
} from '../../shared/recorder-machine';
import type { OverlayInit } from '../../shared/shot-ipc';
import type { Role } from '../../shared/types';
import {
  placeToolbar,
  TOOLBAR_HEIGHT,
  toolbarWidth,
  type PlacementDisplay,
} from '../../shared/toolbar-placement';
import type { CaptureProvider, DisplayInfo } from '../capture/types';
import { sendEvent } from '../events';
import { IpcError } from '../ipc-core';
import { log } from '../logger';
import { OverlaySet } from '../overlay';
import type { SelectionHost } from '../selection-host';
import { getMainWindow, getWorkerWindow, peekWorkerWindow, webContentsWithRoles } from '../windows';
import { whenWorkerReady } from '../worker';
import type { MediaTools } from '../media/ffmpeg';
import type { HistorySink } from '../history/service';
import type { MediaRegistry } from '../recording/media-protocol';
import type { SessionService } from '../recording/session-service';
import { settleWithin } from './quit-cap';
import {
  createCountdownWindow,
  createToolbarWindow,
  type CountdownWindow,
  type ToolbarWindow,
} from './windows';

/** Time for the window manager to remove a hidden/closed window from the composed desktop. */
const SETTLE_MS = 200;
const COUNTDOWN_FROM = 3;
const PREPARE_TIMEOUT_MS = 20_000;
const START_TIMEOUT_MS = 10_000;
const STOP_TIMEOUT_MS = 20_000;
/** On app quit the recording gets this long to finish before its session is left for recovery. */
export const QUIT_FINALIZE_CAP_MS = 15_000;

/** The user (or a source change) ended the start-up before recording began. */
class Cancelled extends Error {}

class StartFailure extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

interface SessionContext {
  sessionId: string;
  target: RecordTarget;
  options: RecordOptions;
  sourceId: string;
  sourceName: string;
  display: DisplayInfo | undefined;
  /** Region in pixels of the display (even aligned), and in global DIP. */
  regionPx: Rect | null;
  regionDip: Rect | null;
  mime: string;
  width: number | null;
  height: number | null;
  audio: AudioFlags;
  canUseDefaultMic: boolean;
  countdown: number | null;
  /** 0..1 while the file is being finished (remux progress against the active time). */
  progress: number | null;
  result: RecordingResult | null;
  sessionCreated: boolean;
}

interface Selection {
  display: DisplayInfo | undefined;
  regionPx: Rect | null;
  regionDip: Rect | null;
}

export interface RecorderDeps {
  provider: CaptureProvider;
  sessions: SessionService;
  media: MediaRegistry;
  /** E2E mock builds: the engine draws a synthetic picture and positions use real displays. */
  synthetic: boolean;
  /** True while a screenshot flow runs (the two never overlap). */
  isScreenshotBusy: () => boolean;
  /** Folder of the finished recordings (the setting, else `Videos/FrameCapt`). */
  outputDir: () => string;
  /** Throws (OUTPUT_DIR_UNWRITABLE) when finished recordings could not be saved there. */
  ensureOutputDir?: () => Promise<void>;
  /** The bundled ffmpeg/ffprobe (remux on finalize). */
  tools: MediaTools;
  /** Finished recordings are added here (a failure never fails the recording). */
  history?: HistorySink;
  /** A recording was saved (its history id, or null): the automatic MP4 export hooks in here. */
  onSaved?: (historyId: string | null) => void;
  /** Overrides the 15 s quit cap (E2E builds only). */
  quitCapMs?: number;
}

function toGeom(display: DisplayInfo): DisplayGeom {
  return {
    id: display.id,
    bounds: display.bounds,
    scaleFactor: display.scaleFactor,
    rotation: display.rotation,
  };
}

/**
 * The authoritative owner of recording state. Windows only send commands (`recorder:*`); this
 * class runs them through the pure state machine and the hidden recorder window's engine, and
 * broadcasts every state change. Commands are idempotent where it matters: a second stop (toolbar
 * button, main window, closing the toolbar, source loss, quitting the app) is a no-op that joins
 * the first.
 */
export class RecorderController implements SelectionHost {
  private machine: RecorderMachineState = createInitialState();
  private ctx: SessionContext | null = null;
  private token = 0;
  private quitting = false;
  private quitAllowed = false;
  private overlays: OverlaySet | undefined;
  private selectionWaiter:
    { resolve: (value: Selection) => void; reject: (e: Error) => void } | undefined;
  private choiceWaiter:
    ((answer: 'continue-without' | 'use-default' | 'cancel') => void) | undefined;
  private countdownWindow: CountdownWindow | undefined;
  private toolbar: ToolbarWindow | undefined;
  private stopPromise: Promise<void> | undefined;
  /** Cancels the running remux (quit past the cap). */
  private finalizeAbort: AbortController | undefined;
  private removeDisplayListeners: (() => void) | undefined;
  private watchedWorker: BrowserWindow | undefined;
  private levelsOn = false;
  /** The main window was on screen when this recording was requested (a shortcut may start it from the tray). */
  private mainWasShown = true;
  private readonly changeListeners = new Set<() => void>();
  private readonly waiters = new Map<
    string,
    { types: ReadonlySet<string>; resolve: (event: EngineEvent) => void }
  >();

  constructor(private readonly deps: RecorderDeps) {}

  // --- reading state -----------------------------------------------------------------------

  get status(): RecorderMachineState['status'] {
    return this.machine.status;
  }

  /** A recording is running (or ending): the app must not quit or close its windows carelessly. */
  get isRecording(): boolean {
    const { status } = this.machine;
    return (
      status === 'recording' ||
      status === 'paused' ||
      status === 'stopping' ||
      status === 'processing'
    );
  }

  /** The recorder owns the overlay windows right now (selection step). */
  get selecting(): boolean {
    return this.overlays !== undefined;
  }

  /** Anything that must keep a screenshot from starting. */
  get busy(): boolean {
    return !isFinished(this.machine.status);
  }

  snapshot(): RecorderSnapshot {
    const state = this.machine;
    const ctx = this.ctx;
    const nowMono = performance.now();
    return {
      status: state.status,
      sessionId: state.sessionId,
      target: ctx?.target ?? null,
      startedAt: state.startedAt,
      activeMs: state.activeDurationMs,
      runningSince:
        state.segmentStartedAt === null ? null : Date.now() - (nowMono - state.segmentStartedAt),
      error: state.error,
      stopReason: state.stopReason,
      audio: state.audio,
      muted: state.muted,
      lost: state.lost,
      choice: state.choice,
      choiceCanUseDefault: ctx?.canUseDefaultMic ?? false,
      quitting: this.quitting,
      countdown: ctx?.countdown ?? null,
      progress: ctx?.progress ?? null,
      width: ctx?.width ?? null,
      height: ctx?.height ?? null,
      result: state.status === 'completed' ? (ctx?.result ?? null) : null,
    };
  }

  private dispatch(event: RecorderEvent): boolean {
    const before = this.machine;
    const { state, rejected } = reduce(before, event);
    if (rejected) {
      log.info(`Recorder: ${event.type} rejected in ${before.status}`);
      return false;
    }
    this.machine = state;
    if (state !== before) {
      if (state.status !== before.status) log.info(`Recorder: ${before.status} -> ${state.status}`);
      this.broadcast();
    }
    return true;
  }

  /** Runs after every state change (the tray follows the recording state). */
  onChange(listener: () => void): () => void {
    this.changeListeners.add(listener);
    return () => this.changeListeners.delete(listener);
  }

  /**
   * The state as one role may see it. Only the main window shows the finished file (name, path,
   * history id); the toolbar, countdown and recorder windows get the same state without it.
   */
  snapshotFor(role: Role): RecorderSnapshot {
    const snapshot = this.snapshot();
    return role === 'main' ? snapshot : { ...snapshot, result: null };
  }

  private broadcast(): void {
    for (const listener of this.changeListeners) listener();
    const full = this.snapshot();
    const redacted: RecorderSnapshot = { ...full, result: null };
    for (const contents of webContentsWithRoles(['main'])) {
      sendEvent(contents, 'recorder:state', full);
    }
    for (const contents of webContentsWithRoles(['toolbar', 'recorder', 'countdown'])) {
      sendEvent(contents, 'recorder:state', redacted);
    }
  }

  // --- commands ----------------------------------------------------------------------------

  async start(request: RecorderStartRequest): Promise<{ sessionId: string }> {
    if (!isFinished(this.machine.status)) {
      throw new IpcError('BUSY', 'A recording is already in progress.');
    }
    if (this.deps.isScreenshotBusy()) {
      throw new IpcError('BUSY', 'A capture is already in progress.');
    }
    if (request.target === 'window' && request.sourceId) {
      const windows = await this.deps.provider.listSources({
        types: ['window'],
        thumbnailWidth: 0,
      });
      if (!windows.some((source) => source.id === request.sourceId)) {
        throw new IpcError('NOT_FOUND', 'That window is no longer available.');
      }
    }
    await this.ensureCanRecord();
    const main = getMainWindow();
    this.mainWasShown = main !== undefined && main.isVisible() && !main.isMinimized();
    // A second start while this one awaited the listing is refused above on re-entry.
    if (!isFinished(this.machine.status))
      throw new IpcError('BUSY', 'A recording is already in progress.');
    if (this.machine.status !== 'idle') this.dispatch({ type: 'RESET' });

    const sessionId = randomUUID();
    this.token += 1;
    this.stopPromise = undefined;
    this.ctx = {
      sessionId,
      target: request.target,
      options: {
        ...structuredClone(request.options),
        // No system audio where the OS has no loopback: the request is dropped up front.
        systemAudio:
          request.options.systemAudio && platformCapabilities(process.platform).systemAudio,
      },
      sourceId: request.sourceId ?? '',
      sourceName: '',
      display: undefined,
      regionPx: null,
      regionDip: null,
      mime: '',
      width: null,
      height: null,
      audio: { mic: false, system: false },
      canUseDefaultMic: false,
      countdown: null,
      progress: null,
      result: null,
      sessionCreated: false,
    };
    this.dispatch({ type: 'START_REQUESTED', sessionId });
    const token = this.token;
    void this.runStart(token, request).catch((error: unknown) => this.failStart(token, error));
    return { sessionId };
  }

  /** Refuses to start when the disk is nearly full or ffmpeg (needed to finish the file) is missing. */
  private async ensureCanRecord(): Promise<void> {
    try {
      this.deps.tools.paths();
    } catch {
      throw new IpcError(
        'FFMPEG_MISSING',
        'FrameCapt cannot finish recordings because its video tools are missing. Reinstall FrameCapt.',
      );
    }
    await this.deps.ensureOutputDir?.();
    await this.deps.sessions.ensureSpaceToStart();
  }

  pause(): void {
    if (this.machine.status !== 'recording') return void log.info('Recorder: pause ignored');
    if (!this.dispatch({ type: 'PAUSE', at: performance.now() })) return;
    this.send({ cmd: 'pause' });
    void this.deps.sessions.recordPause(this.machine.sessionId ?? '', true);
  }

  resume(): void {
    if (this.machine.status !== 'paused') return void log.info('Recorder: resume ignored');
    if (!this.dispatch({ type: 'RESUME', at: performance.now() })) return;
    this.send({ cmd: 'resume' });
    void this.deps.sessions.recordPause(this.machine.sessionId ?? '', false);
  }

  toggleMute(source: AudioSource): void {
    const state = this.machine;
    if (!state.audio[source] || state.lost[source]) return;
    const muted = !state.muted[source];
    if (this.dispatch({ type: 'MUTE_SET', source, muted })) {
      this.send({ cmd: 'mute', source, muted });
    }
  }

  /** Cancels the start-up (selection, preflight, countdown, starting). Recording itself: use stop. */
  cancel(): void {
    if (!isPreRecording(this.machine.status)) return void log.info('Recorder: cancel ignored');
    log.info('Recording cancelled before it started');
    this.endStartup(new Cancelled());
    this.dispatch({ type: 'CANCEL' });
    this.afterStartupEnded();
  }

  /**
   * Stops the recording and finalizes it: engine flush, session finish, publish. Idempotent: any
   * number of calls join the same work. Before recording started it is a cancel.
   */
  stop(reason: 'user' | 'app-quit' | 'engine-closed' = 'user'): Promise<void> {
    const before = this.machine.status;
    if (isPreRecording(before)) {
      this.cancel();
      return Promise.resolve();
    }
    this.dispatch({ type: 'STOP', at: performance.now(), reason });
    if (this.machine.status === 'stopping') this.stopPromise ??= this.finalize();
    return this.stopPromise ?? Promise.resolve();
  }

  reset(): void {
    if (this.machine.status !== 'completed' && this.machine.status !== 'error') return;
    this.dispatch({ type: 'RESET' });
    this.ctx = null;
    this.stopPromise = undefined;
  }

  resolveChoice(answer: 'continue-without' | 'use-default' | 'cancel'): void {
    const waiter = this.choiceWaiter;
    if (!waiter || this.machine.choice === null) {
      throw new IpcError('NOT_FOUND', 'There is nothing to decide right now.');
    }
    this.choiceWaiter = undefined;
    waiter(answer);
  }

  // --- start-up ----------------------------------------------------------------------------

  private isCurrent(token: number): boolean {
    return this.token === token && isPreRecording(this.machine.status);
  }

  private guard(token: number): void {
    if (!this.isCurrent(token)) throw new Cancelled();
  }

  private async runStart(token: number, request: RecorderStartRequest): Promise<void> {
    const ctx = this.requireCtx();
    const displays = this.deps.provider.listDisplays();
    await this.hideMain();
    this.guard(token);

    const selection = await this.select(token, request, displays);
    this.guard(token);
    ctx.display = selection.display;
    ctx.regionPx = selection.regionPx;
    ctx.regionDip = selection.regionDip;
    await this.resolveSource(ctx);
    this.closeOverlays();
    this.dispatch({ type: 'SOURCE_SELECTED' });

    // Preflight: acquire and check every source. Anything missing is the user's decision.
    for (;;) {
      this.guard(token);
      const reply = await this.engineRequest(
        {
          cmd: 'prepare',
          requestId: randomUUID(),
          sourceId: ctx.sourceId,
          kind: ctx.target === 'window' ? 'window' : 'screen',
          region: ctx.regionPx,
          displaySize: ctx.display?.physicalSize ?? null,
          options: ctx.options,
          ...(this.deps.synthetic && {
            synthetic:
              ctx.display !== undefined
                ? { ...ctx.display.physicalSize }
                : { width: 1280, height: 720 },
          }),
        },
        ['prepared', 'needsChoice', 'prepareFailed', 'error'],
        PREPARE_TIMEOUT_MS,
      );
      this.guard(token);
      if (reply.type === 'prepared') {
        ctx.mime = reply.mime;
        ctx.width = reply.width;
        ctx.height = reply.height;
        ctx.audio = reply.audio;
        break;
      }
      if (reply.type === 'needsChoice') {
        ctx.canUseDefaultMic = reply.canUseDefaultMic;
        this.dispatch({ type: 'PREFLIGHT_NEEDS_CHOICE', choice: reply.choice });
        this.restoreMain();
        const answer = await new Promise<'continue-without' | 'use-default' | 'cancel'>(
          (resolve) => {
            this.choiceWaiter = resolve;
          },
        );
        this.guard(token);
        if (answer === 'cancel') {
          this.cancel();
          throw new Cancelled();
        }
        await this.hideMain();
        this.guard(token);
        if (answer === 'use-default') ctx.options.mic = { enabled: true };
        else if (reply.choice === 'system-audio-unavailable') ctx.options.systemAudio = false;
        else ctx.options.mic = { enabled: false };
        continue;
      }
      throw new StartFailure(
        reply.type === 'prepareFailed' || reply.type === 'error' ? reply.code : 'PREPARE_FAILED',
        reply.type === 'prepareFailed' || reply.type === 'error'
          ? reply.message
          : 'Could not get ready to record.',
      );
    }

    this.dispatch({ type: 'PREFLIGHT_OK' });
    this.ensureToolbar(ctx);
    await this.hideMain();
    this.guard(token);
    if (ctx.options.countdown) await this.runCountdown(token, ctx);
    this.guard(token);
    this.dispatch({ type: 'COUNTDOWN_DONE' });

    // Starting: the session directory exists before the first chunk can arrive.
    await this.deps.sessions.create(
      {
        mime: ctx.mime,
        source: {
          kind: ctx.target,
          // A generic label, never the window's title: titles name documents and people, and this file
          // stays on disk for as long as a session is unfinished.
          name: ctx.target === 'window' ? 'Window' : 'Screen',
          ...(ctx.display && { displayId: ctx.display.id }),
        },
        options: ctx.options,
        width: ctx.width ?? 0,
        height: ctx.height ?? 0,
      },
      ctx.sessionId,
      peekWorkerWindow()?.webContents.id,
    );
    ctx.sessionCreated = true;
    this.guard(token);
    const started = await this.engineRequest(
      { cmd: 'start', requestId: randomUUID(), sessionId: ctx.sessionId },
      ['started', 'error'],
      START_TIMEOUT_MS,
    );
    this.guard(token);
    if (started.type !== 'started') {
      throw new StartFailure(
        started.type === 'error' ? started.code : 'START_FAILED',
        started.type === 'error' ? started.message : 'Recording could not start.',
      );
    }
    this.dispatch({
      type: 'STARTED',
      at: performance.now(),
      wallClock: Date.now(),
      audio: ctx.audio,
    });
    this.token += 1; // start-up is over: late start-up work can no longer act
    this.showToolbar();
    log.info(
      `Recording started: ${ctx.target}, ${ctx.width}x${ctx.height}, ` +
        `mic=${ctx.audio.mic} system=${ctx.audio.system}`,
    );
  }

  private requireCtx(): SessionContext {
    if (!this.ctx) throw new Cancelled();
    return this.ctx;
  }

  /** What to record: a window, a whole display, or a region of one. */
  private async select(
    token: number,
    request: RecorderStartRequest,
    displays: readonly DisplayInfo[],
  ): Promise<Selection> {
    if (request.target === 'window') return { display: undefined, regionPx: null, regionDip: null };

    if (request.target === 'screen') {
      const only = request.displayId
        ? displays.find((candidate) => candidate.id === request.displayId)
        : displays.length === 1
          ? displays[0]
          : undefined;
      if (request.displayId && !only) {
        throw new StartFailure('SOURCE_MISSING', 'That screen is no longer available.');
      }
      if (only) return { display: only, regionPx: null, regionDip: null };
    }
    if (displays.length === 0)
      throw new StartFailure('SOURCE_MISSING', 'No screen was found to record.');
    const mode = request.target === 'screen' ? 'pick-display' : 'record-region';
    const overlays = new OverlaySet(mode, {
      onAllBlurred: () => {
        log.info('Overlays lost focus; cancelling the recording');
        this.cancel();
      },
    });
    this.overlays = overlays;
    overlays.open(displays);
    overlays.setFrames(new Map());
    this.watchDisplays(token);
    return new Promise<Selection>((resolve, reject) => {
      this.selectionWaiter = { resolve, reject };
    });
  }

  private async resolveSource(ctx: SessionContext): Promise<void> {
    if (ctx.target === 'window') {
      const windows = await this.deps.provider.listSources({
        types: ['window'],
        thumbnailWidth: 0,
      });
      const found = windows.find((source) => source.id === ctx.sourceId);
      if (!found) throw new StartFailure('SOURCE_MISSING', 'That window is no longer available.');
      ctx.sourceName = found.name;
      return;
    }
    const display = ctx.display;
    if (!display) throw new StartFailure('SOURCE_MISSING', 'No screen was found to record.');
    const screens = await this.deps.provider.listSources({ types: ['screen'], thumbnailWidth: 0 });
    const source = screens.find((candidate) => candidate.displayId === display.id);
    if (!source) throw new StartFailure('SOURCE_MISSING', 'That screen is no longer available.');
    ctx.sourceId = source.id;
    ctx.sourceName = source.name;
  }

  private watchDisplays(token: number): void {
    const onChange = (): void => {
      log.warn('Displays changed while selecting; cancelling the recording');
      this.failStart(
        token,
        new StartFailure('DISPLAYS_CHANGED', 'Your screens changed. Please try again.'),
      );
    };
    screen.on('display-added', onChange);
    screen.on('display-removed', onChange);
    screen.on('display-metrics-changed', onChange);
    this.removeDisplayListeners = () => {
      screen.removeListener('display-added', onChange);
      screen.removeListener('display-removed', onChange);
      screen.removeListener('display-metrics-changed', onChange);
    };
  }

  private closeOverlays(): void {
    this.removeDisplayListeners?.();
    this.removeDisplayListeners = undefined;
    this.overlays?.close();
    this.overlays = undefined;
    this.selectionWaiter = undefined;
  }

  // Overlay IPC (SelectionHost) ---------------------------------------------------------------

  overlayInit(webContentsId: number): Promise<OverlayInit | undefined> {
    return this.overlays?.initFor(webContentsId) ?? Promise.resolve(undefined);
  }

  overlayReady(webContentsId: number): void {
    this.overlays?.show(webContentsId);
  }

  selectionStarted(webContentsId: number): void {
    this.overlays?.clearSelectionsExcept(this.overlays.displayIdOf(webContentsId));
  }

  /** Region mode: map the selection (overlay DIP) to display pixels, even aligned. */
  async confirmRegion(webContentsId: number, displayId: string, rect: Rect): Promise<void> {
    const overlays = this.overlays;
    const waiter = this.selectionWaiter;
    if (
      !overlays ||
      !waiter ||
      overlays.mode !== 'record-region' ||
      this.machine.status !== 'selecting'
    ) {
      throw new IpcError('NOT_FOUND', 'There is no selection in progress.');
    }
    if (overlays.displayIdOf(webContentsId) !== displayId) {
      throw new IpcError('INVALID_PAYLOAD', 'Selection does not belong to this screen.');
    }
    const display = this.deps.provider
      .listDisplays()
      .find((candidate) => candidate.id === displayId);
    if (!display) throw new IpcError('NOT_FOUND', 'That screen is gone.');
    const geom = toGeom(display);
    const mapped = overlayRectToFramePixels(rect, geom, display.physicalSize);
    if (!mapped.ok) {
      throw new IpcError(
        'INVALID_PAYLOAD',
        mapped.reason === 'too-small' ? 'The selection is too small.' : 'The selection is invalid.',
      );
    }
    // 4:2:0 video needs even sides: x, y, width and height are rounded down to even.
    const aligned = checkPixelRect(mapped.rect, display.physicalSize, { align: 2 });
    if (!aligned.ok) throw new IpcError('INVALID_PAYLOAD', 'The selection is too small.');
    const local = framePixelsToDip(aligned.rect, geom, display.physicalSize);
    this.selectionWaiter = undefined;
    waiter.resolve({
      display,
      regionPx: aligned.rect,
      regionDip: {
        x: display.bounds.x + local.x,
        y: display.bounds.y + local.y,
        width: local.width,
        height: local.height,
      },
    });
    await Promise.resolve();
  }

  async pickDisplay(webContentsId: number, displayId: string): Promise<void> {
    const overlays = this.overlays;
    const waiter = this.selectionWaiter;
    if (
      !overlays ||
      !waiter ||
      overlays.mode !== 'pick-display' ||
      this.machine.status !== 'selecting'
    ) {
      throw new IpcError('NOT_FOUND', 'There is no screen selection in progress.');
    }
    if (overlays.displayIdOf(webContentsId) !== displayId) {
      throw new IpcError('INVALID_PAYLOAD', 'That screen is not part of this selection.');
    }
    const display = this.deps.provider
      .listDisplays()
      .find((candidate) => candidate.id === displayId);
    if (!display) throw new IpcError('NOT_FOUND', 'That screen is no longer available.');
    this.selectionWaiter = undefined;
    waiter.resolve({ display, regionPx: null, regionDip: null });
    await Promise.resolve();
  }

  // --- countdown ---------------------------------------------------------------------------

  private realDisplayFor(display: DisplayInfo | undefined): Electron.Display {
    const all = screen.getAllDisplays();
    return (
      all.find((candidate) => String(candidate.id) === display?.id) ??
      (display === undefined
        ? screen.getDisplayNearestPoint(screen.getCursorScreenPoint())
        : screen.getPrimaryDisplay())
    );
  }

  private async runCountdown(token: number, ctx: SessionContext): Promise<void> {
    const real = this.realDisplayFor(ctx.display);
    const countdown = createCountdownWindow(real.bounds);
    this.countdownWindow = countdown;
    const registered = globalShortcut.register('Escape', () => this.cancel());
    if (!registered) log.warn('Could not register Esc for the countdown (in use by another app)');
    try {
      // The window asks for the state when its page has mounted; show it then.
      countdown.win.webContents.once('did-finish-load', () =>
        setTimeout(() => countdown.reveal(), 60),
      );
      for (let n = COUNTDOWN_FROM; n >= 1; n -= 1) {
        ctx.countdown = n;
        this.broadcast();
        await sleep(1000);
        this.guard(token);
      }
    } finally {
      ctx.countdown = null;
      if (registered) globalShortcut.unregister('Escape');
      countdown.close();
      this.countdownWindow = undefined;
    }
    // The countdown window is gone (it was content protected as well) before the first frame.
    await sleep(120);
  }

  // --- the toolbar -------------------------------------------------------------------------

  private placementDisplays(): PlacementDisplay[] {
    return screen.getAllDisplays().map((display) => ({
      id: String(display.id),
      bounds: display.bounds,
      workArea: display.workArea,
    }));
  }

  private ensureToolbar(ctx: SessionContext): void {
    if (this.toolbar) return;
    const width = toolbarWidth(ctx.audio);
    const real = this.realDisplayFor(ctx.display);
    const target =
      ctx.regionDip && !this.deps.synthetic && ctx.display
        ? ({ kind: 'region', displayId: ctx.display.id, region: ctx.regionDip } as const)
        : ({ kind: 'display', displayId: String(real.id) } as const);
    const placement = placeToolbar(
      { width, height: TOOLBAR_HEIGHT },
      target,
      this.placementDisplays(),
    );
    log.info(
      `Toolbar placed: ${placement.where}, outside the recording: ${placement.outsideRecording}`,
    );
    this.toolbar = createToolbarWindow(placement, width, () => {
      this.toolbar = undefined;
      log.info('Toolbar window closed by the user');
      void this.stop('user');
    });
  }

  private showToolbar(): void {
    const toolbar = this.toolbar;
    if (!toolbar || toolbar.win.isDestroyed()) return;
    toolbar.win.showInactive();
    this.setLevels(true);
  }

  private closeToolbar(): void {
    this.setLevels(false);
    this.toolbar?.closeQuietly();
    this.toolbar = undefined;
  }

  /** The toolbar measured its content: the window takes exactly that width (centered on itself). */
  resizeToolbar(width: number): void {
    this.toolbar?.setWidth(Math.ceil(width));
  }

  private setLevels(enabled: boolean): void {
    if (this.levelsOn === enabled) return;
    this.levelsOn = enabled;
    this.send({ cmd: 'levels', enabled });
  }

  // --- stopping ----------------------------------------------------------------------------

  /** Engine flush -> session finish -> remux and publish. Runs once per recording. */
  private async finalize(): Promise<void> {
    const ctx = this.requireCtx();
    const { sessions } = this.deps;
    const sessionId = ctx.sessionId;
    try {
      await sessions.markStopping(sessionId);
      let complete = false;
      try {
        const reply = await this.engineRequest(
          { cmd: 'stop', requestId: randomUUID() },
          ['stopped', 'error'],
          STOP_TIMEOUT_MS,
        );
        complete = reply.type === 'stopped';
        if (reply.type === 'error') {
          log.warn(`Recorder stopped with an error: ${reply.code}`);
          this.dispatch({
            type: 'WRITE_FAILED',
            at: performance.now(),
            code: reply.code,
            message: reply.message,
          });
        }
      } catch (error) {
        log.warn(
          `Recorder did not confirm the stop (${error instanceof StartFailure ? error.code : 'error'})`,
        );
        this.dispatch({
          type: 'WRITE_FAILED',
          at: performance.now(),
          code: 'ENGINE_LOST',
          message: 'The recorder stopped unexpectedly. The recording may be incomplete.',
        });
      }
      if (!complete) {
        await sessions.markStopped(sessionId, {
          truncated: true,
          reason: this.machine.stopReason ?? 'unknown',
        });
      }
      this.dispatch({ type: 'STOPPED' });

      const abort = new AbortController();
      this.finalizeAbort = abort;
      // Determinate progress: the remux position against the active recording time.
      const totalMs = activeDurationAt(this.machine, performance.now());
      let lastShown = -1;
      const published = await sessions.finalize(sessionId, {
        outputDir: this.deps.outputDir(),
        tools: this.deps.tools,
        signal: abort.signal,
        onProgress: (progress) => {
          if (totalMs <= 0) return;
          const fraction = Math.min(0.99, Math.max(0, progress.outTimeUs / 1000 / totalMs));
          const percent = Math.round(fraction * 100);
          if (percent === lastShown) return;
          lastShown = percent;
          ctx.progress = fraction;
          this.broadcast();
        },
      });
      ctx.progress = null;
      // The file's own duration (probed after the remux); the active time only for a raw copy.
      const durationMs =
        published.durationMs ?? Math.round(activeDurationAt(this.machine, performance.now()));
      const historyId = await this.addToHistory(
        ctx,
        published.outputPath,
        published.bytes,
        durationMs,
      );
      ctx.result = {
        id: this.deps.media.register(published.outputPath),
        historyId,
        fileName: path.basename(published.outputPath),
        path: published.outputPath,
        durationMs,
        bytes: published.bytes,
        unindexed: published.unindexed,
        width: ctx.width ?? 0,
        height: ctx.height ?? 0,
        mime: ctx.mime,
        createdAt: Date.now(),
        hasAudio: ctx.audio.mic || ctx.audio.system,
      };
      this.dispatch({ type: 'FINALIZED' });
      this.deps.onSaved?.(historyId);
      log.info(
        `Recording saved: ${Math.round(durationMs)} ms, ${published.bytes} bytes` +
          (published.unindexed ? ' (no seeking index)' : ''),
      );
    } catch (error) {
      const code = error instanceof IpcError ? error.code : 'FINALIZE_FAILED';
      const message =
        error instanceof IpcError
          ? error.message
          : 'The recording could not be saved. The recorded data was kept.';
      log.error('Recording finalize failed', error);
      if (this.machine.status === 'stopping') this.dispatch({ type: 'STOPPED' });
      this.dispatch({ type: 'FAILED', code, message });
    } finally {
      this.finalizeAbort = undefined;
      this.send({ cmd: 'abort' });
      this.closeToolbar();
      this.restoreMain();
    }
  }

  /** The recording's history entry (it exists before the thumbnail does); null if it failed. */
  private async addToHistory(
    ctx: SessionContext,
    file: string,
    bytes: number,
    durationMs: number,
  ): Promise<string | null> {
    try {
      const added = await this.deps.history?.addVideo({
        path: file,
        format: 'webm',
        durationMs,
        width: ctx.width ?? 0,
        height: ctx.height ?? 0,
        sizeBytes: bytes,
        hasAudio: ctx.audio.mic || ctx.audio.system,
        source: ctx.target,
      });
      return added?.id ?? null;
    } catch (error) {
      log.error('The recording could not be added to history', error);
      return null;
    }
  }

  /** Free space fell below the minimum while recording: stop and keep everything written so far. */
  onDiskLow(sessionId: string): void {
    if (this.ctx?.sessionId !== sessionId) return;
    if (this.machine.status !== 'recording' && this.machine.status !== 'paused') return;
    log.warn('Disk space is low; stopping the recording');
    this.dispatch({
      type: 'WRITE_FAILED',
      at: performance.now(),
      code: 'DISK_LOW',
      message: 'Your disk is almost full, so the recording was stopped to keep what was saved.',
    });
    this.stopPromise ??= this.finalize();
  }

  // --- the engine --------------------------------------------------------------------------

  /** Sends to the recorder window if there is one (it is created by the first request). */
  private send(command: EngineCommand): void {
    const win = peekWorkerWindow();
    if (win) sendEvent(win.webContents, 'recorder:engineCommand', command);
  }

  private watchWorker(win: BrowserWindow): void {
    if (this.watchedWorker === win) return;
    this.watchedWorker = win;
    win.once('closed', () => {
      this.watchedWorker = undefined;
      for (const [id, waiter] of this.waiters) {
        waiter.resolve({
          type: 'error',
          code: 'ENGINE_CLOSED',
          message: 'The recorder window closed unexpectedly.',
          requestId: id,
        });
      }
      this.waiters.clear();
      if (this.machine.status === 'recording' || this.machine.status === 'paused') {
        log.warn('Recorder window closed during a recording');
        void this.stop('engine-closed');
      } else if (isPreRecording(this.machine.status)) {
        this.failStart(
          this.token,
          new StartFailure('ENGINE_CLOSED', 'The recorder window closed unexpectedly.'),
        );
      }
    });
  }

  /** Sends a command that has a reply and waits for one of `expect` (or an error) with its id. */
  private async engineRequest(
    command: Extract<EngineCommand, { requestId: string }>,
    expect: readonly EngineEvent['type'][],
    timeoutMs: number,
  ): Promise<EngineEvent> {
    const win = getWorkerWindow();
    this.watchWorker(win);
    await Promise.race([
      whenWorkerReady(),
      sleep(10_000).then(() => {
        throw new StartFailure('WORKER_TIMEOUT', 'The recorder did not start.');
      }),
    ]);
    return new Promise<EngineEvent>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiters.delete(command.requestId);
        reject(new StartFailure('ENGINE_TIMEOUT', 'The recorder did not answer in time.'));
      }, timeoutMs);
      this.waiters.set(command.requestId, {
        types: new Set(expect),
        resolve: (event) => {
          clearTimeout(timer);
          this.waiters.delete(command.requestId);
          resolve(event);
        },
      });
      this.send(command);
    });
  }

  /** `recorder:engineEvent` from the hidden window. */
  onEngineEvent(event: EngineEvent): void {
    const requestId = 'requestId' in event ? event.requestId : undefined;
    const waiter = requestId === undefined ? undefined : this.waiters.get(requestId);
    if (waiter && (waiter.types.has(event.type) || event.type === 'error')) {
      waiter.resolve(event);
      return;
    }
    switch (event.type) {
      case 'sourceLost':
        if (this.machine.status === 'recording' || this.machine.status === 'paused') {
          log.warn('The recorded source went away; finishing the recording');
          this.dispatch({ type: 'SOURCE_LOST', at: performance.now() });
          this.stopPromise ??= this.finalize();
        } else if (isPreRecording(this.machine.status)) {
          this.failStart(this.token, new StartFailure('SOURCE_LOST', 'The source went away.'));
        }
        return;
      case 'trackEnded':
        log.warn(`Audio source ended: ${event.source}`);
        this.dispatch({ type: 'AUDIO_LOST', source: event.source });
        return;
      case 'levels':
        for (const contents of webContentsWithRoles(['toolbar'])) {
          sendEvent(contents, 'recorder:levels', { mic: event.mic, system: event.system });
        }
        return;
      case 'error':
        if (this.machine.status === 'recording' || this.machine.status === 'paused') {
          log.warn(`Recorder error: ${event.code}`);
          this.dispatch({
            type: 'WRITE_FAILED',
            at: performance.now(),
            code: event.code,
            message: event.message,
          });
          this.stopPromise ??= this.finalize();
        }
        return;
      default:
        return;
    }
  }

  // --- ending start-up and the window dance ------------------------------------------------

  /** Stops whatever start-up is waiting for. */
  private endStartup(reason: Error): void {
    this.token += 1;
    this.selectionWaiter?.reject(reason);
    this.selectionWaiter = undefined;
    const choice = this.choiceWaiter;
    this.choiceWaiter = undefined;
    choice?.('cancel');
    for (const [id, waiter] of this.waiters) {
      waiter.resolve({ type: 'error', code: 'CANCELLED', message: 'Cancelled.', requestId: id });
    }
    this.waiters.clear();
    this.closeOverlays();
    globalShortcut.unregister('Escape');
    this.countdownWindow?.close();
    this.countdownWindow = undefined;
  }

  /** Releases the engine and the session of a recording that never started. */
  private afterStartupEnded(): void {
    const ctx = this.ctx;
    this.send({ cmd: 'abort' });
    this.closeToolbar();
    if (ctx?.sessionCreated) void this.deps.sessions.abort(ctx.sessionId);
    if (this.machine.status === 'idle') this.ctx = null;
    // A cancelled start leaves the window as it was; a failure shows it (the error is there).
    if (this.machine.status !== 'idle' || this.mainWasShown) this.restoreMain();
  }

  private failStart(token: number, error: unknown): void {
    if (error instanceof Cancelled) return;
    if (this.token !== token || !isPreRecording(this.machine.status)) return;
    const code = error instanceof StartFailure ? error.code : 'START_FAILED';
    const message =
      error instanceof StartFailure
        ? error.message
        : 'Recording could not start. Please try again.';
    if (error instanceof StartFailure) log.warn(`Recording start failed: ${code}`);
    else log.error('Recording start failed', error);
    this.endStartup(new Cancelled());
    this.dispatch({ type: 'FAILED', code, message });
    this.afterStartupEnded();
  }

  private async hideMain(): Promise<void> {
    const main = getMainWindow();
    // Only a window that is on screen needs to get out of the way (a hidden one must stay hidden).
    if (main && main.isVisible() && !main.isMinimized()) {
      await new Promise<void>((resolve) => {
        const done = setTimeout(resolve, 600);
        main.once('minimize', () => {
          clearTimeout(done);
          resolve();
        });
        main.minimize();
      });
    }
    await sleep(SETTLE_MS);
  }

  private restoreMain(): void {
    const main = getMainWindow();
    if (!main) return;
    if (main.isMinimized()) main.restore();
    main.show();
    main.focus();
  }

  // --- quitting ----------------------------------------------------------------------------

  /**
   * `before-quit`: a recording in progress is stopped and finalized first (the toolbar says
   * "Finishing recording..."), with a hard cap; past the cap the session directory stays for
   * recovery. Returns true when the quit must wait.
   */
  handleBeforeQuit(event: { preventDefault: () => void }, quit: () => void): void {
    if (this.quitAllowed) return;
    if (isPreRecording(this.machine.status)) {
      this.cancel();
      return;
    }
    if (!this.isRecording) return;
    event.preventDefault();
    if (this.quitting) return;
    this.quitting = true;
    this.broadcast();
    log.info('Quit requested during a recording; finishing it first');
    void settleWithin(this.stop('app-quit'), this.deps.quitCapMs ?? QUIT_FINALIZE_CAP_MS).then(
      async (outcome) => {
        if (outcome === 'timeout') {
          log.warn('Finalizing took too long; the session is kept for recovery');
          this.finalizeAbort?.abort(); // kills ffmpeg; the manifest stays for the next start
          await sleep(300);
        }
        this.quitAllowed = true;
        quit();
      },
    );
  }

  /** True while quitting must not close windows by itself. */
  get isQuitting(): boolean {
    return this.quitting;
  }
}
