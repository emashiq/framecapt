import { randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { screen } from 'electron';
import type { CameraSetStyleRequest, CameraStyleState } from '../../shared/camera';
import { framePixelsToDip, overlayRectToFramePixels, type Size } from '../../shared/geometry';
import type { PanelKind, PanelPlaceholder, PanelSlot } from '../../shared/panels';
import type {
  EngineEvent,
  RecorderSessionSummary,
  RecorderSnapshot,
  RecorderStartRequest,
} from '../../shared/recorder-ipc';
import type { AudioSource, RecorderStatus } from '../../shared/recorder-machine';
import {
  CAMERA_BUSY_MESSAGE,
  SYSTEM_AUDIO_BUSY_MESSAGE,
  allocateCamera,
  allocateSystemAudio,
  canStart,
  isActiveStatus,
  primaryOf,
} from '../../shared/recorder-sessions';
import { checkPixelRect, type Rect } from '../../shared/rect';
import type { ToastEvent } from '../../shared/settings-ipc';
import type { OverlayInit, OverlayMode } from '../../shared/shot-ipc';
import type { Role } from '../../shared/types';
import type { DisplayInfo } from '../capture/types';
import { sendEvent } from '../events';
import { IpcError } from '../ipc-core';
import { log } from '../logger';
import { OverlaySet } from '../overlay';
import type { SelectionHost } from '../selection-host';
import { getMainWindow, isOwnUiFocused, webContentsWithRoles } from '../windows';
import { settleWithin } from './quit-cap';
import {
  Cancelled,
  RecordingSession,
  StartFailure,
  toGeom,
  type PanelSpec,
  type RecorderDeps,
  type Selection,
  type SessionHost,
  type SessionSnapshot,
} from './recording-session';

export type { RecorderDeps } from './recording-session';

/** Time for the window manager to remove a hidden/closed window from the composed desktop. */
const SETTLE_MS = 200;
/** On app quit the recordings get this long to finish before their sessions are left for recovery. */
export const QUIT_FINALIZE_CAP_MS = 15_000;

/** The one selection step (overlays on the screens) that exists at a time: only one recording starts at once. */
interface SelectionSlot {
  session: RecordingSession;
  overlays: OverlaySet;
  waiter: { resolve: (value: Selection) => void; reject: (e: Error) => void } | undefined;
  removeDisplayListeners: () => void;
  /** The selection picks a live panel's region (the recording is running), not a recording's start. */
  panel: boolean;
}

/** What the panel menu and the IPC channel ask for; main resolves it to a source. */
export interface AddPanelRequest {
  sessionId?: string | undefined;
  kind: PanelKind;
  sourceId?: string | undefined;
  displayId?: string | undefined;
}

/** What every window sees while nothing is recording. */
const IDLE_SNAPSHOT: SessionSnapshot = {
  status: 'idle',
  sessionId: null,
  target: null,
  startedAt: null,
  activeMs: 0,
  runningSince: null,
  error: null,
  stopReason: null,
  audio: { mic: false, system: false },
  muted: { mic: false, system: false },
  lost: { mic: false, system: false },
  lostTiles: [],
  choice: null,
  choiceCanUseDefault: false,
  camera: null,
  quitting: false,
  countdown: null,
  progress: null,
  width: null,
  height: null,
  result: null,
  panelSlots: [],
};

/**
 * The coordinator of up to three simultaneous recordings (see recording-session.ts for one). It
 * owns what they share: the table of recordings, the selection overlays (one start-up at a time),
 * the main window's hide/restore, the quit and the state broadcast. Windows only send commands
 * (`recorder:*`); a toolbar's command goes to its own recording, the main window's and the
 * tray's to a named one or, by default, the primary one (see primaryOf). The public API of the
 * single-recording era keeps working on the primary recording.
 */
export class RecorderController implements SelectionHost, SessionHost {
  private readonly table = new Map<string, RecordingSession>();
  private selection: SelectionSlot | undefined;
  private quitting = false;
  private quitAllowed = false;
  private readonly changeListeners = new Set<() => void>();
  /** The last status seen per recording (a failure that nobody can see is announced). */
  private readonly lastStatus = new Map<string, RecorderStatus>();

  constructor(private readonly deps: RecorderDeps) {}

  // --- reading state -----------------------------------------------------------------------

  private all(): RecordingSession[] {
    return [...this.table.values()];
  }

  private primary(): RecordingSession | undefined {
    return primaryOf(this.all());
  }

  private find(sessionId: string): RecordingSession | undefined {
    return this.table.get(sessionId);
  }

  /** The status of the primary recording (idle without any). */
  get status(): RecorderStatus {
    return this.primary()?.status ?? 'idle';
  }

  /** A recording is running (or ending): the app must not quit or close its windows carelessly. */
  get isRecording(): boolean {
    return this.all().some((session) => session.isRecording);
  }

  /** At least one recording is recording or paused (a screenshot may be taken; a recording is on screen). */
  get anyLive(): boolean {
    return this.all().some((session) => session.isLive);
  }

  /** Anything that must keep a screenshot from starting (see anyLive: a live recording allows one). */
  get anyBusy(): boolean {
    return this.all().some((session) => !session.isFinished);
  }

  /** A recording is selecting, preflighting, counting down or starting (only one at a time). */
  get startupInProgress(): boolean {
    return this.all().some((session) => session.isPreRecording);
  }

  /** The recorder owns the overlay windows right now (selection step). */
  get selecting(): boolean {
    return this.selection !== undefined;
  }

  /** True while quitting must not close windows by itself. */
  get isQuitting(): boolean {
    return this.quitting;
  }

  /** Every recording, oldest first. */
  sessions(): RecorderSessionSummary[] {
    return this.all().map((session) => session.summary());
  }

  /** The id of the recording the window (engine, toolbar or countdown) belongs to. */
  sessionIdOf(webContentsId: number): string | undefined {
    return this.all().find((session) => session.ownsWebContents(webContentsId))?.id;
  }

  private withList(snapshot: SessionSnapshot, redact: boolean): RecorderSnapshot {
    return {
      ...snapshot,
      result: redact ? null : snapshot.result,
      sessions: this.sessions(),
      canStartAnother: canStart(this.all()),
      quitting: this.quitting,
    };
  }

  /** The primary recording, as the main window and the tray see it. */
  snapshot(): RecorderSnapshot {
    return this.withList(this.primary()?.snapshot() ?? IDLE_SNAPSHOT, false);
  }

  /**
   * The state as one window may see it. The main window gets the primary recording, including the
   * finished file (name, path, history id); a toolbar, countdown or recorder window gets its own
   * recording, without the file.
   */
  snapshotFor(role: Role, webContentsId?: number): RecorderSnapshot {
    if (role === 'main') return this.snapshot();
    const own =
      webContentsId === undefined
        ? undefined
        : this.all().find((session) => session.ownsWebContents(webContentsId));
    return this.withList((own ?? this.primary())?.snapshot() ?? IDLE_SNAPSHOT, true);
  }

  /** Runs after every state change (the tray follows the recording state). */
  onChange(listener: () => void): () => void {
    this.changeListeners.add(listener);
    return () => this.changeListeners.delete(listener);
  }

  private broadcast(): void {
    for (const listener of this.changeListeners) listener();
    for (const contents of webContentsWithRoles(['main'])) {
      sendEvent(contents, 'recorder:state', this.snapshot());
    }
    for (const contents of webContentsWithRoles(['toolbar', 'recorder', 'countdown'])) {
      sendEvent(contents, 'recorder:state', this.snapshotFor('toolbar', contents.id));
    }
  }

  // --- SessionHost -------------------------------------------------------------------------

  changed(session: RecordingSession): void {
    // A cancelled start-up and a reset recording leave the table.
    if (session.status === 'idle') {
      this.table.delete(session.id);
      this.lastStatus.delete(session.id);
    } else {
      const before = this.lastStatus.get(session.id);
      this.lastStatus.set(session.id, session.status);
      if (session.status === 'error' && before !== 'error') this.announceFailure(session);
    }
    this.broadcast();
  }

  /** A recording failed while the main window (which shows errors) is out of the way: say so in a toolbar. */
  private announceFailure(session: RecordingSession): void {
    const main = getMainWindow();
    if (main?.isVisible() || !this.anyLive) return;
    const message = session.snapshot().error?.message;
    if (message) this.toastToolbar({ level: 'error', message });
  }

  hideMain(): Promise<void> {
    return hideMainWindow();
  }

  restoreMain(session: RecordingSession, force = false): void {
    // Another recording that is starting or on screen still needs the window out of the way.
    const needed = this.all().some(
      (other) => other !== session && (other.isPreRecording || other.isLive),
    );
    if (needed && !force) return;
    const main = getMainWindow();
    if (!main) return;
    if (main.isMinimized()) main.restore();
    main.show();
    main.focus();
  }

  toolbarBlurred(): void {
    // The user may have clicked another app from the toolbar while a selection was open.
    this.selection?.overlays.recheckBlur();
    this.deps.onToolbarBlur?.();
  }

  // --- commands ----------------------------------------------------------------------------

  async start(request: RecorderStartRequest): Promise<{ sessionId: string }> {
    // The real entry point of every recording (button, shortcut, tray and direct IPC alike).
    this.ensureCanStartAnother();
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
    if (request.target === 'multi') {
      // Every source must still exist: screens and windows come from one fresh listing.
      const listed = await this.deps.provider.listSources({
        types: ['screen', 'window'],
        thumbnailWidth: 0,
      });
      const gone = request.sources?.some(
        ({ sourceId }) => !listed.some((source) => source.id === sourceId),
      );
      if (gone) throw new IpcError('NOT_FOUND', 'One of the sources is no longer available.');
    }
    await this.ensureCanRecord();
    const main = getMainWindow();
    const mainWasShown = main !== undefined && main.isVisible() && !main.isMinimized();
    // A second start while this one awaited the listing is refused here, on re-entry.
    this.ensureCanStartAnother();

    // Starting a recording replaces the results nobody reset.
    for (const session of this.all()) {
      if (session.isFinished) {
        this.table.delete(session.id);
        this.lastStatus.delete(session.id);
      }
    }
    const others = this.all().map((session) => ({
      status: session.status,
      systemAudio: session.systemAudioRequested,
      camera: session.cameraRequested,
    }));
    const audio = allocateSystemAudio(others, request.options.systemAudio);
    const camera = allocateCamera(others, request.options.camera !== undefined);
    const options = { ...request.options, systemAudio: audio.systemAudio };
    if (camera.dropped) delete options.camera;
    if (audio.dropped) this.toastUser({ level: 'info', message: SYSTEM_AUDIO_BUSY_MESSAGE });
    if (camera.dropped) this.toastUser({ level: 'info', message: CAMERA_BUSY_MESSAGE });

    const sessionId = randomUUID();
    const session = new RecordingSession(
      sessionId,
      this.nextLabel(),
      { ...request, options },
      mainWasShown,
      this.deps,
      this,
    );
    this.table.set(sessionId, session);
    session.begin();
    return { sessionId };
  }

  private ensureCanStartAnother(): void {
    if (this.startupInProgress) throw new IpcError('BUSY', 'A recording is already starting.');
    if (!canStart(this.all())) {
      throw new IpcError('BUSY', 'The most recordings that can run at once are already running.');
    }
  }

  /** "Recording 1", the lowest number not taken by a recording that exists. */
  private nextLabel(): string {
    const taken = new Set(this.all().map((session) => session.label));
    let n = 1;
    while (taken.has(`Recording ${n}`)) n += 1;
    return `Recording ${n}`;
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
    const running = this.all().filter((session) => isActiveStatus(session.status)).length;
    await this.deps.sessions.ensureSpaceToStart(running);
  }

  /** The recording a command is for: the named one, else the primary one. */
  private target(sessionId: string | undefined): RecordingSession | undefined {
    return sessionId === undefined ? this.primary() : this.find(sessionId);
  }

  pause(sessionId?: string): void {
    const session = this.target(sessionId);
    if (session) session.pause();
    else log.info('Recorder: pause ignored');
  }

  resume(sessionId?: string): void {
    const session = this.target(sessionId);
    if (session) session.resume();
    else log.info('Recorder: resume ignored');
  }

  toggleMute(source: AudioSource, sessionId?: string): void {
    this.target(sessionId)?.toggleMute(source);
  }

  /**
   * Cancels the start-up (selection, preflight, countdown, starting; the overlay's Esc calls it
   * too). A recording itself is ended with stop.
   */
  cancel(sessionId?: string): void {
    // The overlay's Esc during a panel's region selection.
    if (sessionId === undefined && this.selection?.panel) {
      this.closeSelection(this.selection.session, new Cancelled());
      return;
    }
    const session =
      sessionId === undefined
        ? this.all().find((candidate) => candidate.isPreRecording)
        : this.find(sessionId);
    if (session) session.cancel();
    else log.info('Recorder: cancel ignored');
  }

  /**
   * Stops a recording and finalizes it: engine flush, session finish, publish. Idempotent: any
   * number of calls join the same work. Before recording started it is a cancel.
   */
  stop(reason: 'user' | 'app-quit' | 'engine-closed' = 'user', sessionId?: string): Promise<void> {
    return this.target(sessionId)?.stop(reason) ?? Promise.resolve();
  }

  /** Stops every recording (the tray's "Stop all recordings"). */
  stopAll(): Promise<void> {
    return Promise.all(
      this.all()
        .filter((session) => session.isLive || session.isPreRecording)
        .map((session) => session.stop('user')),
    ).then(() => undefined);
  }

  reset(sessionId?: string): void {
    this.target(sessionId)?.reset();
  }

  resolveChoice(answer: 'continue-without' | 'use-default' | 'cancel', sessionId?: string): void {
    const session =
      sessionId === undefined
        ? this.all().find((candidate) => candidate.isPreRecording)
        : this.find(sessionId);
    if (!session) throw new IpcError('NOT_FOUND', 'There is nothing to decide right now.');
    session.resolveChoice(answer);
  }

  /** Free space fell below the minimum while recording: that recording stops and keeps what was written. */
  onDiskLow(sessionId: string): void {
    this.find(sessionId)?.onDiskLow();
  }

  // --- live panels --------------------------------------------------------------------------

  /** The recording a panel command is for: the named one, else the primary one if live, else the newest live one. */
  private panelSession(sessionId: string | undefined): RecordingSession {
    const session = this.liveSession(sessionId);
    if (!session) throw new IpcError('NOT_FOUND', 'There is no recording to change.');
    return session;
  }

  /**
   * Adds a region, window or screen to a running recording (the toolbar's "Add panel", the main
   * window's). A region opens the selection overlays and resolves when the user has chosen it;
   * it rejects with Cancelled when the user backs out. Returns the panel's slot (1..3).
   */
  async addPanel(request: AddPanelRequest): Promise<{ slot: number }> {
    const session = this.panelSession(request.sessionId);
    const refusal = session.panelRefusal();
    if (refusal) throw refusal;
    const spec = await this.resolvePanel(session, request);
    return { slot: await session.addPanel(spec) };
  }

  /** Adds a source main already knows (a meeting window, a shared screen) to a recording. */
  async addPanelSource(
    sessionId: string,
    source: { kind: PanelKind; sourceId: string; region?: Rect; displaySize?: Size },
  ): Promise<number> {
    return this.panelSession(sessionId).addPanel({
      kind: source.kind,
      sourceId: source.sourceId,
      region: source.region ?? null,
      displaySize: source.displaySize ?? null,
    });
  }

  /** What the panel menu shows for a recording (the named one, else the live one the UI follows). */
  panelState(
    sessionId: string | undefined,
  ): { sessionId: string; panels: PanelSlot[]; addDisabled: boolean } | undefined {
    const session = this.liveSession(sessionId);
    if (!session?.isLive) return undefined;
    return {
      sessionId: session.id,
      panels: session.snapshot().panelSlots,
      addDisabled: session.panelRefusal() !== null,
    };
  }

  removePanel(sessionId: string | undefined, slot: number): void {
    this.panelSession(sessionId).removePanel(slot);
  }

  setPanelHidden(
    sessionId: string | undefined,
    slot: number,
    hidden: boolean,
    placeholder: PanelPlaceholder,
  ): void {
    this.panelSession(sessionId).setPanelHidden(slot, hidden, placeholder);
  }

  /** Checks the request against a fresh listing (like a recording's start does) and picks the region. */
  private async resolvePanel(
    session: RecordingSession,
    request: AddPanelRequest,
  ): Promise<PanelSpec> {
    const { provider } = this.deps;
    if (request.kind === 'window') {
      const windows = await provider.listSources({ types: ['window'], thumbnailWidth: 0 });
      if (!windows.some((source) => source.id === request.sourceId)) {
        throw new IpcError('NOT_FOUND', 'That window is no longer available.');
      }
      return { kind: 'window', sourceId: request.sourceId ?? '', region: null, displaySize: null };
    }
    const screens = await provider.listSources({ types: ['screen'], thumbnailWidth: 0 });
    const displays = provider.listDisplays();
    const gone = new IpcError('NOT_FOUND', 'That screen is no longer available.');
    if (request.kind === 'screen') {
      const source = request.sourceId
        ? screens.find((candidate) => candidate.id === request.sourceId)
        : screens.find((candidate) => candidate.displayId === request.displayId);
      const display = displays.find((candidate) => candidate.id === source?.displayId);
      if (!source || !display) throw gone;
      return {
        kind: 'screen',
        sourceId: source.id,
        region: null,
        displaySize: display.physicalSize,
      };
    }
    const chosen = await this.selectPanelRegion(session, displays);
    const source = screens.find((candidate) => candidate.displayId === chosen.display?.id);
    if (!chosen.display || !chosen.regionPx || !source) throw gone;
    return {
      kind: 'region',
      sourceId: source.id,
      region: chosen.regionPx,
      displaySize: chosen.display.physicalSize,
    };
  }

  /** The region overlay of a running recording: the one selection slot, like a recording's start. */
  private async selectPanelRegion(
    session: RecordingSession,
    displays: readonly DisplayInfo[],
  ): Promise<Selection> {
    if (this.selection || this.startupInProgress || this.deps.isScreenshotBusy()) {
      throw new IpcError('BUSY', 'Another selection is already open.');
    }
    if (displays.length === 0) throw new IpcError('NOT_FOUND', 'No screen was found.');
    const cancel = (): void => this.closeSelection(session, new Cancelled());
    const picked = this.beginSelection(session, 'record-region', displays, true, {
      onBlur: cancel,
      onDisplaysChanged: cancel,
    });
    this.raiseToolbar();
    try {
      return await picked;
    } finally {
      this.closeSelection(session, new Cancelled());
    }
  }

  // --- screenshots, toolbars and the camera -------------------------------------------------

  /** The recording a toolbar message is for: the named one, else the newest live one. */
  private liveSession(sessionId: string | undefined): RecordingSession | undefined {
    if (sessionId !== undefined) return this.find(sessionId);
    const primary = this.primary();
    return primary?.isLive
      ? primary
      : this.all()
          .reverse()
          .find((session) => session.isLive);
  }

  /** A short result line in a recording's toolbar pill ("Screenshot saved"). */
  toastToolbar(event: ToastEvent, sessionId?: string): void {
    this.liveSession(sessionId)?.toastToolbar(event);
  }

  /** A message for the user: the main window when it is on screen, else a recording's toolbar. */
  private toastUser(event: ToastEvent): void {
    if (getMainWindow()?.isVisible()) {
      for (const contents of webContentsWithRoles(['main'])) {
        sendEvent(contents, 'app:toast', event);
      }
    } else this.toastToolbar(event);
  }

  /** The toolbar's camera button: a still of what a recording records, saved to the screenshots folder. */
  async screenshotNow(sessionId?: string): Promise<void> {
    const session = this.liveSession(sessionId);
    if (!session || !session.isLive) {
      throw new IpcError('NOT_FOUND', 'There is no recording to capture.');
    }
    await session.screenshotNow();
  }

  /** Keeps the toolbars clickable above selection overlays opened during a recording. */
  raiseToolbar(): void {
    for (const session of this.all()) session.raiseToolbar();
  }

  /** The toolbar's camera button. */
  toggleCamera(sessionId?: string): void {
    this.cameraOwner(sessionId).toggleCamera();
  }

  /** The toolbar measured its content: its window takes exactly that width (centered on itself). */
  resizeToolbar(width: number, webContentsId: number): void {
    this.all()
      .find((session) => session.ownsWebContents(webContentsId))
      ?.resizeToolbar(width);
  }

  private cameraOwner(sessionId?: string): RecordingSession {
    const session =
      sessionId === undefined
        ? this.all().find((candidate) => candidate.hasCamera)
        : this.find(sessionId);
    if (!session) throw new IpcError('NOT_FOUND', 'This recording has no camera.');
    return session;
  }

  /** `camera:getStyle`: what the bubble shows. */
  cameraStyle(): CameraStyleState {
    return this.cameraOwner().cameraStyle();
  }

  /** `camera:setStyle`: the bubble's own size, shape and hide buttons. */
  setCameraStyle(request: CameraSetStyleRequest): CameraStyleState {
    return this.cameraOwner().setCameraStyle(request);
  }

  // --- the engines -------------------------------------------------------------------------

  /** `recorder:engineEvent` from a hidden recorder window (without an id: the primary recording's). */
  onEngineEvent(event: EngineEvent, webContentsId?: number): void {
    const session =
      webContentsId === undefined
        ? this.primary()
        : this.all().find((candidate) => candidate.ownsEngine(webContentsId));
    session?.onEngineEvent(event);
  }

  // --- the selection overlays (SelectionHost) ----------------------------------------------

  openSelection(
    session: RecordingSession,
    token: number,
    mode: OverlayMode,
    displays: readonly DisplayInfo[],
  ): Promise<Selection> {
    return this.beginSelection(session, mode, displays, false, {
      onBlur: () => {
        log.info('Overlays lost focus; cancelling the recording');
        session.cancel();
      },
      onDisplaysChanged: () => {
        log.warn('Displays changed while selecting; cancelling the recording');
        session.failStart(
          token,
          new StartFailure('DISPLAYS_CHANGED', 'Your screens changed. Please try again.'),
        );
      },
    });
  }

  private beginSelection(
    session: RecordingSession,
    mode: OverlayMode,
    displays: readonly DisplayInfo[],
    panel: boolean,
    handlers: { onBlur: () => void; onDisplaysChanged: () => void },
  ): Promise<Selection> {
    const overlays = new OverlaySet(mode, {
      isOwnUiFocused,
      onAllBlurred: handlers.onBlur,
    });
    const slot: SelectionSlot = {
      session,
      overlays,
      waiter: undefined,
      removeDisplayListeners: () => undefined,
      panel,
    };
    this.selection = slot;
    overlays.open(displays);
    overlays.setFrames(new Map());
    slot.removeDisplayListeners = this.watchDisplays(handlers.onDisplaysChanged);
    return new Promise<Selection>((resolve, reject) => {
      slot.waiter = { resolve, reject };
    });
  }

  private watchDisplays(onChange: () => void): () => void {
    screen.on('display-added', onChange);
    screen.on('display-removed', onChange);
    screen.on('display-metrics-changed', onChange);
    return () => {
      screen.removeListener('display-added', onChange);
      screen.removeListener('display-removed', onChange);
      screen.removeListener('display-metrics-changed', onChange);
    };
  }

  closeSelection(session: RecordingSession, reason: Error): void {
    const slot = this.selection;
    if (!slot || slot.session !== session) return;
    this.selection = undefined;
    slot.waiter?.reject(reason);
    slot.removeDisplayListeners();
    slot.overlays.close();
  }

  overlayInit(webContentsId: number): Promise<OverlayInit | undefined> {
    return this.selection?.overlays.initFor(webContentsId) ?? Promise.resolve(undefined);
  }

  overlayReady(webContentsId: number): void {
    this.selection?.overlays.show(webContentsId);
  }

  selectionStarted(webContentsId: number): void {
    const overlays = this.selection?.overlays;
    overlays?.clearSelectionsExcept(overlays.displayIdOf(webContentsId));
  }

  /** Region mode: map the selection (overlay DIP) to display pixels, even aligned. */
  async confirmRegion(webContentsId: number, displayId: string, rect: Rect): Promise<void> {
    const slot = this.selection;
    const waiter = slot?.waiter;
    if (
      !slot ||
      !waiter ||
      slot.overlays.mode !== 'record-region' ||
      (slot.panel ? !slot.session.isLive : slot.session.status !== 'selecting')
    ) {
      throw new IpcError('NOT_FOUND', 'There is no selection in progress.');
    }
    if (slot.overlays.displayIdOf(webContentsId) !== displayId) {
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
    slot.waiter = undefined;
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
    const slot = this.selection;
    const waiter = slot?.waiter;
    if (
      !slot ||
      !waiter ||
      slot.overlays.mode !== 'pick-display' ||
      slot.session.status !== 'selecting'
    ) {
      throw new IpcError('NOT_FOUND', 'There is no screen selection in progress.');
    }
    if (slot.overlays.displayIdOf(webContentsId) !== displayId) {
      throw new IpcError('INVALID_PAYLOAD', 'That screen is not part of this selection.');
    }
    const display = this.deps.provider
      .listDisplays()
      .find((candidate) => candidate.id === displayId);
    if (!display) throw new IpcError('NOT_FOUND', 'That screen is no longer available.');
    slot.waiter = undefined;
    waiter.resolve({ display, regionPx: null, regionDip: null });
    await Promise.resolve();
  }

  // --- quitting ----------------------------------------------------------------------------

  /**
   * `before-quit`: recordings in progress are stopped and finalized first, all at once (their
   * toolbars say "Finishing recording..."), inside one hard cap; past the cap the session
   * directories stay for recovery. A recording that is only starting is cancelled.
   */
  handleBeforeQuit(event: { preventDefault: () => void }, quit: () => void): void {
    if (this.quitAllowed) return;
    for (const session of this.all()) {
      if (session.isPreRecording) session.cancel();
    }
    const recording = this.all().filter((session) => session.isRecording);
    if (recording.length === 0) return;
    event.preventDefault();
    if (this.quitting) return;
    this.quitting = true;
    this.broadcast();
    log.info(`Quit requested during ${recording.length} recording(s); finishing them first`);
    const stopped = Promise.all(recording.map((session) => session.stop('app-quit')));
    void settleWithin(stopped, this.deps.quitCapMs ?? QUIT_FINALIZE_CAP_MS).then(
      async (outcome) => {
        if (outcome === 'timeout') {
          log.warn('Finalizing took too long; the sessions are kept for recovery');
          // kills ffmpeg; the manifests stay for the next start
          for (const session of recording) session.abortFinalize();
          await sleep(300);
        }
        this.quitAllowed = true;
        quit();
      },
    );
  }
}

/** Minimizes the main window if it is on screen and lets the desktop settle (it must not be in the picture). */
async function hideMainWindow(): Promise<void> {
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
