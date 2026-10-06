import type { RecorderStatus } from '../../shared/recorder-machine';
import type { Settings } from '../../shared/settings';
import type { SettingsSectionId } from '../../shared/settings-ipc';
import { acceleratorKeys, type EditorAction, type ShortcutAction } from '../../shared/shortcuts';
import { fuzzyMatch, type Match } from './fuzzy';

/**
 * The commands of the app: one list for the menu bar and the command center. A command only calls
 * an action the app already has (`CommandActions`, the same functions the buttons use). The
 * `disabledReason` here is explanation, never a gate.
 */

export type CommandGroup = 'Capture' | 'Navigate' | 'Help' | 'App';
export const GROUP_ORDER: readonly CommandGroup[] = ['Capture', 'Navigate', 'Help', 'App'];

/** Where a command's shortcut hint comes from: a setting (read live) or a fixed key. */
export type HintSource =
  | { kind: 'global'; action: ShortcutAction }
  | { kind: 'editor'; action: EditorAction }
  | { kind: 'fixed'; keys: string[] };

export interface Command {
  id: string;
  title: string;
  /** The label in a menu, when it reads better than the title ("New screenshot – region"). */
  menuLabel?: string;
  group: CommandGroup;
  /** Extra words the search also matches (not highlighted). */
  keywords: string[];
  hint?: HintSource;
  /** Why the command cannot run right now (null: it can). Shown, never hidden. */
  disabledReason: string | null;
  /** False for commands that only make sense in a menu. */
  inPalette: boolean;
  run: () => void;
}

/** What the commands read to know whether they can run (display state). */
export interface CommandEnv {
  recorderStatus: RecorderStatus;
}

export type Target = 'screen' | 'window' | 'region';

/** The things a command can do: each one is an existing function of the app. */
export interface CommandActions {
  /** Same as the Screenshot and Record buttons of the Capture view (and the tray). */
  startCapture: (kind: 'screenshot' | 'record', target: Target) => void;
  stopRecording: () => void;
  togglePause: () => void;
  navigate: (view: 'capture' | 'history' | 'settings', section?: SettingsSectionId) => void;
  showKeyboardHelp: () => void;
  /** Same as the Open image button of the Capture view (a picture file opens in the editor). */
  openImage: () => void;
  toggleTheme: () => void;
  quit: () => void;
  openCommandCenter: () => void;
}

const TARGETS: readonly { target: Target; shot: ShortcutAction; record: ShortcutAction }[] = [
  { target: 'region', shot: 'screenshotRegion', record: 'recordRegion' },
  { target: 'window', shot: 'screenshotWindow', record: 'recordWindow' },
  { target: 'screen', shot: 'screenshotScreen', record: 'recordScreen' },
];

const SECTIONS: readonly { id: SettingsSectionId; label: string; keywords: string[] }[] = [
  { id: 'general', label: 'General', keywords: ['theme', 'tray', 'startup', 'notifications'] },
  {
    id: 'screenshots',
    label: 'Screenshots',
    keywords: ['format', 'editable data', 'editable originals', 'clipboard'],
  },
  { id: 'recording', label: 'Recording', keywords: ['quality', 'microphone', 'audio', 'fps'] },
  { id: 'shortcuts', label: 'Shortcuts', keywords: ['keys', 'keyboard', 'hotkeys'] },
  { id: 'storage', label: 'Storage', keywords: ['folder', 'output', 'location'] },
  { id: 'advanced', label: 'Advanced', keywords: ['diagnostics', 'capture test'] },
  { id: 'about', label: 'About', keywords: ['version', 'licenses'] },
];

const RECORDER_IDLE: readonly RecorderStatus[] = ['idle', 'completed', 'error'];
export const isRecorderBusy = (status: RecorderStatus): boolean => !RECORDER_IDLE.includes(status);

/** Why a screenshot or a recording cannot start right now, or null. Explanation only. */
export function captureBlockedReason(env: Pick<CommandEnv, 'recorderStatus'>): string | null {
  return isRecorderBusy(env.recorderStatus) ? 'A recording is in progress. Stop it first.' : null;
}

