import { setTimeout as sleep } from 'node:timers/promises';
import { nativeImage, screen } from 'electron';
import type { EditorOpenTabEvent } from '../shared/editor-ipc';
import { overlayRectToFramePixels, type DisplayGeom } from '../shared/geometry';
import type { Rect } from '../shared/rect';
import { stitchBitmaps, StitchError } from '../shared/stitch';
import type { ToastEvent } from '../shared/settings-ipc';
import type { FlowEndedEvent, OverlayMode, StartScreenshotRequest } from '../shared/shot-ipc';
import { isBlankBitmap, type CaptureTarget } from '../shared/shots';
import { grabScreensExact, grabWindowExact } from './capture/exact-capture';
import type { CaptureProvider, DisplayInfo } from './capture/types';
import { sendEvent } from './events';
import { IpcError } from './ipc-core';
import { log } from './logger';
import { OverlaySet, type FrozenFrame } from './overlay';
import { FlowState } from './shots/flow-state';
import type { ShotSessionStore } from './shots/session-store';
import { getMainWindow, isOwnUiFocused } from './windows';
import { requestFrames, WorkerError, type WorkerFrame } from './worker';

/** Time for the window manager to remove a hidden/closed window from the composed desktop. */
const SETTLE_MS = 200;
const WINDOW_UNAVAILABLE =
  "That window is minimized or can't be captured. Restore it and try again.";
const SCREEN_FAILED = 'Could not capture the screen. Please try again.';

export interface CaptureFlowDeps {
  provider: CaptureProvider;
  store: ShotSessionStore;
  /** E2E mock builds only: the worker draws generated frames instead of capturing. */
  synthetic: boolean;
  /** True while something else (a recording being set up or saved) must keep a screenshot from starting. */
  isBlocked?: () => boolean;
  /** True while a recording runs: a flow started then saves directly and leaves the windows alone. */
  isRecording?: () => boolean;
  /** All selection overlays are up during a recording: the toolbar is raised above them. */
  onOverlaysShown?: () => void;
  /** Saves a capture with no editor (during a recording); throws when it could not be saved. */
  saveDirect?: (shot: {
    kind: CaptureTarget;
    width: number;
    height: number;
    png: Buffer;
  }) => Promise<{ savedPath: string; copied?: boolean }>;
  /** Tells the user the outcome of a direct save (the recording toolbar shows it). */
  toast?: (event: ToastEvent) => void;
  /** The "after a capture" setting: copy or save before the editor opens (a failure is ignored). */
  afterCapture?: (shot: {
    kind: CaptureTarget;
    width: number;
    height: number;
    png: Buffer;
  }) => Promise<{ savedPath?: string }>;
  /** Opens the finished capture as a tab of the main window (after it is restored). */
  openEditor?: (event: EditorOpenTabEvent) => void;
}

class FlowFailure extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

/**
 * Orchestrates one screenshot capture at a time: hide the main window, grab frames through the
 * worker, show per-display overlays, crop, create the session and put everything back. Every path
 * ends in exactly one `finish`, which closes the overlays, restores the main window and tells the
 * renderer how the flow ended.
 */
export class CaptureFlow {
  readonly state = new FlowState();
  private overlays: OverlaySet | undefined;
  private displays: DisplayInfo[] = [];
  private flowId = 0;
  /** performance.now() when the current flow was requested, for the "click to overlay" timing. */
  private requestedAt = 0;
  private removeDisplayListeners: (() => void) | undefined;
  /** The main window was on screen when the flow began (a shortcut may start it from the tray). */
  private mainWasShown = true;
  /** The flow began during a recording: no main window, no editor, the image is saved directly. */
  private recordingFlow = false;

  constructor(private readonly deps: CaptureFlowDeps) {}

