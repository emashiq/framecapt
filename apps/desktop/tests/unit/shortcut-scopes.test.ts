import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SettingsStore, SETTINGS_FILE } from '../../src/main/settings/store';
import { ShortcutManager, type GlobalShortcutApi } from '../../src/main/shortcuts';
import {
  DEFAULT_SETTINGS,
  SettingsPatchSchema,
  applyPatch,
  parseSettings,
  resetSection,
} from '../../src/shared/settings';
import {
  DEFAULT_EDITOR_SHORTCUTS,
  DEFAULT_SHORTCUTS,
  EDITOR_ACTIONS,
  EDITOR_LABELS,
  acceleratorFromKeyEvent,
  checkAccelerator,
  checkEditorShortcuts,
  crossScopeHolder,
  editorActionUsing,
  matchEditorAction,
  reservedCheck,
  type EditorShortcutsMap,
  type KeyEventLike,
} from '../../src/shared/shortcuts';

const key = (code: string, k: string, mods: Partial<KeyEventLike> = {}): KeyEventLike => ({
  code,
  key: k,
  ctrlKey: false,
  altKey: false,
  shiftKey: false,
  metaKey: false,
  ...mods,
});

describe('app scope (the editor)', () => {
  it('allows a bare key, and keeps the global rule for the global scope', () => {
    expect(checkAccelerator('V', 'app')).toEqual({ ok: true, accelerator: 'V' });
    expect(checkAccelerator('Shift+V', 'app')).toEqual({ ok: true, accelerator: 'Shift+V' });
    expect(checkAccelerator('5', 'app').ok).toBe(true);
    expect(checkAccelerator('V').ok).toBe(false);
    expect(checkAccelerator('V', 'global').ok).toBe(false);
  });

  it('refuses the keys the editor uses itself, with a reason', () => {
    for (const fixed of ['Escape', 'Enter', 'Delete', 'Backspace', 'Tab', 'Space', 'Left', 'Up']) {
      expect(checkAccelerator(fixed, 'app'), fixed).toMatchObject({
        ok: false,
        reason: expect.stringContaining('editor itself'),
      });
    }
  });

  it('records a bare key from a key event only in the app scope', () => {
    const event = key('KeyV', 'v');
    expect(acceleratorFromKeyEvent(event, 'app')).toEqual({ ok: true, accelerator: 'V' });
    expect(acceleratorFromKeyEvent(event)).toMatchObject({ ok: false });
  });

  it('the defaults are valid, unique and cover every action', () => {
    expect(Object.keys(DEFAULT_EDITOR_SHORTCUTS).sort()).toEqual([...EDITOR_ACTIONS].sort());
    expect(checkEditorShortcuts(DEFAULT_EDITOR_SHORTCUTS)).toEqual({ ok: true });
    for (const value of Object.values(DEFAULT_EDITOR_SHORTCUTS)) {
      expect(checkAccelerator(value, 'app')).toEqual({ ok: true, accelerator: value });
    }
  });

  it('checkEditorShortcuts names the duplicate', () => {
    const duplicate: EditorShortcutsMap = { ...DEFAULT_EDITOR_SHORTCUTS, toolCrop: 'V' };
    expect(checkEditorShortcuts(duplicate)).toEqual({
      ok: false,
      action: 'toolCrop',
      reason: `V is already used by “${EDITOR_LABELS.toolSelect}”.`,
    });
    // Off does not count as a duplicate.
    expect(
      checkEditorShortcuts({ ...DEFAULT_EDITOR_SHORTCUTS, toolCrop: null, toolArrow: null }),
    ).toEqual({ ok: true });
  });

  it('finds the editor action that holds a key (for the swap offer)', () => {
    expect(editorActionUsing(DEFAULT_EDITOR_SHORTCUTS, 'v')).toBe('toolSelect');
    expect(editorActionUsing(DEFAULT_EDITOR_SHORTCUTS, 'V', 'toolSelect')).toBeNull();
    expect(editorActionUsing(DEFAULT_EDITOR_SHORTCUTS, 'ctrl+shift+z')).toBe('redo');
    expect(editorActionUsing(DEFAULT_EDITOR_SHORTCUTS, 'Q')).toBeNull();
  });

  it('a global shortcut and an editor key may not share a combination', () => {
    expect(
      crossScopeHolder('global', 'Ctrl+S', DEFAULT_SHORTCUTS, DEFAULT_EDITOR_SHORTCUTS),
    ).toContain(EDITOR_LABELS.save);
    expect(
      crossScopeHolder('app', 'Ctrl+Shift+3', DEFAULT_SHORTCUTS, DEFAULT_EDITOR_SHORTCUTS),
    ).toContain('Screenshot: region');
    expect(
      crossScopeHolder('app', 'Ctrl+Shift+Q', DEFAULT_SHORTCUTS, DEFAULT_EDITOR_SHORTCUTS),
    ).toBeNull();
  });
});

