import { describe, expect, it } from 'vitest';
import {
  DEFAULT_SETTINGS,
  SettingsPatchSchema,
  applyPatch,
  migrateSettings,
  parseSettings,
  patchFromRecordOptions,
  recordOptionsFromSettings,
  resetSection,
} from '../../src/shared/settings';
import { DEFAULT_RECORD_OPTIONS } from '../../src/shared/recorder-ipc';
import { DEFAULT_SHORTCUTS } from '../../src/shared/shortcuts';

/** The unversioned flat layout the migration scaffold understands (no such file was ever shipped). */
const V0_FIXTURE = {
  theme: 'dark',
  closeToTray: false,
  screenshotFormat: 'jpeg',
  jpegQuality: 0.8,
  screenshotDir: 'D:\\Shots',
  recordingDir: 'D:\\Clips',
  quality: 'source',
  fps: 60,
  micDeviceId: 'abc123',
  systemAudio: true,
  shortcuts: { screenshotRegion: 'Ctrl+Alt+R' },
};

describe('defaults', () => {
  it('match the brief', () => {
    expect(DEFAULT_SETTINGS.version).toBe(1);
    expect(DEFAULT_SETTINGS.general).toEqual({
      theme: 'system',
      launchAtLogin: false,
      closeToTray: true,
      showNotifications: true,
    });
    expect(DEFAULT_SETTINGS.screenshots).toMatchObject({
      format: 'png',
      jpegQuality: 0.92,
      outputDir: null,
      afterCapture: 'editor',
      copyToClipboardOnSave: false,
      keepEditableOriginals: true,
    });
    expect(DEFAULT_SETTINGS.recording).toMatchObject({
      quality: '1080p',
      fps: 30,
      countdown: true,
      micEnabled: false,
      systemAudio: false,
      outputDir: null,
      autoExportMp4: false,
      storage: 'original',
    });
    expect(DEFAULT_SETTINGS.shortcuts).toEqual(DEFAULT_SHORTCUTS);
  });

  it('a settings file written before Keep editable originals existed loads with it on', () => {
    const parsed = parseSettings({ version: 1, screenshots: { format: 'jpeg' } });
    expect(parsed.ok && parsed.settings.screenshots).toMatchObject({
      format: 'jpeg',
      keepEditableOriginals: true,
    });
  });

  it('an empty object parses to the defaults', () => {
    expect(parseSettings({ version: 1 })).toEqual({ ok: true, settings: DEFAULT_SETTINGS });
  });

  it('fills in a section that is only partly there (an older v1 file)', () => {
    const parsed = parseSettings({ version: 1, general: { theme: 'light' } });
    expect(parsed.ok && parsed.settings.general).toEqual({
      ...DEFAULT_SETTINGS.general,
      theme: 'light',
    });
  });

  it('drops unknown keys', () => {
    const parsed = parseSettings({ version: 1, general: { theme: 'light', bogus: 1 }, extra: 2 });
    expect(parsed.ok && 'extra' in parsed.settings).toBe(false);
    expect(parsed.ok && 'bogus' in parsed.settings.general).toBe(false);
  });
});

describe('validation', () => {
  it.each([
    ['bad theme', { version: 1, general: { theme: 'neon' } }],
    ['bad fps', { version: 1, recording: { fps: 24 } }],
    ['jpeg quality out of range', { version: 1, screenshots: { jpegQuality: 2 } }],
    ['bad accelerator', { version: 1, shortcuts: { stopRecording: 'A' } }],
    ['duplicate accelerators', { version: 1, shortcuts: { stopRecording: 'Ctrl+Shift+1' } }],
    ['a newer version', { version: 2 }],
    ['not an object', 'text'],
    ['an array', []],
  ])('rejects %s', (_name, raw) => {
    expect(parseSettings(raw).ok).toBe(false);
  });
});

