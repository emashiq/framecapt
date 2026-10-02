import { setTimeout as sleep } from 'node:timers/promises';
import { nativeImage, screen } from 'electron';
import { overlayRectToFramePixels, type DisplayGeom } from '../shared/geometry';
import type { Rect } from '../shared/rect';
import type { FlowEndedEvent, OverlayMode, StartScreenshotRequest } from '../shared/shot-ipc';
import { isBlankBitmap, type ShotKind } from '../shared/shots';
import type { CaptureProvider, DisplayInfo } from './capture/types';
import { sendEvent } from './events';
import { IpcError } from './ipc-core';
import { log } from './logger';
import { OverlaySet, type FrozenFrame } from './overlay';
import { FlowState } from './shots/flow-state';
import type { ShotSessionStore } from './shots/session-store';
import { getMainWindow } from './windows';
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
  private removeDisplayListeners: (() => void) | undefined;

  constructor(private readonly deps: CaptureFlowDeps) {}

  /**
   * Claims the flow and starts it in the background. Throws BUSY when another flow runs and
   * NOT_FOUND when the requested window disappeared. Outcomes arrive as events.
   */
  async start(request: StartScreenshotRequest): Promise<void> {
    const claim = this.state.tryStart();
    if (!claim.ok) throw new IpcError('BUSY', 'A capture is already in progress.');
    const flowId = claim.flowId;
    this.flowId = flowId;
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
    if (request.target === 'window' && request.sourceId) {
      await this.hideMainWindow();
      await this.captureSingle(flowId, request.sourceId, 'window');
      return;
    }
    if (request.target === 'screen' && this.displays.length === 1) {
      const display = this.displays[0];
      const sourceId = display && (await this.screenSourceFor(display.id));
      if (!sourceId) throw new FlowFailure('SOURCE_MISSING', 'No screen was found to capture.');
      await this.hideMainWindow();
      await this.captureSingle(flowId, sourceId, 'screen', display);
      return;
    }

    const mode: OverlayMode = request.target === 'screen' ? 'pick-display' : 'region';
    await this.hideMainWindow();
    if (!this.state.isCurrent(flowId)) return;
    const frames = mode === 'region' ? await this.grabDisplays(this.displays) : new Map();
    if (!this.state.isCurrent(flowId)) return;
    this.openOverlays(flowId, mode, frames);
  }

  // --- the selection UI ------------------------------------------------------------------

  private openOverlays(
    flowId: number,
    mode: OverlayMode,
    frames: ReadonlyMap<string, FrozenFrame>,
  ): void {
    const overlays = new OverlaySet(mode, {
      onAllBlurred: () => {
        log.info('Overlays lost focus; cancelling the capture');
        this.finish(flowId, { outcome: 'cancelled' });
      },
    });
    this.overlays = overlays;
    this.state.setPhase(flowId, 'selecting');
    this.watchDisplays(flowId);
    overlays.open(this.displays, frames);
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
    return this.overlays?.initFor(webContentsId);
  }

  overlayReady(webContentsId: number): void {
    this.overlays?.show(webContentsId);
  }

  /** The user started dragging on one display: selections on the others are cleared. */
  selectionStarted(webContentsId: number): void {
    this.overlays?.clearSelectionsExcept(this.overlays.displayIdOf(webContentsId));
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
      // The frozen frame is a PNG of physical pixels: scaleFactor 1 makes crop() use pixels.
      const image = nativeImage.createFromBuffer(frame.png, { scaleFactor: 1 });
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
    await this.completeWith(flowId, {
      kind,
      width: frame.width,
      height: frame.height,
      png: frame.png,
    });
  }

  private looksBlank(frame: WorkerFrame): boolean {
    if (this.deps.synthetic) return false;
    const image = nativeImage.createFromBuffer(frame.png, { scaleFactor: 1 });
    const size = image.getSize();
    if (size.width < 1 || size.height < 1) return true;
    return isBlankBitmap(image.toBitmap(), size.width, size.height);
  }

  /** Grabs every display's screen for the freeze-frame, keyed by display id. */
  private async grabDisplays(displays: readonly DisplayInfo[]): Promise<Map<string, FrozenFrame>> {
    const sources = await this.deps.provider.listSources({ types: ['screen'], thumbnailWidth: 0 });
    const requests = displays.map((display) => {
      const source = sources.find((candidate) => candidate.displayId === display.id);
      if (!source) throw new FlowFailure('SOURCE_MISSING', 'A screen could not be found.');
      return { display, request: this.sourceRequest(source.id, 'screen', display) };
    });
    const frames = await requestFrames(
      requests.map((entry) => entry.request),
      { synthetic: this.deps.synthetic },
    );
    const result = new Map<string, FrozenFrame>();
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
      result.set(display.id, { width: frame.width, height: frame.height, png: frame.png });
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
    shot: { kind: ShotKind; width: number; height: number; png: Buffer },
  ): Promise<void> {
    if (!this.state.isCurrent(flowId)) return;
    const session = await this.deps.store.create(shot);
    if (!this.state.isCurrent(flowId)) {
      await this.deps.store.discard(session.id);
      return;
    }
    log.info(`Screenshot captured: ${shot.kind} ${shot.width}x${shot.height}`);
    this.finish(flowId, { outcome: 'completed' }, () => {
      const main = getMainWindow();
      if (main) {
        sendEvent(main.webContents, 'shot:ready', { session: this.deps.store.meta(session) });
      }
    });
  }

  // --- ending ----------------------------------------------------------------------------

  private fail(flowId: number, error: unknown): void {
    const failure = describeFailure(error);
    if (error instanceof FlowFailure) log.warn(`Capture flow failed: ${failure.code}`);
    else log.error('Capture flow failed', error);
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
    if (main) {
      if (main.isMinimized()) main.restore();
      main.show();
      main.focus();
    }
    beforeEnded?.();
    if (main) sendEvent(main.webContents, 'capture:flowEnded', ended);
  }

  private async hideMainWindow(): Promise<void> {
    const main = getMainWindow();
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

function describeFailure(error: unknown): { code: string; message: string } {
  if (error instanceof FlowFailure) return { code: error.code, message: error.message };
  if (error instanceof WorkerError && error.code === 'WORKER_TIMEOUT') {
    return { code: 'WORKER_TIMEOUT', message: 'Capturing took too long. Please try again.' };
  }
  return { code: 'CAPTURE_FAILED', message: SCREEN_FAILED };
}
