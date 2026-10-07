import { describe, expect, it } from 'vitest';
import { FlowDetector, type CursorSample } from '../../src/main/flows/flow-detector';

/** Feeds `at` for `ms` milliseconds in 100 ms polls; returns the samples that became steps. */
function hold(
  detector: FlowDetector,
  at: { x: number; y: number },
  from: number,
  ms: number,
  jitter = 0,
): CursorSample[] {
  const steps: CursorSample[] = [];
  for (let t = from; t <= from + ms; t += 100) {
    const wobble = jitter === 0 ? 0 : (t / 100) % 2 === 0 ? jitter : -jitter;
    const hit = detector.feed({ x: at.x + wobble, y: at.y, t });
    if (hit) steps.push(hit);
  }
  return steps;
}

describe('FlowDetector', () => {
  it('the first rest after starting is a step, once, after 700 ms', () => {
    const detector = new FlowDetector();
    expect(detector.feed({ x: 100, y: 100, t: 0 })).toBeNull();
    expect(detector.feed({ x: 100, y: 100, t: 600 })).toBeNull();
    expect(detector.feed({ x: 100, y: 100, t: 700 })).toEqual({ x: 100, y: 100, t: 700 });
    // Staying put makes no second step.
    expect(hold(detector, { x: 100, y: 100 }, 800, 5000)).toEqual([]);
  });

  it('the pointer where capture started is not a step; the first needs real movement', () => {
    const detector = new FlowDetector();
    detector.start({ x: 100, y: 100, t: 0 });
    // Resting on the Start button makes nothing, however long.
    expect(hold(detector, { x: 100, y: 100 }, 100, 5000)).toEqual([]);
    // Moving to something and resting there does.
    detector.feed({ x: 400, y: 300, t: 6000 });
    expect(hold(detector, { x: 400, y: 300 }, 6100, 800)).toHaveLength(1);
  });

  it('move, then rest: one step per item', () => {
    const detector = new FlowDetector();
    const first = hold(detector, { x: 100, y: 100 }, 0, 800);
    expect(first).toHaveLength(1);
    // Travel to another item (more than 24 DIP) and rest there.
    detector.feed({ x: 300, y: 200, t: 2000 });
    const second = hold(detector, { x: 300, y: 200 }, 2100, 800);
    expect(second).toHaveLength(1);
    expect(second[0]).toMatchObject({ x: 300, y: 200 });
  });

  it('tolerates jitter inside the 6 DIP radius, but not a drift beyond it', () => {
    const detector = new FlowDetector();
    // +-5 DIP wobble around the anchor still counts as resting.
    expect(hold(detector, { x: 50, y: 50 }, 0, 1000, 3)).toHaveLength(1);

    const drifting = new FlowDetector();
    const steps: CursorSample[] = [];
    // 8 DIP every 300 ms: it never rests within 6 DIP for 700 ms.
    for (let i = 0; i < 20; i += 1) {
      const hit = drifting.feed({ x: 100 + i * 8, y: 100, t: i * 300 });
      if (hit) steps.push(hit);
    }
    expect(steps).toEqual([]);
  });

  it('a new rest within 24 DIP of the last step is not a new step', () => {
    const detector = new FlowDetector();
    expect(hold(detector, { x: 100, y: 100 }, 0, 800)).toHaveLength(1);
    // 20 DIP away: a small adjustment, not "went to another item".
    detector.feed({ x: 120, y: 100, t: 3000 });
    expect(hold(detector, { x: 120, y: 100 }, 3100, 1500)).toEqual([]);
    // 30 DIP away is.
    detector.feed({ x: 131, y: 100, t: 5000 });
    expect(hold(detector, { x: 131, y: 100 }, 5100, 1000)).toHaveLength(1);
  });

  it('never two steps closer than 1.5 s: the second waits for the interval', () => {
    const detector = new FlowDetector();
    expect(hold(detector, { x: 100, y: 100 }, 0, 700)).toHaveLength(1); // step at t=700
    detector.feed({ x: 400, y: 100, t: 800 });
    // The dwell is satisfied at t=1500, but the last step was at 700: wait until 2200.
    const second = hold(detector, { x: 400, y: 100 }, 900, 2000);
    expect(second).toHaveLength(1);
    expect(second[0]?.t).toBeGreaterThanOrEqual(700 + 1500);
    expect(second[0]?.t).toBeLessThan(700 + 1500 + 200);
  });

  it('makes no step while paused, and resuming starts a fresh rest', () => {
    const detector = new FlowDetector();
    detector.setPaused(true);
    expect(hold(detector, { x: 100, y: 100 }, 0, 3000)).toEqual([]);
    detector.setPaused(false);
    expect(detector.feed({ x: 100, y: 100, t: 3100 })).toBeNull();
    expect(detector.feed({ x: 100, y: 100, t: 3700 })).toBeNull();
    expect(detector.feed({ x: 100, y: 100, t: 3800 })).toEqual({ x: 100, y: 100, t: 3800 });
  });

  it('a manual step is remembered: resting at the same place does not repeat it', () => {
    const detector = new FlowDetector();
    detector.noteManual({ x: 100, y: 100, t: 0 });
    expect(hold(detector, { x: 100, y: 100 }, 100, 3000)).toEqual([]);
    detector.feed({ x: 400, y: 400, t: 4000 });
    expect(hold(detector, { x: 400, y: 400 }, 4100, 1000)).toHaveLength(1);
  });

  it('reset forgets the last step', () => {
    const detector = new FlowDetector();
    expect(hold(detector, { x: 100, y: 100 }, 0, 800)).toHaveLength(1);
    detector.reset();
    expect(hold(detector, { x: 100, y: 100 }, 5000, 800)).toHaveLength(1);
  });

  it('resting on another display is a step even a few DIP from the last one', () => {
    const detector = new FlowDetector();
    detector.start({ x: 1900, y: 500, t: 0, display: 'a' });
    const at = { x: 1905, y: 500 };
    // Same display: too close to the start, no step.
    for (let t = 2000; t <= 3000; t += 100) {
      expect(detector.feed({ ...at, t, display: 'a' })).toBeNull();
    }
    detector.noteManual({ ...at, t: 3000, display: 'a' });
    // Another display: the move distance does not matter.
    let hits = 0;
    for (let t = 6000; t <= 7000; t += 100) {
      if (detector.feed({ x: 1912, y: 500, t, display: 'b' })) hits += 1;
    }
    expect(hits).toBe(1);
  });
});