type NewCommand = Omit<Command, 'disabledReason' | 'inPalette' | 'keywords'> & Partial<Command>;

/** Every command for the current state. The order is the order within a group. */
export function buildCommands(env: CommandEnv, actions: CommandActions): Command[] {
  const commands: Command[] = [];
  const add = (command: NewCommand): void => {
    commands.push({ disabledReason: null, inPalette: true, keywords: [], ...command });
  };

  for (const { target, shot } of TARGETS) {
    add({
      id: `shot.${target}`,
      title: `Take screenshot – ${target}`,
      menuLabel: `New screenshot – ${target}`,
      group: 'Capture',
      keywords: ['capture', 'screen shot', 'snip', target],
      hint: { kind: 'global', action: shot },
      disabledReason: captureBlockedReason(env),
      run: () => actions.startCapture('screenshot', target),
    });
  }
  for (const { target, record } of TARGETS) {
    add({
      id: `rec.${target}`,
      title: `Record – ${target}`,
      menuLabel: `New recording – ${target}`,
      group: 'Capture',
      keywords: ['video', 'screen recording', 'capture', target],
      hint: { kind: 'global', action: record },
      disabledReason: captureBlockedReason(env),
      run: () => actions.startCapture('record', target),
    });
  }
  add({
    id: 'file.openImage',
    title: 'Open image…',
    group: 'Capture',
    keywords: ['picture', 'photo', 'file', 'import', 'edit', 'png', 'jpg'],
    hint: { kind: 'editor', action: 'openImage' },
    run: actions.openImage,
  });
  // Stop and pause belong to the recording that runs: they stay available while it runs.
  if (env.recorderStatus === 'recording' || env.recorderStatus === 'paused') {
    add({
      id: 'rec.stop',
      title: 'Stop recording',
      group: 'Capture',
      keywords: ['end', 'save', 'finish'],
      hint: { kind: 'global', action: 'stopRecording' },
      run: actions.stopRecording,
    });
    add({
      id: 'rec.pause',
      title: env.recorderStatus === 'paused' ? 'Resume recording' : 'Pause recording',
      group: 'Capture',
      keywords: ['pause', 'resume', 'continue'],
      hint: { kind: 'global', action: 'pauseRecording' },
      run: actions.togglePause,
    });
  }

  add({
    id: 'nav.capture',
    title: 'Open Capture',
    menuLabel: 'Capture',
    group: 'Navigate',
    keywords: ['home', 'new'],
    run: () => actions.navigate('capture'),
  });
  add({
    id: 'nav.history',
    title: 'Open History',
    menuLabel: 'History',
    group: 'Navigate',
    keywords: ['captures', 'library', 'saved', 'recordings', 'screenshots'],
    run: () => actions.navigate('history'),
  });
  add({
    id: 'nav.settings',
    title: 'Open Settings',
    menuLabel: 'Settings',
    group: 'Navigate',
    keywords: ['preferences', 'options'],
    run: () => actions.navigate('settings'),
  });
  for (const { id, label, keywords } of SECTIONS) {
    add({
      id: `settings.${id}`,
      title: `Settings: ${label}`,
      group: 'Navigate',
      keywords: ['preferences', ...keywords],
      run: () => actions.navigate('settings', id),
    });
  }
  add({
    id: 'view.toggleTheme',
    title: 'Toggle light or dark theme',
    group: 'Navigate',
    keywords: ['appearance', 'dark mode', 'light mode', 'color'],
    run: actions.toggleTheme,
  });
  add({
    id: 'view.commandCenter',
    title: 'Command center',
    menuLabel: 'Command center…',
    group: 'Navigate',
    inPalette: false,
    hint: { kind: 'editor', action: 'commandCenter' },
    run: actions.openCommandCenter,
  });

  add({
    id: 'help.shortcuts',
    title: 'Keyboard shortcuts',
    group: 'Help',
    keywords: ['keys', 'hotkeys', 'help'],
    hint: { kind: 'fixed', keys: ['?'] },
    run: actions.showKeyboardHelp,
  });
  add({
    id: 'help.about',
    title: 'About FrameCapt',
    group: 'Help',
    keywords: ['version', 'licenses', 'help'],
    run: () => actions.navigate('settings', 'about'),
  });
  add({
    id: 'app.quit',
    title: 'Quit FrameCapt',
    group: 'App',
    keywords: ['exit', 'close'],
    run: actions.quit,
  });
  return commands;
}