describe('migration v0 -> v1', () => {
  it('upgrades the flat layout with a fixture', () => {
    const migrated = migrateSettings(V0_FIXTURE) as { version: number };
    expect(migrated.version).toBe(1);
    const parsed = parseSettings(V0_FIXTURE);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.settings.general).toMatchObject({ theme: 'dark', closeToTray: false });
    expect(parsed.settings.screenshots).toMatchObject({
      format: 'jpeg',
      jpegQuality: 0.8,
      outputDir: 'D:\\Shots',
    });
    expect(parsed.settings.recording).toMatchObject({
      quality: 'source',
      fps: 60,
      micDeviceId: 'abc123',
      systemAudio: true,
      outputDir: 'D:\\Clips',
    });
    expect(parsed.settings.shortcuts.screenshotRegion).toBe('Ctrl+Alt+R');
    // What the fixture did not have comes from the defaults.
    expect(parsed.settings.shortcuts.recordRegion).toBe(DEFAULT_SHORTCUTS.recordRegion);
    expect(parsed.settings.general.showNotifications).toBe(true);
  });

  it('leaves a current file alone and an unversioned empty file becomes the defaults', () => {
    expect(migrateSettings({ version: 1, a: 1 })).toEqual({ version: 1, a: 1 });
    expect(parseSettings({})).toEqual({ ok: true, settings: DEFAULT_SETTINGS });
  });
});

describe('patches', () => {
  it('applies a one-level-deep change without touching the rest', () => {
    const next = applyPatch(DEFAULT_SETTINGS, {
      general: { theme: 'dark' },
      recording: { fps: 60 },
    });
    expect(next.general).toEqual({ ...DEFAULT_SETTINGS.general, theme: 'dark' });
    expect(next.recording.fps).toBe(60);
    expect(next.recording.quality).toBe('1080p');
    expect(DEFAULT_SETTINGS.general.theme).toBe('system');
  });

  it('micDeviceId: null clears the device', () => {
    const withDevice = applyPatch(DEFAULT_SETTINGS, { recording: { micDeviceId: 'x' } });
    expect(withDevice.recording.micDeviceId).toBe('x');
    const cleared = applyPatch(withDevice, { recording: { micDeviceId: null } });
    expect('micDeviceId' in cleared.recording).toBe(false);
  });

  it('the patch schema has no output folder and rejects unknown values', () => {
    // An output folder in a patch is an unknown key: rejected, never applied.
    expect(SettingsPatchSchema.safeParse({ screenshots: { outputDir: 'C:\\x' } }).success).toBe(
      false,
    );
    expect(SettingsPatchSchema.safeParse({ general: { theme: 'x' } }).success).toBe(false);
    expect(SettingsPatchSchema.safeParse({ recording: { fps: 61 } }).success).toBe(false);
    // A partial patch must not fill in defaults.
    expect(SettingsPatchSchema.parse({ general: {} })).toEqual({ general: {} });
  });

  it('resets one section, keeping the others and the folders of screenshots/recording', () => {
    const custom = applyPatch(DEFAULT_SETTINGS, {
      general: { theme: 'dark' },
      recording: { fps: 60 },
      shortcuts: { recordScreen: 'Ctrl+Alt+Q' },
    });
    custom.recording.outputDir = 'D:\\Clips';
    const general = resetSection(custom, 'general');
    expect(general.general).toEqual(DEFAULT_SETTINGS.general);
    expect(general.recording.fps).toBe(60);
    const recording = resetSection(custom, 'recording');
    expect(recording.recording.fps).toBe(30);
    expect(recording.recording.outputDir).toBe('D:\\Clips');
    expect(resetSection(custom, 'shortcuts').shortcuts).toEqual(DEFAULT_SHORTCUTS);
    expect(resetSection(custom, 'storage').recording.outputDir).toBeNull();
  });

  it('a full reset keeps the one-time notices', () => {
    const seen = applyPatch(DEFAULT_SETTINGS, { notices: { homeTipDismissed: true } });
    expect(resetSection(seen, undefined).notices.homeTipDismissed).toBe(true);
  });
});

