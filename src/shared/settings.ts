import { z } from 'zod';
import type { RecordOptions } from './recorder-ipc';
import { DEFAULT_SHORTCUTS, checkShortcuts, type ShortcutsMap } from './shortcuts';

/** Current version of settings.json. Bump it and add a step to `migrateSettings` to change the shape. */
export const SETTINGS_VERSION = 1;

const AcceleratorOrNull = z.string().min(1).max(64).nullable();
const OutputDirSchema = z.string().min(1).max(1024).nullable();

export const GeneralSettingsSchema = z.object({
  theme: z.enum(['system', 'light', 'dark']),
  launchAtLogin: z.boolean(),
  closeToTray: z.boolean(),
  showNotifications: z.boolean(),
});

export const ScreenshotSettingsSchema = z.object({
  format: z.enum(['png', 'jpeg']),
  jpegQuality: z.number().min(0.5).max(1),
  /** Null = Pictures/Framelet. Set only through `settings:chooseOutputDir`. */
  outputDir: OutputDirSchema,
  afterCapture: z.enum(['editor', 'copy-and-editor', 'save-and-editor']),
  copyToClipboardOnSave: z.boolean(),
});

export const RecordingSettingsSchema = z.object({
  quality: z.enum(['1080p', 'source']),
  fps: z.union([z.literal(30), z.literal(60)]),
  countdown: z.boolean(),
  micEnabled: z.boolean(),
  /** Undefined = the default microphone. */
  micDeviceId: z.string().min(1).max(256).optional(),
  systemAudio: z.boolean(),
  /** Null = Videos/Framelet. Set only through `settings:chooseOutputDir`. */
  outputDir: OutputDirSchema,
  autoExportMp4: z.boolean(),
});

export const ShortcutSettingsSchema = z.object({
  screenshotScreen: AcceleratorOrNull,
  screenshotWindow: AcceleratorOrNull,
  screenshotRegion: AcceleratorOrNull,
  recordScreen: AcceleratorOrNull,
  recordWindow: AcceleratorOrNull,
  recordRegion: AcceleratorOrNull,
  stopRecording: AcceleratorOrNull,
  pauseRecording: AcceleratorOrNull,
});

/** One-time notices the user has already seen. */
export const NoticeSettingsSchema = z.object({
  trayHintShown: z.boolean(),
  homeTipDismissed: z.boolean(),
});

export const SettingsSchema = z.object({
  version: z.literal(SETTINGS_VERSION),
  general: GeneralSettingsSchema,
  screenshots: ScreenshotSettingsSchema,
  recording: RecordingSettingsSchema,
  shortcuts: ShortcutSettingsSchema,
  notices: NoticeSettingsSchema,
});
export type Settings = z.infer<typeof SettingsSchema>;
export type SettingsSection = Exclude<keyof Settings, 'version'>;

export const DEFAULT_SETTINGS: Settings = {
  version: SETTINGS_VERSION,
  general: { theme: 'system', launchAtLogin: false, closeToTray: true, showNotifications: true },
  screenshots: {
    format: 'png',
    jpegQuality: 0.92,
    outputDir: null,
    afterCapture: 'editor',
    copyToClipboardOnSave: false,
  },
  recording: {
    quality: '1080p',
    fps: 30,
    countdown: true,
    micEnabled: false,
    systemAudio: false,
    outputDir: null,
    autoExportMp4: false,
  },
  shortcuts: { ...DEFAULT_SHORTCUTS },
  notices: { trayHintShown: false, homeTipDismissed: false },
};

/**
 * A change request from the UI: any subset of the settings, one level deep. The output folders are
 * not part of it (they are chosen in a main-process dialog), nor are the one-time notices'
 * counterparts that main owns (`trayHintShown`).
 */
export const SettingsPatchSchema = z.strictObject({
  general: GeneralSettingsSchema.partial().strict().optional(),
  screenshots: ScreenshotSettingsSchema.omit({ outputDir: true }).partial().strict().optional(),
  recording: RecordingSettingsSchema.omit({ outputDir: true })
    .extend({ micDeviceId: z.string().min(1).max(256).nullable() })
    .partial()
    .strict()
    .optional(),
  shortcuts: ShortcutSettingsSchema.partial().strict().optional(),
  notices: NoticeSettingsSchema.omit({ trayHintShown: true }).partial().strict().optional(),
});
export type SettingsPatch = z.infer<typeof SettingsPatchSchema>;

/** The sections the user can reset from the UI. `storage` resets both output folders. */
export const ResetSectionSchema = z.enum([
  'general',
  'screenshots',
  'recording',
  'shortcuts',
  'storage',
]);
export type ResetSection = z.infer<typeof ResetSectionSchema>;

export const OutputTargetSchema = z.enum(['screenshots', 'recording']);
export type OutputTarget = z.infer<typeof OutputTargetSchema>;

// --- reading a file --------------------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Upgrades an older file to the current shape, one version at a time. Pure. `version` 0 is the
 * unversioned flat layout (a scaffold for the mechanism: no such file was ever shipped); a file
 * from a newer app is left as it is and fails validation (it is then set aside, not overwritten).
 */
export function migrateSettings(raw: unknown): unknown {
  if (!isRecord(raw)) return raw;
  let current: Record<string, unknown> = raw;
  const version = typeof current.version === 'number' ? current.version : 0;
  if (version === 0) current = migrateV0ToV1(current);
  return current;
}

