import { describe, expect, it } from 'vitest';
import {
  DEFAULT_RECORD_OPTIONS,
  EngineCommandSchema,
  RecordOptionsSchema,
} from '../../src/shared/recorder-ipc';
import {
  applyPatch,
  DEFAULT_SETTINGS,
  parseSettings,
  patchFromRecordOptions,
  recordOptionsFromSettings,
  SettingsPatchSchema,
} from '../../src/shared/settings';

describe('follow mouse: recorder-ipc', () => {
  it('the cursor command is bounded to 0..1', () => {
    expect(EngineCommandSchema.safeParse({ cmd: 'cursor', nx: 0, ny: 1 }).success).toBe(true);
    expect(EngineCommandSchema.safeParse({ cmd: 'cursor', nx: 0.4, ny: 0.6 }).success).toBe(true);
    for (const bad of [
      { cmd: 'cursor', nx: -0.1, ny: 0.5 },
      { cmd: 'cursor', nx: 0.5, ny: 1.01 },
      { cmd: 'cursor', nx: Number.NaN, ny: 0.5 },
      { cmd: 'cursor', nx: '0.5', ny: 0.5 },
      { cmd: 'cursor', nx: 0.5 },
    ]) {
      expect(EngineCommandSchema.safeParse(bad).success, JSON.stringify(bad)).toBe(false);
    }
  });

  it('record options parse with and without follow (an old manifest has none)', () => {
    expect(RecordOptionsSchema.safeParse(DEFAULT_RECORD_OPTIONS).success).toBe(true);
    for (const zoom of [1.5, 2, 3]) {
      expect(
        RecordOptionsSchema.safeParse({ ...DEFAULT_RECORD_OPTIONS, follow: { zoom } }).success,
      ).toBe(true);
    }
    for (const bad of [{ zoom: 4 }, { zoom: 2, extra: 1 }, {}, 2]) {
      expect(
        RecordOptionsSchema.safeParse({ ...DEFAULT_RECORD_OPTIONS, follow: bad }).success,
        JSON.stringify(bad),
      ).toBe(false);
    }
  });
});

describe('follow mouse: settings', () => {
  it('defaults to off, maps to the follow record option and back', () => {
    expect(DEFAULT_SETTINGS.recording.followMouseZoom).toBe('off');
    const on = applyPatch(DEFAULT_SETTINGS, { recording: { followMouseZoom: '2' } });
    expect(recordOptionsFromSettings(on.recording).follow).toEqual({ zoom: 2 });
    const off = applyPatch(
      on,
      patchFromRecordOptions(recordOptionsFromSettings(DEFAULT_SETTINGS.recording)),
    );
    expect(off.recording.followMouseZoom).toBe('off');
    const fromOptions = applyPatch(
      DEFAULT_SETTINGS,
      patchFromRecordOptions({ ...DEFAULT_RECORD_OPTIONS, follow: { zoom: 1.5 } }),
    );
    expect(fromOptions.recording.followMouseZoom).toBe('1.5');
  });

  it('a settings file from before the option loads with the default; a bad value is refused', () => {
    const { followMouseZoom: _gone, ...older } = DEFAULT_SETTINGS.recording;
    const parsed = parseSettings({ ...DEFAULT_SETTINGS, recording: older });
    expect(parsed.ok && parsed.settings.recording.followMouseZoom).toBe('off');
    expect(
      parseSettings({ ...DEFAULT_SETTINGS, recording: { ...older, followMouseZoom: '4' } }).ok,
    ).toBe(false);
    expect(SettingsPatchSchema.safeParse({ recording: { followMouseZoom: '3' } }).success).toBe(
      true,
    );
    expect(SettingsPatchSchema.safeParse({ recording: { followMouseZoom: 3 } }).success).toBe(
      false,
    );
  });
});
