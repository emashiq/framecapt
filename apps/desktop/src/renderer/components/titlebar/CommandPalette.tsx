import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { Camera, CornerDownLeft, Search, Video } from 'lucide-react';
import { friendlyError } from '../../../shared/error-messages';
import type { HistoryItemView } from '../../../shared/history-ipc';
import type { Settings } from '../../../shared/settings';
import { fuzzyMatch, highlightRuns } from '../../commands/fuzzy';
import { hintFor, rankCommands, type Command } from '../../commands/registry';
import { announce } from '../../lib/announce';
import { cn } from '../../lib/cn';
import { formatRelative } from '../../lib/time';

/** How many saved captures the palette lists, and how long it waits after the last keystroke. */
const CAPTURE_LIMIT = 6;
const DEBOUNCE_MS = 180;

type CaptureSearch =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'ready'; items: HistoryItemView[] }
  | { status: 'error'; message: string };

type Row =
  | { kind: 'command'; command: Command; indices: number[] }
  | { kind: 'capture'; item: HistoryItemView; indices: number[] };

interface Section {
  heading: string;
  rows: Row[];
  /** A line inside the group instead of rows (searching, failed). */
  note?: string;
}

const headingId = (heading: string): string => `command-heading-${heading.replaceAll(' ', '-')}`;

function Highlight({ text, indices }: { text: string; indices: readonly number[] }) {
  return (
    <>
      {highlightRuns(text, indices).map((run, index) =>
        run.hit ? (
          <mark
            key={index}
            className="bg-transparent font-semibold text-inherit underline decoration-accent decoration-2 underline-offset-2"
          >
            {run.text}
          </mark>
        ) : (
          <span key={index}>{run.text}</span>
        ),
      )}
    </>
  );
}

export interface CommandPaletteProps {
  open: boolean;
  /** `commands`: the command list only (Ctrl+Shift+P); `all`: commands and saved captures. */
  mode: 'all' | 'commands';
  commands: readonly Command[];
  settings: Pick<Settings, 'shortcuts' | 'editorShortcuts'>;
  recents: readonly string[];
  onClose: () => void;
  onRun: (command: Command) => void;
  /** Enter on a capture: opens it in History, as the Recent captures tiles do. */
  onOpenCapture: (item: HistoryItemView) => void;
  /** Shift+Enter on a capture: shows it in its folder. */
  onRevealCapture: (item: HistoryItemView) => void;
}

/**
 * The command center: a modal combobox over a listbox. The search box keeps the focus; the arrow
 * keys move the highlighted option (`aria-activedescendant`), Enter runs it, Esc closes. Commands
 * that cannot run now stay in the list with their reason. Saved captures come from the same
 * `history:list` search History uses, so main answers the search.
 */
export function CommandPalette(props: CommandPaletteProps) {
  const { open, onClose } = props;
  const ref = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (open && !dialog.open) dialog.showModal();
    if (!open && dialog.open) dialog.close();
  }, [open]);

  return (
    <dialog
      ref={ref}
      aria-label="Command center"
      data-testid="command-palette"
      className="fixed top-12 right-auto bottom-auto left-1/2 m-0 w-[min(640px,94vw)] -translate-x-1/2 rounded-xl border border-line bg-surface p-0 text-fg shadow-raised backdrop:bg-black/30"
      // State drives the dialog: Esc asks to close, the effect above closes it. (The dialog's own
      // `close` event arrives a task late and could close a palette that was just reopened.)
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      {open ? <PaletteBody {...props} /> : null}
    </dialog>
  );
}

