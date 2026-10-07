import { screen, type BrowserWindow } from 'electron';
import {
  CAMERA_WINDOW_DIP,
  clampInto,
  cornerBounds,
  cornerCenter,
  cornerOfBubble,
  normalizedCenter,
  type CameraCorner,
  type CameraSetStyleRequest,
  type CameraShape,
  type CameraSize,
  type CameraStyleState,
} from '../../shared/camera';
import type { EngineCommand } from '../../shared/recorder-ipc';
import type { Rect } from '../../shared/rect';
import { createCameraWindow } from './windows';

/** While the bubble is dragged its position goes to the recorder about this often. */
const MOVE_INTERVAL_MS = 1000 / 30;

type CameraCommand = Extract<EngineCommand, { cmd: 'camera' }>;

export interface CameraBubbleDeps {
  /** The device the recording asked for (undefined = the default camera). */
  deviceId: string | undefined;
  shape: CameraShape;
  size: CameraSize;
  corner: CameraCorner;
  /**
   * The captured area in global DIP for screen and region recordings: the camera follows the
   * bubble's position inside it. Null (window recordings): the camera sits in a corner of the video.
   */
  captureRect: Rect | null;
  /** The work area the bubble starts in when there is no capture rectangle (corner mode). */
  homeArea: Rect;
  /** Tells the recorder where the camera is. */
  send: (command: CameraCommand) => void;
  /** Size, shape and corner changes are remembered in the settings. */
  persist: (patch: {
    cameraSize?: CameraSize;
    cameraShape?: CameraShape;
    cameraCorner?: CameraCorner;
  }) => void;
  /** The bubble was shown or hidden (the toolbar's button follows). */
  onVisibleChange: () => void;
}

/**
 * The camera bubble window and what it means for the recording. Moving the bubble moves the camera
 * in the video: inside the captured area for a screen or region recording (the bubble is kept
 * inside it, so what you see is what is recorded); for a window recording the bubble snaps to the
 * display corner it was dropped in and the camera takes that corner of the video.
 */
export class CameraBubble {
  readonly win: BrowserWindow;
  private shown = false;
  private disposed = false;
  private corner: CameraCorner;
  private size: CameraSize;
  private shape: CameraShape;
  private moveTimer: ReturnType<typeof setTimeout> | undefined;
  private movePending = false;

  constructor(private readonly deps: CameraBubbleDeps) {
    this.corner = deps.corner;
    this.size = deps.size;
    this.shape = deps.shape;
    const side = CAMERA_WINDOW_DIP[this.size];
    const bounds = deps.captureRect
      ? cornerBounds(side, 'br', deps.captureRect)
      : cornerBounds(side, this.corner, deps.homeArea);
    this.win = createCameraWindow(bounds);
    this.win.on('move', () => this.onMove());
    this.win.on('moved', () => this.onMoved());
    // Alt+F4 on the bubble only hides the camera.
    this.win.on('close', (event) => {
      if (this.disposed) return;
      event.preventDefault();
      this.setVisible(false);
    });
    this.send();
  }

  get visible(): boolean {
    return this.shown;
  }

  styleState(): CameraStyleState {
    return {
      ...(this.deps.deviceId !== undefined && { deviceId: this.deps.deviceId }),
      shape: this.shape,
      size: this.size,
    };
  }

  /** Shows the bubble without taking focus from what is being recorded. */
  show(): void {
    this.setVisible(true);
  }

  setVisible(visible: boolean): void {
    if (this.disposed || this.shown === visible) return;
    this.shown = visible;
    if (visible) this.win.showInactive();
    else this.win.hide();
    this.send();
    this.deps.onVisibleChange();
  }

  /** The bubble's own size, shape and visibility buttons (`camera:setStyle`). */
  setStyle(request: CameraSetStyleRequest): CameraStyleState {
    if (this.disposed) return this.styleState();
    if (request.shape !== undefined && request.shape !== this.shape) {
      this.shape = request.shape;
      this.deps.persist({ cameraShape: this.shape });
    }
    if (request.size !== undefined && request.size !== this.size) {
      this.size = request.size;
      this.deps.persist({ cameraSize: this.size });
      this.resize();
    }
    this.send();
    if (request.visible !== undefined) this.setVisible(request.visible);
    return this.styleState();
  }

  close(): void {
    this.disposed = true;
    if (this.moveTimer !== undefined) clearTimeout(this.moveTimer);
    this.moveTimer = undefined;
    if (!this.win.isDestroyed()) this.win.destroy();
  }

  // --- position ----------------------------------------------------------------------------

  /** A new size keeps the bubble's center, then the usual placement rules apply. */
  private resize(): void {
    const old = this.win.getBounds();
    const side = CAMERA_WINDOW_DIP[this.size];
    const centered: Rect = {
      x: Math.round(old.x + old.width / 2 - side / 2),
      y: Math.round(old.y + old.height / 2 - side / 2),
      width: side,
      height: side,
    };
    this.place(centered);
  }

  /** Puts the bubble where the placement rules allow (inside the capture area, or in its corner). */
  private place(bounds: Rect): void {
    const { captureRect } = this.deps;
    const next = captureRect
      ? clampInto(bounds, captureRect)
      : cornerBounds(bounds.width, this.corner, this.workAreaOf(bounds));
    const now = this.win.getBounds();
    if (
      now.x !== next.x ||
      now.y !== next.y ||
      now.width !== next.width ||
      now.height !== next.height
    ) {
      this.win.setBounds(next);
    }
  }

  private workAreaOf(bounds: Rect): Rect {
    return screen.getDisplayMatching(bounds).workArea;
  }

  /** Live drag: a position about 30 times a second (leading edge, then the latest on a timer). */
  private onMove(): void {
    if (this.disposed) return;
    if (this.moveTimer !== undefined) {
      this.movePending = true;
      return;
    }
    this.send();
    this.moveTimer = setTimeout(() => {
      this.moveTimer = undefined;
      if (this.movePending) {
        this.movePending = false;
        this.onMove();
      }
    }, MOVE_INTERVAL_MS);
  }

  /** The drag ended: snap into the corner (window recordings) or back inside the area. */
  private onMoved(): void {
    if (this.disposed) return;
    const bounds = this.win.getBounds();
    if (!this.deps.captureRect) {
      const display = screen.getDisplayMatching(bounds);
      const corner = cornerOfBubble(bounds, display.bounds);
      if (corner !== this.corner) {
        this.corner = corner;
        this.deps.persist({ cameraCorner: corner });
      }
    }
    this.place(bounds);
    this.send();
  }

  private send(): void {
    const { captureRect } = this.deps;
    const center = captureRect
      ? normalizedCenter(this.win.getBounds(), captureRect)
      : cornerCenter(this.corner);
    this.deps.send({
      cmd: 'camera',
      ...center,
      size: this.size,
      shape: this.shape,
      visible: this.shown,
    });
  }
}