describe('record options', () => {
  it('maps the recording settings to what the recorder takes', () => {
    expect(recordOptionsFromSettings(DEFAULT_SETTINGS.recording)).toEqual(DEFAULT_RECORD_OPTIONS);
    const custom = applyPatch(DEFAULT_SETTINGS, {
      recording: { micEnabled: true, micDeviceId: 'dev', systemAudio: true, quality: 'source' },
    });
    expect(recordOptionsFromSettings(custom.recording)).toMatchObject({
      mic: { enabled: true, deviceId: 'dev' },
      systemAudio: true,
      quality: 'source',
    });
  });

  it('storage defaults to original, patches to compressed and reaches the recorder as an optional flag', () => {
    expect(DEFAULT_SETTINGS.recording.storage).toBe('original');
    const loaded = parseSettings({ version: 1, recording: { fps: 60 } });
    expect(loaded.ok && loaded.settings.recording.storage).toBe('original');
    const next = applyPatch(DEFAULT_SETTINGS, { recording: { storage: 'compressed' } });
    expect(next.recording.storage).toBe('compressed');
    expect(recordOptionsFromSettings(next.recording)).toMatchObject({ compressed: true });
    expect('compressed' in recordOptionsFromSettings(DEFAULT_SETTINGS.recording)).toBe(false);
    expect(SettingsPatchSchema.safeParse({ recording: { storage: 'zip' } }).success).toBe(false);
  });

  it('carries the phase-05 localStorage options over', () => {
    const patch = patchFromRecordOptions({
      mic: { enabled: true, deviceId: 'old-mic' },
      systemAudio: true,
      quality: 'source',
      fps: 60,
      countdown: false,
    });
    const next = applyPatch(DEFAULT_SETTINGS, patch);
    expect(next.recording).toMatchObject({
      micEnabled: true,
      micDeviceId: 'old-mic',
      systemAudio: true,
      quality: 'source',
      fps: 60,
      countdown: false,
    });
    expect(
      applyPatch(next, patchFromRecordOptions(DEFAULT_RECORD_OPTIONS)).recording.micDeviceId,
    ).toBeUndefined();
  });
});

describe('the quick save editor shortcut (added after version 1 shipped)', () => {
  it('a settings file from before it loads unchanged and gets the default key', () => {
    const { quickSave, ...olderEditorKeys } = DEFAULT_SETTINGS.editorShortcuts;
    expect(quickSave).toBe('Ctrl+Shift+S');
    const older = { ...structuredClone(DEFAULT_SETTINGS), editorShortcuts: olderEditorKeys };
    older.screenshots.format = 'jpeg';
    older.editorShortcuts.save = 'Ctrl+Alt+S' as never;
    const parsed = parseSettings(older);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.settings.editorShortcuts.quickSave).toBe('Ctrl+Shift+S');
    // Everything the user had stays as it was.
    expect(parsed.settings.screenshots.format).toBe('jpeg');
    expect(parsed.settings.editorShortcuts.save).toBe('Ctrl+Alt+S');
  });

  it('a file that has no editor shortcuts at all still loads', () => {
    const { editorShortcuts: _dropped, ...older } = structuredClone(DEFAULT_SETTINGS);
    void _dropped;
    expect(parseSettings(older).ok).toBe(true);
  });

  it('a user key that clashes with the new default keeps the user key and leaves quick save unbound', () => {
    const { quickSave: _quick, ...keys } = DEFAULT_SETTINGS.editorShortcuts;
    void _quick;
    const clashing = {
      ...structuredClone(DEFAULT_SETTINGS),
      editorShortcuts: { ...keys, toolText: 'Ctrl+Shift+S' },
    };
    const parsed = parseSettings(clashing);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.settings.editorShortcuts.toolText).toBe('Ctrl+Shift+S');
    expect(parsed.settings.editorShortcuts.quickSave).toBeNull();
  });

  it('a key the user cleared stays cleared', () => {
    const cleared = structuredClone(DEFAULT_SETTINGS);
    cleared.editorShortcuts.quickSave = null;
    const parsed = parseSettings(cleared);
    expect(parsed.ok && parsed.settings.editorShortcuts.quickSave).toBeNull();
  });
});
