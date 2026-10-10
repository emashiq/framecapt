import { describe, expect, it } from 'vitest';
import {
  MeetingPanelWatcher,
  visibilityOf,
  type MeetingVisibility,
  type PanelBinding,
} from '../../src/main/meeting/visibility';
import type { WinInfo } from '../../src/main/platform/window-probe';
import type { PanelPlaceholder } from '../../src/shared/panels';

function win(overrides: Partial<WinInfo> = {}): WinInfo {
  return {
    hwnd: '10',
    title: 'Zoom Meeting',
    className: 'ConfMultiTabContentWndClass',
    pid: 1,
    exe: 'zoom.exe',
    rect: { x: 0, y: 0, width: 800, height: 600 },
    minimized: false,
    visible: true,
    cloaked: false,
    ...overrides,
  };
}

const MEET_TITLE = 'Meet – abc-defg-hij - Google Chrome';

describe('visibilityOf', () => {
  it('a normal window is visible', () => {
    expect(visibilityOf('zoom', win(), false)).toBe('visible');
  });

  it('a window covered by other windows is still visible (the capture records it)', () => {
    // A covered window has nothing different about it: not minimized, not cloaked.
    expect(
      visibilityOf('zoom', win({ rect: { x: -3000, y: 0, width: 800, height: 600 } }), false),
    ).toBe('visible');
  });

  it('a minimized window is hidden', () => {
    expect(visibilityOf('zoom', win({ minimized: true }), false)).toBe('hidden');
  });

  it('a cloaked window (another virtual desktop) is hidden', () => {
    expect(visibilityOf('teams', win({ cloaked: true }), false)).toBe('hidden');
  });

  it('a Meet call is hidden once its tab is no longer the active tab', () => {
    const meet = win({ title: MEET_TITLE, className: 'Chrome_WidgetWin_1', exe: 'chrome.exe' });
    expect(visibilityOf('meet', meet, false)).toBe('visible');
    expect(visibilityOf('meet', { ...meet, title: 'Inbox - Gmail - Google Chrome' }, false)).toBe(
      'hidden',
    );
  });

  it('only a Meet call depends on the title: a desktop app keeps its window whatever it says', () => {
    expect(visibilityOf('zoom', win({ title: 'Anything' }), false)).toBe('visible');
  });

  it('a window that is gone, or a meeting that ended, is ended', () => {
    expect(visibilityOf('zoom', null, false)).toBe('ended');
    expect(visibilityOf('zoom', win(), true)).toBe('ended');
    // Ended wins over hidden.
    expect(visibilityOf('zoom', win({ minimized: true }), true)).toBe('ended');
  });
});

