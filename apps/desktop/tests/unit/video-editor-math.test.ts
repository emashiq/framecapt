import { describe, expect, it } from 'vitest';
import {
  clampZoom,
  formatRulerLabel,
  formatTimecode,
  packLanes,
  scrollAfterZoom,
  sliderToZoom,
  snapTime,
  tickSpec,
  ticksBetween,
  zoomLimits,
  zoomToSlider,
} from '../../src/renderer/views/video-editor/timeline-math';
import {
  ASPECTS,
  cursorFor,
  dragRect,
  fitAspect,
  hitHandle,
  rectAround,
  rectFromPoints,
} from '../../src/renderer/views/video-editor/rect-drag';
import { playStart, playbackStep, stepTime } from '../../src/renderer/views/video-editor/playback';

describe('timeline ticks and time text', () => {
  it('picks a step whose labels are far enough apart', () => {
    expect(tickSpec(0.1)).toEqual({ step: 1000, minor: 200 });
    expect(tickSpec(1).step).toBe(100);
    expect(tickSpec(0.001).step).toBe(120_000);
    expect(tickSpec(1e-9).step).toBe(3_600_000);
  });

  it('lists major and minor ticks in a range', () => {
    const spec = tickSpec(0.1);
    const ticks = ticksBetween(spec, 0, 3000, 10_000);
    expect(ticks.map((tick) => tick.ms)).toEqual([
      0, 200, 400, 600, 800, 1000, 1200, 1400, 1600, 1800, 2000, 2200, 2400, 2600, 2800, 3000,
    ]);
    expect(ticks.filter((tick) => tick.major).map((tick) => tick.ms)).toEqual([
      0, 1000, 2000, 3000,
    ]);
    expect(ticksBetween(spec, 9000, 20_000, 10_000).at(-1)?.ms).toBe(10_000);
  });

  it('formats times', () => {
    expect(formatTimecode(0)).toBe('0:00.000');
    expect(formatTimecode(65_250)).toBe('1:05.250');
    expect(formatTimecode(3_723_500)).toBe('1:02:03.500');
    expect(formatTimecode(-5)).toBe('0:00.000');
    expect(formatRulerLabel(5000, 1000)).toBe('0:05');
    expect(formatRulerLabel(5500, 500)).toBe('0:05.5');
    expect(formatRulerLabel(5050, 50)).toBe('0:05.050');
    expect(formatRulerLabel(3_605_000, 5000)).toBe('1:00:05');
  });
});

describe('snapping', () => {
  it('snaps to the nearest target inside the threshold', () => {
    expect(snapTime(1010, [0, 1000, 1030], 20)).toEqual({ ms: 1000, target: 1000 });
    expect(snapTime(1026, [0, 1000, 1030], 20)).toEqual({ ms: 1030, target: 1030 });
    expect(snapTime(500, [0, 1000], 20)).toEqual({ ms: 500, target: null });
    expect(snapTime(500, [], 20)).toEqual({ ms: 500, target: null });
  });
});

describe('zoom', () => {
  it('fits the whole recording at the minimum and never zooms outside the limits', () => {
    const limits = zoomLimits(60_000, 1200);
    expect(limits.min).toBeCloseTo(0.02);
    expect(clampZoom(0.0001, limits)).toBe(limits.min);
    expect(clampZoom(50, limits)).toBe(limits.max);
    expect(zoomLimits(500, 1200).max).toBeGreaterThanOrEqual(zoomLimits(500, 1200).min);
  });

  it('maps the slider on a log scale and back', () => {
    const limits = zoomLimits(3_600_000, 1000);
    expect(zoomToSlider(limits.min, limits)).toBeCloseTo(0);
    expect(zoomToSlider(limits.max, limits)).toBeCloseTo(1);
    for (const position of [0.1, 0.5, 0.9]) {
      expect(zoomToSlider(sliderToZoom(position, limits), limits)).toBeCloseTo(position);
    }
  });

  it('keeps the time under the cursor in place', () => {
    const scroll = scrollAfterZoom(400, 300, 0.1, 0.4);
    // The time under x=300 before: (400 + 300) / 0.1 = 7000 ms; after it is at 7000 * 0.4 - scroll.
    expect(7000 * 0.4 - scroll).toBeCloseTo(300);
    expect(scrollAfterZoom(0, 0, 0.1, 0.05)).toBe(0);
  });
});

describe('lanes', () => {
  it('stacks overlapping spans and reuses free rows', () => {
    const { lanes, count } = packLanes([
      { id: 'a', startMs: 0, endMs: 1000 },
      { id: 'b', startMs: 500, endMs: 1500 },
      { id: 'c', startMs: 1000, endMs: 2000 },
      { id: 'd', startMs: 1200, endMs: 1300 },
    ]);
    expect(lanes.get('a')).toBe(0);
    expect(lanes.get('b')).toBe(1);
    expect(lanes.get('c')).toBe(0);
    expect(lanes.get('d')).toBe(2);
    expect(count).toBe(3);
    expect(packLanes([]).count).toBe(1);
  });
});

