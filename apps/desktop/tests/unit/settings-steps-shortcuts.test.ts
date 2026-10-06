import { describe, expect, it } from 'vitest';
import {
  DEFAULT_SETTINGS,
  parseSettings,
  SettingsPatchSchema,
  type Settings,
} from '../../src/shared/settings';
import {
  actionUsing,
  checkShortcuts,
  DEFAULT_SHORTCUTS,
  SHORTCUT_ACTIONS,
  SHORTCUT_LABELS,
  type ShortcutsMap,
} from '../../src/shared/shortcuts';
import { ShortcutValidateRequestSchema } from '../../src/shared/settings-ipc';

/** A settings file as an older build wrote it: no step shortcuts at all. */
function oldFile(shortcuts: Partial<ShortcutsMap> = {}): Record<string, unknown> {
  const copy = JSON.parse(JSON.stringify(DEFAULT_SETTINGS)) as Settings;
  const old: Record<string, unknown> = { ...copy.shortcuts, ...shortcuts };
  delete old.stepsToggle;
  delete old.stepsCapture;
  return { ...copy, shortcuts: old };
}

describe('step guide shortcuts', () => {
  it('are two global actions with labels and defaults', () => {
    expect(SHORTCUT_ACTIONS).toContain('stepsToggle');
    expect(SHORTCUT_ACTIONS).toContain('stepsCapture');
    expect(SHORTCUT_LABELS.stepsToggle).toMatch(/step/i);
    expect(SHORTCUT_LABELS.stepsCapture).toMatch(/step/i);
    expect(DEFAULT_SHORTCUTS.stepsToggle).toBe('Ctrl+Shift+8');
    // No comfortable key is free for "Capture a step": it starts unset.
    expect(DEFAULT_SHORTCUTS.stepsCapture).toBeNull();
  });

  it('the Steps default collides with no other default (including Ctrl+Shift+4, all screens)', () => {
    expect(DEFAULT_SHORTCUTS.screenshotAllScreens).toBe('Ctrl+Shift+4');
    expect(checkShortcuts(DEFAULT_SHORTCUTS)).toEqual({ ok: true });
    expect(actionUsing(DEFAULT_SHORTCUTS, 'Ctrl+Shift+8', 'stepsToggle')).toBeNull();
  });

  it('an old settings file loads, getting the Steps default and no key for Capture a step', () => {
    const parsed = parseSettings(oldFile());
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.settings.shortcuts.stepsToggle).toBe('Ctrl+Shift+8');
    expect(parsed.settings.shortcuts.stepsCapture).toBeNull();
    expect(parsed.settings.shortcuts.screenshotRegion).toBe('Ctrl+Shift+3');
  });

  it('an old file whose user already bound Ctrl+Shift+8 keeps that binding; the new action starts unset', () => {
    const parsed = parseSettings(oldFile({ recordScreen: 'Ctrl+Shift+8' }));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.settings.shortcuts.recordScreen).toBe('Ctrl+Shift+8');
    expect(parsed.settings.shortcuts.stepsToggle).toBeNull();
  });

  it('a file that already has the keys keeps what the user chose', () => {
    const base = oldFile();
    (base.shortcuts as Record<string, unknown>).stepsToggle = null;
    (base.shortcuts as Record<string, unknown>).stepsCapture = 'Ctrl+Alt+K';
    const parsed = parseSettings(base);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.settings.shortcuts.stepsToggle).toBeNull();
    expect(parsed.settings.shortcuts.stepsCapture).toBe('Ctrl+Alt+K');
  });

  it('two actions on one key still make the file invalid', () => {
    const base = oldFile();
    (base.shortcuts as Record<string, unknown>).stepsToggle = 'Ctrl+Shift+3';
    expect(parseSettings(base).ok).toBe(false);
  });

  it('can be changed with a settings patch and checked with shortcuts:validate', () => {
    expect(
      SettingsPatchSchema.safeParse({
        shortcuts: { stepsToggle: 'Ctrl+Alt+S', stepsCapture: null },
      }).success,
    ).toBe(true);
    expect(SettingsPatchSchema.safeParse({ shortcuts: { stepsNope: 'Ctrl+Alt+S' } }).success).toBe(
      false,
    );
    expect(
      ShortcutValidateRequestSchema.safeParse({ action: 'stepsCapture', accelerator: 'Ctrl+Alt+K' })
        .success,
    ).toBe(true);
  });

  it('the new defaults are part of DEFAULT_SETTINGS', () => {
    expect(DEFAULT_SETTINGS.shortcuts).toEqual(DEFAULT_SHORTCUTS);
  });
});
