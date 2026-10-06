import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { StepsController, type StepsDeps } from '../../src/main/flows/controller';
import type { DisplayInfo } from '../../src/main/capture/types';

const left: DisplayInfo = {
  id: '1',
  label: 'Left',
  bounds: { x: 0, y: 0, width: 1000, height: 500 },
  scaleFactor: 2,
  rotation: 0,
  physicalSize: { width: 2000, height: 1000 },
  isPrimary: true,
};
const right: DisplayInfo = {
  id: '2',
  label: 'Right',
  bounds: { x: 1000, y: 0, width: 800, height: 600 },
  scaleFactor: 1,
  rotation: 0,
  physicalSize: { width: 800, height: 600 },
  isPrimary: false,
};

interface Setup {
  controller: StepsController;
  deps: StepsDeps & { written: [string, number][]; discarded: string[]; saved: unknown[] };
  move: (x: number, y: number) => void;
  /** Advances the clock by `ms` in 100 ms polls (the interval runs on fake timers). */
  wait: (ms: number) => Promise<void>;
  ui: { open: ReturnType<typeof vi.fn>; close: ReturnType<typeof vi.fn> };
  state: { blocked: boolean; overPill: boolean };
}

function setup(overrides: Partial<StepsDeps> = {}): Setup {
  let clock = 1_000_000;
  const pointer = { x: 0, y: 0 };
  const state = { blocked: false, overPill: false };
  const written: [string, number][] = [];
  const discarded: string[] = [];
  const saved: unknown[] = [];
  const ui = { open: vi.fn(), close: vi.fn() };
  const deps: Setup['deps'] = {
    now: () => clock,
    monotonic: () => clock,
    cursor: () => ({ ...pointer }),
    displays: () => [left, right],
    grab: (display) =>
      Promise.resolve({
        width: display.physicalSize.width,
        height: display.physicalSize.height,
        png: new Uint8Array([1]),
      }),
    sessions: {
      begin: () => Promise.resolve({ id: 's1', dir: '/session' }),
      writeStep: (dir, index) => {
        written.push([dir, index]);
        return Promise.resolve(`${dir}/step-${index + 1}.png`);
      },
      discard: (dir) => {
        discarded.push(dir);
        return Promise.resolve();
      },
    },
    save: (input) => {
      saved.push(input);
      return Promise.resolve({ historyId: '0f0e0d0c-0b0a-4908-8706-050403020100' });
    },
    isBlocked: () => state.blocked,
    isOverPill: () => state.overPill,
    ui,
    written,
    discarded,
    saved,
    ...overrides,
  };
  const controller = new StepsController(deps);
  return {
    controller,
    deps,
    ui,
    state,
    move: (x, y) => {
      pointer.x = x;
      pointer.y = y;
    },
    wait: async (ms) => {
      for (let elapsed = 0; elapsed < ms; elapsed += 100) {
        clock += 100;
        await vi.advanceTimersByTimeAsync(100);
      }
    },
  };
}

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe('StepsController states', () => {
  it('starts idle, goes active with the pill, and refuses a second start', async () => {
    const { controller, ui } = setup();
    expect(controller.snapshot()).toEqual({
      state: 'idle',
      auto: true,
      count: 0,
      max: 200,
      notice: null,
    });
    await controller.start();
    expect(controller.status).toBe('active');
    expect(controller.active).toBe(true);
    expect(ui.open).toHaveBeenCalledTimes(1);
    await expect(controller.start()).rejects.toMatchObject({ code: 'BUSY' });
  });

  it('does not start while a recording or screenshot flow is active', async () => {
    const { controller, state } = setup();
    state.blocked = true;
    await expect(controller.start()).rejects.toMatchObject({ code: 'BUSY' });
    expect(controller.status).toBe('idle');
  });

  it('two simultaneous starts claim the state once', async () => {
    const { controller, ui } = setup();
    const results = await Promise.allSettled([controller.start(), controller.start()]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(ui.open).toHaveBeenCalledTimes(1);
  });

  it('pause and resume change the state and are idempotent', async () => {
    const { controller } = setup();
    await controller.start();
    controller.pause();
    controller.pause();
    expect(controller.status).toBe('paused');
    controller.resume();
    controller.resume();
    expect(controller.status).toBe('active');
  });

  it('notifies listeners of every change', async () => {
    const { controller } = setup();
    const seen: string[] = [];
    controller.onChange((snapshot) => seen.push(snapshot.state));
    await controller.start();
    controller.pause();
    await controller.cancel();
    expect(seen).toEqual(['active', 'paused', 'idle']);
  });
});

describe('automatic steps', () => {
  it('takes a step when the pointer moves and rests, with the pointer in image pixels', async () => {
    const { controller, move, wait } = setup();
    await controller.start();
    move(250, 100);
    await wait(1000);
    expect(controller.snapshot().count).toBe(1);
    const done = await controller.done();
    expect('historyId' in done).toBe(true);
  });

  it('maps the pointer to the display under it (scale 2 on the left, 1 on the right)', async () => {
    const { controller, deps, move, wait } = setup();
    await controller.start();
    move(250, 100);
    await wait(1000);
    move(1400, 300);
    await wait(1500);
    expect(controller.snapshot().count).toBe(2);
    await controller.done();
    const input = deps.saved[0] as {
      steps: { width: number; cursor: { x: number; y: number } | null }[];
    };
    expect(input.steps.map((s) => [s.width, s.cursor])).toEqual([
      [2000, { x: 500, y: 200 }],
      [800, { x: 400, y: 300 }],
    ]);
  });

  it('Auto off takes no steps by itself, back on does', async () => {
    const { controller, move, wait } = setup();
    await controller.start();
    controller.setAuto(false);
    move(250, 100);
    await wait(2000);
    expect(controller.snapshot().count).toBe(0);
    controller.setAuto(true);
    move(600, 300);
    await wait(1000);
    expect(controller.snapshot().count).toBe(1);
  });

  it('takes no step while paused and none while the pointer rests on the pill', async () => {
    const { controller, move, wait, state } = setup();
    await controller.start();
    controller.pause();
    move(250, 100);
    await wait(2000);
    expect(controller.snapshot().count).toBe(0);
    controller.resume();
    state.overPill = true;
    await wait(2000);
    expect(controller.snapshot().count).toBe(0);
  });

  it('does not poll at all when nothing is running (idle costs nothing)', async () => {
    const cursor = vi.fn(() => ({ x: 0, y: 0 }));
    const { controller, wait } = setup({ cursor });
    await wait(1000);
    expect(cursor).not.toHaveBeenCalled();
    await controller.start();
    await controller.cancel();
    cursor.mockClear();
    await wait(1000);
    expect(cursor).not.toHaveBeenCalled();
  });
});

describe('manual steps', () => {
  it('captures at once at the pointer, even with Auto off or paused', async () => {
    const { controller, move, deps } = setup();
    await controller.start();
    controller.setAuto(false);
    move(100, 100);
    await controller.captureStep();
    controller.pause();
    move(900, 400);
    await controller.captureStep();
    expect(controller.snapshot().count).toBe(2);
    expect(deps.written).toEqual([
      ['/session', 0],
      ['/session', 1],
    ]);
  });

  it('does nothing before a guide is started', async () => {
    const { controller } = setup();
    await controller.captureStep();
    expect(controller.snapshot().count).toBe(0);
  });

  it('uses the last pointer place outside the pill when the button was pressed on the pill', async () => {
    const { controller, move, wait, state, deps } = setup();
    await controller.start();
    controller.setAuto(false);
    move(250, 100);
    await wait(200);
    state.overPill = true;
    move(500, 480);
    await controller.captureStep();
    await controller.done();
    const input = deps.saved[0] as { steps: { cursor: { x: number; y: number } | null }[] };
    expect(input.steps[0]?.cursor).toEqual({ x: 500, y: 200 });
  });

  it('the pointer is dropped (null) when it was over the pill and no earlier place is known', async () => {
    const { controller, state, deps } = setup();
    await controller.start();
    state.overPill = true;
    await controller.captureStep();
    await controller.done();
    const input = deps.saved[0] as { steps: { cursor: unknown }[] };
    expect(input.steps[0]?.cursor).toBeNull();
  });
});

describe('the step limit', () => {
  it('pauses itself at the maximum with a notice, refusing more steps', async () => {
    const { controller, deps } = setup({ maxSteps: 3 });
    await controller.start();
    for (let i = 0; i < 5; i += 1) await controller.captureStep();
    expect(controller.snapshot()).toMatchObject({ state: 'paused', count: 3, max: 3 });
    expect(controller.snapshot().notice).toContain('Step limit reached');
    expect(deps.written).toHaveLength(3);
    controller.resume(); // cannot go on
    expect(controller.status).toBe('paused');
    const done = await controller.done();
    expect('historyId' in done).toBe(true);
  });
});

describe('finishing', () => {
  it('Done with no step discards the session without saving', async () => {
    const { controller, deps, ui } = setup();
    await controller.start();
    expect(await controller.done()).toEqual({ discarded: true });
    expect(deps.saved).toEqual([]);
    expect(deps.discarded).toEqual(['/session']);
    expect(ui.close).toHaveBeenCalledTimes(1);
    expect(controller.status).toBe('idle');
  });

  it('Done saves the steps in order and cleans the session', async () => {
    const { controller, deps, ui } = setup();
    await controller.start();
    await controller.captureStep();
    await controller.captureStep();
    const result = await controller.done();
    expect(result).toEqual({ historyId: '0f0e0d0c-0b0a-4908-8706-050403020100' });
    const input = deps.saved[0] as { steps: { source: string }[]; createdAt: number };
    expect(input.steps.map((s) => s.source)).toEqual([
      '/session/step-1.png',
      '/session/step-2.png',
    ]);
    expect(deps.discarded).toEqual(['/session']);
    expect(ui.close).toHaveBeenCalledTimes(1);
    expect(controller.status).toBe('idle');
  });

  it('a failed save keeps the session: back to paused with a notice, and Done can be tried again', async () => {
    let fail = true;
    const { controller, deps } = setup({
      save: () =>
        fail
          ? Promise.reject(new Error('disk full'))
          : Promise.resolve({ historyId: '0f0e0d0c-0b0a-4908-8706-050403020100' }),
    });
    await controller.start();
    await controller.captureStep();
    await expect(controller.done()).rejects.toMatchObject({ code: 'INTERNAL' });
    expect(controller.snapshot()).toMatchObject({ state: 'paused', count: 1 });
    expect(controller.snapshot().notice).toContain('could not be saved');
    expect(deps.discarded).toEqual([]);
    fail = false;
    expect('historyId' in (await controller.done())).toBe(true);
  });

  it('Cancel throws everything away and returns to idle', async () => {
    const { controller, deps, ui } = setup();
    await controller.start();
    await controller.captureStep();
    await controller.cancel();
    expect(controller.status).toBe('idle');
    expect(deps.saved).toEqual([]);
    expect(deps.discarded).toEqual(['/session']);
    expect(ui.close).toHaveBeenCalledTimes(1);
    expect(controller.snapshot().count).toBe(0);
    // A second cancel is a no-op.
    await controller.cancel();
    expect(ui.close).toHaveBeenCalledTimes(1);
  });

  it('Done without a running guide is refused', async () => {
    const { controller } = setup();
    await expect(controller.done()).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('a step still being grabbed when Cancel arrives is dropped', async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const { controller, deps } = setup({
      grab: async () => {
        await gate;
        return { width: 10, height: 10, png: new Uint8Array([1]) };
      },
    });
    await controller.start();
    const capturing = controller.captureStep();
    const cancelling = controller.cancel();
    release();
    await Promise.all([capturing, cancelling]);
    expect(controller.status).toBe('idle');
    expect(deps.written).toEqual([]);
    expect(deps.saved).toEqual([]);
  });
});

describe('capture failures', () => {
  it('a write error pauses the capture and says so, without losing earlier steps', async () => {
    let calls = 0;
    const { controller } = setup({
      sessions: {
        begin: () => Promise.resolve({ id: 's', dir: '/session' }),
        writeStep: () => {
          calls += 1;
          return calls === 1
            ? Promise.resolve('/session/step-1.png')
            : Promise.reject(new Error('ENOSPC'));
        },
        discard: () => Promise.resolve(),
      },
    });
    await controller.start();
    await controller.captureStep();
    await controller.captureStep();
    expect(controller.snapshot()).toMatchObject({ state: 'paused', count: 1 });
    expect(controller.snapshot().notice).toContain("couldn't be saved");
  });
});