  /**
   * Claims the flow and starts it in the background. Throws BUSY when another flow runs and
   * NOT_FOUND when the requested window disappeared. Outcomes arrive as events.
   */
  async start(request: StartScreenshotRequest): Promise<void> {
    // The real entry point of every screenshot: the button, the shortcut, the tray and a direct IPC
    // call all land here.
    if (this.deps.isBlocked?.()) throw new IpcError('BUSY', 'A recording is in progress.');
    const recording = this.deps.isRecording?.() ?? false;
    const claim = this.state.tryStart();
    if (!claim.ok) throw new IpcError('BUSY', 'A capture is already in progress.');
    const flowId = claim.flowId;
    this.flowId = flowId;
    this.recordingFlow = recording;
    this.requestedAt = performance.now();
    const main = getMainWindow();
    this.mainWasShown = main !== undefined && main.isVisible() && !main.isMinimized();
    try {
      if (request.target === 'window' && request.sourceId) {
        const windows = await this.deps.provider.listSources({
          types: ['window'],
          thumbnailWidth: 0,
        });
        if (!windows.some((source) => source.id === request.sourceId)) {
          throw new IpcError('NOT_FOUND', 'That window is no longer available.');
        }
      }
    } catch (error) {
      this.state.end(flowId);
      throw error;
    }
    void this.run(flowId, request).catch((error: unknown) => this.fail(flowId, error));
  }

  private async run(flowId: number, request: StartScreenshotRequest): Promise<void> {
    this.displays = this.deps.provider.listDisplays();
    if (request.allScreens) {
      await this.hideMainWindow();
      await this.captureAllScreens(flowId);
      return;
    }
    if (request.target === 'window' && request.sourceId) {
      await this.hideMainWindow();
      await this.captureSingle(flowId, request.sourceId, 'window');
      return;
    }
    if (request.target === 'screen' && (request.displayId || this.displays.length === 1)) {
      const display = request.displayId
        ? this.displays.find((candidate) => candidate.id === request.displayId)
        : this.displays[0];
      const sourceId = display && (await this.screenSourceFor(display.id));
      if (!sourceId) throw new FlowFailure('SOURCE_MISSING', 'No screen was found to capture.');
      await this.hideMainWindow();
      await this.captureSingle(flowId, sourceId, 'screen', display);
      return;
    }

    const mode: OverlayMode = request.target === 'screen' ? 'pick-display' : 'region';
    const started = performance.now();
    // The overlay windows are created hidden now, so their renderers load while the main window
    // hides and the screens are grabbed; they stay invisible until they have their frame.
    const overlays = this.createOverlays(flowId, mode);
    await this.hideMainWindow();
    const hidden = performance.now();
    if (!this.state.isCurrent(flowId)) return;
    const frames = mode === 'region' ? await this.grabDisplays(this.displays) : new Map();
    const grabbed = performance.now();
    if (!this.state.isCurrent(flowId)) return;
    this.state.setPhase(flowId, 'selecting');
    this.watchDisplays(flowId);
    overlays.setFrames(frames);
    log.info(
      `Selection ready (${mode}): hide ${Math.round(hidden - started)} ms, grab ` +
        `${Math.round(grabbed - hidden)} ms`,
    );
  }

  // --- the selection UI ------------------------------------------------------------------

  private createOverlays(flowId: number, mode: OverlayMode): OverlaySet {
    const overlays = new OverlaySet(mode, {
      onShown: (shown, total) => {
        if (shown === total && this.recordingFlow) this.deps.onOverlaysShown?.();
        if (shown === 1 || shown === total) {
          const ms = Math.round(performance.now() - this.requestedAt);
          log.info(
            `Selection visible (${mode}): ${shown === 1 ? 'first' : 'last'} overlay ${ms} ms after the request`,
          );
        }
      },
      isOwnUiFocused,
      onAllBlurred: () => {
        log.info('Overlays lost focus; cancelling the capture');
        this.finish(flowId, { outcome: 'cancelled' });
      },
    });
    this.overlays = overlays;
    overlays.open(this.displays);
    return overlays;
  }