describe('matchEditorAction', () => {
  it('matches the defaults like the old hard-coded keys did', () => {
    const match = (e: KeyEventLike) => matchEditorAction(e, DEFAULT_EDITOR_SHORTCUTS);
    expect(match(key('KeyV', 'v'))).toBe('toolSelect');
    expect(match(key('KeyX', 'X'))).toBe('toolRedact');
    expect(match(key('KeyZ', 'z', { ctrlKey: true }))).toBe('undo');
    expect(match(key('KeyZ', 'Z', { ctrlKey: true, shiftKey: true }))).toBe('redo');
    expect(match(key('KeyS', 's', { ctrlKey: true }))).toBe('save');
    expect(match(key('KeyC', 'c', { ctrlKey: true }))).toBe('copy');
    expect(match(key('Equal', '=', { ctrlKey: true }))).toBe('zoomIn');
    expect(match(key('Equal', '+', { ctrlKey: true, shiftKey: true }))).toBe('zoomIn');
    expect(match(key('Minus', '-', { ctrlKey: true }))).toBe('zoomOut');
    expect(match(key('Digit0', '0', { ctrlKey: true }))).toBe('zoomFit');
    expect(match(key('Digit1', '1', { ctrlKey: true }))).toBe('zoomActual');
  });

  it('does not fire for a modified tool key, an unbound key or a fixed key', () => {
    const match = (e: KeyEventLike) => matchEditorAction(e, DEFAULT_EDITOR_SHORTCUTS);
    expect(match(key('KeyV', 'V', { shiftKey: true }))).toBeNull();
    expect(match(key('KeyV', 'v', { altKey: true }))).toBeNull();
    expect(match(key('KeyQ', 'q'))).toBeNull();
    expect(match(key('Escape', 'Escape'))).toBeNull();
    expect(match(key('Delete', 'Delete'))).toBeNull();
    expect(match(key('ControlLeft', 'Control', { ctrlKey: true }))).toBeNull();
  });

  it('follows a rebinding: the new key works, the old one no longer does', () => {
    const rebound: EditorShortcutsMap = { ...DEFAULT_EDITOR_SHORTCUTS, toolArrow: 'W', undo: 'U' };
    expect(matchEditorAction(key('KeyW', 'w'), rebound)).toBe('toolArrow');
    expect(matchEditorAction(key('KeyA', 'a'), rebound)).toBeNull();
    expect(matchEditorAction(key('KeyU', 'u'), rebound)).toBe('undo');
    expect(matchEditorAction(key('KeyZ', 'z', { ctrlKey: true }), rebound)).toBeNull();
  });

  it('a turned-off action never matches', () => {
    const off: EditorShortcutsMap = { ...DEFAULT_EDITOR_SHORTCUTS, toolText: null };
    expect(matchEditorAction(key('KeyT', 't'), off)).toBeNull();
  });

  it('reads the layout key as well as the physical key (AZERTY: the A key types "q")', () => {
    // Physical KeyQ typing "a": the tool bound to the letter A still answers.
    expect(matchEditorAction(key('KeyQ', 'a'), DEFAULT_EDITOR_SHORTCUTS)).toBe('toolArrow');
  });
});