function migrateV0ToV1(old: Record<string, unknown>): Record<string, unknown> {
  const pick = (
    source: Record<string, unknown>,
    keys: readonly string[],
  ): Record<string, unknown> =>
    Object.fromEntries(keys.filter((key) => key in source).map((key) => [key, source[key]]));
  return {
    version: 1,
    general: pick(old, ['theme', 'launchAtLogin', 'closeToTray']),
    screenshots: {
      ...(old.screenshotFormat !== undefined && { format: old.screenshotFormat }),
      ...(old.jpegQuality !== undefined && { jpegQuality: old.jpegQuality }),
      ...(old.screenshotDir !== undefined && { outputDir: old.screenshotDir }),
    },
    recording: {
      ...pick(old, ['quality', 'fps', 'countdown', 'micDeviceId', 'systemAudio']),
      ...(old.recordingDir !== undefined && { outputDir: old.recordingDir }),
    },
    shortcuts: isRecord(old.shortcuts) ? old.shortcuts : {},
  };
}

/** Section-wise merge of `partial` over the defaults (unknown keys are dropped by the schema). */
function withDefaults(partial: Record<string, unknown>): Record<string, unknown> {
  const merged: Record<string, unknown> = { version: partial.version };
  for (const section of ['general', 'screenshots', 'recording', 'shortcuts', 'notices'] as const) {
    const given = partial[section];
    merged[section] = {
      ...DEFAULT_SETTINGS[section],
      ...(isRecord(given) ? given : {}),
    };
  }
  return merged;
}

export type ParsedSettings = { ok: true; settings: Settings } | { ok: false; reason: string };

/**
 * Reads the parsed JSON of settings.json: migrate, fill in what is missing from the defaults,
 * validate (including "no two actions share a shortcut"). Anything wrong -> `ok: false`.
 */
export function parseSettings(raw: unknown): ParsedSettings {
  const migrated = migrateSettings(raw);
  if (!isRecord(migrated)) return { ok: false, reason: 'not an object' };
  const parsed = SettingsSchema.safeParse(withDefaults(migrated));
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    return { ok: false, reason: `${issue?.path.join('.') ?? ''}: ${issue?.message ?? 'invalid'}` };
  }
  const check = checkShortcuts(parsed.data.shortcuts as ShortcutsMap);
  if (!check.ok) return { ok: false, reason: `shortcuts.${check.action}: ${check.reason}` };
  return { ok: true, settings: parsed.data };
}

/** `current` with `patch` applied (one level deep). `micDeviceId: null` clears the device. */
export function applyPatch(current: Settings, patch: SettingsPatch): Settings {
  const next: Settings = structuredClone(current);
  for (const section of ['general', 'screenshots', 'recording', 'shortcuts', 'notices'] as const) {
    const changes = patch[section];
    if (!changes) continue;
    Object.assign(next[section], changes);
  }
  if ((patch.recording as { micDeviceId?: string | null } | undefined)?.micDeviceId === null) {
    delete next.recording.micDeviceId;
  }
  return next;
}

/** `settings` with one UI section back at its defaults. */
export function resetSection(current: Settings, section: ResetSection | undefined): Settings {
  const defaults = structuredClone(DEFAULT_SETTINGS);
  if (section === undefined) return { ...defaults, notices: current.notices };
  const next: Settings = structuredClone(current);
  switch (section) {
    case 'general':
      next.general = defaults.general;
      break;
    case 'screenshots':
      next.screenshots = { ...defaults.screenshots, outputDir: current.screenshots.outputDir };
      break;
    case 'recording':
      next.recording = { ...defaults.recording, outputDir: current.recording.outputDir };
      break;
    case 'shortcuts':
      next.shortcuts = defaults.shortcuts;
      break;
    case 'storage':
      next.screenshots.outputDir = null;
      next.recording.outputDir = null;
      break;
  }
  return next;
}

/** The record options the recorder takes, from the recording settings. */
export function recordOptionsFromSettings(recording: Settings['recording']): RecordOptions {
  return {
    mic: {
      enabled: recording.micEnabled,
      ...(recording.micDeviceId !== undefined && { deviceId: recording.micDeviceId }),
    },
    systemAudio: recording.systemAudio,
    quality: recording.quality,
    fps: recording.fps,
    countdown: recording.countdown,
  };
}

/** The settings patch that carries the phase-05 localStorage record options over (done once). */
export function patchFromRecordOptions(options: RecordOptions): SettingsPatch {
  return {
    recording: {
      micEnabled: options.mic.enabled,
      micDeviceId: options.mic.deviceId ?? null,
      systemAudio: options.systemAudio,
      quality: options.quality,
      fps: options.fps,
      countdown: options.countdown,
    },
  };
}

/** Where output goes when nothing was chosen, relative to the user's Pictures/Videos folder. */
export const DEFAULT_OUTPUT_SUBFOLDER = 'Framelet';

/** What the UI shows next to the settings: the folders actually in use. */
export const EffectiveSettingsSchema = z.object({
  screenshotsDir: z.string(),
  recordingsDir: z.string(),
});
export type EffectiveSettings = z.infer<typeof EffectiveSettingsSchema>;

export const SettingsStateSchema = z.object({
  settings: SettingsSchema,
  effective: EffectiveSettingsSchema,
});
export type SettingsState = z.infer<typeof SettingsStateSchema>;
