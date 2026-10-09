import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import {
  globalShortcut,
  nativeImage,
  screen,
  type BrowserWindow,
  type WebContents,
} from 'electron';
import type {
  CameraCorner,
  CameraSetStyleRequest,
  CameraShape,
  CameraSize,
  CameraStyleState,
} from '../../shared/camera';
import { globalDipToDisplayLocal, type DisplayGeom, type Size } from '../../shared/geometry';
import {
  freePanelSlot,
  MAX_PANELS,
  panelLabel,
  type PanelKind,
  type PanelPlaceholder,
  type PanelSlot,
} from '../../shared/panels';
import { platformCapabilities } from '../../shared/platform';
import type {
  EngineCommand,
  EngineEvent,
  RecordOptions,
  RecorderSessionSummary,
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
import type { Rect } from '../../shared/rect';
import { layoutSourceName, type RecordingLayout } from '../../shared/recording-layout';
import type { ToastEvent } from '../../shared/settings-ipc';
import type { OverlayMode } from '../../shared/shot-ipc';
import type { CaptureTarget } from '../../shared/shots';
import {
  placeToolbar,
  TOOLBAR_HEIGHT,
  toolbarWidth,
  type PlacementDisplay,
} from '../../shared/toolbar-placement';
import { grabScreensExact } from '../capture/exact-capture';
import type { CaptureProvider, DisplayInfo } from '../capture/types';
import { sendEvent } from '../events';
import type { HistorySink } from '../history/service';
import { IpcError } from '../ipc-core';
import { log } from '../logger';
import type { MediaTools } from '../media/ffmpeg';
import type { MediaRegistry } from '../recording/media-protocol';
import type { ManifestPanel } from '../recording/session-service';
import type { SessionService } from '../recording/session-service';
import { requestFrames } from '../worker';
import { CameraBubble } from './camera';
import type { EngineWindowPool } from './engine-pool';
import {
  createCountdownWindow,
  createToolbarWindow,
  type CountdownWindow,
  type ToolbarWindow,
} from './windows';

const COUNTDOWN_FROM = 3;
const PREPARE_TIMEOUT_MS = 20_000;
const START_TIMEOUT_MS = 10_000;
const STOP_TIMEOUT_MS = 20_000;
/** Adding a panel acquires a capture stream and waits for its first frame. */
const PANEL_TIMEOUT_MS = 15_000;
/** How often the mouse is sampled for a follow-mouse recording. */
const CURSOR_INTERVAL_MS = 1000 / 30;

/** The user (or a source change) ended the start-up before recording began. */
export class Cancelled extends Error {}

export class StartFailure extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

/** The sources of a multi-source recording, in the order the user chose them (the first is the primary). */
interface MultiContext {
  sources: {
    sourceId: string;
    kind: 'screen' | 'window';
    /** Generic ("Screen 1", "Window 2"): window titles never reach disk. */
    name: string;
    /** Screens only. */
    display: DisplayInfo | undefined;
  }[];
  /** Each source's tile in the recorded picture (known once the engine has prepared). */
  tiles: Rect[];
}

interface SessionContext {
  sessionId: string;
  target: RecordTarget;
  options: RecordOptions;
  sourceId: string;
  sourceName: string;
  display: DisplayInfo | undefined;
  /** Multi-source recordings: the sources and where they sit in the picture. */
  multi: MultiContext | null;
  /** The ids of the requested sources (multi-source recordings), until they are resolved. */
  multiIds: string[];
  /** Multi-source recordings: indexes of the sources that went away (the recording goes on). */
  lostTiles: Set<number>;
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

/** A source to add to the picture of a running recording, already resolved by main. */
export interface PanelSpec {
  kind: PanelKind;
  sourceId: string;
  /** Region in pixels of the display (even aligned), for a region panel. */
  region: Rect | null;
  /** Physical size of the display (screen and region panels). */
  displaySize: Size | null;
}

/** One panel of the recording; `removedAtMs` is null while it is in the picture. */
interface PanelState extends ManifestPanel {
  hidden: boolean;
  placeholder: PanelPlaceholder | null;
}

/** What the selection step chose. */
export interface Selection {
  display: DisplayInfo | undefined;
  regionPx: Rect | null;
  regionDip: Rect | null;
}

export interface RecorderDeps {
  provider: CaptureProvider;
  sessions: SessionService;
  media: MediaRegistry;
  /** The hidden windows that run the engines (one per recording). */
  engines: EngineWindowPool;
  /** E2E mock builds: the engine draws a synthetic picture and positions use real displays. */
  synthetic: boolean;
  /** Saves a screenshot taken during the recording (a file in the screenshots folder, plus history). */
  saveScreenshot: (shot: {
    kind: CaptureTarget;
    width: number;
    height: number;
    png: Buffer;
  }) => Promise<{ copied?: boolean } | void>;
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
  /** The camera bubble's size, shape and corner are remembered in the recording settings. */
  persistCameraStyle?: (patch: {
    cameraSize?: CameraSize;
    cameraShape?: CameraShape;
    cameraCorner?: CameraCorner;
  }) => void;
  /** A recording's toolbar lost focus (an open selection checks whether the user left FrameCapt). */
  onToolbarBlur?: () => void;
  /** Overrides the 15 s quit cap (E2E builds only). */
  quitCapMs?: number;
  /** E2E builds only: the engine's start command is sent this many ms late (a slow PC). */
  engineStartDelayMs?: number;
}

/** What a recording needs from the controller that owns all of them. */
export interface SessionHost {
  /** The app is quitting and finishing the recordings first. */
  readonly isQuitting: boolean;
  /** This recording's state (or its countdown, camera, ...) changed. */
  changed(session: RecordingSession): void;
  /** The one selection slot: overlays for a screen or region pick (only one start-up at a time). */
  openSelection(
    session: RecordingSession,
    token: number,
    mode: OverlayMode,
    displays: readonly DisplayInfo[],
  ): Promise<Selection>;
  /** Closes the selection if it is this recording's; a still-waiting pick is rejected with `reason`. */
  closeSelection(session: RecordingSession, reason: Error): void;
  hideMain(): Promise<void>;
  /** Brings the main window back unless another recording still needs it out of the way (or `force`). */
  restoreMain(session: RecordingSession, force?: boolean): void;
  /** One of this recording's windows lost focus. */
  toolbarBlurred(): void;
}

/** Where a display sits on the virtual desktop, in physical pixels. */
function physicalRect(display: DisplayInfo): Rect {
  return {
    x: Math.round(display.bounds.x * display.scaleFactor),
    y: Math.round(display.bounds.y * display.scaleFactor),
    ...display.physicalSize,
  };
}

/** The recorded layout of a multi-source recording, with generic names only. */
function multiLayout(multi: MultiContext, width: number, height: number): RecordingLayout {
  return {
    width,
    height,
    sources: multi.sources.map((source, index) => ({
      name: source.name,
      kind: source.kind,
      rect: multi.tiles[index] ?? { x: 0, y: 0, width, height },
    })),
  };
}

export function toGeom(display: DisplayInfo): DisplayGeom {
  return {
    id: display.id,
    bounds: display.bounds,
    scaleFactor: display.scaleFactor,
    rotation: display.rotation,
  };
}

/** A recording's state as one window sees it (the list of all recordings is added by the controller). */
export type SessionSnapshot = Omit<RecorderSnapshot, 'sessions' | 'canStartAnother'>;

/**
 * One recording: its state machine, its hidden engine window, toolbar, countdown and camera, and
 * the whole path from start-up to the saved file. The controller owns up to three of them and the
 * things they share (the selection overlays, the main window, quitting). Commands are idempotent
 * where it matters: a second stop (toolbar button, main window, closing the toolbar, source loss,
 * quitting the app) is a no-op that joins the first.
 */
export class RecordingSession {
  private machine: RecorderMachineState = createInitialState();
  private ctx: SessionContext;
  private token = 0;
  private choiceWaiter:
    ((answer: 'continue-without' | 'use-default' | 'cancel') => void) | undefined;
  private countdownWindow: CountdownWindow | undefined;
  private toolbar: ToolbarWindow | undefined;
  private camera: CameraBubble | undefined;
  private stopPromise: Promise<void> | undefined;
  /** Cancels the running remux (quit past the cap). */
  private finalizeAbort: AbortController | undefined;
  /** This recording's hidden engine window, once it has one. */
  private engineWin: BrowserWindow | undefined;
  /** The engine was given back: a window that arrives late is given back at once. */
  private engineReleased = false;
  private levelsOn = false;
  /** A screenshot of the recording is being taken (a second click waits for it). */
  private snapping = false;
  /** Follow-mouse recordings: samples the mouse for the engine. */
  private cursorTimer: ReturnType<typeof setInterval> | undefined;
  private lastCursor: { nx: number; ny: number } | undefined;
  /** Every panel this recording had, in the order they were added (removed ones keep their times). */
  private panelLog: PanelState[] = [];
  /** Slots whose panel is being added (the engine is still acquiring the source). */
  private readonly pendingSlots = new Set<number>();
  private readonly waiters = new Map<
    string,
    { types: ReadonlySet<string>; resolve: (event: EngineEvent) => void }
  >();

  constructor(
    sessionId: string,
    /** "Recording 1", "Recording 2": shown wherever recordings are listed. */
    readonly label: string,
    private readonly request: RecorderStartRequest,
    /** The main window was on screen when this recording was requested (a shortcut may start it from the tray). */
    private readonly mainWasShown: boolean,
    private readonly deps: RecorderDeps,
    private readonly host: SessionHost,
  ) {
    this.ctx = {
      sessionId,
      target: request.target,
      options: {
        ...structuredClone(request.options),
        // No system audio where the OS has no loopback: the request is dropped up front.
        systemAudio:
          request.options.systemAudio && platformCapabilities(process.platform).systemAudio,
      },
      sourceId: request.sourceId ?? request.sources?.[0]?.sourceId ?? '',
      sourceName: '',
      display: undefined,
      multi: null,
      multiIds: request.sources?.map(({ sourceId }) => sourceId) ?? [],
      lostTiles: new Set(),
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
    // Only a whole screen follows the mouse (several sources never do).
    if (request.target !== 'screen') delete this.ctx.options.follow;
  }

  /** Starts the start-up (selection, preflight, countdown, the engine's start). */
  begin(): void {
    this.dispatch({ type: 'START_REQUESTED', sessionId: this.ctx.sessionId });
    const token = this.token;
    void this.runStart(token, this.request).catch((error: unknown) => this.failStart(token, error));
  }

  // --- reading state -----------------------------------------------------------------------

  get id(): string {
    return this.ctx.sessionId;
  }

  get status(): RecorderMachineState['status'] {
    return this.machine.status;
  }

  /** Recording or paused: the one state in which a screenshot may be taken. */
  get isLive(): boolean {
    return this.machine.status === 'recording' || this.machine.status === 'paused';
  }

  /** Recording, paused or being saved: the app must not quit or close its windows carelessly. */
  get isRecording(): boolean {
    const { status } = this.machine;
    return (
      status === 'recording' ||
      status === 'paused' ||
      status === 'stopping' ||
      status === 'processing'
    );
  }

  get isPreRecording(): boolean {
    return isPreRecording(this.machine.status);
  }

  get isFinished(): boolean {
    return isFinished(this.machine.status);
  }

  get systemAudioRequested(): boolean {
    return this.ctx.options.systemAudio;
  }

  get cameraRequested(): boolean {
    return this.ctx.options.camera !== undefined;
  }

  get target(): RecordTarget {
    return this.ctx.target;
  }

  get currentToken(): number {
    return this.token;
  }

  /** The webContents of this recording's engine, toolbar and countdown windows. */
  ownsWebContents(id: number): boolean {
    return [this.engineWin, this.toolbar?.win, this.countdownWindow?.win].some(
      (win) => win !== undefined && !win.isDestroyed() && win.webContents.id === id,
    );
  }

  ownsEngine(id: number): boolean {
    return this.engineWin !== undefined && this.engineWin.webContents.id === id;
  }

  /** Every live webContents of this recording (state broadcasts go to them). */
  windows(): WebContents[] {
    return [this.engineWin, this.toolbar?.win, this.countdownWindow?.win]
      .filter((win): win is BrowserWindow => win !== undefined && !win.isDestroyed())
      .map((win) => win.webContents);
  }

  summary(): RecorderSessionSummary {
    const snapshot = this.snapshot();
    return {
      sessionId: this.ctx.sessionId,
      label: this.label,
      status: snapshot.status,
      target: snapshot.target,
      activeMs: snapshot.activeMs,
      runningSince: snapshot.runningSince,
      progress: snapshot.progress,
      quitting: snapshot.quitting,
      panels: this.livePanels().length,
    };
  }

  snapshot(): SessionSnapshot {
    const state = this.machine;
    const ctx = this.ctx;
    const nowMono = performance.now();
    return {
      status: state.status,
      sessionId: state.sessionId,
      target: ctx.target,
      startedAt: state.startedAt,
      activeMs: state.activeDurationMs,
      runningSince:
        state.segmentStartedAt === null ? null : Date.now() - (nowMono - state.segmentStartedAt),
      error: state.error,
      stopReason: state.stopReason,
      audio: state.audio,
      muted: state.muted,
      lost: state.lost,
      lostTiles: [...ctx.lostTiles].sort((a, b) => a - b),
      choice: state.choice,
      choiceCanUseDefault: ctx.canUseDefaultMic,
      camera: this.camera ? { visible: this.camera.visible } : null,
      quitting: this.host.isQuitting,
      countdown: ctx.countdown,
      progress: ctx.progress,
      width: ctx.width,
      height: ctx.height,
      result: state.status === 'completed' ? ctx.result : null,
      panelSlots: this.livePanels().map((panel): PanelSlot => ({
        slot: panel.slot,
        kind: panel.kind,
        label: panel.name,
        hidden: panel.hidden,
        placeholder: panel.placeholder,
      })),
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
      if (state.status !== before.status) {
        log.info(`Recorder ${this.label}: ${before.status} -> ${state.status}`);
      }
      this.host.changed(this);
    }
    return true;
  }

  // --- commands ----------------------------------------------------------------------------

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
    log.info(`Recording cancelled before it started (${this.label})`);
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

  /** The result (or error) was seen: the recording can go. Returns whether it was finished. */
  reset(): boolean {
    if (this.machine.status !== 'completed' && this.machine.status !== 'error') return false;
    this.dispatch({ type: 'RESET' });
    this.stopPromise = undefined;
    return true;
  }

  resolveChoice(answer: 'continue-without' | 'use-default' | 'cancel'): void {
    const waiter = this.choiceWaiter;
    if (!waiter || this.machine.choice === null) {
      throw new IpcError('NOT_FOUND', 'There is nothing to decide right now.');
    }
    this.choiceWaiter = undefined;
    waiter(answer);
  }

  // --- live panels -------------------------------------------------------------------------

  private livePanels(): PanelState[] {
    return this.panelLog.filter((panel) => panel.removedAtMs === null);
  }

  /** Why a panel cannot be added right now (null: it can). */
  panelRefusal(): IpcError | null {
    if (!this.isLive) {
      return new IpcError('NOT_FOUND', 'Panels can only be added while a recording is running.');
    }
    if (this.ctx.target === 'multi') {
      return new IpcError(
        'INVALID_PAYLOAD',
        'Panels are not available for a recording of several sources.',
      );
    }
    if (this.livePanels().length + this.pendingSlots.size >= MAX_PANELS) {
      return new IpcError('PANEL_LIMIT', `A recording can have at most ${MAX_PANELS} panels.`);
    }
    return null;
  }

  /** Time in the recording (paused time excluded) for the manifest. */
  private recordingMs(): number {
    return Math.round(activeDurationAt(this.machine, performance.now()));
  }

  private saveSlots(): void {
    const panels: ManifestPanel[] = this.panelLog.map(
      ({ slot, kind, name, addedAtMs, removedAtMs }) => ({
        slot,
        kind,
        name,
        addedAtMs,
        removedAtMs,
      }),
    );
    void this.deps.sessions.recordPanels(this.ctx.sessionId, panels).catch(() => undefined);
  }

  /** Adds a source to the picture; returns its slot (1..3). The engine draws it from the next frame. */
  async addPanel(spec: PanelSpec): Promise<number> {
    const refusal = this.panelRefusal();
    if (refusal) throw refusal;
    const used = [...this.livePanels().map((panel) => panel.slot), ...this.pendingSlots];
    const slot = freePanelSlot(used);
    if (slot === undefined)
      throw new IpcError('PANEL_LIMIT', 'A recording can have at most 3 panels.');
    this.pendingSlots.add(slot);
    let reply: EngineEvent;
    try {
      reply = await this.engineRequest(
        {
          cmd: 'addPanel',
          requestId: randomUUID(),
          slot,
          sourceId: spec.sourceId,
          kind: spec.kind === 'window' ? 'window' : 'screen',
          region: spec.region,
          displaySize: spec.displaySize,
          ...(this.deps.synthetic && {
            synthetic: spec.displaySize ? { ...spec.displaySize } : { width: 1280, height: 720 },
          }),
        },
        ['panelAdded', 'panelFailed'],
        PANEL_TIMEOUT_MS,
      );
    } catch (error) {
      log.warn(`Adding a panel failed: ${error instanceof StartFailure ? error.code : 'error'}`);
      throw new IpcError('NOT_FOUND', "That source couldn't be added to the recording.");
    } finally {
      this.pendingSlots.delete(slot);
    }
    if (reply.type !== 'panelAdded') {
      log.warn(`The engine could not add a panel: ${'code' in reply ? reply.code : reply.type}`);
      throw new IpcError('NOT_FOUND', "That source couldn't be added to the recording.");
    }
    if (!this.isLive) {
      // The recording ended while the source was being added: the engine is released with it.
      throw new IpcError('NOT_FOUND', 'The recording has ended.');
    }
    this.panelLog.push({
      slot,
      kind: spec.kind,
      name: panelLabel(slot),
      addedAtMs: this.recordingMs(),
      removedAtMs: null,
      hidden: false,
      placeholder: null,
    });
    this.saveSlots();
    this.host.changed(this);
    log.info(`Panel added (${this.label}): ${spec.kind} in slot ${slot}`);
    return slot;
  }

  private livePanel(slot: number): PanelState {
    const panel = this.livePanels().find((candidate) => candidate.slot === slot);
    if (!panel) throw new IpcError('NOT_FOUND', 'That panel is no longer in the recording.');
    return panel;
  }

  removePanel(slot: number): void {
    if (!this.isLive) throw new IpcError('NOT_FOUND', 'There is no recording to change.');
    const panel = this.livePanel(slot);
    panel.removedAtMs = this.recordingMs();
    this.send({ cmd: 'removePanel', slot });
    this.saveSlots();
    this.host.changed(this);
  }

  /** Hides a picture behind a neutral card (audio goes on) or shows it again. Slot 0 is the recording itself. */
  setPanelHidden(slot: number, hidden: boolean, placeholder: PanelPlaceholder): void {
    if (!this.isLive) throw new IpcError('NOT_FOUND', 'There is no recording to change.');
    if (slot > 0) {
      const panel = this.livePanel(slot);
      panel.hidden = hidden;
      panel.placeholder = hidden ? placeholder : null;
    }
    this.send({ cmd: 'setPanelHidden', slot, hidden, placeholder });
    this.host.changed(this);
  }

  /** Aborts the remux that is running (quit past the cap); the session stays for recovery. */
  abortFinalize(): void {
    this.finalizeAbort?.abort();
  }

  // --- start-up ----------------------------------------------------------------------------

  private isCurrent(token: number): boolean {
    return this.token === token && isPreRecording(this.machine.status);
  }

  private guard(token: number): void {
    if (!this.isCurrent(token)) throw new Cancelled();
  }

  private async runStart(token: number, request: RecorderStartRequest): Promise<void> {
    const ctx = this.ctx;
    const displays = this.deps.provider.listDisplays();
    await this.host.hideMain();
    this.guard(token);

    const selection = await this.select(token, request, displays);
    this.guard(token);
    ctx.display = selection.display;
    ctx.regionPx = selection.regionPx;
    ctx.regionDip = selection.regionDip;
    await this.resolveSource(ctx);
    this.host.closeSelection(this, new Cancelled());
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
          ...(ctx.multi && {
            multi: ctx.multi.sources.map((source) => ({
              sourceId: source.sourceId,
              kind: source.kind,
              rect: source.display ? physicalRect(source.display) : null,
              ...(this.deps.synthetic && {
                synthetic: source.display
                  ? { ...source.display.physicalSize }
                  : { width: 1280, height: 720 },
              }),
            })),
          }),
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
        if (ctx.multi) {
          if (reply.tiles?.length !== ctx.multi.sources.length) {
            throw new StartFailure('PREPARE_FAILED', 'Could not get ready to record.');
          }
          ctx.multi.tiles = reply.tiles;
        }
        break;
      }
      if (reply.type === 'needsChoice') {
        ctx.canUseDefaultMic = reply.canUseDefaultMic;
        this.dispatch({ type: 'PREFLIGHT_NEEDS_CHOICE', choice: reply.choice });
        this.host.restoreMain(this, true);
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
        await this.host.hideMain();
        this.guard(token);
        if (reply.choice === 'camera-missing') delete ctx.options.camera;
        else if (answer === 'use-default') ctx.options.mic = { enabled: true };
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
    this.pumpCursor(ctx); // the follow window starts where the mouse is, not mid-screen
    this.ensureToolbar(ctx);
    this.ensureCamera(ctx);
    await this.host.hideMain();
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
          name: ctx.multi ? 'Multiple sources' : ctx.target === 'window' ? 'Window' : 'Screen',
          ...(ctx.display && !ctx.multi && { displayId: ctx.display.id }),
        },
        ...(ctx.multi && { layout: multiLayout(ctx.multi, ctx.width ?? 0, ctx.height ?? 0) }),
        options: ctx.options,
        width: ctx.width ?? 0,
        height: ctx.height ?? 0,
      },
      ctx.sessionId,
      this.engineWin?.webContents.id,
    );
    ctx.sessionCreated = true;
    this.guard(token);
    if (this.deps.engineStartDelayMs) {
      await new Promise((resolve) => setTimeout(resolve, this.deps.engineStartDelayMs));
      this.guard(token);
    }
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
    this.startCursorFollow(ctx);
    this.showToolbar();
    log.info(
      `Recording started (${this.label}): ${ctx.target}, ${ctx.width}x${ctx.height}, ` +
        `mic=${ctx.audio.mic} system=${ctx.audio.system}`,
    );
  }

  /** What to record: a window, a whole display, or a region of one. */
  private async select(
    token: number,
    request: RecorderStartRequest,
    displays: readonly DisplayInfo[],
  ): Promise<Selection> {
    if (request.target === 'window') return { display: undefined, regionPx: null, regionDip: null };
    if (request.target === 'multi') {
      // No selection step: the sources are chosen already. The countdown and the toolbar use the primary screen.
      const primary = displays.find((display) => display.isPrimary) ?? displays[0];
      if (!primary) throw new StartFailure('SOURCE_MISSING', 'No screen was found to record.');
      return { display: primary, regionPx: null, regionDip: null };
    }

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
    return this.host.openSelection(
      this,
      token,
      request.target === 'screen' ? 'pick-display' : 'record-region',
      displays,
    );
  }

  private async resolveSource(ctx: SessionContext): Promise<void> {
    if (ctx.target === 'multi') return this.resolveMulti(ctx);
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

  /** Every requested source, checked again against a fresh listing (screens need their display). */
  private async resolveMulti(ctx: SessionContext): Promise<void> {
    const listed = await this.deps.provider.listSources({
      types: ['screen', 'window'],
      thumbnailWidth: 0,
    });
    const displays = this.deps.provider.listDisplays();
    const sources: MultiContext['sources'] = [];
    for (const [index, sourceId] of ctx.multiIds.entries()) {
      const found = listed.find((source) => source.id === sourceId);
      const display =
        found?.kind === 'screen'
          ? displays.find((candidate) => candidate.id === found.displayId)
          : undefined;
      if (!found || (found.kind === 'screen' && !display)) {
        throw new StartFailure('SOURCE_MISSING', 'One of the sources is no longer available.');
      }
      sources.push({
        sourceId,
        kind: found.kind,
        name: layoutSourceName(found.kind, index),
        display,
      });
    }
    ctx.multi = { sources, tiles: [] };
    ctx.sourceId = ctx.multiIds[0] ?? '';
    ctx.sourceName = 'Multiple sources';
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
        this.host.changed(this);
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

  // --- screenshots during a recording --------------------------------------------------------

  /** A short result line in this recording's toolbar pill ("Screenshot saved"). */
  toastToolbar(event: ToastEvent): void {
    const win = this.toolbar?.win;
    if (win && !win.isDestroyed()) sendEvent(win.webContents, 'recorder:toast', event);
  }

  /**
   * The toolbar's camera button: a still of what is being recorded (the whole screen, the recorded
   * region, or the recorded window), saved straight to the screenshots folder.
   */
  async screenshotNow(): Promise<void> {
    if (!this.isLive) throw new IpcError('NOT_FOUND', 'There is no recording to capture.');
    if (this.snapping) throw new IpcError('BUSY', 'A screenshot is already being taken.');
    this.snapping = true;
    try {
      const shot = await this.grabStill(this.ctx);
      const saved = await this.deps.saveScreenshot(shot);
      log.info(`Screenshot saved during a recording: ${shot.kind} ${shot.width}x${shot.height}`);
      this.toastToolbar({
        level: 'info',
        message: saved && saved.copied ? 'Screenshot saved and copied' : 'Screenshot saved',
      });
    } catch (error) {
      log.warn(`Screenshot during a recording failed: ${String(error)}`);
      this.toastToolbar({ level: 'error', message: "Couldn't save the screenshot" });
      throw error;
    } finally {
      this.snapping = false;
    }
  }

  private async grabStill(
    ctx: SessionContext,
  ): Promise<{ kind: CaptureTarget; width: number; height: number; png: Buffer }> {
    // A multi-source recording takes the still of its primary (first) source.
    const first = ctx.multi?.sources[0];
    const kind: CaptureTarget = first ? first.kind : (ctx.target as CaptureTarget);
    const display = first ? first.display : ctx.display;
    const regionPx = first ? null : ctx.regionPx;
    if (kind !== 'window' && display && !this.deps.synthetic) {
      // Pixel-exact desktopCapturer image; the worker's video frame is the fallback.
      const grab = await grabScreensExact([display]).catch(() => undefined);
      const exact = grab?.frames.get(display.id);
      if (exact) {
        const image = regionPx ? exact.image.crop(regionPx) : exact.image;
        const size = image.getSize();
        return { kind, width: size.width, height: size.height, png: image.toPNG() };
      }
    }
    const [frame] = await requestFrames(
      [
        {
          sourceId: ctx.sourceId,
          ...(display && { displayId: display.id }),
          ...(this.deps.synthetic && {
            syntheticSize: display ? { ...display.physicalSize } : { width: 1280, height: 720 },
          }),
        },
      ],
      { synthetic: this.deps.synthetic },
    );
    if (!frame) throw new Error('The capture returned no image.');
    if (kind === 'window' || !regionPx) {
      return { kind, width: frame.width, height: frame.height, png: frame.png };
    }
    const cropped = nativeImage.createFromBuffer(frame.png, { scaleFactor: 1 }).crop(regionPx);
    const size = cropped.getSize();
    return { kind, width: size.width, height: size.height, png: cropped.toPNG() };
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
    const toolbar = createToolbarWindow(placement, width, () => {
      this.toolbar = undefined;
      log.info('Toolbar window closed by the user');
      void this.stop('user');
    });
    this.toolbar = toolbar;
    toolbar.win.on('blur', () => this.host.toolbarBlurred());
  }

  // --- the camera bubble -------------------------------------------------------------------

  /** A recording with a camera: the bubble appears (during the countdown already) and stays until it ends. */
  private ensureCamera(ctx: SessionContext): void {
    const options = ctx.options.camera;
    if (!options || this.camera) return;
    // E2E mock displays are not on screen (like the toolbar's placement): the real display stands in.
    const captureRect = this.deps.synthetic
      ? ctx.target === 'window' || ctx.target === 'multi'
        ? null
        : this.realDisplayFor(ctx.display).bounds
      : (ctx.regionDip ?? (ctx.target === 'screen' && ctx.display ? ctx.display.bounds : null));
    this.camera = new CameraBubble({
      deviceId: options.deviceId,
      shape: options.shape,
      size: options.size,
      corner: options.corner,
      captureRect,
      homeArea: this.realDisplayFor(ctx.display).workArea,
      send: (command) => this.send(command),
      persist: (patch) => this.deps.persistCameraStyle?.(patch),
      onVisibleChange: () => this.host.changed(this),
    });
    this.camera.show();
  }

  private closeCamera(): void {
    this.camera?.close();
    this.camera = undefined;
  }

  get hasCamera(): boolean {
    return this.camera !== undefined;
  }

  private requireCamera(): CameraBubble {
    if (!this.camera) throw new IpcError('NOT_FOUND', 'This recording has no camera.');
    return this.camera;
  }

  /** `camera:getStyle`: what the bubble shows. */
  cameraStyle(): CameraStyleState {
    return this.requireCamera().styleState();
  }

  /** `camera:setStyle`: the bubble's own size, shape and hide buttons. */
  setCameraStyle(request: CameraSetStyleRequest): CameraStyleState {
    return this.requireCamera().setStyle(request);
  }

  /** Keeps the toolbar clickable above selection overlays opened during the recording. */
  raiseToolbar(): void {
    const win = this.toolbar?.win;
    if (win && !win.isDestroyed()) win.moveTop();
  }

  /** The toolbar's camera button. */
  toggleCamera(): void {
    const camera = this.requireCamera();
    camera.setVisible(!camera.visible);
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

  // --- follow mouse ------------------------------------------------------------------------

  /** Follow-mouse recordings: the mouse goes to the engine ~30 times a second, only when it moved. */
  private startCursorFollow(ctx: SessionContext): void {
    if (!ctx.options.follow || !ctx.display || this.cursorTimer !== undefined) return;
    this.cursorTimer = setInterval(() => this.pumpCursor(ctx), CURSOR_INTERVAL_MS);
  }

  private stopCursorFollow(): void {
    if (this.cursorTimer !== undefined) clearInterval(this.cursorTimer);
    this.cursorTimer = undefined;
    this.lastCursor = undefined;
  }

  /** Sends the mouse position on the recorded display; on another display the last one stays. */
  private pumpCursor(ctx: SessionContext): void {
    const { display } = ctx;
    if (!ctx.options.follow || !display) return;
    const local = globalDipToDisplayLocal(screen.getCursorScreenPoint(), toGeom(display));
    const { width, height } = display.bounds;
    if (local.x < 0 || local.y < 0 || local.x >= width || local.y >= height) return;
    const nx = local.x / width;
    const ny = local.y / height;
    if (this.lastCursor?.nx === nx && this.lastCursor.ny === ny) return;
    this.lastCursor = { nx, ny };
    this.send({ cmd: 'cursor', nx, ny });
  }

  // --- stopping ----------------------------------------------------------------------------

  /** Engine flush -> session finish -> remux and publish. Runs once per recording. */
  private async finalize(): Promise<void> {
    const ctx = this.ctx;
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
          this.host.changed(this);
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
        `Recording saved (${this.label}): ${Math.round(durationMs)} ms, ${published.bytes} bytes` +
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
      this.stopCursorFollow();
      this.releaseEngine();
      this.closeToolbar();
      this.closeCamera();
      this.host.restoreMain(this);
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
        format: ctx.multi ? 'fcap' : 'webm',
        durationMs,
        width: ctx.width ?? 0,
        height: ctx.height ?? 0,
        sizeBytes: bytes,
        hasAudio: ctx.audio.mic || ctx.audio.system,
        source: ctx.target,
        // The frame rate that was asked for: the video editor exports at it (the file itself is
        // variable frame rate and does not say).
        fps: ctx.options.fps,
      });
      return added?.id ?? null;
    } catch (error) {
      log.error('The recording could not be added to history', error);
      return null;
    }
  }

  /** Free space fell below the minimum while recording: stop and keep everything written so far. */
  onDiskLow(): void {
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

  /** Sends to this recording's engine window if it has one (it is acquired by the first request). */
  private send(command: EngineCommand): void {
    const win = this.engineWin;
    if (win && !win.isDestroyed()) sendEvent(win.webContents, 'recorder:engineCommand', command);
  }

  /** Gives this recording an engine window (a ready one), once. */
  private async ensureEngine(): Promise<void> {
    if (this.engineWin) return;
    if (this.engineReleased) {
      throw new StartFailure('ENGINE_CLOSED', 'The recorder window closed unexpectedly.');
    }
    let win: BrowserWindow;
    try {
      win = await this.deps.engines.acquire();
    } catch {
      throw new StartFailure('WORKER_TIMEOUT', 'The recorder did not start.');
    }
    if (this.engineReleased) {
      // The start-up ended while the window was starting up.
      this.deps.engines.release(win);
      throw new Cancelled();
    }
    this.engineWin = win;
    win.once('closed', () => this.onEngineClosed(win));
  }

  /** Stops the engine's work and gives the window back (the end of the recording or its start-up). */
  private releaseEngine(): void {
    this.engineReleased = true;
    const win = this.engineWin;
    this.engineWin = undefined;
    if (!win) return;
    if (!win.isDestroyed()) sendEvent(win.webContents, 'recorder:engineCommand', { cmd: 'abort' });
    this.deps.engines.release(win);
  }

  private onEngineClosed(win: BrowserWindow): void {
    if (this.engineWin !== win) return; // given back on purpose
    this.engineWin = undefined;
    this.engineReleased = true; // a recording never gets a second engine window
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
      log.warn(`Recorder window closed during a recording (${this.label})`);
      void this.stop('engine-closed');
    } else if (isPreRecording(this.machine.status)) {
      this.failStart(
        this.token,
        new StartFailure('ENGINE_CLOSED', 'The recorder window closed unexpectedly.'),
      );
    }
  }

  /** Sends a command that has a reply and waits for one of `expect` (or an error) with its id. */
  private async engineRequest(
    command: Extract<EngineCommand, { requestId: string }>,
    expect: readonly EngineEvent['type'][],
    timeoutMs: number,
  ): Promise<EngineEvent> {
    await this.ensureEngine();
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

  /** `recorder:engineEvent` from this recording's hidden window. */
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
      case 'tileLost':
        if (!this.ctx.lostTiles.has(event.index)) {
          log.warn(`A recorded source ended (source ${event.index + 1}); recording continues`);
          this.ctx.lostTiles.add(event.index);
          this.host.changed(this);
        }
        return;
      case 'panelLost': {
        const panel = this.livePanels().find((candidate) => candidate.slot === event.slot);
        if (!panel) return;
        log.warn(`A panel's source ended (${panel.name}); recording continues`);
        panel.removedAtMs = this.recordingMs();
        this.saveSlots();
        this.toastToolbar({ level: 'info', message: `${panel.name} ended` });
        this.host.changed(this);
        return;
      }
      case 'trackEnded':
        log.warn(`Audio source ended: ${event.source}`);
        this.dispatch({ type: 'AUDIO_LOST', source: event.source });
        return;
      case 'levels': {
        const win = this.toolbar?.win;
        if (win && !win.isDestroyed()) {
          sendEvent(win.webContents, 'recorder:levels', { mic: event.mic, system: event.system });
        }
        return;
      }
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
    this.stopCursorFollow();
    this.host.closeSelection(this, reason);
    const choice = this.choiceWaiter;
    this.choiceWaiter = undefined;
    choice?.('cancel');
    for (const [id, waiter] of this.waiters) {
      waiter.resolve({ type: 'error', code: 'CANCELLED', message: 'Cancelled.', requestId: id });
    }
    this.waiters.clear();
    globalShortcut.unregister('Escape');
    this.countdownWindow?.close();
    this.countdownWindow = undefined;
  }

  /** Releases the engine and the session of a recording that never started. */
  private afterStartupEnded(): void {
    const ctx = this.ctx;
    this.stopCursorFollow();
    this.releaseEngine();
    this.closeToolbar();
    this.closeCamera();
    if (ctx.sessionCreated) void this.deps.sessions.abort(ctx.sessionId);
    // A cancelled start leaves the window as it was; a failure shows it (the error is there).
    if (this.machine.status !== 'idle' || this.mainWasShown) this.host.restoreMain(this);
  }

  /** The start-up failed (or its source went away): the error is shown, everything is released. */
  failStart(token: number, error: unknown): void {
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
}
