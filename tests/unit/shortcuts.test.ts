import { describe, expect, it } from 'vitest';
import {
  DEFAULT_SHORTCUTS,
  SHORTCUT_ACTIONS,
  acceleratorFromKeyEvent,
  actionUsing,
  checkAccelerator,
  checkShortcuts,
  type KeyEventLike,
  type ShortcutsMap,
} from '../../src/shared/shortcuts';

const key = (code: string, mods: Partial<KeyEventLike> = {}): KeyEventLike => ({
  code,
  key: '',
  ctrlKey: false,
  altKey: false,
  shiftKey: false,
  metaKey: false,
  ...mods,
});

describe('checkAccelerator', () => {
  it('normalizes names, case and modifier order', () => {
    expect(checkAccelerator('shift+ctrl+a')).toEqual({ ok: true, accelerator: 'Ctrl+Shift+A' });
    expect(checkAccelerator('Control+Alt+f5')).toEqual({ ok: true, accelerator: 'Ctrl+Alt+F5' });
    expect(checkAccelerator('CommandOrControl+Shift+1')).toEqual({
      ok: true,
      accelerator: 'Ctrl+Shift+1',
    });
    expect(checkAccelerator('ctrl+return')).toEqual({ ok: true, accelerator: 'Ctrl+Enter' });
    expect(checkAccelerator('Alt+Up')).toEqual({ ok: true, accelerator: 'Alt+Up' });
  });

  it('requires Ctrl or Alt unless the key is an F-key or PrintScreen', () => {
    expect(checkAccelerator('A').ok).toBe(false);
    expect(checkAccelerator('Shift+A').ok).toBe(false);
    expect(checkAccelerator('1').ok).toBe(false);
    expect(checkAccelerator('Escape').ok).toBe(false);
    expect(checkAccelerator('F9')).toEqual({ ok: true, accelerator: 'F9' });
    expect(checkAccelerator('F24')).toEqual({ ok: true, accelerator: 'F24' });
    expect(checkAccelerator('PrintScreen')).toEqual({ ok: true, accelerator: 'PrintScreen' });
    expect(checkAccelerator('Shift+F9')).toEqual({ ok: true, accelerator: 'Shift+F9' });
    expect(checkAccelerator('Alt+A')).toEqual({ ok: true, accelerator: 'Alt+A' });
  });

  it('rejects malformed, unknown and multi-key strings', () => {
    for (const bad of [
      '',
      '+',
      'Ctrl+',
      'Ctrl++',
      'Ctrl+Shift',
      'Ctrl+A+B',
      'Ctrl+Banana',
      'F25',
    ]) {
      expect(checkAccelerator(bad).ok, bad).toBe(false);
    }
    // The Windows key is not offered.
    expect(checkAccelerator('Super+A').ok).toBe(false);
    expect(checkAccelerator('Meta+A').ok).toBe(false);
  });

  it('gives a reason a user can act on', () => {
    expect(checkAccelerator('A')).toMatchObject({
      ok: false,
      reason: expect.stringContaining('Ctrl or Alt'),
    });
    expect(checkAccelerator('Ctrl+Shift')).toMatchObject({
      ok: false,
      reason: expect.stringContaining('key'),
    });
  });
});

describe('acceleratorFromKeyEvent', () => {
  it('returns null while only modifiers are down', () => {
    expect(acceleratorFromKeyEvent(key('ControlLeft', { ctrlKey: true }))).toBeNull();
    expect(acceleratorFromKeyEvent(key('ShiftRight', { shiftKey: true }))).toBeNull();
    expect(acceleratorFromKeyEvent(key('AltLeft', { altKey: true }))).toBeNull();
  });

  it('uses the physical key, so Shift+1 is "1" and not "!"', () => {
    expect(
      acceleratorFromKeyEvent(key('Digit1', { key: '!', ctrlKey: true, shiftKey: true })),
    ).toEqual({ ok: true, accelerator: 'Ctrl+Shift+1' });
    expect(acceleratorFromKeyEvent(key('KeyR', { ctrlKey: true, altKey: true }))).toEqual({
      ok: true,
      accelerator: 'Ctrl+Alt+R',
    });
    expect(acceleratorFromKeyEvent(key('F9'))).toEqual({ ok: true, accelerator: 'F9' });
    expect(acceleratorFromKeyEvent(key('PrintScreen'))).toEqual({
      ok: true,
      accelerator: 'PrintScreen',
    });
    expect(acceleratorFromKeyEvent(key('ArrowUp', { ctrlKey: true }))).toEqual({
      ok: true,
      accelerator: 'Ctrl+Up',
    });
    expect(acceleratorFromKeyEvent(key('Backquote', { ctrlKey: true }))).toEqual({
      ok: true,
      accelerator: 'Ctrl+`',
    });
  });

  it('explains a key without a modifier and refuses the Windows key and unknown keys', () => {
    const plain = acceleratorFromKeyEvent(key('KeyA'));
    expect(plain).toMatchObject({ ok: false });
    expect(acceleratorFromKeyEvent(key('KeyA', { ctrlKey: true, metaKey: true }))).toMatchObject({
      ok: false,
    });
    expect(acceleratorFromKeyEvent(key('NumpadAdd', { ctrlKey: true }))).toMatchObject({
      ok: false,
    });
  });
});

describe('shortcut sets', () => {
  it('the defaults are valid, canonical and unique', () => {
    expect(checkShortcuts(DEFAULT_SHORTCUTS)).toEqual({ ok: true });
    for (const action of SHORTCUT_ACTIONS) {
      expect(checkAccelerator(DEFAULT_SHORTCUTS[action])).toEqual({
        ok: true,
        accelerator: DEFAULT_SHORTCUTS[action],
      });
    }
    expect(DEFAULT_SHORTCUTS.screenshotRegion).toBe('Ctrl+Shift+3');
    // PrintScreen is the Snipping Tool's: never a default.
    expect(Object.values(DEFAULT_SHORTCUTS)).not.toContain('PrintScreen');
  });

  it('refuses two actions on one accelerator, however it is spelled', () => {
    const shortcuts: ShortcutsMap = { ...DEFAULT_SHORTCUTS, recordRegion: 'shift+control+3' };
    const result = checkShortcuts(shortcuts);
    expect(result).toMatchObject({ ok: false, action: 'recordRegion' });
    expect(JSON.stringify(result)).toContain('Screenshot: region');
  });

  it('refuses an invalid accelerator and allows disabled (null) entries', () => {
    expect(checkShortcuts({ ...DEFAULT_SHORTCUTS, stopRecording: 'A' })).toMatchObject({
      ok: false,
      action: 'stopRecording',
    });
    const allOff = Object.fromEntries(SHORTCUT_ACTIONS.map((a) => [a, null])) as ShortcutsMap;
    expect(checkShortcuts(allOff)).toEqual({ ok: true });
  });

  it('actionUsing finds the holder and ignores the action being edited', () => {
    expect(actionUsing(DEFAULT_SHORTCUTS, 'ctrl+shift+1')).toBe('screenshotScreen');
    expect(actionUsing(DEFAULT_SHORTCUTS, 'Ctrl+Shift+1', 'screenshotScreen')).toBeNull();
    expect(actionUsing(DEFAULT_SHORTCUTS, 'Ctrl+Alt+Q')).toBeNull();
  });
});
