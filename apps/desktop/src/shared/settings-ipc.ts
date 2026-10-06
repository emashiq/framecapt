import { z } from 'zod';
import {
  OutputTargetSchema,
  ResetSectionSchema,
  SettingsPatchSchema,
  SettingsStateSchema,
} from './settings';
import { EDITOR_ACTIONS, SHORTCUT_ACTIONS, type ShortcutStates } from './shortcuts';

export { SettingsStateSchema };

export const SettingsUpdateRequestSchema = z.strictObject({ patch: SettingsPatchSchema });
export const SettingsResetRequestSchema = z.strictObject({
  section: ResetSectionSchema.optional(),
});
export const OutputTargetRequestSchema = z.strictObject({ target: OutputTargetSchema });

export const ChooseOutputDirResponseSchema = z.object({
  /** False when the user closed the dialog without choosing. */
  changed: z.boolean(),
  state: SettingsStateSchema,
});

const ShortcutStateSchema = z.object({
  accelerator: z.string().nullable(),
  status: z.enum(['ok', 'conflict', 'invalid', 'disabled']),
  message: z.string().optional(),
});
export const ShortcutStatesSchema = z.object(
  Object.fromEntries(SHORTCUT_ACTIONS.map((action) => [action, ShortcutStateSchema])),
) as unknown as z.ZodType<ShortcutStates>;

/** A global action or an editor action: both are edited with the same field. */
const ShortcutActionSchema = z.enum([...SHORTCUT_ACTIONS, ...EDITOR_ACTIONS]);

export const ShortcutValidateRequestSchema = z.strictObject({
  action: ShortcutActionSchema,
  accelerator: z.string().max(64).nullable(),
});
export const ShortcutValidateResponseSchema = z.union([
  z.strictObject({
    ok: z.literal(true),
    accelerator: z.string().nullable(),
    /** Allowed, with a heads-up (for example Print Screen, which the Snipping Tool may own). */
    warning: z.string().optional(),
  }),
  z.strictObject({
    ok: z.literal(false),
    reason: z.string(),
    /** Set when another action of the same scope holds the combination (the UI offers a swap). */
    usedBy: ShortcutActionSchema.optional(),
  }),
]);

export const ShortcutPauseRequestSchema = z.strictObject({ paused: z.boolean() });

/** Answer to `app:confirmQuit`: stop the recording and quit, or keep recording. */
export const ResolveQuitRequestSchema = z.strictObject({ stop: z.boolean() });

/** A tray or shortcut action that needs the main window (a window picker, or an unsaved editor). */
export const StartRequestEventSchema = z.object({
  kind: z.enum(['screenshot', 'record']),
  target: z.enum(['screen', 'window', 'region']),
});
export type StartRequestEvent = z.infer<typeof StartRequestEventSchema>;

export const ToastEventSchema = z.object({
  level: z.enum(['info', 'error']),
  message: z.string().max(400),
});
export type ToastEvent = z.infer<typeof ToastEventSchema>;

export const NAV_VIEWS = ['capture', 'history', 'settings'] as const;
export const SETTINGS_SECTIONS = [
  'general',
  'screenshots',
  'recording',
  'shortcuts',
  'storage',
  'advanced',
  'about',
] as const;
export type SettingsSectionId = (typeof SETTINGS_SECTIONS)[number];

export const NavigateEventSchema = z.object({
  view: z.enum(NAV_VIEWS),
  section: z.enum(SETTINGS_SECTIONS).optional(),
});
export type NavigateEvent = z.infer<typeof NavigateEventSchema>;
