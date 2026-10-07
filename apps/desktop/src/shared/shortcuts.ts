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
  'screenshotAllScreens',
  'recordScreen',
  'recordWindow',
  'recordRegion',
  'stopRecording',
  'pauseRecording',
  'stepsToggle',
  'stepsCapture',
] as const;
export type ShortcutAction = (typeof SHORTCUT_ACTIONS)[number];

export type ShortcutsMap = Record<ShortcutAction, string | null>;

export const SHORTCUT_LABELS: Record<ShortcutAction, string> = {
  screenshotScreen: 'Screenshot: screen',
  screenshotWindow: 'Screenshot: window',
  screenshotRegion: 'Screenshot: region',
  screenshotAllScreens: 'Screenshot: all screens',
  recordScreen: 'Record: screen',
  recordWindow: 'Record: window',
  recordRegion: 'Record: region',
  stopRecording: 'Stop recording',
  pauseRecording: 'Pause or resume recording',
  stepsToggle: 'Start or finish step capture',
  stepsCapture: 'Capture a step',
};

/**
 * Ctrl+Shift+digit is not reserved by Windows itself, but some apps use these in-app (Windows
 * Terminal opens profiles with Ctrl+Shift+1..9) and Windows' own "switch input language" hot keys
 * can be set to Ctrl+Shift+0..9. Registration conflicts are reported in Settings.
 * PrintScreen is deliberately not a default: the Windows Snipping Tool owns it by default.
 */
export const DEFAULT_SHORTCUTS: ShortcutsMap = {
  screenshotScreen: 'Ctrl+Shift+1',
  screenshotWindow: 'Ctrl+Shift+2',
  screenshotRegion: 'Ctrl+Shift+3',
  screenshotAllScreens: 'Ctrl+Shift+4',
  recordScreen: 'Ctrl+Shift+5',
  recordWindow: 'Ctrl+Shift+6',
  recordRegion: 'Ctrl+Shift+7',
  stopRecording: 'Ctrl+Shift+0',
  pauseRecording: 'Ctrl+Shift+9',
  stepsToggle: 'Ctrl+Shift+8',
  // No default: every comfortable combination is taken by another app. Set one in Settings.
  stepsCapture: null,
};

/**
 * Per action: 'ok' registered, 'conflict' another app (or action) holds it, 'invalid', 'disabled'.
 */
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
 * Where a shortcut works. `global`: registered with the OS, works from any app (needs a modifier,
 * is checked against what the OS reserves). `app`: handled by FrameCapt's own window (the editor),
 * so a bare key is fine; the editor ignores them while a text field has focus.
 */
export type ShortcutScope = 'global' | 'app';

/** Keys the editor uses itself (nudge, delete, apply, cancel, pan): they cannot be rebound. */
const APP_FIXED_KEYS = new Set([
  'Escape',
  'Enter',
  'Tab',
  'Backspace',
  'Delete',
  'Up',
  'Down',
  'Left',
  'Right',
  'Space',
]);

/**
 * Parses an accelerator and returns it in canonical form. Rules: exactly one non-modifier key from
 * the supported set; at least Ctrl or Alt unless the key is an F-key or PrintScreen (Shift alone
 * would hijack typing); Escape, Enter, Tab and Backspace need a modifier like any other key.
 */
