import { screen } from 'electron';
import type { Point } from '../../shared/geometry';
import { placeToolbar, TOOLBAR_HEIGHT } from '../../shared/toolbar-placement';
import { log } from '../logger';
import { createToolbarWindow, type ToolbarWindow } from '../recorder/windows';
import { getMainWindow } from '../windows';

/** The pill's first width; it then measures its content and asks for exactly that (`toolbar:resize`). */
const INITIAL_WIDTH = 440;

export interface StepsPill {
  /** Gets the main window out of the way and shows the controls. */
  open(): void;
  /** Closes the controls and puts the main window back if it was on screen. */
  close(): void;
  /** True while `point` (global DIP) is over the pill: the pointer resting there is not a step. */
  isOver(point: Point): boolean;
  resize(width: number): void;
}

/**
 * The window of the step-capture controls: the recording toolbar's pill (frameless, always on
 * top, excluded from capture) in `steps` mode, bottom-center of the display the pointer is on.
 * `onUserClosed` runs when the window is closed from outside (Alt+F4): the steps are then saved,
 * never lost.
 */
export function createStepsPill(onUserClosed: () => void): StepsPill {
  let toolbar: ToolbarWindow | undefined;
  let mainWasShown = false;

  return {
    open() {
      const main = getMainWindow();
      mainWasShown = main !== undefined && main.isVisible() && !main.isMinimized();
      if (mainWasShown) main?.minimize();
      const pointer = screen.getCursorScreenPoint();
      const where = placeToolbar(
        { width: INITIAL_WIDTH, height: TOOLBAR_HEIGHT },
        { kind: 'display', displayId: String(screen.getDisplayNearestPoint(pointer).id) },
        screen.getAllDisplays().map((display) => ({
          id: String(display.id),
          bounds: display.bounds,
          workArea: display.workArea,
        })),
      );
      toolbar = createToolbarWindow(
        where,
        INITIAL_WIDTH,
        () => {
          toolbar = undefined;
          log.info('Steps pill closed by the user');
          onUserClosed();
        },
        'steps',
      );
      const win = toolbar.win;
      win.once('ready-to-show', () => {
        if (!win.isDestroyed()) win.showInactive();
      });
    },
    close() {
      toolbar?.closeQuietly();
      toolbar = undefined;
      const main = getMainWindow();
      if (mainWasShown && main) {
        if (main.isMinimized()) main.restore();
        main.show();
        main.focus();
      }
    },
    isOver(point) {
      if (!toolbar || toolbar.win.isDestroyed()) return false;
      const bounds = toolbar.win.getBounds();
      return (
        point.x >= bounds.x &&
        point.x < bounds.x + bounds.width &&
        point.y >= bounds.y &&
        point.y < bounds.y + bounds.height
      );
    },
    resize(width) {
      toolbar?.setWidth(Math.ceil(width));
    },
  };
}