describe('rect dragging', () => {
  const bounds = { width: 1000, height: 500 };
  const rect = { x: 100, y: 100, width: 200, height: 100 };

  it('moves inside the bounds', () => {
    expect(dragRect(rect, 'move', 50, -30, bounds, 8)).toEqual({
      x: 150,
      y: 70,
      width: 200,
      height: 100,
    });
    expect(dragRect(rect, 'move', -500, 900, bounds, 8)).toEqual({
      x: 0,
      y: 400,
      width: 200,
      height: 100,
    });
  });

  it('resizes from each corner and edge, keeping the minimum and the bounds', () => {
    expect(dragRect(rect, 'se', 40, 20, bounds, 8)).toEqual({
      x: 100,
      y: 100,
      width: 240,
      height: 120,
    });
    expect(dragRect(rect, 'nw', 40, 20, bounds, 8)).toEqual({
      x: 140,
      y: 120,
      width: 160,
      height: 80,
    });
    expect(dragRect(rect, 'e', -500, 0, bounds, 8)).toEqual({
      x: 100,
      y: 100,
      width: 8,
      height: 100,
    });
    expect(dragRect(rect, 'n', 0, -500, bounds, 8)).toEqual({
      x: 100,
      y: 0,
      width: 200,
      height: 200,
    });
    expect(dragRect(rect, 'se', 5000, 5000, bounds, 8)).toEqual({
      x: 100,
      y: 100,
      width: 900,
      height: 400,
    });
  });

  it('keeps an aspect ratio when asked', () => {
    const wide = dragRect({ x: 0, y: 0, width: 160, height: 90 }, 'se', 80, 0, bounds, 8, 16 / 9);
    expect(wide.width / wide.height).toBeCloseTo(16 / 9, 1);
    expect(wide.width).toBe(240);
    // Cannot grow outside: the drag is refused.
    const start = { x: 900, y: 0, width: 100, height: 50 };
    expect(dragRect(start, 'se', 100, 0, bounds, 8, 2)).toEqual(start);
  });

  it('finds handles, the inside, and nothing', () => {
    expect(hitHandle({ x: 100, y: 100 }, rect, 6)).toBe('nw');
    expect(hitHandle({ x: 300, y: 150 }, rect, 6)).toBe('e');
    expect(hitHandle({ x: 200, y: 150 }, rect, 6)).toBe('move');
    expect(hitHandle({ x: 600, y: 400 }, rect, 6)).toBeNull();
    expect(cursorFor('ne')).toBe('nesw-resize');
    expect(cursorFor(null)).toBe('default');
  });

  it('makes a rect from two points in any order, and around a click', () => {
    expect(rectFromPoints({ x: 300, y: 200 }, { x: 100, y: 50 }, bounds, 8)).toEqual({
      x: 100,
      y: 50,
      width: 200,
      height: 150,
    });
    expect(rectFromPoints({ x: 10, y: 10 }, { x: 11, y: 11 }, bounds, 8)).toEqual({
      x: 10,
      y: 10,
      width: 8,
      height: 8,
    });
    expect(rectAround({ x: 5, y: 5 }, { width: 200, height: 100 }, bounds)).toEqual({
      x: 0,
      y: 0,
      width: 200,
      height: 100,
    });
    expect(rectAround({ x: 500, y: 250 }, { width: 5000, height: 100 }, bounds).width).toBe(1000);
  });

  it('fits an aspect ratio into an area, centred', () => {
    const area = { x: 0, y: 0, width: 1920, height: 1080 };
    expect(fitAspect(1, area)).toEqual({ x: 420, y: 0, width: 1080, height: 1080 });
    expect(fitAspect(9 / 16, area)).toEqual({ x: 656, y: 0, width: 608, height: 1080 });
    expect(fitAspect(16 / 9, { x: 10, y: 10, width: 800, height: 800 })).toEqual({
      x: 10,
      y: 185,
      width: 800,
      height: 450,
    });
    expect(ASPECTS.map((aspect) => aspect.id)).toEqual(['free', '16:9', '9:16', '1:1', '4:3']);
  });
});

describe('playback over cuts', () => {
  const segments = [
    { startMs: 500, endMs: 2000 },
    { startMs: 3000, endMs: 6000 },
  ];

  it('plays inside a piece, jumps over a cut and stops at the end of the trim', () => {
    expect(playbackStep(segments, 1000)).toEqual({ kind: 'play' });
    expect(playbackStep(segments, 2000)).toEqual({ kind: 'jump', toMs: 3000 });
    expect(playbackStep(segments, 2500)).toEqual({ kind: 'jump', toMs: 3000 });
    expect(playbackStep(segments, 100)).toEqual({ kind: 'jump', toMs: 500 });
    expect(playbackStep(segments, 6000)).toEqual({ kind: 'stop', atMs: 6000 });
    expect(playbackStep([], 0)).toEqual({ kind: 'stop', atMs: 0 });
  });

  it('starts where it makes sense', () => {
    expect(playStart(segments, 1000)).toBe(1000);
    expect(playStart(segments, 2500)).toBe(3000);
    expect(playStart(segments, 0)).toBe(500);
    expect(playStart(segments, 6000)).toBe(500);
  });

  it('steps over cuts and stops at the ends', () => {
    expect(stepTime(segments, 1000, 33)).toBe(1033);
    expect(stepTime(segments, 1990, 33)).toBe(3000);
    expect(stepTime(segments, 3000, -33)).toBe(2000);
    expect(stepTime(segments, 500, -33)).toBe(500);
    expect(stepTime(segments, 5990, 1000)).toBe(6000);
    expect(stepTime(segments, 1500, 1000)).toBe(3000);
  });
});