/** The keys to show for a command's shortcut: the live setting, "Not set", or none. */
export function hintFor(
  command: Pick<Command, 'hint'>,
  settings: Pick<Settings, 'shortcuts' | 'editorShortcuts'>,
): string[] | 'Not set' | null {
  const { hint } = command;
  if (!hint) return null;
  if (hint.kind === 'fixed') return hint.keys;
  const accelerator =
    hint.kind === 'global'
      ? settings.shortcuts[hint.action]
      : settings.editorShortcuts[hint.action];
  return accelerator ? acceleratorKeys(accelerator) : 'Not set';
}

export interface RankedCommand {
  command: Command;
  /** The match in the title (to highlight); null when only a keyword matched or the query is empty. */
  match: Match | null;
}
export interface RankedGroup {
  heading: string;
  items: RankedCommand[];
}

/** Keyword hits count half: a title match is what the user typed. */
const KEYWORD_WEIGHT = 0.5;

/**
 * The commands for a query, grouped. Empty query: the recent ones first (in the order they were
 * used), then everything by group. With a query: only matches, best first inside each group.
 */
export function rankCommands(
  commands: readonly Command[],
  query: string,
  recents: readonly string[] = [],
): RankedGroup[] {
  const candidates = commands.filter((command) => command.inPalette);
  const text = query.trim();
  const groups: RankedGroup[] = [];

  if (text === '') {
    const recent = recents.flatMap((id) => candidates.filter((command) => command.id === id));
    if (recent.length > 0) {
      groups.push({
        heading: 'Recent',
        items: recent.map((command) => ({ command, match: null })),
      });
    }
    const seen = new Set(recent.map((command) => command.id));
    for (const group of GROUP_ORDER) {
      const items = candidates
        .filter((command) => command.group === group && !seen.has(command.id))
        .map((command) => ({ command, match: null }));
      if (items.length > 0) groups.push({ heading: group, items });
    }
    return groups;
  }

  for (const group of GROUP_ORDER) {
    const scored: (RankedCommand & { score: number })[] = [];
    for (const command of candidates.filter((candidate) => candidate.group === group)) {
      const title = fuzzyMatch(text, command.title);
      let score = title?.score ?? null;
      if (score === null) {
        const keyword = fuzzyMatch(text, command.keywords.join(' '));
        if (keyword) score = keyword.score * KEYWORD_WEIGHT;
      }
      if (score !== null) scored.push({ command, match: title, score });
    }
    // Array.prototype.sort is stable: equal scores keep the registry order.
    scored.sort((a, b) => b.score - a.score);
    if (scored.length > 0) {
      groups.push({
        heading: group,
        items: scored.map(({ command, match }) => ({ command, match })),
      });
    }
  }
  return groups;
}

/** The menu bar: which commands each menu shows (null is a separator). */
export const MENUS: readonly { id: string; label: string; items: readonly (string | null)[] }[] = [
  {
    id: 'file',
    label: 'File',
    items: [
      'file.openImage',
      null,
      'shot.region',
      'shot.window',
      'shot.screen',
      null,
      'rec.region',
      'rec.window',
      'rec.screen',
      null,
      'nav.history',
      'nav.settings',
      null,
      'app.quit',
    ],
  },
  {
    id: 'view',
    label: 'View',
    items: [
      'nav.capture',
      'nav.history',
      'nav.settings',
      null,
      'view.commandCenter',
      'view.toggleTheme',
    ],
  },
  { id: 'help', label: 'Help', items: ['help.shortcuts', 'help.about'] },
];
