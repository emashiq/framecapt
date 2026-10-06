import { describe, expect, it } from 'vitest';
import {
  placeToolbar,
  TOOLBAR_HEIGHT,
  toolbarWidth,
  type PlacementDisplay,
} from '../../src/shared/toolbar-placement';

const SIZE = { width: 324, height: TOOLBAR_HEIGHT };

/** Taskbar of 48 DIP at the bottom of display A. */
const A: PlacementDisplay = {
  id: 'a',
  bounds: { x: 0, y: 0, width: 3440, height: 1440 },
  workArea: { x: 0, y: 0, width: 3440, height: 1392 },
};
const B: PlacementDisplay = {
  id: 'b',
  bounds: { x: 3440, y: 0, width: 2560, height: 1440 },
  workArea: { x: 3440, y: 0, width: 2560, height: 1440 },
};

describe('placeToolbar: whole display or window', () => {
  it('is bottom-center of the work area, 24 DIP above the taskbar', () => {
    const spot = placeToolbar(SIZE, { kind: 'display', displayId: 'a' }, [A, B]);
    expect(spot.x).toBe(Math.round((3440 - 324) / 2));
    expect(spot.y).toBe(1392 - TOOLBAR_HEIGHT - 24);
    expect(spot.displayId).toBe('a');
    expect(spot.outsideRecording).toBe(false);
  });

  it('follows the display origin (second display)', () => {
    const spot = placeToolbar(SIZE, { kind: 'display', displayId: 'b' }, [A, B]);
    expect(spot.x).toBe(3440 + Math.round((2560 - 324) / 2));
    expect(spot.y).toBe(1440 - TOOLBAR_HEIGHT - 24);
  });

  it('works on a display with a negative origin', () => {
    const left: PlacementDisplay = {
      id: 'l',
      bounds: { x: -1920, y: -200, width: 1920, height: 1080 },
      workArea: { x: -1920, y: -200, width: 1920, height: 1040 },
    };
    const spot = placeToolbar(SIZE, { kind: 'display', displayId: 'l' }, [left, A]);
    expect(spot.x).toBe(-1920 + Math.round((1920 - 324) / 2));
    expect(spot.y).toBe(-200 + 1040 - TOOLBAR_HEIGHT - 24);
  });
});

describe('placeToolbar: region', () => {
  it('goes just below the region when there is room', () => {
    const region = { x: 100, y: 100, width: 1280, height: 720 };
    const spot = placeToolbar(SIZE, { kind: 'region', displayId: 'a', region }, [A, B]);
    expect(spot.where).toBe('below-region');
    expect(spot.y).toBe(100 + 720 + 12);
    expect(spot.outsideRecording).toBe(true);
    // centered under the region
    expect(spot.x).toBe(Math.round(100 + (1280 - 324) / 2));
  });

  it('goes above the region when the space below is taken by the taskbar', () => {
    const region = { x: 400, y: 500, width: 800, height: 860 }; // bottom at 1360, taskbar from 1392
    const spot = placeToolbar(SIZE, { kind: 'region', displayId: 'a', region }, [A]);
    expect(spot.where).toBe('above-region');
    expect(spot.y).toBe(500 - 12 - TOOLBAR_HEIGHT);
    expect(spot.outsideRecording).toBe(true);
  });

  it('uses the other display when the region leaves no room above or below', () => {
    const region = { x: 0, y: 0, width: 3440, height: 1392 };
    const spot = placeToolbar(SIZE, { kind: 'region', displayId: 'a', region }, [A, B]);
    expect(spot.where).toBe('other-display');
    expect(spot.displayId).toBe('b');
    expect(spot.outsideRecording).toBe(true);
    expect(spot.x).toBeGreaterThanOrEqual(3440);
  });

  it('falls back to inside the region (and says so) on a single display with no room', () => {
    const region = { x: 0, y: 0, width: 3440, height: 1392 };
    const spot = placeToolbar(SIZE, { kind: 'region', displayId: 'a', region }, [A]);
    expect(spot.where).toBe('inside-fallback');
    expect(spot.outsideRecording).toBe(false);
  });

  it('keeps the toolbar horizontally inside the work area for a region at the screen edge', () => {
    const region = { x: 3300, y: 100, width: 140, height: 100 };
    const spot = placeToolbar(SIZE, { kind: 'region', displayId: 'a', region }, [A]);
    expect(spot.x + 324).toBeLessThanOrEqual(3440 - 8);
    const left = placeToolbar(
      SIZE,
      { kind: 'region', displayId: 'a', region: { x: 0, y: 100, width: 50, height: 50 } },
      [A],
    );
    expect(left.x).toBeGreaterThanOrEqual(8);
  });

  it('never overlaps the region when it reports outsideRecording', () => {
    const cases = [
      { x: 10, y: 10, width: 300, height: 200 },
      { x: 500, y: 700, width: 1000, height: 650 },
      { x: 2000, y: 20, width: 1400, height: 1300 },
    ];
    for (const region of cases) {
      const spot = placeToolbar(SIZE, { kind: 'region', displayId: 'a', region }, [A, B]);
      if (spot.outsideRecording && spot.displayId === 'a') {
        const overlapX = spot.x < region.x + region.width && spot.x + 324 > region.x;
        const overlapY = spot.y < region.y + region.height && spot.y + TOOLBAR_HEIGHT > region.y;
        expect(overlapX && overlapY).toBe(false);
      }
    }
  });
});

describe('toolbarWidth', () => {
  it('grows with the recorded audio sources and more when one is lost', () => {
    const none = toolbarWidth({ mic: false, system: false });
    // grip, timer, pause, screenshot and stop: the screenshot button added 40 DIP to the old 300
    expect(none).toBe(340);
    const mic = toolbarWidth({ mic: true, system: false });
    const both = toolbarWidth({ mic: true, system: true });
    expect(mic).toBeGreaterThan(none);
    expect(both).toBeGreaterThan(mic);
    expect(
      toolbarWidth({ mic: true, system: false }, { mic: true, system: false }),
    ).toBeGreaterThan(mic);
    expect(toolbarWidth({ mic: false, system: false }, { mic: true, system: true })).toBe(none);
  });
});
