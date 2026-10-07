import { useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { Folder, FolderPlus, Library } from 'lucide-react';
import { folderNameProblem, joinFolder, type LibraryTree } from '../../shared/library';
import { Button } from '../components/ui/Button';
import { Modal } from '../components/ui/Dialog';
import { cn } from '../lib/cn';
import { createFolder } from './actions';
import { buildTree, folderLabel, visibleRows, type FolderNode } from './tree';

export interface FolderPickerDialogProps {
  open: boolean;
  title: string;
  confirmLabel: string;
  /** What the library root is called here ("All captures", "The main capture folders"). */
  rootLabel: string;
  tree: LibraryTree | null;
  /** The folder highlighted when the dialog opens (null = the root). */
  initial: string | null;
  /** A folder that cannot be chosen (the one the items are already in). */
  isDisabled?: (folder: string | null) => boolean;
  onConfirm: (folder: string | null) => void;
  onClose: () => void;
}

/**
 * Choose a folder of the library (or the root): a listbox of the whole tree, and a field to make a
 * new folder inside the highlighted one. Used by "Move to…" and "Save new captures to…".
 */
export function FolderPickerDialog(props: FolderPickerDialogProps) {
  return (
    <Modal
      open={props.open}
      onClose={props.onClose}
      label={props.title}
      data-testid="folder-picker"
      className="w-[min(440px,92vw)]"
    >
      <PickerBody {...props} />
    </Modal>
  );
}

/** Mounted only while the dialog is open, so every opening starts from the initial folder. */
function PickerBody(props: FolderPickerDialogProps) {
  const { tree, initial, isDisabled } = props;
  const [chosen, setChosen] = useState<string | null>(initial);
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const listRef = useRef<HTMLDivElement>(null);
  const roots = useMemo(() => buildTree(tree?.folders ?? []), [tree]);
  const rows = useMemo(() => {
    const everything = new Set<string>();
    const mark = (node: FolderNode): void => {
      everything.add(node.path);
      node.children.forEach(mark);
    };
    roots.forEach(mark);
    return visibleRows(roots, everything);
  }, [roots]);

  const problem = name === '' ? null : folderNameProblem(name);
  const disabled = isDisabled?.(chosen) ?? false;

  const make = async (): Promise<void> => {
    if (name === '' || problem) return;
    setBusy(true);
    const folder = joinFolder(chosen, name);
    const made = await createFolder(folder);
    setBusy(false);
    if (made) {
      setChosen(folder);
      setName('');
    }
  };

  const onListKey = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
    const options = [...(listRef.current?.querySelectorAll<HTMLElement>('[role="option"]') ?? [])];
    const at = options.indexOf(document.activeElement as HTMLElement);
    const next =
      options[Math.max(0, Math.min(options.length - 1, at + (event.key === 'ArrowDown' ? 1 : -1)))];
    if (!next) return;
    event.preventDefault();
    next.focus();
  };

  const option = (path: string | null, label: string, depth: number, count: number | null) => {
    const selected = chosen === path;
    return (
      <button
        key={path ?? '(root)'}
        type="button"
        role="option"
        aria-selected={selected}
        tabIndex={selected ? 0 : -1}
        data-testid="folder-option"
        data-path={path ?? ''}
        onClick={() => setChosen(path)}
        onDoubleClick={() => {
          if (!(isDisabled?.(path) ?? false)) props.onConfirm(path);
        }}
        style={{ paddingLeft: 10 + depth * 18 }}
        className={cn(
          'flex w-full items-center gap-2 rounded-lg py-1.5 pr-2.5 text-left text-sm',
          selected ? 'bg-accent-soft text-accent-fg' : 'text-fg hover:bg-surface-3',
          (isDisabled?.(path) ?? false) && 'opacity-50',
        )}
      >
        {path === null ? (
          <Library className="size-4 shrink-0" aria-hidden="true" />
        ) : (
          <Folder className="size-4 shrink-0" aria-hidden="true" />
        )}
        <span className="min-w-0 flex-1 truncate">{label}</span>
        {count !== null ? (
          <span className="text-xs text-fg-subtle tabular-nums">{count}</span>
        ) : null}
      </button>
    );
  };

  return (
    <div className="p-6">
      <h2 className="text-lg font-semibold text-fg">{props.title}</h2>
      <div
        ref={listRef}
        role="listbox"
        aria-label="Folders"
        onKeyDown={onListKey}
        className="mt-4 max-h-72 overflow-y-auto rounded-xl border border-line bg-surface-2 p-1.5"
      >
        {option(null, props.rootLabel, 0, tree?.rootCount ?? null)}
        {rows.map((node) => option(node.path, node.name, node.depth, node.info.count))}
      </div>
      <div className="mt-3">
        <label className="text-[13px] text-fg-muted" htmlFor="folder-picker-new">
          New folder in “{folderLabel(chosen)}”
        </label>
        <div className="mt-1 flex gap-2">
          <input
            id="folder-picker-new"
            data-testid="folder-picker-new"
            value={name}
            maxLength={80}
            onChange={(event) => setName(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                event.preventDefault();
                void make();
              }
            }}
            aria-invalid={problem !== null}
            aria-describedby="folder-picker-problem"
            placeholder="Folder name"
            className="selectable h-9 min-w-0 flex-1 rounded-lg border border-control bg-surface px-3 text-[13px] text-fg placeholder:text-fg-subtle focus-visible:border-accent"
          />
          <Button
            size="sm"
            variant="secondary"
            data-testid="folder-picker-create"
            icon={<FolderPlus className="size-4" aria-hidden="true" />}
            disabled={name === '' || problem !== null || busy}
            onClick={() => void make()}
          >
            Create
          </Button>
        </div>
        <p id="folder-picker-problem" className="mt-1 min-h-4 text-xs text-danger" role="status">
          {problem ?? ''}
        </p>
      </div>
      <div className="mt-4 flex justify-end gap-2.5">
        <Button variant="secondary" data-testid="folder-picker-cancel" onClick={props.onClose}>
          Cancel
        </Button>
        <Button
          variant="primary"
          data-testid="folder-picker-confirm"
          disabled={disabled}
          onClick={() => props.onConfirm(chosen)}
        >
          {props.confirmLabel}
        </Button>
      </div>
    </div>
  );
}