describe('reservedCheck', () => {
  it('blocks what Windows keeps, with a reason', () => {
    for (const reserved of [
      'Ctrl+Alt+Delete',
      'Alt+F4',
      'Alt+Tab',
      'Ctrl+Escape',
      'Ctrl+Shift+Escape',
      'F12',
    ]) {
      expect(reservedCheck(reserved, 'win32'), reserved).toMatchObject({
        level: 'blocked',
        reason: expect.any(String),
      });
    }
    expect(reservedCheck('F12', 'win32')?.reason).toContain('debugger');
  });

  it('warns, but allows, Print Screen', () => {
    expect(reservedCheck('PrintScreen', 'win32')).toMatchObject({
      level: 'warning',
      reason: expect.stringContaining('Snipping Tool'),
    });
    expect(reservedCheck('Ctrl+PrintScreen', 'linux')?.level).toBe('warning');
  });

  it('blocks the common Linux desktop defaults', () => {
    for (const reserved of [
      'Ctrl+Alt+T',
      'Ctrl+Alt+L',
      'Ctrl+Alt+Delete',
      'Alt+Tab',
      'Ctrl+Alt+F2',
    ]) {
      expect(reservedCheck(reserved, 'linux'), reserved).toMatchObject({ level: 'blocked' });
    }
    // F12 is a Windows debugger rule only.
    expect(reservedCheck('F12', 'linux')).toBeNull();
  });

  it('blocks the editing keys everywhere', () => {
    for (const platform of ['win32', 'linux', 'darwin']) {
      expect(reservedCheck('Ctrl+C', platform)?.level).toBe('blocked');
      expect(reservedCheck('Ctrl+V', platform)?.level).toBe('blocked');
    }
  });

  it('leaves the defaults and ordinary combinations alone', () => {
    for (const platform of ['win32', 'linux']) {
      for (const accelerator of [
        ...Object.values(DEFAULT_SHORTCUTS).filter((key) => key !== null),
        'Ctrl+Alt+Q',
        'F9',
      ]) {
        expect(reservedCheck(accelerator, platform), `${accelerator} on ${platform}`).toBeNull();
      }
    }
    expect(reservedCheck('Alt+F4', 'darwin')).toBeNull();
  });
});

describe('the manager and reserved combinations', () => {
  function fakeApi() {
    const registered: string[] = [];
    const api: GlobalShortcutApi = {
      register: (accelerator) => {
        registered.push(accelerator);
        return true;
      },
      unregister: () => undefined,
    };
    return { api, registered };
  }

  it('reports a reserved combination without asking the OS to register it', () => {
    const { api, registered } = fakeApi();
    const manager = new ShortcutManager({ api, run: () => undefined, platform: 'win32' });
    const states = manager.apply({ ...DEFAULT_SHORTCUTS, recordRegion: 'Alt+F4' });
    expect(states.recordRegion).toMatchObject({
      accelerator: 'Alt+F4',
      status: 'invalid',
      message: expect.stringContaining('Alt+F4'),
    });
    expect(registered).not.toContain('Alt+F4');
    expect(states.screenshotRegion.status).toBe('ok');
  });

  it('the same combination is fine on a platform that does not reserve it', () => {
    const { api, registered } = fakeApi();
    const manager = new ShortcutManager({ api, run: () => undefined, platform: 'linux' });
    manager.apply({ ...DEFAULT_SHORTCUTS, recordRegion: 'F12' });
    expect(registered).toContain('F12');
  });
});

