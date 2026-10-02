import type { Size } from './geometry';
import type { Rect } from './rect';

export interface PlacementDisplay {
  id: string;
  /** Full bounds in global DIP. */
  bounds: Rect;
  /** Bounds without the taskbar, in global DIP. */
  workArea: Rect;
}

export type PlacementTarget =
  | { kind: 'display'; displayId: string }
  /** `region` is in global DIP, inside the display `displayId`. */
  | { kind: 'region'; displayId: string; region: Rect };

export interface ToolbarPlacement {
  x: number;
  y: number;
  displayId: string;
  /**
   * True when the toolbar sits outside the recorded area, so it cannot be in the video even if
   * content protection did not work. Always false for a whole-screen recording on one display.
   */
  outsideRecording: boolean;
  where: 'bottom-center' | 'below-region' | 'above-region' | 'other-display' | 'inside-fallback';
}

const EDGE = 8;

/** Bottom-center of the work area (above the taskbar), `margin` DIP from the bottom. */
function bottomCenter(area: Rect, size: Size, margin: number): { x: number; y: number } {
  return {
    x: Math.round(area.x + (area.width - size.width) / 2),
    y: Math.round(area.y + area.height - size.height - margin),
  };
}

function clampX(x: number, area: Rect, width: number): number {
  return Math.round(Math.min(Math.max(x, area.x + EDGE), area.x + area.width - width - EDGE));
}

/**
 * Where the floating toolbar goes. A whole screen or window: bottom-center of that display, 24 DIP
 * above the taskbar. A region: just outside it, below when there is room in the work area, else
 * above, else on another display, and only then (single display, region fills it) inside the
 * recorded area, which is reported so the UI can rely on content protection alone.
 */
export function placeToolbar(
  size: Size,
  target: PlacementTarget,
  displays: readonly PlacementDisplay[],
  options: { margin?: number; gap?: number } = {},
): ToolbarPlacement {
  const margin = options.margin ?? 24;
  const gap = options.gap ?? 12;
  const display = displays.find((candidate) => candidate.id === target.displayId) ?? displays[0];
  if (!display)
    return {
      x: 0,
      y: 0,
      displayId: target.displayId,
      outsideRecording: false,
      where: 'inside-fallback',
    };

  if (target.kind === 'display') {
    const spot = bottomCenter(display.workArea, size, margin);
    return { ...spot, displayId: display.id, outsideRecording: false, where: 'bottom-center' };
  }

  const { region } = target;
  const area = display.workArea;
  const regionBottom = region.y + region.height;
  const x = clampX(region.x + (region.width - size.width) / 2, area, size.width);

  const below = regionBottom + gap;
  if (below + size.height <= area.y + area.height - EDGE) {
    return {
      x,
      y: Math.round(below),
      displayId: display.id,
      outsideRecording: true,
      where: 'below-region',
    };
  }
  const above = region.y - gap - size.height;
  if (above >= area.y + EDGE) {
    return {
      x,
      y: Math.round(above),
      displayId: display.id,
      outsideRecording: true,
      where: 'above-region',
    };
  }
  const other = displays.find((candidate) => candidate.id !== display.id);
  if (other) {
    const spot = bottomCenter(other.workArea, size, margin);
    return { ...spot, displayId: other.id, outsideRecording: true, where: 'other-display' };
  }
  const spot = bottomCenter(area, size, margin);
  return { ...spot, displayId: display.id, outsideRecording: false, where: 'inside-fallback' };
}

/** Toolbar height in DIP. */
export const TOOLBAR_HEIGHT = 48;

/**
 * Toolbar width in DIP: a fixed core (grip, dot and timer, pause, stop) plus a slot per recorded
 * audio source (mute button and level meter), which grows when that source is lost to make room
 * for the warning badge.
 */
export function toolbarWidth(
  audio: { mic: boolean; system: boolean },
  lost: { mic: boolean; system: boolean } = { mic: false, system: false },
): number {
  const slot = (present: boolean, gone: boolean): number => (present ? (gone ? 196 : 76) : 0);
  return 252 + slot(audio.mic, lost.mic) + slot(audio.system, lost.system);
}
