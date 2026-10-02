/**
 * Global shortcuts: the actions, their defaults and the pure rules for accelerator strings. No
 * Electron here: main registers, the renderer records and displays, both validate with this file.
 *
 * An accelerator is `Ctrl+Alt+Shift+Key` in exactly that modifier order (Electron accepts it and it
 * compares as a plain string). Super (the Windows key) is not offered: Windows reserves nearly all
 * Win combinations for itself.
 */

export const SHORTCUT_ACTIONS = [
  'screenshotScreen',
  'screenshotWindow',
  'screenshotRegion',
  'recordScreen',
  'recordWindow',
  'recordRegion',
  'stopRecording',
  'pauseRecording',
] as const;
export type ShortcutAction = (typeof SHORTCUT_ACTIONS)[number];

export const SHORTCUT_LABELS: Record<ShortcutAction, string> = {
  screenshotScreen: 'Screenshot: screen',
  screenshotWindow: 'Screenshot: window',
  screenshotRegion: 'Screenshot: region',
  recordScreen: 'Record: screen',
  recordWindow: 'Record: window',
  recordRegion: 'Record: region',
  stopRecording: 'Stop recording',
  pauseRecording: 'Pause or resume recording',
};

/**
 * Ctrl+Shift+digit is not reserved by Windows itself, but some apps use these in-app (Windows
 * Terminal opens profiles with Ctrl+Shift+1..9) and Windows' own "switch input language" hot keys
 * can be set to Ctrl+Shift+0..9. Registration conflicts are reported in Settings.
 * PrintScreen is deliberately not a default: the Windows Snipping Tool owns it by default.
 */
export const DEFAULT_SHORTCUTS: Record<ShortcutAction, string> = {
  screenshotScreen: 'Ctrl+Shift+1',
  screenshotWindow: 'Ctrl+Shift+2',
  screenshotRegion: 'Ctrl+Shift+3',
  recordScreen: 'Ctrl+Shift+5',
  recordWindow: 'Ctrl+Shift+6',
  recordRegion: 'Ctrl+Shift+7',
  stopRecording: 'Ctrl+Shift+0',
  pauseRecording: 'Ctrl+Shift+9',
};

export type ShortcutsMap = Record<ShortcutAction, string | null>;

/** Per action: 'ok' registered, 'conflict' another app (or action) holds it, 'invalid', 'disabled'. */
export type ShortcutStatus = 'ok' | 'conflict' | 'invalid' | 'disabled';

export interface ShortcutState {
  accelerator: string | null;
  status: ShortcutStatus;
  /** A sentence for the UI when status is not ok/disabled. */
  message?: string;
}
export type ShortcutStates = Record<ShortcutAction, ShortcutState>;

// --- accelerator grammar ------------------------------------------------------------------

const MODIFIER_ORDER = ['Ctrl', 'Alt', 'Shift'] as const;
type Modifier = (typeof MODIFIER_ORDER)[number];

const MODIFIER_ALIASES: Record<string, Modifier> = {
  ctrl: 'Ctrl',
  control: 'Ctrl',
  commandorcontrol: 'Ctrl',
  cmdorctrl: 'Ctrl',
  alt: 'Alt',
  option: 'Alt',
  shift: 'Shift',
};

const NAMED_KEYS = [
  'Space',
  'Tab',
  'Backspace',
  'Delete',
  'Insert',
  'Enter',
  'Escape',
  'Up',
  'Down',
  'Left',
  'Right',
  'Home',
  'End',
  'PageUp',
  'PageDown',
  'PrintScreen',
] as const;
const NAMED_KEY_LOOKUP = new Map(NAMED_KEYS.map((key) => [key.toLowerCase(), key]));
NAMED_KEY_LOOKUP.set('return', 'Enter');
NAMED_KEY_LOOKUP.set('esc', 'Escape');
NAMED_KEY_LOOKUP.set('del', 'Delete');
NAMED_KEY_LOOKUP.set('prtsc', 'PrintScreen');

const PUNCTUATION = "`-=[]\\;',./";

/** Keys that need no modifier to be a global shortcut. */
function standsAlone(key: string): boolean {
  return key === 'PrintScreen' || /^F([1-9]|1\d|2[0-4])$/.test(key);
}

function canonicalKey(token: string): string | null {
  if (/^[a-z0-9]$/i.test(token)) return token.toUpperCase();
  const fn = /^f([1-9]|1\d|2[0-4])$/i.exec(token);
  if (fn) return `F${fn[1]}`;
  if (token.length === 1 && PUNCTUATION.includes(token)) return token;
  return NAMED_KEY_LOOKUP.get(token.toLowerCase()) ?? null;
}

export type AcceleratorCheck = { ok: true; accelerator: string } | { ok: false; reason: string };

/**
 * Parses an accelerator and returns it in canonical form. Rules: exactly one non-modifier key from
 * the supported set; at least Ctrl or Alt unless the key is an F-key or PrintScreen (Shift alone
 * would hijack typing); Escape, Enter, Tab and Backspace need a modifier like any other key.
 */