describe('editor shortcuts in the settings', () => {
  it('have defaults, and the defaults are what a new file holds', () => {
    expect(DEFAULT_SETTINGS.editorShortcuts).toEqual(DEFAULT_EDITOR_SHORTCUTS);
  });

  it('a file written before they existed loads unchanged, with the defaults filled in', () => {
    const before = {
      version: 1,
      general: { theme: 'dark' },
      shortcuts: { recordRegion: 'Ctrl+Alt+Q' },
      notices: { trayHintShown: true, homeTipDismissed: true },
    };
    const parsed = parseSettings(before);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.settings.general.theme).toBe('dark');
    expect(parsed.settings.shortcuts.recordRegion).toBe('Ctrl+Alt+Q');
    expect(parsed.settings.notices).toEqual({
      trayHintShown: true,
      homeTipDismissed: true,
      onboardingDismissed: false,
      editableNoticeShown: false,
    });
    expect(parsed.settings.editorShortcuts).toEqual(DEFAULT_EDITOR_SHORTCUTS);
  });

  it('the unversioned layout migrates and gets them too', () => {
    const parsed = parseSettings({ theme: 'light' });
    expect(parsed.ok && parsed.settings.editorShortcuts).toEqual(DEFAULT_EDITOR_SHORTCUTS);
  });

  it('a partial section keeps what was set and defaults the rest', () => {
    const parsed = parseSettings({ version: 1, editorShortcuts: { toolArrow: 'W', undo: null } });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.settings.editorShortcuts.toolArrow).toBe('W');
    expect(parsed.settings.editorShortcuts.undo).toBeNull();
    expect(parsed.settings.editorShortcuts.toolSelect).toBe('V');
  });

  it('a file with a duplicate or an unusable editor key is not accepted', () => {
    expect(parseSettings({ version: 1, editorShortcuts: { toolCrop: 'V' } }).ok).toBe(false);
    expect(parseSettings({ version: 1, editorShortcuts: { toolCrop: 'Escape' } }).ok).toBe(false);
    expect(parseSettings({ version: 1, editorShortcuts: { toolCrop: 'Ctrl+' } }).ok).toBe(false);
  });

  it('a patch changes one editor key, and a typo in the name is refused', () => {
    const next = applyPatch(DEFAULT_SETTINGS, { editorShortcuts: { toolRect: 'B' } });
    expect(next.editorShortcuts.toolRect).toBe('B');
    expect(next.editorShortcuts.toolSelect).toBe('V');
    expect(SettingsPatchSchema.safeParse({ editorShortcuts: { toolRectangle: 'B' } }).success).toBe(
      false,
    );
    expect(SettingsPatchSchema.safeParse({ editorShortcuts: {} }).success).toBe(true);
  });

  it('"Reset all shortcuts" puts back both the global and the editor keys', () => {
    const custom = applyPatch(DEFAULT_SETTINGS, {
      shortcuts: { recordScreen: 'Ctrl+Alt+Q' },
      editorShortcuts: { toolArrow: 'W' },
    });
    const reset = resetSection(custom, 'shortcuts');
    expect(reset.shortcuts).toEqual(DEFAULT_SHORTCUTS);
    expect(reset.editorShortcuts).toEqual(DEFAULT_EDITOR_SHORTCUTS);
    // Another section's reset leaves them.
    expect(resetSection(custom, 'general').editorShortcuts.toolArrow).toBe('W');
  });
});

describe('the store and swapping', () => {
  let dir: string;
  let file: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'framecapt-shortcut-scopes-'));
    file = path.join(dir, SETTINGS_FILE);
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  it('swaps two global shortcuts in one update', () => {
    const store = new SettingsStore(file);
    store.update({
      shortcuts: { screenshotScreen: 'Ctrl+Shift+3', screenshotRegion: 'Ctrl+Shift+1' },
    });
    expect(store.get().shortcuts.screenshotScreen).toBe('Ctrl+Shift+3');
    expect(store.get().shortcuts.screenshotRegion).toBe('Ctrl+Shift+1');
  });

  it('the same two changes one after the other would collide: the swap must be one update', () => {
    const store = new SettingsStore(file);
    expect(() => store.update({ shortcuts: { screenshotScreen: 'Ctrl+Shift+3' } })).toThrow(
      /already used/,
    );
    expect(store.get().shortcuts.screenshotScreen).toBe('Ctrl+Shift+1');
  });

  it('swaps two editor keys in one update and refuses a duplicate', () => {
    const store = new SettingsStore(file);
    store.update({ editorShortcuts: { toolSelect: 'C', toolCrop: 'V' } });
    expect(store.get().editorShortcuts.toolSelect).toBe('C');
    expect(store.get().editorShortcuts.toolCrop).toBe('V');
    expect(() => store.update({ editorShortcuts: { toolArrow: 'V' } })).toThrow(/already used/);
    expect(store.get().editorShortcuts.toolArrow).toBe('A');
  });

  it('stores editor keys in canonical form and refuses a fixed key', () => {
    const store = new SettingsStore(file);
    store.update({ editorShortcuts: { save: 'shift+ctrl+j' } });
    expect(store.get().editorShortcuts.save).toBe('Ctrl+Shift+J');
    expect(() => store.update({ editorShortcuts: { toolText: 'Escape' } })).toThrow();
  });
});