function PaletteBody({
  mode,
  commands,
  settings,
  recents,
  onClose,
  onRun,
  onOpenCapture,
  onRevealCapture,
}: CommandPaletteProps) {
  const [query, setQuery] = useState('');
  const [result, setResult] = useState<{ text: string; search: CaptureSearch } | null>(null);
  const [cursor, setCursor] = useState({ key: '', index: 0 });
  const listRef = useRef<HTMLDivElement>(null);
  const text = query.trim();
  const searching = mode === 'all' && text !== '';
  const captures: CaptureSearch = !searching
    ? { status: 'idle' }
    : result?.text === text
      ? result.search
      : { status: 'loading' };

  // Saved captures: the same search the History view runs, after a short pause in typing.
  useEffect(() => {
    if (!searching) return;
    let live = true;
    const done = (search: CaptureSearch): void => {
      if (live) setResult({ text, search });
    };
    const timer = setTimeout(() => {
      window.framecapt
        .invoke('history:list', { query: text, limit: CAPTURE_LIMIT })
        .then((response) =>
          done(
            response.ok
              ? { status: 'ready', items: response.data.items }
              : {
                  status: 'error',
                  message: friendlyError(response.error.code, response.error.message),
                },
          ),
        )
        .catch(() => done({ status: 'error', message: 'Could not search your captures.' }));
    }, DEBOUNCE_MS);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [searching, text]);

  const sections = ((): Section[] => {
    const result: Section[] = rankCommands(commands, text, recents).map((group) => ({
      heading: group.heading,
      rows: group.items.map(({ command, match }) => ({
        kind: 'command',
        command,
        indices: match?.indices ?? [],
      })),
    }));
    if (mode === 'all' && text !== '') {
      if (captures.status === 'loading') {
        result.push({ heading: 'Recent captures', rows: [], note: 'Searching your captures…' });
      } else if (captures.status === 'error') {
        result.push({ heading: 'Recent captures', rows: [], note: captures.message });
      } else if (captures.status === 'ready' && captures.items.length > 0) {
        result.push({
          heading: 'Recent captures',
          rows: captures.items.map((item) => ({
            kind: 'capture',
            item,
            indices: fuzzyMatch(text, item.fileName)?.indices ?? [],
          })),
        });
      }
    }
    return result;
  })();

  const rows = sections.flatMap((section) => section.rows);
  const noMatches = rows.length === 0 && captures.status !== 'loading';

  // A new result list starts at its first row.
  const listKey = `${text}|${rows.length}`;
  const active = cursor.key === listKey ? cursor.index : 0;
  const setActive = (index: number): void => setCursor({ key: listKey, index });

  useEffect(() => {
    listRef.current
      ?.querySelector<HTMLElement>(`#command-option-${active}`)
      ?.scrollIntoView?.({ block: 'nearest' });
  }, [active, rows.length]);

  const status = noMatches
    ? 'No matching commands'
    : `${rows.length} result${rows.length === 1 ? '' : 's'}`;

  function activate(row: Row | undefined, alternate: boolean): void {
    if (!row) return;
    if (row.kind === 'capture') {
      onClose();
      (alternate ? onRevealCapture : onOpenCapture)(row.item);
      return;
    }
    if (row.command.disabledReason) {
      announce(`${row.command.title} is unavailable: ${row.command.disabledReason}`);
      return;
    }
    onClose();
    onRun(row.command);
  }

  function onKeyDown(event: KeyboardEvent<HTMLInputElement>): void {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      if (rows.length === 0) return;
      setActive((active + (event.key === 'ArrowDown' ? 1 : -1) + rows.length) % rows.length);
    } else if (event.key === 'Enter') {
      event.preventDefault();
      activate(rows[active], event.shiftKey);
    }
  }

  const starts = sections.map((_, at) =>
    sections.slice(0, at).reduce((count, section) => count + section.rows.length, 0),
  );
  return (
    <div className="flex max-h-[min(70vh,520px)] flex-col">
      <div className="flex items-center gap-2.5 border-b border-line px-3.5">
        <Search className="size-4 shrink-0 text-fg-muted" aria-hidden="true" />
        <input
          type="text"
          role="combobox"
          aria-label="Search commands and captures"
          aria-expanded={rows.length > 0}
          aria-controls={rows.length > 0 ? 'command-list' : undefined}
          aria-activedescendant={rows.length > 0 ? `command-option-${active}` : undefined}
          aria-autocomplete="list"
          autoComplete="off"
          spellCheck={false}
          autoFocus
          data-testid="command-input"
          placeholder={mode === 'commands' ? 'Search commands…' : 'Search commands and captures…'}
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={onKeyDown}
          className="selectable h-12 min-w-0 flex-1 bg-transparent text-sm text-fg outline-none placeholder:text-fg-muted"
        />
      </div>
      <div
        ref={listRef}
        id={rows.length > 0 ? 'command-list' : undefined}
        role={rows.length > 0 ? 'listbox' : undefined}
        aria-label={rows.length > 0 ? 'Results' : undefined}
        className="min-h-0 overflow-y-auto p-1.5"
      >
        {sections.map((section, sectionIndex) => (
          <div
            key={section.heading}
            role="group"
            aria-labelledby={headingId(section.heading)}
            data-testid={`command-group-${section.heading}`}
          >
            <div
              id={headingId(section.heading)}
              role="presentation"
              className="px-2.5 pt-2 pb-1 text-xs font-semibold tracking-wide text-fg-muted uppercase"
            >
              {section.heading}
            </div>
            {section.note ? (
              <p className="px-2.5 py-1.5 text-[13px] text-fg-muted" data-testid="command-note">
                {section.note}
              </p>
            ) : null}
            {section.rows.map((row, rowIndex) => {
              const mine = (starts[sectionIndex] ?? 0) + rowIndex;
              const selected = mine === active;
              const disabled = row.kind === 'command' && row.command.disabledReason !== null;
              const title = row.kind === 'command' ? row.command.title : row.item.fileName;
              const keys = row.kind === 'command' ? hintFor(row.command, settings) : null;
              const Icon = row.kind === 'capture' && row.item.type === 'recording' ? Video : Camera;
              return (
                <div
                  key={row.kind === 'command' ? row.command.id : row.item.id}
                  id={`command-option-${mine}`}
                  role="option"
                  aria-selected={selected}
                  aria-disabled={disabled ? true : undefined}
                  data-testid={
                    row.kind === 'command' ? `command-${row.command.id}` : 'command-capture'
                  }
                  data-id={row.kind === 'capture' ? row.item.id : undefined}
                  className={cn(
                    'flex cursor-default items-center gap-3 rounded-lg px-2.5 py-2 text-sm',
                    selected ? 'bg-accent-soft text-accent-fg' : 'text-fg',
                    disabled && !selected && 'text-fg-muted',
                  )}
                  // Keep the focus in the search box.
                  onMouseDown={(event) => event.preventDefault()}
                  onMouseMove={() => setActive(mine)}
                  onClick={(event) => activate(row, event.shiftKey)}
                >
                  {row.kind === 'capture' ? (
                    <Icon className="size-4 shrink-0 text-fg-subtle" aria-hidden="true" />
                  ) : null}
                  <span className="min-w-0 flex-1">
                    <span className="block truncate">
                      <Highlight text={title} indices={row.indices} />
                    </span>
                    {row.kind === 'command' && row.command.disabledReason ? (
                      <span className="block truncate text-xs text-fg-muted">
                        Unavailable: {row.command.disabledReason}
                      </span>
                    ) : null}
                  </span>
                  {row.kind === 'capture' ? (
                    <span className="shrink-0 text-xs text-fg-muted">
                      {row.item.exists ? formatRelative(row.item.createdAt) : 'File missing'}
                    </span>
                  ) : Array.isArray(keys) ? (
                    <span className="shrink-0 text-xs text-fg-muted">{keys.join('+')}</span>
                  ) : null}
                </div>
              );
            })}
          </div>
        ))}
        {noMatches ? (
          <p className="px-3 py-6 text-center text-sm text-fg-muted" data-testid="command-empty">
            No matching commands
          </p>
        ) : null}
      </div>
      <p className="flex items-center gap-3 border-t border-line px-3.5 py-2 text-xs text-fg-muted">
        <span>
          <CornerDownLeft className="mr-1 inline size-3" aria-hidden="true" />
          Run
        </span>
        <span>Up and Down to choose</span>
        {mode === 'all' ? <span>Shift+Enter shows a capture in its folder</span> : null}
        <span className="ml-auto">Esc to close</span>
      </p>
      <div role="status" aria-live="polite" className="sr-only" data-testid="command-status">
        {status}
      </div>
    </div>
  );
}