export function checkAccelerator(value: string): AcceleratorCheck {
  // "Ctrl++" cannot be written in this grammar; a bare "+" key is not offered either.
  const tokens = value.split('+').map((token) => token.trim());
  if (tokens.some((token) => token === '')) {
    return { ok: false, reason: 'That is not a valid shortcut.' };
  }
  const modifiers = new Set<Modifier>();
  let key: string | null = null;
  for (const token of tokens) {
    const modifier = MODIFIER_ALIASES[token.toLowerCase()];
    if (modifier) {
      modifiers.add(modifier);
      continue;
    }
    const parsed = canonicalKey(token);
    if (parsed === null) return { ok: false, reason: `“${token}” is not a supported key.` };
    if (key !== null) return { ok: false, reason: 'Use one key plus modifiers.' };
    key = parsed;
  }
  if (key === null) return { ok: false, reason: 'Add a key after the modifiers.' };
  if (!standsAlone(key) && !modifiers.has('Ctrl') && !modifiers.has('Alt')) {
    return {
      ok: false,
      reason: 'Include Ctrl or Alt, so the shortcut cannot be typed by accident.',
    };
  }
  const ordered = MODIFIER_ORDER.filter((modifier) => modifiers.has(modifier));
  return { ok: true, accelerator: [...ordered, key].join('+') };
}

export function isValidAccelerator(value: string): boolean {
  return checkAccelerator(value).ok;
}

/** The accelerator as key labels for a keyboard hint: "Ctrl+Shift+1" -> ["Ctrl", "Shift", "1"]. */
export function acceleratorKeys(accelerator: string): string[] {
  return accelerator.split('+');
}

// --- recording a combination in the UI ------------------------------------------------------

export interface KeyEventLike {
  code: string;
  key: string;
  ctrlKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
  metaKey: boolean;
}

const CODE_NAMES: Record<string, string> = {
  Space: 'Space',
  Tab: 'Tab',
  Backspace: 'Backspace',
  Delete: 'Delete',
  Insert: 'Insert',
  Enter: 'Enter',
  Escape: 'Escape',
  ArrowUp: 'Up',
  ArrowDown: 'Down',
  ArrowLeft: 'Left',
  ArrowRight: 'Right',
  Home: 'Home',
  End: 'End',
  PageUp: 'PageUp',
  PageDown: 'PageDown',
  PrintScreen: 'PrintScreen',
  Backquote: '`',
  Minus: '-',
  Equal: '=',
  BracketLeft: '[',
  BracketRight: ']',
  Backslash: '\\',
  Semicolon: ';',
  Quote: "'",
  Comma: ',',
  Period: '.',
  Slash: '/',
};

const MODIFIER_CODES = /^(Control|Alt|Shift|Meta|OS)(Left|Right)?$/;

/** True for a key event that is only a modifier going down (the combination is still open). */
export function isModifierEvent(event: Pick<KeyEventLike, 'code'>): boolean {
  return MODIFIER_CODES.test(event.code);
}

/** The modifier names currently held, in accelerator order. */
export function heldModifiers(event: KeyEventLike): string[] {
  return [
    ...(event.ctrlKey ? ['Ctrl'] : []),
    ...(event.altKey ? ['Alt'] : []),
    ...(event.shiftKey ? ['Shift'] : []),
  ];
}

/**
 * Turns a keydown into an accelerator, from the physical key (`code`), so Shift+1 is "Shift+1" and
 * not "!". Returns the check result for the whole combination, or null while only modifiers are
 * down. The Windows key makes the combination unusable.
 */
export function acceleratorFromKeyEvent(event: KeyEventLike): AcceleratorCheck | null {
  if (isModifierEvent(event)) return null;
  if (event.metaKey) return { ok: false, reason: 'The Windows key cannot be used in shortcuts.' };
  let base: string | undefined;
  if (/^Key[A-Z]$/.test(event.code)) base = event.code.slice(3);
  else if (/^Digit\d$/.test(event.code)) base = event.code.slice(5);
  else if (/^F\d{1,2}$/.test(event.code)) base = event.code;
  else base = CODE_NAMES[event.code];
  if (!base) return { ok: false, reason: 'That key cannot be used in a shortcut.' };
  return checkAccelerator([...heldModifiers(event), base].join('+'));
}

// --- the set of shortcuts -------------------------------------------------------------------

/** The action that already uses `accelerator` (compared canonically), ignoring `except`. */
export function actionUsing(
  shortcuts: Partial<Record<ShortcutAction, string | null>>,
  accelerator: string,
  except?: ShortcutAction,
): ShortcutAction | null {
  const wanted = checkAccelerator(accelerator);
  if (!wanted.ok) return null;
  for (const action of SHORTCUT_ACTIONS) {
    if (action === except) continue;
    const other = shortcuts[action];
    if (!other) continue;
    const parsed = checkAccelerator(other);
    if (parsed.ok && parsed.accelerator === wanted.accelerator) return action;
  }
  return null;
}

export type ShortcutsCheck = { ok: true } | { ok: false; action: ShortcutAction; reason: string };

/** Validates a whole map: every accelerator valid and no two actions sharing one. */
export function checkShortcuts(shortcuts: ShortcutsMap): ShortcutsCheck {
  const seen = new Map<string, ShortcutAction>();
  for (const action of SHORTCUT_ACTIONS) {
    const value = shortcuts[action];
    if (value === null) continue;
    const parsed = checkAccelerator(value);
    if (!parsed.ok) return { ok: false, action, reason: parsed.reason };
    const holder = seen.get(parsed.accelerator);
    if (holder) {
      return {
        ok: false,
        action,
        reason: `${value} is already used by “${SHORTCUT_LABELS[holder]}”.`,
      };
    }
    seen.set(parsed.accelerator, action);
  }
  return { ok: true };
}
