import { X } from 'lucide-react';
import {
  COMMAND_ACTIONS,
  EDITOR_ACTIONS,
  EDITOR_LABELS,
  SHORTCUT_ACTIONS,
  SHORTCUT_LABELS,
  acceleratorKeys,
  isCommandAction,
} from '../../shared/shortcuts';
import { useSettings } from '../settings/store';
import { Button } from './ui/Button';
import { Kbd } from './ui/Kbd';
import { Modal } from './ui/Dialog';

interface Entry {
  keys: string[];
  text: string;
}

const MAIN_KEYS: Entry[] = [
  { keys: ['?'], text: 'Show this help (also F1)' },
  { keys: ['Tab'], text: 'Move to the next control' },
  { keys: ['Shift', 'Tab'], text: 'Move to the previous control' },
  { keys: ['Enter'], text: 'Press the focused button' },
  { keys: ['Esc'], text: 'Close a dialog or cancel' },
];

const OVERLAY_KEYS: Entry[] = [
  { keys: ['←', '↑', '→', '↓'], text: 'Start a selection, then move it 1 px (Shift: 10 px)' },
  { keys: ['Alt', '←', '↑', '→', '↓'], text: 'Resize the selection 1 px (Shift: 10 px)' },
  { keys: ['Enter'], text: 'Capture or record the selection' },
  { keys: ['Esc'], text: 'Cancel' },
  { keys: ['Tab'], text: 'Move between Capture and Cancel' },
];

/** The editor keys that cannot be changed (the others are read from the settings). */
const EDITOR_FIXED_KEYS: Entry[] = [
  { keys: ['Ctrl', 'Y'], text: 'Redo (also, unless you bound it to something else)' },
  { keys: ['←', '↑', '→', '↓'], text: 'Move the selected marks (Shift: 10 px)' },
  { keys: ['Delete'], text: 'Remove the selected marks' },
  { keys: ['Shift', 'Click'], text: 'Add a mark to the selection (or drag a box around several)' },
  { keys: ['Alt', 'Drag'], text: 'Move a mark without snapping to guides' },
  { keys: ['Enter'], text: 'Apply the crop' },
];

const OTHER_KEYS: Entry[] = [
  {
    keys: ['←', '↑', '→', '↓'],
    text: 'History: move between captures (Delete removes from history)',
  },
  { keys: ['Enter'], text: 'Window picker: pick the focused window' },
  { keys: ['Tab'], text: 'Recording bar: move between Pause, Stop and the mute buttons' },
];

function Group({ title, entries }: { title: string; entries: Entry[] }) {
  return (
    <section aria-label={title} className="break-inside-avoid">
      <h3 className="mb-2 text-xs font-semibold tracking-wide text-fg-muted uppercase">{title}</h3>
      <ul className="space-y-1.5">
        {entries.map((entry) => (
          <li
            key={`${entry.keys.join('+')}-${entry.text}`}
            className="flex items-center gap-3 text-[13px]"
          >
            <span className="flex w-40 shrink-0 flex-wrap justify-end gap-1">
              <Kbd keys={entry.keys} />
            </span>
            <span className="text-fg-muted">{entry.text}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}

export interface KeyboardHelpProps {
  open: boolean;
  onClose: () => void;
}

/** Every key the app answers to, with the global shortcuts as configured right now. */
export function KeyboardHelp({ open, onClose }: KeyboardHelpProps) {
  const { shortcuts, editorShortcuts } = useSettings();
  const global: Entry[] = SHORTCUT_ACTIONS.map((action) => {
    const accelerator = shortcuts[action];
    return {
      keys: accelerator ? acceleratorKeys(accelerator) : ['Not set'],
      text: SHORTCUT_LABELS[action],
    };
  });
  const keysOf = (accelerator: string | null): string[] =>
    accelerator ? acceleratorKeys(accelerator) : ['Not set'];
  const commandCenter: Entry[] = COMMAND_ACTIONS.map((action) => ({
    keys: keysOf(editorShortcuts[action]),
    text: EDITOR_LABELS[action],
  }));
  const editor: Entry[] = [
    ...EDITOR_ACTIONS.filter((action) => !isCommandAction(action)).map((action) => {
      const accelerator = editorShortcuts[action];
      return {
        keys: accelerator ? acceleratorKeys(accelerator) : ['Not set'],
        text: EDITOR_LABELS[action],
      };
    }),
    ...EDITOR_FIXED_KEYS,
  ];
  return (
    <Modal
      open={open}
      onClose={onClose}
      label="Keyboard shortcuts"
      className="max-h-[88vh] w-[min(920px,94vw)]"
      data-testid="keyboard-help"
    >
      <div className="flex max-h-[88vh] flex-col">
        <header className="flex items-start justify-between gap-4 border-b border-line px-6 py-4">
          <div>
            <h2 className="text-lg font-semibold text-fg">Keyboard shortcuts</h2>
            <p className="text-[13px] text-fg-muted">
              The global shortcuts work from any app. Change them, and the editor keys, in Settings
              → Shortcuts.
            </p>
          </div>
          <Button
            variant="ghost"
            size="sm"
            icon={<X className="size-4" aria-hidden="true" />}
            aria-label="Close keyboard shortcuts"
            onClick={onClose}
            autoFocus
          >
            Close
          </Button>
        </header>
        <div
          role="region"
          aria-label="Keyboard shortcut lists"
          tabIndex={0}
          className="grid gap-x-10 gap-y-6 overflow-y-auto px-6 py-5 md:grid-cols-2"
        >
          <Group title="From anywhere" entries={global} />
          <Group title="In the main window" entries={[...commandCenter, ...MAIN_KEYS]} />
          <Group title="Choosing an area" entries={OVERLAY_KEYS} />
          <Group title="In the editor" entries={editor} />
          <Group title="Elsewhere" entries={OTHER_KEYS} />
        </div>
      </div>
    </Modal>
  );
}
