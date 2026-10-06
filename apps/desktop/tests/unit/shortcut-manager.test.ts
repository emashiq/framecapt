import { describe, expect, it, vi } from 'vitest';
import { hasProblems, ShortcutManager, type GlobalShortcutApi } from '../../src/main/shortcuts';
import {
  DEFAULT_SHORTCUTS,
  SHORTCUT_ACTIONS,
  type ShortcutAction,
  type ShortcutsMap,
} from '../../src/shared/shortcuts';

/** A stand-in for Electron's globalShortcut that also knows what "other apps" hold. */
function fakeApi(taken: string[] = []) {
  const held = new Map<string, () => void>();
  const log: string[] = [];
  const api: GlobalShortcutApi = {
    register: (accelerator, callback) => {
      log.push(`register ${accelerator}`);
      if (taken.includes(accelerator) || held.has(accelerator)) return false;
      held.set(accelerator, callback);
      return true;
    },
    unregister: (accelerator) => {
      log.push(`unregister ${accelerator}`);
      held.delete(accelerator);
    },
  };
  return { api, held, log };
}

describe('ShortcutManager', () => {
  it('registers every default shortcut and reports ok', () => {
    const { api, held } = fakeApi();
    const manager = new ShortcutManager({ api, run: vi.fn() });
    const states = manager.apply(DEFAULT_SHORTCUTS);
    expect([...held.keys()].sort()).toEqual(
      Object.values(DEFAULT_SHORTCUTS).filter(Boolean).sort(),
    );
    for (const action of SHORTCUT_ACTIONS) {
      const accelerator = DEFAULT_SHORTCUTS[action];
      expect(states[action]).toEqual(
        accelerator === null
          ? { accelerator: null, status: 'disabled' }
          : { accelerator, status: 'ok' },
      );
    }
    expect(hasProblems(states)).toBe(false);
  });

  it('runs the action of the accelerator that fired', () => {
    const { api, held } = fakeApi();
    const run = vi.fn<(action: ShortcutAction) => void>();
    new ShortcutManager({ api, run }).apply(DEFAULT_SHORTCUTS);
    held.get('Ctrl+Shift+3')?.();
    held.get('Ctrl+Shift+9')?.();
    expect(run.mock.calls.map(([action]) => action)).toEqual([
      'screenshotRegion',
      'pauseRecording',
    ]);
  });

  it('reports a conflict when another app holds the combination, with a message for the UI', () => {
    const { api, held } = fakeApi(['Ctrl+Shift+1']);
    const manager = new ShortcutManager({ api, run: vi.fn() });
    const states = manager.apply(DEFAULT_SHORTCUTS);
    expect(states.screenshotScreen.status).toBe('conflict');
    expect(states.screenshotScreen.message).toBe(
      'Ctrl+Shift+1 is used by another app — choose a different shortcut.',
    );
    expect(states.screenshotWindow.status).toBe('ok');
    expect(held.has('Ctrl+Shift+1')).toBe(false);
    expect(hasProblems(states)).toBe(true);
  });

  it('a disabled (null) shortcut registers nothing and is "disabled"', () => {
    const { api, held } = fakeApi();
    const manager = new ShortcutManager({ api, run: vi.fn() });
    const states = manager.apply({ ...DEFAULT_SHORTCUTS, recordWindow: null });
    expect(states.recordWindow).toEqual({ accelerator: null, status: 'disabled' });
    expect(held.size).toBe(9);
  });

  it('never registers a duplicate: the second action gets a conflict', () => {
    const { api, held } = fakeApi();
    const manager = new ShortcutManager({ api, run: vi.fn() });
    const states = manager.apply({ ...DEFAULT_SHORTCUTS, recordRegion: 'shift+ctrl+3' });
    expect(states.screenshotRegion.status).toBe('ok');
    expect(states.recordRegion.status).toBe('conflict');
    expect(states.recordRegion.message).toContain('Screenshot: region');
    expect([...held.keys()].filter((key) => key === 'Ctrl+Shift+3')).toHaveLength(1);
  });

  it('an invalid string is "invalid"; a string the OS rejects (throws) is "invalid" too', () => {
    const api: GlobalShortcutApi = {
      register: () => {
        throw new TypeError('conversion failure');
      },
      unregister: () => undefined,
    };
    const manager = new ShortcutManager({ api, run: vi.fn() });
    const states = manager.apply({ ...DEFAULT_SHORTCUTS, stopRecording: 'A' });
    expect(states.stopRecording.status).toBe('invalid');
    expect(states.screenshotScreen.status).toBe('invalid');
  });

  it('a change unregisters only its own previous accelerators, then registers the new set', () => {
    const { api, held, log } = fakeApi();
    // Something else in the app (the countdown's Esc) holds a shortcut of its own.
    api.register('Escape', () => undefined);
    const manager = new ShortcutManager({ api, run: vi.fn() });
    manager.apply(DEFAULT_SHORTCUTS);
    log.length = 0;
    manager.apply({ ...DEFAULT_SHORTCUTS, screenshotRegion: 'Ctrl+Alt+R' });
    const unregistered = log
      .filter((line) => line.startsWith('unregister'))
      .map((l) => l.slice(11));
    expect(unregistered.sort()).toEqual(Object.values(DEFAULT_SHORTCUTS).filter(Boolean).sort());
    expect(unregistered).not.toContain('Escape');
    expect(held.has('Escape')).toBe(true);
    expect(held.has('Ctrl+Alt+R')).toBe(true);
    expect(held.has('Ctrl+Shift+3')).toBe(false);
  });

  it('does not release a combination it never got (another app keeps it)', () => {
    const { api, log } = fakeApi(['Ctrl+Shift+1']);
    const manager = new ShortcutManager({ api, run: vi.fn() });
    manager.apply(DEFAULT_SHORTCUTS);
    log.length = 0;
    manager.apply(DEFAULT_SHORTCUTS);
    expect(log).not.toContain('unregister Ctrl+Shift+1');
  });

  it('pause releases everything for the shortcut recorder and resume restores it', () => {
    const { api, held } = fakeApi();
    const manager = new ShortcutManager({ api, run: vi.fn() });
    manager.apply(DEFAULT_SHORTCUTS);
    manager.setPaused(true);
    expect(held.size).toBe(0);
    manager.setPaused(true); // idempotent
    manager.setPaused(false);
    expect(held.size).toBe(10);
  });

  it('a change while paused takes effect on resume', () => {
    const { api, held } = fakeApi();
    const manager = new ShortcutManager({ api, run: vi.fn() });
    manager.apply(DEFAULT_SHORTCUTS);
    manager.setPaused(true);
    manager.apply({ ...DEFAULT_SHORTCUTS, recordScreen: 'Ctrl+Alt+Q' });
    expect(held.size).toBe(0);
    manager.setPaused(false);
    expect(held.has('Ctrl+Alt+Q')).toBe(true);
    expect(held.has('Ctrl+Shift+5')).toBe(false);
  });

  it('dispose unregisters everything it holds and tells listeners about status changes', () => {
    const { api, held } = fakeApi();
    const manager = new ShortcutManager({ api, run: vi.fn() });
    const listener = vi.fn();
    manager.onStatus(listener);
    manager.apply(DEFAULT_SHORTCUTS);
    expect(listener).toHaveBeenCalledTimes(1);
    manager.dispose();
    expect(held.size).toBe(0);
    expect(manager.heldAccelerators).toEqual([]);
  });

  it('handles a whole map of nulls', () => {
    const { api, held } = fakeApi();
    const none = Object.fromEntries(SHORTCUT_ACTIONS.map((a) => [a, null])) as ShortcutsMap;
    const states = new ShortcutManager({ api, run: vi.fn() }).apply(none);
    expect(held.size).toBe(0);
    expect(SHORTCUT_ACTIONS.every((action) => states[action].status === 'disabled')).toBe(true);
  });
});
