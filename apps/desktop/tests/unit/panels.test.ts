import { describe, expect, it } from 'vitest';
import { fitSnap, panelLayout, scaleRegion, slotRects } from '../../src/shared/compositor-layout';
import {
  freePanelSlot,
  MAX_PANELS,
  panelLabel,
  PLACEHOLDER_TEXT,
  tileCardText,
} from '../../src/shared/panels';
import type { Rect } from '../../src/shared/rect';

const OUT = { width: 1920, height: 1080 };

const inside = (rect: Rect, out = OUT): boolean =>
  rect.x >= 0 &&
  rect.y >= 0 &&
  rect.x + rect.width <= out.width &&
  rect.y + rect.height <= out.height;
const even = (rect: Rect): boolean =>
  [rect.x, rect.y, rect.width, rect.height].every((value) => value % 2 === 0);
const overlap = (a: Rect, b: Rect): boolean =>
  a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;

describe('panelLayout', () => {
  it('one picture fills the frame', () => {
    expect(panelLayout(OUT, 1)).toEqual([{ x: 0, y: 0, width: 1920, height: 1080 }]);
    expect(panelLayout(OUT, 0)).toEqual([]);
  });

  it('two pictures: the primary takes the left two thirds, the panel the right third', () => {
    expect(panelLayout(OUT, 2)).toEqual([
      { x: 0, y: 0, width: 1280, height: 1080 },
      { x: 1280, y: 0, width: 640, height: 1080 },
    ]);
  });

  it('three and four pictures stack the panels in the right column with equal heights', () => {
    const three = panelLayout(OUT, 3);
    expect(three.slice(1)).toEqual([
      { x: 1280, y: 0, width: 640, height: 540 },
      { x: 1280, y: 540, width: 640, height: 540 },
    ]);
    const four = panelLayout(OUT, 4);
    expect(four.slice(1).map((rect) => rect.height)).toEqual([360, 360, 360]);
    expect(four.slice(1).map((rect) => rect.y)).toEqual([0, 360, 720]);
  });

  it('every rect is even aligned, inside the output and none overlap (odd-looking sizes too)', () => {
    for (const out of [OUT, { width: 1366, height: 768 }, { width: 1722, height: 722 }]) {
      for (let n = 1; n <= 4; n += 1) {
        const rects = panelLayout(out, n);
        expect(rects).toHaveLength(n);
        rects.forEach((rect, index) => {
          expect(even(rect), `${out.width}x${out.height} n=${n} #${index}`).toBe(true);
          expect(inside(rect, out)).toBe(true);
          expect(rect.width).toBeGreaterThan(0);
          expect(rect.height).toBeGreaterThan(0);
          rects.slice(index + 1).forEach((other) => expect(overlap(rect, other)).toBe(false));
        });
      }
    }
  });

  it('slotRects gives the lowest occupied slot the primary rect, whatever the slots are', () => {
    const rects = slotRects(OUT, [3, 0, 1]);
    expect(rects.get(0)).toEqual({ x: 0, y: 0, width: 1280, height: 1080 });
    expect(rects.get(1)?.y).toBe(0);
    expect(rects.get(3)?.y).toBe(540);
    expect(slotRects(OUT, [0]).get(0)).toEqual({ x: 0, y: 0, width: 1920, height: 1080 });
  });
});

describe('fitSnap', () => {
  it('letterboxes a frame of another aspect', () => {
    const box = { x: 1280, y: 0, width: 640, height: 540 };
    expect(fitSnap({ width: 1920, height: 1080 }, box)).toEqual({
      x: 1280,
      y: 90,
      width: 640,
      height: 360,
    });
  });

  it('fills the box when the fitted size is within 2 px (a crop rounded to even sides)', () => {
    const box = { x: 0, y: 0, width: 1920, height: 804 };
    expect(fitSnap({ width: 3440, height: 1440 }, box)).toEqual(box);
    expect(fitSnap({ width: 1920, height: 804 }, box)).toEqual(box);
  });
});

describe('scaleRegion', () => {
  const display = { width: 3840, height: 2160 };
  it('keeps the region when the frame has the display size', () => {
    const region = { x: 100, y: 200, width: 640, height: 360 };
    expect(scaleRegion(region, display, display)).toBe(region);
  });

  it('scales it to a frame captured smaller, inside the frame', () => {
    expect(
      scaleRegion({ x: 1920, y: 1080, width: 1920, height: 1080 }, display, {
        width: 1920,
        height: 1080,
      }),
    ).toEqual({ x: 960, y: 540, width: 960, height: 540 });
    const edge = scaleRegion({ x: 3838, y: 2158, width: 2, height: 2 }, display, {
      width: 1281,
      height: 721,
    });
    expect(edge.x + edge.width).toBeLessThanOrEqual(1281);
    expect(edge.y + edge.height).toBeLessThanOrEqual(721);
    expect(edge.width).toBeGreaterThanOrEqual(1);
  });
});

describe('panel slots', () => {
  it('hands out the lowest free slot and stops at the cap', () => {
    expect(freePanelSlot([])).toBe(1);
    expect(freePanelSlot([1, 3])).toBe(2);
    expect(freePanelSlot(new Set([1, 2, 3]))).toBeUndefined();
    expect(MAX_PANELS).toBe(3);
  });

  it('the recording is Panel 1, so slot 1 is Panel 2', () => {
    expect(panelLabel(1)).toBe('Panel 2');
    expect(panelLabel(3)).toBe('Panel 4');
  });
});

describe('tileCardText', () => {
  it('draws the video for a live tile', () => {
    expect(tileCardText({ lost: false, hidden: false, placeholder: null })).toBeNull();
  });

  it('a hidden tile shows its placeholder text, never the video', () => {
    for (const placeholder of ['meeting-hidden', 'meeting-ended', 'share-paused'] as const) {
      expect(tileCardText({ lost: false, hidden: true, placeholder })).toBe(
        PLACEHOLDER_TEXT[placeholder],
      );
    }
    expect(PLACEHOLDER_TEXT).toEqual({
      'meeting-hidden': 'Meeting window hidden',
      'meeting-ended': 'Meeting ended',
      'share-paused': 'Screen share paused',
    });
  });

  it('a source that ended wins over a hidden one', () => {
    expect(tileCardText({ lost: true, hidden: true, placeholder: 'share-paused' })).toBe(
      'Source ended',
    );
  });
});