export function checkAccelerator(value: string, scope: ShortcutScope = 'global'): AcceleratorCheck {
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
  if (scope === 'app' && APP_FIXED_KEYS.has(key)) {
    return { ok: false, reason: `${key} is used by the editor itself and cannot be changed.` };
  }
  if (scope === 'global' && !standsAlone(key) && !modifiers.has('Ctrl') && !modifiers.has('Alt')) {
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
export function acceleratorFromKeyEvent(
  event: KeyEventLike,
  scope: ShortcutScope = 'global',
): AcceleratorCheck | null {
  if (isModifierEvent(event)) return null;
  if (event.metaKey) return { ok: false, reason: 'The Windows key cannot be used in shortcuts.' };
  let base: string | undefined;
  if (/^Key[A-Z]$/.test(event.code)) base = event.code.slice(3);
  else if (/^Digit\d$/.test(event.code)) base = event.code.slice(5);
  else if (/^F\d{1,2}$/.test(event.code)) base = event.code;
  else base = CODE_NAMES[event.code];
  if (!base) return { ok: false, reason: 'That key cannot be used in a shortcut.' };
  return checkAccelerator([...heldModifiers(event), base].join('+'), scope);
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

// --- what the OS keeps for itself ------------------------------------------------------------

export interface ReservedCheck {
  /** `blocked`: the OS (or every app) owns it, it cannot be saved. `warning`: allowed, with a heads-up. */
  level: 'blocked' | 'warning';
  reason: string;
}

/** Combinations nobody can register: the system itself handles them. */
const RESERVED_BLOCKED: Record<'win32' | 'linux', Record<string, string>> = {
  win32: {
    'Ctrl+Alt+Delete': 'Windows keeps Ctrl+Alt+Delete for the security screen.',
    'Ctrl+Shift+Escape': 'Windows keeps Ctrl+Shift+Esc for Task Manager.',
    'Alt+F4': 'Windows keeps Alt+F4 for closing windows.',
    'Alt+Tab': 'Windows keeps Alt+Tab for switching windows.',
    'Alt+Shift+Tab': 'Windows keeps Alt+Shift+Tab for switching windows.',
    'Ctrl+Escape': 'Windows keeps Ctrl+Esc for the Start menu.',
    'Alt+Escape': 'Windows keeps Alt+Esc for cycling windows.',
    'Alt+Space': 'Windows keeps Alt+Space for the window menu.',
    F12: 'F12 is reserved for debuggers on Windows, so it cannot be registered.',
  },
  linux: {
    'Ctrl+Alt+T': 'Most Linux desktops open a terminal with Ctrl+Alt+T.',
    'Ctrl+Alt+L': 'Most Linux desktops lock the screen with Ctrl+Alt+L.',
    'Ctrl+Alt+Delete': 'Most Linux desktops use Ctrl+Alt+Delete for the logout or power dialog.',
    'Alt+Tab': 'Linux desktops use Alt+Tab for switching windows.',
    'Alt+Shift+Tab': 'Linux desktops use Alt+Shift+Tab for switching windows.',
    'Alt+F4': 'Linux desktops use Alt+F4 for closing windows.',
    'Alt+Space': 'Linux desktops use Alt+Space for the window menu.',
    'Alt+F2': 'Linux desktops use Alt+F2 for the run dialog.',
    'Ctrl+Alt+Left': 'Linux desktops use Ctrl+Alt+arrows to switch workspaces.',
    'Ctrl+Alt+Right': 'Linux desktops use Ctrl+Alt+arrows to switch workspaces.',
    'Ctrl+Alt+Up': 'Linux desktops use Ctrl+Alt+arrows to switch workspaces.',
    'Ctrl+Alt+Down': 'Linux desktops use Ctrl+Alt+arrows to switch workspaces.',
  },
};

/** Editing keys every app uses: a global shortcut on them would break copy, paste and undo everywhere. */
const EDITING_KEYS = new Set(['Ctrl+C', 'Ctrl+V', 'Ctrl+X', 'Ctrl+Z', 'Ctrl+Y', 'Ctrl+A']);

/**
 * Whether a (canonical) global accelerator is one the OS or every app already uses, checked BEFORE
 * registration is attempted so the settings screen can say why. Pure; `platform` is the
 * `process.platform` string. `null` means nothing is known against it (registration can still find
 * that another app holds it). Platforms other than Windows and Linux have no table.
 */
export function reservedCheck(accelerator: string, platform: string): ReservedCheck | null {
  if (EDITING_KEYS.has(accelerator)) {
    return {
      level: 'blocked',
      reason: `${accelerator} is used by almost every app for editing: as a global shortcut it would stop working there.`,
    };
  }
  if (platform !== 'win32' && platform !== 'linux') return null;
  const reason = RESERVED_BLOCKED[platform][accelerator];
  if (reason) return { level: 'blocked', reason };
  if (platform === 'linux' && /^Ctrl\+Alt\+F([1-9]|1[0-2])$/.test(accelerator)) {
    return {
      level: 'blocked',
      reason: 'Linux uses Ctrl+Alt+F1 to F12 to switch to a text console.',
    };
  }
  if (/(^|\+)PrintScreen$/.test(accelerator)) {
    return {
      level: 'warning',
      reason:
        platform === 'win32'
          ? 'Print Screen may already belong to the Snipping Tool. If it does not respond, turn that off in Windows Settings (Accessibility, Keyboard) or pick another key.'
          : "Print Screen may already belong to your desktop's screenshot tool. If it does not respond, pick another key.",
    };
  }
  return null;
}

// --- editor (in-app) shortcuts ----------------------------------------------------------------

/**
 * The keys that work in the whole main window, editor included: the command center's and Open
 * image. They live in the same editable in-app set as the editor keys.
 */
export const COMMAND_ACTIONS = ['commandCenter', 'commandPalette', 'openImage'] as const;
export type CommandAction = (typeof COMMAND_ACTIONS)[number];

/**
 * The editor's customizable keys. Delete, Esc, Enter, arrows and Space (pan) stay fixed: they are
 * part of how a mark is edited, not commands. The editor ignores all of these while a text field
 * has focus, so a bare letter never gets in the way of typing.
 */
export const EDITOR_ACTIONS = [
  ...COMMAND_ACTIONS,
  'toolSelect',
  'toolCrop',
  'toolArrow',
  'toolRect',
  'toolText',
  'toolRedact',
  'toolEllipse',
  'toolLine',
  'toolPen',
  'toolHighlight',
  'toolBlur',
  'toolStep',
  'toolCallout',
  'toolSpotlight',
  'toolMagnifier',
  'toolStamp',
  'toolRuler',
  'insertImage',
  'duplicate',
  'bringForward',
  'sendBackward',
  'bringToFront',
  'sendToBack',
  'selectAll',
  'undo',
  'redo',
  'save',
  'quickSave',
  'copy',
  'zoomIn',
  'zoomOut',
  'zoomFit',
  'zoomActual',
] as const;
export type EditorAction = (typeof EDITOR_ACTIONS)[number];

export const EDITOR_LABELS: Record<EditorAction, string> = {
  commandCenter: 'Command center: search commands and captures',
  commandPalette: 'Command center: commands only',
  openImage: 'Open an image to edit',
  toolSelect: 'Select tool',
  toolCrop: 'Crop tool',
  toolArrow: 'Arrow tool',
  toolRect: 'Rectangle tool',
  toolText: 'Text tool',
  toolRedact: 'Redact tool',
  toolEllipse: 'Ellipse tool',
  toolLine: 'Line tool',
  toolPen: 'Pen tool',
  toolHighlight: 'Highlighter tool',
  toolBlur: 'Blur or pixelate tool',
  toolStep: 'Step number tool',
  toolCallout: 'Callout tool',
  toolSpotlight: 'Spotlight tool',
  toolMagnifier: 'Magnifier tool',
  toolStamp: 'Stamp tool',
  toolRuler: 'Ruler tool',
  insertImage: 'Insert an image from a file',
  duplicate: 'Duplicate the selection',
  bringForward: 'Bring forward',
  sendBackward: 'Send backward',
  bringToFront: 'Bring to front',
  sendToBack: 'Send to back',
  selectAll: 'Select all marks',
  undo: 'Undo',
  redo: 'Redo',
  save: 'Save',
  quickSave: 'Quick save (no dialog)',
  copy: 'Copy to the clipboard',
  zoomIn: 'Zoom in',
  zoomOut: 'Zoom out',
  zoomFit: 'Fit to window',
  zoomActual: 'Zoom to 100 %',
};

export const DEFAULT_EDITOR_SHORTCUTS: Record<EditorAction, string> = {
  commandCenter: 'Ctrl+K',
  commandPalette: 'Ctrl+Shift+P',
  openImage: 'Ctrl+O',
  toolSelect: 'V',
  toolCrop: 'C',
  toolArrow: 'A',
  toolRect: 'R',
  toolText: 'T',
  toolRedact: 'X',
  toolEllipse: 'O',
  toolLine: 'L',
  toolPen: 'P',
  toolHighlight: 'H',
  toolBlur: 'B',
  toolStep: 'N',
  toolCallout: 'D',
  toolSpotlight: 'S',
  toolMagnifier: 'M',
  toolStamp: 'E',
  toolRuler: 'I',
  insertImage: 'Ctrl+Shift+O',
  duplicate: 'Ctrl+D',
  bringForward: 'Ctrl+]',
  sendBackward: 'Ctrl+[',
  bringToFront: 'Ctrl+Shift+]',
  sendToBack: 'Ctrl+Shift+[',
  selectAll: 'Ctrl+A',
  undo: 'Ctrl+Z',
  redo: 'Ctrl+Shift+Z',
  save: 'Ctrl+S',
  quickSave: 'Ctrl+Shift+S',
  copy: 'Ctrl+C',
  zoomIn: 'Ctrl+=',
  zoomOut: 'Ctrl+-',
  zoomFit: 'Ctrl+0',
  zoomActual: 'Ctrl+1',
};

export type EditorShortcutsMap = Record<EditorAction, string | null>;

export function isCommandAction(action: string): action is CommandAction {
  return (COMMAND_ACTIONS as readonly string[]).includes(action);
}

/** Any action a shortcut field can edit: global or editor. */
export type AnyShortcutAction = ShortcutAction | EditorAction;

export function isEditorAction(action: string): action is EditorAction {
  return (EDITOR_ACTIONS as readonly string[]).includes(action);
}

/** What a keydown means in the editor, read from the layout's key and from the physical key. */
function editorCandidates(event: KeyEventLike): string[] {
  const found: string[] = [];
  const physical = acceleratorFromKeyEvent(event, 'app');
  if (physical?.ok) found.push(physical.accelerator);
  let token = event.key;
  let shift = event.shiftKey;
  // Ctrl+Shift+= types "+" and Ctrl+Shift+- types "_": the same keys as Ctrl+= and Ctrl+-.
  if (token === '+') {
    token = '=';
    shift = false;
  } else if (token === '_') {
    token = '-';
    shift = false;
  }
  if (token.length === 1 || /^F\d{1,2}$/.test(token)) {
    const modifiers = [
      ...(event.ctrlKey || event.metaKey ? ['Ctrl'] : []),
      ...(event.altKey ? ['Alt'] : []),
      ...(shift ? ['Shift'] : []),
    ];
    const parsed = checkAccelerator([...modifiers, token].join('+'), 'app');
    if (parsed.ok) found.push(parsed.accelerator);
  }
  return found;
}

/** The editor action a keydown triggers under `bindings`, or null. */
export function matchEditorAction(
  event: KeyEventLike,
  bindings: Partial<Record<EditorAction, string | null>>,
): EditorAction | null {
  const candidates = editorCandidates(event);
  if (candidates.length === 0) return null;
  for (const action of EDITOR_ACTIONS) {
    const bound = bindings[action];
    if (bound && candidates.includes(bound)) return action;
  }
  return null;
}

/** The editor action that already uses `accelerator` (compared canonically), ignoring `except`. */
export function editorActionUsing(
  bindings: Partial<Record<EditorAction, string | null>>,
  accelerator: string,
  except?: EditorAction,
): EditorAction | null {
  const wanted = checkAccelerator(accelerator, 'app');
  if (!wanted.ok) return null;
  for (const action of EDITOR_ACTIONS) {
    if (action === except) continue;
    const other = bindings[action];
    if (!other) continue;
    const parsed = checkAccelerator(other, 'app');
    if (parsed.ok && parsed.accelerator === wanted.accelerator) return action;
  }
  return null;
}

export type EditorShortcutsCheck =
  { ok: true } | { ok: false; action: EditorAction; reason: string };

/** Validates the editor map: every accelerator valid for the app scope and no two actions sharing one. */
export function checkEditorShortcuts(bindings: EditorShortcutsMap): EditorShortcutsCheck {
  const seen = new Map<string, EditorAction>();
  for (const action of EDITOR_ACTIONS) {
    const value = bindings[action];
    if (value === null) continue;
    const parsed = checkAccelerator(value, 'app');
    if (!parsed.ok) return { ok: false, action, reason: parsed.reason };
    const holder = seen.get(parsed.accelerator);
    if (holder) {
      return {
        ok: false,
        action,
        reason: `${value} is already used by “${EDITOR_LABELS[holder]}”.`,
      };
    }
    seen.set(parsed.accelerator, action);
  }
  return { ok: true };
}

/**
 * The action in the OTHER scope that holds `accelerator`, as a phrase for a message: a global
 * shortcut would take the key away from the editor, and an editor key that equals a global one
 * would never be seen.
 */
export function crossScopeHolder(
  scope: ShortcutScope,
  accelerator: string,
  global: Partial<Record<ShortcutAction, string | null>>,
  editor: Partial<Record<EditorAction, string | null>>,
): string | null {
  if (scope === 'global') {
    const holder = editorActionUsing(editor, accelerator);
    return holder ? `“${EDITOR_LABELS[holder]}” in the editor` : null;
  }
  const holder = actionUsing(global, accelerator);
  return holder ? `the global shortcut “${SHORTCUT_LABELS[holder]}”` : null;
}