describe('MeetingPanelWatcher', () => {
  const binding = (overrides: Partial<PanelBinding> = {}): PanelBinding => ({
    sessionId: 's1',
    slot: 1,
    meetingId: 'm1',
    app: 'zoom',
    hwnd: '10',
    ...overrides,
  });

  function setup(initial: WinInfo | null = win()) {
    const windows = new Map<string, WinInfo | null>([['10', initial]]);
    const calls: string[] = [];
    const changes: string[] = [];
    let failFor: string | null = null;
    let timer: (() => void) | undefined;
    const intervals: number[] = [];
    const cleared: unknown[] = [];
    const watcher = new MeetingPanelWatcher({
      probe: { get: (hwnd) => Promise.resolve(windows.get(hwnd) ?? null) },
      setPanelHidden: (sessionId, slot, hidden, placeholder: PanelPlaceholder) => {
        if (sessionId === failFor) throw new Error('gone');
        calls.push(`${sessionId}/${slot} ${hidden ? 'hide' : 'show'} ${placeholder}`);
      },
      setInterval: (callback, ms) => {
        timer = callback;
        intervals.push(ms);
        return 'timer';
      },
      clearInterval: (handle) => {
        cleared.push(handle);
        timer = undefined;
      },
      onChange: (b, state: MeetingVisibility) => changes.push(`${b.sessionId}/${b.slot} ${state}`),
    });
    return {
      watcher,
      calls,
      changes,
      intervals,
      cleared,
      hasTimer: () => timer !== undefined,
      set: (hwnd: string, info: WinInfo | null) => windows.set(hwnd, info),
      failFor: (sessionId: string) => {
        failFor = sessionId;
      },
    };
  }

  it('looks every 500 ms while something is bound, and stops when nothing is', () => {
    const t = setup();
    expect(t.hasTimer()).toBe(false);
    t.watcher.bind(binding());
    expect(t.intervals).toEqual([500]);
    t.watcher.bind(binding({ slot: 2, hwnd: '11' }));
    expect(t.intervals).toHaveLength(1); // one timer for all
    t.watcher.unbind('s1', 1);
    expect(t.hasTimer()).toBe(true);
    t.watcher.unbind('s1', 2);
    expect(t.hasTimer()).toBe(false);
    expect(t.cleared).toHaveLength(1);
  });

  it('needs two hidden readings in a row to hide, and shows again at once', async () => {
    const t = setup();
    t.watcher.bind(binding());
    t.set('10', win({ minimized: true }));
    await t.watcher.poll();
    expect(t.calls).toEqual([]); // one reading is not enough
    await t.watcher.poll();
    expect(t.calls).toEqual(['s1/1 hide meeting-hidden']);
    expect(t.watcher.stateOf('s1', 1)).toBe('hidden');

    await t.watcher.poll(); // still hidden: nothing new
    expect(t.calls).toHaveLength(1);

    t.set('10', win());
    await t.watcher.poll();
    expect(t.calls).toEqual(['s1/1 hide meeting-hidden', 's1/1 show meeting-hidden']);
    expect(t.watcher.stateOf('s1', 1)).toBe('visible');
  });

  it('a window that flickers (hidden, visible, hidden) never hides the picture', async () => {
    const t = setup();
    t.watcher.bind(binding());
    for (const minimized of [true, false, true, false, true]) {
      t.set('10', win({ minimized }));
      await t.watcher.poll();
    }
    expect(t.calls).toEqual([]);
  });

  it('a window that is gone ends the meeting at once, and it stays ended', async () => {
    const t = setup();
    t.watcher.bind(binding());
    t.set('10', null);
    await t.watcher.poll();
    expect(t.calls).toEqual(['s1/1 hide meeting-ended']);
    t.set('10', win()); // a window that comes back does not undo the end
    await t.watcher.poll();
    expect(t.calls).toHaveLength(1);
    expect(t.watcher.stateOf('s1', 1)).toBe('ended');
  });

  it('the detector ending the meeting shows the ended card', async () => {
    const t = setup();
    t.watcher.bind(binding());
    t.watcher.bind(binding({ sessionId: 's2', meetingId: 'm2', slot: 2, hwnd: '11' }));
    t.watcher.markMeetingEnded('m1');
    expect(t.calls).toEqual(['s1/1 hide meeting-ended']);
    // A reading in flight cannot undo it.
    await t.watcher.poll();
    expect(t.watcher.stateOf('s1', 1)).toBe('ended');
    // A binding made after the end starts ended.
    t.watcher.bind(binding({ sessionId: 's3', slot: 3 }));
    expect(t.watcher.stateOf('s3', 3)).toBe('ended');
  });

  it('watches slot 0 (the recording itself) like a panel', async () => {
    const t = setup();
    t.watcher.bind(binding({ slot: 0 }));
    t.set('10', win({ cloaked: true }));
    await t.watcher.poll();
    await t.watcher.poll();
    expect(t.calls).toEqual(['s1/0 hide meeting-hidden']);
  });

  it('tells the owner about every change, the first binding included', async () => {
    const t = setup();
    t.watcher.bind(binding());
    t.set('10', win({ minimized: true }));
    await t.watcher.poll();
    await t.watcher.poll();
    t.set('10', win());
    await t.watcher.poll();
    expect(t.changes).toEqual(['s1/1 visible', 's1/1 hidden', 's1/1 visible']);
  });

  it('stops watching a recording that ended', async () => {
    const t = setup();
    t.watcher.bind(binding());
    t.watcher.bind(binding({ slot: 2 }));
    t.watcher.endSession('s1');
    expect(t.watcher.size).toBe(0);
    expect(t.hasTimer()).toBe(false);
    t.set('10', win({ minimized: true }));
    await t.watcher.poll();
    expect(t.calls).toEqual([]);
  });

  it('stops watching a picture when the recorder says its recording or panel is gone', async () => {
    const t = setup();
    t.watcher.bind(binding());
    t.watcher.bind(binding({ sessionId: 's2', slot: 2 }));
    t.failFor('s1');
    t.set('10', win({ minimized: true }));
    await t.watcher.poll();
    await t.watcher.poll();
    expect(t.watcher.stateOf('s1', 1)).toBeUndefined();
    expect(t.calls).toEqual(['s2/2 hide meeting-hidden']);
  });

  it('adds the panel once a window that was hidden at the start is shown', async () => {
    const t = setup(win({ minimized: true }));
    let attached = 0;
    const pending = binding({
      slot: null,
      attach: () => {
        attached += 1;
        return Promise.resolve(1);
      },
    });
    t.watcher.bind(pending, 'hidden');
    await t.watcher.poll();
    await t.watcher.poll();
    expect(attached).toBe(0);
    expect(t.calls).toEqual([]); // no picture to hide yet
    t.set('10', win());
    await t.watcher.poll();
    expect(attached).toBe(1);
    expect(t.watcher.stateOf('s1', 1)).toBe('visible');
    expect(t.calls).toEqual(['s1/1 show meeting-hidden']);
    expect(t.changes).toEqual(['s1/null hidden', 's1/1 visible']);
    await t.watcher.poll();
    expect(attached).toBe(1);
  });

  it('keeps trying to add the panel when it fails', async () => {
    const t = setup();
    let attempts = 0;
    t.watcher.bind(
      binding({
        slot: null,
        attach: () => {
          attempts += 1;
          return attempts < 2 ? Promise.reject(new Error('busy')) : Promise.resolve(1);
        },
      }),
      'hidden',
    );
    await t.watcher.poll();
    await t.watcher.poll();
    expect(attempts).toBe(2);
    expect(t.watcher.stateOf('s1', 1)).toBe('visible');
  });
});