  private watchDisplays(flowId: number): void {
    const onChange = (): void => {
      log.warn('Displays changed while selecting; cancelling the capture');
      this.finish(flowId, {
        outcome: 'error',
        code: 'DISPLAYS_CHANGED',
        message: 'Your screens changed — please try again.',
      });
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

  /** What an overlay renderer should draw, or undefined for an unknown webContents. */
  overlayInit(webContentsId: number) {
    return this.overlays?.initFor(webContentsId) ?? Promise.resolve(undefined);
  }

  overlayReady(webContentsId: number): void {
    this.overlays?.show(webContentsId);
  }

  /** The user started dragging on one display: selections on the others are cleared. */
  selectionStarted(webContentsId: number): void {
    this.overlays?.clearSelectionsExcept(this.overlays.displayIdOf(webContentsId));
  }

  /** A flow is running that was started during a recording. */
  get duringRecording(): boolean {
    return this.state.active && this.recordingFlow;
  }

  cancel(): void {
    if (this.state.active) log.info('Capture cancelled by the user');
    this.finish(this.flowId, { outcome: 'cancelled' });
  }

  // --- confirming ------------------------------------------------------------------------

  /** Region mode: crop the frozen frame to the selection and finish. */
  async confirmRegion(webContentsId: number, displayId: string, rect: Rect): Promise<void> {
    const overlays = this.overlays;
    const flowId = this.flowId;
    if (!overlays || overlays.mode !== 'region' || this.state.phase !== 'selecting') {
      throw new IpcError('NOT_FOUND', 'There is no selection in progress.');
    }
    if (overlays.displayIdOf(webContentsId) !== displayId) {
      throw new IpcError('INVALID_PAYLOAD', 'Selection does not belong to this screen.');
    }
    const display = this.displays.find((candidate) => candidate.id === displayId);
    const frame = overlays.frameFor(displayId);
    if (!display || !frame) throw new IpcError('NOT_FOUND', 'The frozen screen is gone.');

    const pixels = overlayRectToFramePixels(rect, toGeom(display), frame);
    if (!pixels.ok) {
      throw new IpcError(
        'INVALID_PAYLOAD',
        pixels.reason === 'too-small' ? 'The selection is too small.' : 'The selection is invalid.',
      );
    }
    this.state.setPhase(flowId, 'capturing');
    try {
      // The frozen frame is an image of physical pixels (scale factor 1): crop() uses pixels.
      const image = frame.image;
      const size = image.getSize();
      if (size.width !== frame.width || size.height !== frame.height) {
        throw new FlowFailure('CAPTURE_FAILED', 'The frozen screen could not be read.');
      }
      const cropped = image.crop(pixels.rect);
      const cropSize = cropped.getSize();
      if (cropSize.width !== pixels.rect.width || cropSize.height !== pixels.rect.height) {
        throw new FlowFailure('CAPTURE_FAILED', 'The selection could not be cropped.');
      }
      await this.completeWith(flowId, {
        kind: 'region',
        width: cropSize.width,
        height: cropSize.height,
        png: cropped.toPNG(),
      });
    } catch (error) {
      this.fail(flowId, error);
    }
  }

  /** Pick-display mode: close the overlays, let the screen settle, grab that display. */
  async pickDisplay(webContentsId: number, displayId: string): Promise<void> {
    const overlays = this.overlays;
    const flowId = this.flowId;
    if (!overlays || overlays.mode !== 'pick-display' || this.state.phase !== 'selecting') {
      throw new IpcError('NOT_FOUND', 'There is no screen selection in progress.');
    }
    if (overlays.displayIdOf(webContentsId) !== displayId) {
      throw new IpcError('INVALID_PAYLOAD', 'That screen is not part of this selection.');
    }
    this.state.setPhase(flowId, 'capturing');
    try {
      const sourceId = await this.screenSourceFor(displayId);
      if (!sourceId) throw new FlowFailure('SOURCE_MISSING', 'That screen is no longer available.');
      // Overlays must be gone before the grab, so they can never be in the picture.
      this.removeDisplayListeners?.();
      this.removeDisplayListeners = undefined;
      overlays.close();
      this.overlays = undefined;
      await sleep(SETTLE_MS);
      const display = this.displays.find((candidate) => candidate.id === displayId);
      await this.captureSingle(flowId, sourceId, 'screen', display);
    } catch (error) {
      this.fail(flowId, error);
    }
  }

  // --- capturing -------------------------------------------------------------------------

  private async captureSingle(
    flowId: number,
    sourceId: string,
    kind: 'screen' | 'window',
    display?: DisplayInfo,
  ): Promise<void> {
    this.state.setPhase(flowId, 'capturing');
    if (kind === 'screen' && display && !this.deps.synthetic) {
      // Pixel-exact desktopCapturer image first; the worker's video frame is the fallback.
      const grab = await grabScreensExact([display]).catch((error: unknown) => {
        log.warn(`Exact screen grab failed: ${describeFailure(error).code}`);
        return undefined;
      });
      const exact = grab?.frames.get(display.id);
      if (exact) {
        log.info(`Screenshot path: screen exact (desktopCapturer), ${grab?.ms} ms`);
        if (!this.state.isCurrent(flowId)) return;
        await this.completeWith(flowId, {
          kind,
          width: exact.width,
          height: exact.height,
          png: exact.image.toPNG(),
        });
        return;
      }
      log.warn('Screenshot path: screen fell back to the getDisplayMedia frame');
    }
    let frames: WorkerFrame[];
    try {
      frames = await requestFrames([this.sourceRequest(sourceId, kind, display)], {
        synthetic: this.deps.synthetic,
      });
    } catch (error) {
      throw kind === 'window' ? new FlowFailure('WINDOW_UNAVAILABLE', WINDOW_UNAVAILABLE) : error;
    }
    if (!this.state.isCurrent(flowId)) return;
    const frame = frames[0];
    if (!frame) throw new FlowFailure('CAPTURE_FAILED', 'The capture returned no image.');
    if (kind === 'window' && this.looksBlank(frame)) {
      throw new FlowFailure('WINDOW_UNAVAILABLE', WINDOW_UNAVAILABLE);
    }
    let shot: { width: number; height: number; png: Buffer } = frame;
    if (kind === 'window' && !this.deps.synthetic) {
      // The video frame told us the size; ask for a window image of exactly that size.
      const probe = await grabWindowExact(sourceId, frame).catch(() => ({}));
      const exact = 'frame' in probe ? probe.frame : undefined;
      if (exact && !this.looksBlank(exact)) {
        shot = exact;
        log.info('Screenshot path: window exact (desktopCapturer thumbnail)');
      } else {
        const got = 'thumbnailSize' in probe ? probe.thumbnailSize : undefined;
        log.info(
          `Screenshot path: window from the getDisplayMedia frame ${frame.width}x${frame.height} ` +
            `(thumbnail ${got ? `${got.width}x${got.height}` : 'unavailable'} is not that size)`,
        );
      }
    }
    await this.completeWith(flowId, {
      kind,
      width: shot.width,
      height: shot.height,
      png: shot.png,
    });
  }

  /** Every screen in one image: each display's pixels at its place on the virtual desktop. */
  private async captureAllScreens(flowId: number): Promise<void> {
    this.state.setPhase(flowId, 'capturing');
    const frames = await this.grabDisplays(this.displays);
    if (!this.state.isCurrent(flowId)) return;
    try {
      const stitched = stitchBitmaps(
        this.displays.map((display) => {
          const frame = frames.get(display.id);
          if (!frame) throw new FlowFailure('CAPTURE_FAILED', 'A screen returned no image.');
          const { x, y } = physicalOrigin(display);
          return { x, y, width: frame.width, height: frame.height, bitmap: frame.image.toBitmap() };
        }),
      );
      const image = nativeImage.createFromBitmap(Buffer.from(stitched.bitmap.buffer), {
        width: stitched.width,
        height: stitched.height,
        scaleFactor: 1,
      });
      await this.completeWith(flowId, {
        kind: 'screen',
        width: stitched.width,
        height: stitched.height,
        png: image.toPNG(),
      });
    } catch (error) {
      throw error instanceof StitchError ? new FlowFailure(error.code, error.message) : error;
    }
  }

  private looksBlank(frame: { png: Buffer }): boolean {
    if (this.deps.synthetic) return false;
    const image = nativeImage.createFromBuffer(frame.png, { scaleFactor: 1 });
    const size = image.getSize();
    if (size.width < 1 || size.height < 1) return true;
    return isBlankBitmap(image.toBitmap(), size.width, size.height);
  }

  /**
   * Grabs every display's screen for the freeze-frame, keyed by display id. Pixel-exact
   * desktopCapturer images where their size matches the display exactly, the worker's
   * getDisplayMedia frame for the rest (and for the synthetic E2E frames).
   */
  private async grabDisplays(displays: readonly DisplayInfo[]): Promise<Map<string, FrozenFrame>> {
    const result = new Map<string, FrozenFrame>();
    let remaining = displays;
    if (!this.deps.synthetic) {
      try {
        const grab = await grabScreensExact(displays);
        for (const [id, frame] of grab.frames) result.set(id, frame);
        remaining = displays.filter((display) => !grab.frames.has(display.id));
        log.info(
          `Freeze-frame: ${grab.frames.size}/${displays.length} screens exact (desktopCapturer) in ` +
            `${grab.ms} ms`,
        );
      } catch (error) {
        log.warn(`Exact screen grab failed (${describeFailure(error).code}); using video frames`);
      }
    }
    if (remaining.length === 0) return result;
    if (!this.deps.synthetic) {
      log.warn(`${remaining.length} screen(s) fall back to the getDisplayMedia frame`);
    }

    const sources = await this.deps.provider.listSources({ types: ['screen'], thumbnailWidth: 0 });
    const requests = remaining.map((display) => {
      const source = sources.find((candidate) => candidate.displayId === display.id);
      if (!source) throw new FlowFailure('SOURCE_MISSING', 'A screen could not be found.');
      return { display, request: this.sourceRequest(source.id, 'screen', display) };
    });
    const frames = await requestFrames(
      requests.map((entry) => entry.request),
      { synthetic: this.deps.synthetic },
    );
    for (const { display, request } of requests) {
      const frame = frames.find((candidate) => candidate.sourceId === request.sourceId);
      if (!frame) throw new FlowFailure('CAPTURE_FAILED', 'A screen returned no image.');
      const { physicalSize } = display;
      if (frame.width !== physicalSize.width || frame.height !== physicalSize.height) {
        log.warn(
          `Frame ${frame.width}x${frame.height} differs from display ${display.id} physical ` +
            `size ${physicalSize.width}x${physicalSize.height}; using the frame ratio`,
        );
      }
      result.set(display.id, {
        width: frame.width,
        height: frame.height,
        image: nativeImage.createFromBuffer(frame.png, { scaleFactor: 1 }),
      });
    }
    return result;
  }

  private sourceRequest(sourceId: string, kind: 'screen' | 'window', display?: DisplayInfo) {
    const syntheticSize =
      kind === 'screen' && display ? { ...display.physicalSize } : { width: 1280, height: 720 };
    return {
      sourceId,
      ...(display && { displayId: display.id }),
      ...(this.deps.synthetic && { syntheticSize }),
    };
  }

  private async screenSourceFor(displayId: string): Promise<string | undefined> {
    const sources = await this.deps.provider.listSources({ types: ['screen'], thumbnailWidth: 0 });
    return sources.find((source) => source.displayId === displayId)?.id;
  }

  private async completeWith(
    flowId: number,
    shot: { kind: CaptureTarget; width: number; height: number; png: Buffer },
  ): Promise<void> {
    if (!this.state.isCurrent(flowId)) return;
    if (this.recordingFlow) return this.saveDirectly(flowId, shot);
    const session = await this.deps.store.create(shot);
    if (!this.state.isCurrent(flowId)) {
      await this.deps.store.discard(session.id);
      return;
    }
    log.info(`Screenshot captured: ${shot.kind} ${shot.width}x${shot.height}`);
    const after = await this.deps.afterCapture?.(shot).catch(() => ({}) as { savedPath?: string });
    if (!this.state.isCurrent(flowId)) return;
    this.finish(flowId, { outcome: 'completed' }, () =>
      this.deps.openEditor?.({
        kind: 'session',
        sessionId: session.id,
        ...(after?.savedPath && { savedPath: after.savedPath }),
      }),
    );
  }

  /** During a recording: no session, no editor; the file goes straight to the screenshots folder. */
  private async saveDirectly(
    flowId: number,
    shot: { kind: CaptureTarget; width: number; height: number; png: Buffer },
  ): Promise<void> {
    if (!this.deps.saveDirect) throw new FlowFailure('CAPTURE_FAILED', SCREEN_FAILED);
    const { copied } = await this.deps.saveDirect(shot);
    log.info(`Screenshot saved during a recording: ${shot.kind} ${shot.width}x${shot.height}`);
    this.deps.toast?.({
      level: 'info',
      message: copied ? 'Screenshot saved and copied' : 'Screenshot saved',
    });
    this.finish(flowId, { outcome: 'completed' });
  }

  // --- ending ----------------------------------------------------------------------------

  private fail(flowId: number, error: unknown): void {
    const failure = describeFailure(error);
    if (error instanceof FlowFailure) log.warn(`Capture flow failed: ${failure.code}`);
    else log.error('Capture flow failed', error);
    if (this.recordingFlow && this.state.isCurrent(flowId)) {
      this.deps.toast?.({ level: 'error', message: failure.message });
    }
    this.finish(flowId, { outcome: 'error', ...failure });
  }

  /**
   * Ends the flow exactly once: closes the overlays and frozen frames, restores the main window,
   * then notifies the renderer. Further calls for the same flow do nothing.
   */
  private finish(flowId: number, ended: FlowEndedEvent, beforeEnded?: () => void): void {
    if (!this.state.end(flowId)) return;
    this.removeDisplayListeners?.();
    this.removeDisplayListeners = undefined;
    this.overlays?.close();
    this.overlays = undefined;

    const main = getMainWindow();
    // A capture that was cancelled leaves the window as it was (hidden in the tray stays hidden).
    // During a recording the main window is never touched: it would end up in the video.
    if (!this.recordingFlow && main && (ended.outcome !== 'cancelled' || this.mainWasShown)) {
      if (main.isMinimized()) main.restore();
      main.show();
      main.focus();
    }
    beforeEnded?.();
    if (main) sendEvent(main.webContents, 'capture:flowEnded', ended);
  }

  private async hideMainWindow(): Promise<void> {
    const main = this.recordingFlow ? undefined : getMainWindow();
    if (main?.isVisible()) {
      await new Promise<void>((resolve) => {
        main.once('hide', () => resolve());
        main.hide();
      });
    }
    await sleep(SETTLE_MS);
  }
}

function toGeom(display: DisplayInfo): DisplayGeom {
  return {
    id: display.id,
    bounds: display.bounds,
    scaleFactor: display.scaleFactor,
    rotation: display.rotation,
  };
}

/** Where a display's top-left pixel sits on the virtual desktop, in physical pixels. */
function physicalOrigin(display: DisplayInfo): { x: number; y: number } {
  if (process.platform === 'win32') {
    const { x, y } = screen.dipToScreenRect(null, display.bounds);
    return { x, y };
  }
  return {
    x: Math.round(display.bounds.x * display.scaleFactor),
    y: Math.round(display.bounds.y * display.scaleFactor),
  };
}

function describeFailure(error: unknown): { code: string; message: string } {
  if (error instanceof FlowFailure) return { code: error.code, message: error.message };
  if (error instanceof WorkerError && error.code === 'WORKER_TIMEOUT') {
    return { code: 'WORKER_TIMEOUT', message: 'Capturing took too long. Please try again.' };
  }
  return { code: 'CAPTURE_FAILED', message: SCREEN_FAILED };
}
