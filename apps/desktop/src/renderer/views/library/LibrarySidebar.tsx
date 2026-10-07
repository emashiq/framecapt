import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type DragEvent,
  type KeyboardEvent,
  type MouseEvent,
  type PointerEvent,
  type ReactNode,
} from 'react';
import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import {
  ArrowUpToLine,
  ChevronRight,
  Clock,
  Folder,
  FolderInput,
  FolderOpen,
  FolderPlus,
  Image as ImageIcon,
  Library,
  ListOrdered,
  MapPin,
  Pencil,
  Pin,
  PanelLeftClose,
  Trash2,
  Video,
  type LucideIcon,
} from 'lucide-react';
import {
  folderNameProblem,
  isInsideFolder,
  joinFolder,
  type LibraryTree,
} from '../../../shared/library';
import { AlertConfirm } from '../../components/ui/AlertConfirm';
import { IconButton } from '../../components/ui/IconButton';
import { Tooltip } from '../../components/ui/Tooltip';
import { cn } from '../../lib/cn';
import {
  createFolder,
  deleteFolder,
  moveContentsUp,
  moveItemsTo,
  renameFolder,
  revealFolder,
  setCaptureFolder,
} from '../../library/actions';
import { hasItemsDrag, readDraggedIds } from '../../library/dnd';
import {
  ancestorsOf,
  buildTree,
  folderLabel,
  visibleRows,
  type FolderNode,
  type FolderSelection,
} from '../../library/tree';
import {
  SIDEBAR_DEFAULT,
  SIDEBAR_MAX,
  SIDEBAR_MIN,
  setLibraryPrefs,
} from '../../library/view-prefs';
import { menuItemClass } from '../history/HistoryCard';

/** How many captures each smart item has (muted, right-aligned). */
export interface SmartCounts {
  all: number;
  recent: number;
  screenshot: number;
  recording: number;
  flow: number;
}

export interface LibrarySidebarProps {
  tree: LibraryTree | null;
  counts: SmartCounts;
  selection: FolderSelection;
  onSelect: (selection: FolderSelection) => void;
  /** Width in px (200..360). */
  width: number;
  /** Called after items were moved by a drop (the list reloads itself). */
  onMoved?: () => void;
}

const SMART_ITEMS: {
  key: string;
  label: string;
  icon: LucideIcon;
  selection: FolderSelection;
  count: keyof SmartCounts;
}[] = [
  { key: 'all', label: 'All captures', icon: Library, selection: { kind: 'all' }, count: 'all' },
  { key: 'recent', label: 'Recent', icon: Clock, selection: { kind: 'recent' }, count: 'recent' },
  {
    key: 'type:screenshot',
    label: 'Screenshots',
    icon: ImageIcon,
    selection: { kind: 'type', type: 'screenshot' },
    count: 'screenshot',
  },
  {
    key: 'type:recording',
    label: 'Recordings',
    icon: Video,
    selection: { kind: 'type', type: 'recording' },
    count: 'recording',
  },
  {
    key: 'type:flow',
    label: 'Guides',
    icon: ListOrdered,
    selection: { kind: 'type', type: 'flow' },
    count: 'flow',
  },
];

interface MenuTarget {
  /** null = the root ("All captures"). */
  folder: string | null;
  x: number;
  y: number;
}

/** Which folders were open, kept while the app runs so hiding the sidebar and coming back looks the same. */
let rememberedExpanded: ReadonlySet<string> = new Set();

const keyOf = (folder: string): string => `f:${folder}`;
const ALL_KEY = 'all';
const OTHER_KEY = 'other';
const SMART_KEYS = SMART_ITEMS.map((item) => item.key);

/** The key of the row a selection highlights (folders are resolved by the caller). */
function smartKey(selection: FolderSelection): string | null {
  switch (selection.kind) {
    case 'all':
      return ALL_KEY;
    case 'recent':
      return 'recent';
    case 'type':
      return `type:${selection.type}`;
    case 'other':
      return OTHER_KEY;
    case 'folder':
      return null;
  }
}

const sameName = (a: string | null, b: string | null): boolean =>
  a !== null && b !== null && a.toLowerCase() === b.toLowerCase();

/**
 * The Library's sidebar: the smart items (All captures, Recent, Screenshots, Recordings, Guides),
 * the tree of real folders (with counts) and "Other locations". An ARIA tree with the usual keys
 * (arrows, Enter, F2 rename, Delete), drop targets for captures and a context menu per folder.
 * Every change goes through the library channels. The width is dragged at its right edge.
 */
export function LibrarySidebar({
  tree,
  counts,
  selection,
  onSelect,
  width,
  onMoved,
}: LibrarySidebarProps) {
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => rememberedExpanded);
  useEffect(() => {
    rememberedExpanded = expanded;
  }, [expanded]);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [creating, setCreating] = useState<{ parent: string | null } | null>(null);
  const [menu, setMenu] = useState<MenuTarget | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const [dragOver, setDragOver] = useState<string | null>(null);
  const [focusKey, setFocusKey] = useState(ALL_KEY);
  const treeRef = useRef<HTMLUListElement>(null);

  const roots = useMemo(() => buildTree(tree?.folders ?? []), [tree]);
  const rows = useMemo(() => visibleRows(roots, expanded), [roots, expanded]);
  const captureFolder = tree?.captureFolder ?? null;

  // The folder that is shown stays visible: when the selection moves, its parents open up.
  const selectedFolder = selection.kind === 'folder' ? selection.path : null;
  const [shownFor, setShownFor] = useState<string | null>(null);
  if (selectedFolder !== shownFor) {
    setShownFor(selectedFolder);
    if (selectedFolder !== null) {
      const missing = ancestorsOf(selectedFolder).filter((path) => !expanded.has(path));
      if (missing.length > 0) setExpanded(new Set([...expanded, ...missing]));
    }
  }

  const toggleExpanded = useCallback((folder: string, open?: boolean) => {
    setExpanded((current) => {
      const next = new Set(current);
      const want = open ?? !next.has(folder);
      if (want) next.add(folder);
      else next.delete(folder);
      return next;
    });
  }, []);

  const keys = useMemo(
    () => [
      ...SMART_KEYS,
      ...rows.map((node) => keyOf(node.path)),
      ...((tree?.otherCount ?? 0) > 0 ? [OTHER_KEY] : []),
    ],
    [rows, tree?.otherCount],
  );
  const focusRow = (key: string): void => {
    setFocusKey(key);
    treeRef.current?.querySelector<HTMLElement>(`[data-key="${CSS.escape(key)}"]`)?.focus();
  };

  const selectedNode =
    selection.kind === 'folder'
      ? rows.find((node) => sameName(node.path, selection.path))
      : undefined;
  const selectedKey = smartKey(selection) ?? (selectedNode ? keyOf(selectedNode.path) : '');
  const tabKey = keys.includes(focusKey) ? focusKey : ALL_KEY;

  const startCreate = (parent: string | null): void => {
    if (parent !== null) toggleExpanded(parent, true);
    setCreating({ parent });
  };

  const commitCreate = async (name: string): Promise<void> => {
    const parent = creating?.parent ?? null;
    setCreating(null);
    const folder = joinFolder(parent, name);
    if (await createFolder(folder)) {
      if (parent !== null) toggleExpanded(parent, true);
      onSelect({ kind: 'folder', path: folder });
    }
  };

  const commitRename = async (folder: string, name: string): Promise<void> => {
    setRenaming(null);
    if (name === folder.slice(folder.lastIndexOf('/') + 1)) return;
    const next = await renameFolder(folder, name);
    if (next === null) return;
    const move = (path: string): string =>
      isInsideFolder(path, folder) ? next + path.slice(folder.length) : path;
    setExpanded((current) => new Set([...current].map(move)));
    if (selection.kind === 'folder' && isInsideFolder(selection.path, folder)) {
      onSelect({ kind: 'folder', path: move(selection.path) });
    }
  };

  const drop = (event: DragEvent, folder: string | null): void => {
    setDragOver(null);
    if (!hasItemsDrag(event.dataTransfer)) return;
    event.preventDefault();
    const ids = readDraggedIds(event.dataTransfer);
    if (ids.length > 0) void moveItemsTo(ids, folder).then((moved) => moved && onMoved?.());
  };
  const dropProps = (key: string, folder: string | null) => ({
    onDragOver: (event: DragEvent) => {
      if (!hasItemsDrag(event.dataTransfer)) return;
      event.preventDefault();
      event.dataTransfer.dropEffect = 'move';
      setDragOver(key);
    },
    onDragLeave: (event: DragEvent) => {
      if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDragOver(null);
    },
    onDrop: (event: DragEvent) => drop(event, folder),
  });

  const openMenuFor = (folder: string | null, event: MouseEvent<HTMLElement>): void => {
    event.preventDefault();
    const rect = event.currentTarget.getBoundingClientRect();
    const fromMouse = event.button === 2;
    setMenu({
      folder,
      x: fromMouse ? event.clientX : rect.left + 24,
      y: fromMouse ? event.clientY : rect.bottom - 8,
    });
  };

  const onTreeKeyDown = (event: KeyboardEvent<HTMLUListElement>): void => {
    const target = event.target as HTMLElement;
    if (target.tagName === 'INPUT') return;
    const key = target.dataset.key;
    if (!key) return;
    const index = keys.indexOf(key);
    const node = rows.find((row) => keyOf(row.path) === key);
    const go = (to: number): void => {
      event.preventDefault();
      const next = keys[Math.max(0, Math.min(keys.length - 1, to))];
      if (next) focusRow(next);
    };
    switch (event.key) {
      case 'ArrowDown':
        return go(index + 1);
      case 'ArrowUp':
        return go(index - 1);
      case 'Home':
        return go(0);
      case 'End':
        return go(keys.length - 1);
      case 'ArrowRight':
        if (node && node.children.length > 0) {
          event.preventDefault();
          if (!expanded.has(node.path)) toggleExpanded(node.path, true);
          else go(index + 1);
        }
        return;
      case 'ArrowLeft':
        if (!node) return;
        event.preventDefault();
        if (expanded.has(node.path) && node.children.length > 0) toggleExpanded(node.path, false);
        else {
          const parent = node.path.includes('/')
            ? node.path.slice(0, node.path.lastIndexOf('/'))
            : null;
          const parentKey = parent === null ? null : keys.find((k) => sameName(k, keyOf(parent)));
          if (parentKey) focusRow(parentKey);
        }
        return;
      case 'Enter':
      case ' ':
        event.preventDefault();
        if (key === OTHER_KEY) onSelect({ kind: 'other' });
        else if (node) onSelect({ kind: 'folder', path: node.path });
        else {
          const smart = SMART_ITEMS.find((item) => item.key === key);
          if (smart) onSelect(smart.selection);
        }
        return;
      case 'F2':
        if (node) {
          event.preventDefault();
          setRenaming(node.path);
        }
        return;
      case 'Delete':
        if (node) {
          event.preventDefault();
          setConfirmDelete(node.path);
        }
        return;
      default:
        if (event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10')) {
          event.preventDefault();
          const rect = target.getBoundingClientRect();
          if (key !== ALL_KEY && !node) return;
          setMenu({
            folder: node?.path ?? null,
            x: rect.left + 24,
            y: rect.bottom - 8,
          });
        }
    }
  };

  const siblingsOf = (node: FolderNode): { size: number; position: number } => {
    const parent = node.path.includes('/') ? node.path.slice(0, node.path.lastIndexOf('/')) : null;
    const list =
      parent === null ? roots : (rows.find((row) => sameName(row.path, parent))?.children ?? roots);
    return { size: list.length, position: list.indexOf(node) + 1 };
  };

  const renderCreateRow = (parent: string | null, depth: number): ReactNode => (
    <li role="none" key={`create:${parent ?? ''}`}>
      <NameField
        label="New folder name"
        initial=""
        depth={depth}
        onCommit={(name) => void commitCreate(name)}
        onCancel={() => setCreating(null)}
      />
    </li>
  );

  /** Drags the right edge: the sidebar's width, 200 to 360 px. */
  const startResize = (event: PointerEvent<HTMLDivElement>): void => {
    event.preventDefault();
    const handle = event.currentTarget;
    handle.setPointerCapture(event.pointerId);
    const startX = event.clientX;
    const startWidth = width;
    const move = (next: globalThis.PointerEvent): void =>
      setLibraryPrefs({ sidebarWidth: startWidth + next.clientX - startX });
    const stop = (): void => {
      handle.removeEventListener('pointermove', move);
      handle.removeEventListener('pointerup', stop);
      handle.removeEventListener('pointercancel', stop);
    };
    handle.addEventListener('pointermove', move);
    handle.addEventListener('pointerup', stop);
    handle.addEventListener('pointercancel', stop);
  };
  const onResizeKey = (event: KeyboardEvent<HTMLDivElement>): void => {
    const step = event.shiftKey ? 48 : 16;
    if (event.key === 'ArrowLeft') setLibraryPrefs({ sidebarWidth: width - step });
    else if (event.key === 'ArrowRight') setLibraryPrefs({ sidebarWidth: width + step });
    else if (event.key === 'Home') setLibraryPrefs({ sidebarWidth: SIDEBAR_MIN });
    else if (event.key === 'End') setLibraryPrefs({ sidebarWidth: SIDEBAR_MAX });
    else return;
    event.preventDefault();
  };

  return (
    <nav
      aria-label="Library"
      data-testid="folder-pane"
      style={{ width }}
      className="relative flex shrink-0 flex-col border-r border-line bg-pane"
    >
      <div className="flex h-11 shrink-0 items-center justify-between gap-2 pr-2 pl-4">
        <h2 className="text-[13px] font-semibold text-fg">Library</h2>
        <div className="flex items-center gap-0.5">
          <IconButton
            size="sm"
            variant="ghost"
            aria-label="New folder"
            data-testid="folder-new"
            className="size-7"
            icon={<FolderPlus className="size-4" />}
            onClick={() => startCreate(selection.kind === 'folder' ? selection.path : null)}
          />
          <IconButton
            size="sm"
            variant="ghost"
            aria-label="Hide sidebar (Ctrl+B)"
            data-testid="folder-pane-collapse"
            className="size-7"
            icon={<PanelLeftClose className="size-4" />}
            onClick={() => setLibraryPrefs({ sidebarCollapsed: true })}
          />
        </div>
      </div>
      <ul
        ref={treeRef}
        role="tree"
        aria-label="Capture folders"
        data-testid="folder-tree"
        onKeyDown={onTreeKeyDown}
        className="min-h-0 flex-1 overflow-y-auto px-2 pb-3"
      >
        {SMART_ITEMS.map((item) => (
          <Row
            key={item.key}
            rowKey={item.key}
            level={1}
            label={item.label}
            icon={<item.icon className="size-4 shrink-0 text-fg-subtle" aria-hidden="true" />}
            count={counts[item.count]}
            selected={selectedKey === item.key}
            dropping={dragOver === item.key}
            tabStop={tabKey === item.key}
            title={
              item.key === ALL_KEY
                ? 'All captures. Drop items here to move them out of their folder.'
                : item.label
            }
            onFocus={() => setFocusKey(item.key)}
            onClick={() => onSelect(item.selection)}
            {...(item.key === ALL_KEY
              ? {
                  onContextMenu: (event: MouseEvent<HTMLElement>) => openMenuFor(null, event),
                  ...dropProps(ALL_KEY, null),
                }
              : {})}
          />
        ))}
        <li role="presentation" className="px-2 pt-4 pb-1">
          <span className="text-[11px] font-semibold tracking-wider text-fg-subtle uppercase">
            Folders
          </span>
        </li>
        {creating?.parent === null ? renderCreateRow(null, 0) : null}
        {rows.length === 0 && creating === null ? (
          <li role="presentation" className="px-2 py-1 text-xs text-fg-subtle">
            No folders yet. Use + to make one.
          </li>
        ) : null}
        {rows.map((node) => {
          const key = keyOf(node.path);
          const open = expanded.has(node.path);
          const { size, position } = siblingsOf(node);
          return [
            <Row
              key={key}
              rowKey={key}
              level={node.depth}
              label={node.name}
              icon={
                open ? (
                  <FolderOpen className="size-4 shrink-0 text-accent-fg" aria-hidden="true" />
                ) : (
                  <Folder className="size-4 shrink-0 text-accent-fg" aria-hidden="true" />
                )
              }
              count={node.total}
              selected={selectedKey === key}
              dropping={dragOver === key}
              tabStop={tabKey === key}
              expandable={node.children.length > 0}
              expanded={open}
              isSaveFolder={sameName(captureFolder, node.path)}
              setSize={size}
              position={position}
              renaming={renaming === node.path}
              title={node.path.split('/').join(' / ')}
              onToggle={() => toggleExpanded(node.path)}
              onFocus={() => setFocusKey(key)}
              onClick={() => onSelect({ kind: 'folder', path: node.path })}
              onContextMenu={(event) => openMenuFor(node.path, event)}
              onRename={(name) => void commitRename(node.path, name)}
              onCancelRename={() => {
                setRenaming(null);
                focusRow(key);
              }}
              {...dropProps(key, node.path)}
            />,
            creating?.parent === node.path ? renderCreateRow(node.path, node.depth) : null,
          ];
        })}
        {(tree?.otherCount ?? 0) > 0 ? (
          <Row
            rowKey={OTHER_KEY}
            level={1}
            label="Other locations"
            icon={<FolderInput className="size-4 shrink-0 text-fg-subtle" aria-hidden="true" />}
            count={tree?.otherCount ?? 0}
            selected={selectedKey === OTHER_KEY}
            dropping={false}
            tabStop={tabKey === OTHER_KEY}
            title="Captures saved outside the capture folders. Drag them into a folder to bring them in."
            onFocus={() => setFocusKey(OTHER_KEY)}
            onClick={() => onSelect({ kind: 'other' })}
          />
        ) : null}
      </ul>
      <div
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize the sidebar"
        aria-valuemin={SIDEBAR_MIN}
        aria-valuemax={SIDEBAR_MAX}
        aria-valuenow={width}
        tabIndex={0}
        data-testid="sidebar-resize"
        onPointerDown={startResize}
        onKeyDown={onResizeKey}
        onDoubleClick={() => setLibraryPrefs({ sidebarWidth: SIDEBAR_DEFAULT })}
        className="absolute inset-y-0 -right-[3px] z-10 w-1.5 cursor-col-resize touch-none transition-colors duration-150 hover:bg-accent-solid/30 focus-visible:bg-accent-solid/50"
      />

      <DropdownMenu.Root
        modal={false}
        open={menu !== null}
        onOpenChange={(open) => {
          if (!open) setMenu(null);
        }}
      >
        <DropdownMenu.Trigger asChild>
          <span
            aria-hidden="true"
            style={{
              position: 'fixed',
              left: menu?.x ?? 0,
              top: menu?.y ?? 0,
              width: 1,
              height: 1,
            }}
          />
        </DropdownMenu.Trigger>
        <DropdownMenu.Portal>
          <DropdownMenu.Content
            data-testid="folder-menu"
            aria-label={menu?.folder ? `Folder ${folderLabel(menu.folder)}` : 'All captures'}
            align="start"
            sideOffset={2}
            collisionPadding={8}
            onCloseAutoFocus={(event) => {
              event.preventDefault();
              // A rename or new-folder field opened by the menu keeps the focus it took.
              if (!document.querySelector('[data-testid="folder-name-input"]')) focusRow(tabKey);
            }}
            className="z-50 min-w-60 rounded-xl border border-line bg-surface p-1.5 text-fg shadow-raised"
          >
            {menu ? (
              <FolderMenu
                folder={menu.folder}
                node={rows.find((row) => sameName(row.path, menu.folder))}
                tree={tree}
                captureFolder={captureFolder}
                onNew={() => startCreate(menu.folder)}
                onRename={() => menu.folder !== null && setRenaming(menu.folder)}
                onDelete={() => menu.folder !== null && setConfirmDelete(menu.folder)}
                onMoveUp={() => menu.folder !== null && void moveContentsUp(menu.folder)}
              />
            ) : null}
          </DropdownMenu.Content>
        </DropdownMenu.Portal>
      </DropdownMenu.Root>

      <AlertConfirm
        open={confirmDelete !== null}
        title="Delete this folder?"
        description={
          confirmDelete
            ? `“${folderLabel(confirmDelete)}” is removed from both capture folders. Only an empty folder can be deleted; your captures are never deleted by this.`
            : ''
        }
        cancelLabel="Keep folder"
        confirmLabel="Delete folder"
        onConfirm={() => {
          const folder = confirmDelete;
          setConfirmDelete(null);
          if (folder) void deleteFolder(folder);
        }}
        onCancel={() => setConfirmDelete(null)}
      />
    </nav>
  );
}

interface RowProps {
  rowKey: string;
  level: number;
  label: string;
  icon: ReactNode;
  count: number;
  selected: boolean;
  dropping: boolean;
  tabStop: boolean;
  title: string;
  expandable?: boolean;
  expanded?: boolean;
  isSaveFolder?: boolean;
  setSize?: number;
  position?: number;
  renaming?: boolean;
  onToggle?: () => void;
  onFocus: () => void;
  onClick: () => void;
  onContextMenu?: (event: MouseEvent<HTMLElement>) => void;
  onRename?: (name: string) => void;
  onCancelRename?: () => void;
  onDragOver?: (event: DragEvent) => void;
  onDragLeave?: (event: DragEvent) => void;
  onDrop?: (event: DragEvent) => void;
}

function Row(props: RowProps) {
  const { level, selected } = props;
  return (
    <li
      role="treeitem"
      aria-level={level}
      aria-selected={selected}
      {...(props.expandable ? { 'aria-expanded': props.expanded === true } : {})}
      {...(props.setSize !== undefined && { 'aria-setsize': props.setSize })}
      {...(props.position !== undefined && { 'aria-posinset': props.position })}
      aria-label={`${props.label}, ${props.count} ${props.count === 1 ? 'capture' : 'captures'}${
        props.isSaveFolder ? ', new captures are saved here' : ''
      }`}
      data-key={props.rowKey}
      data-testid="folder-row"
      data-path={props.rowKey.startsWith('f:') ? props.rowKey.slice(2) : `:${props.rowKey}`}
      data-selected={selected || undefined}
      data-drop={props.dropping || undefined}
      tabIndex={props.tabStop ? 0 : -1}
      title={props.title}
      onFocus={props.onFocus}
      onClick={props.onClick}
      onContextMenu={props.onContextMenu}
      onDragOver={props.onDragOver}
      onDragLeave={props.onDragLeave}
      onDrop={props.onDrop}
      style={{ paddingLeft: 4 + (level - 1) * 16 }}
      className={cn(
        'group/row flex h-7 cursor-pointer items-center gap-1.5 rounded-md pr-2 text-[13px] outline-none',
        'transition-colors duration-100 focus-visible:ring-2 focus-visible:ring-accent-solid/60 focus-visible:ring-inset',
        selected ? 'bg-accent-soft font-medium text-accent-fg' : 'text-fg hover:bg-surface-3',
        props.dropping && 'bg-accent-soft ring-2 ring-accent-solid ring-inset',
      )}
    >
      <span className="flex size-4 shrink-0 items-center justify-center">
        {props.expandable ? (
          <button
            type="button"
            tabIndex={-1}
            aria-hidden="true"
            data-testid="folder-chevron"
            onClick={(event) => {
              event.stopPropagation();
              props.onToggle?.();
            }}
            className="flex size-4 items-center justify-center rounded text-fg-subtle hover:bg-surface-3"
          >
            <ChevronRight
              className={cn(
                'size-3 transition-transform duration-150 motion-reduce:transition-none',
                props.expanded && 'rotate-90',
              )}
            />
          </button>
        ) : null}
      </span>
      {props.icon}
      {props.renaming ? (
        <NameField
          label="Folder name"
          initial={props.label}
          depth={0}
          inline
          onCommit={(name) => props.onRename?.(name)}
          onCancel={() => props.onCancelRename?.()}
        />
      ) : (
        <span className="min-w-0 flex-1 truncate" data-testid="folder-name">
          {props.label}
        </span>
      )}
      {props.isSaveFolder ? (
        <Tooltip content="New captures are saved here" side="right">
          <span
            data-testid="folder-save-badge"
            className="inline-flex shrink-0 items-center text-accent-fg"
          >
            <Pin className="size-3 fill-current" aria-hidden="true" />
            <span className="sr-only">Save location</span>
          </span>
        </Tooltip>
      ) : null}
      {!props.renaming ? (
        <span
          data-testid="folder-count"
          className={cn(
            'shrink-0 text-[11px] tabular-nums',
            selected ? 'text-accent-fg/80' : 'text-fg-subtle',
          )}
        >
          {props.count}
        </span>
      ) : null}
    </li>
  );
}

/** An inline name field: Enter keeps the name (when valid), Escape or leaving the field cancels. */
function NameField({
  label,
  initial,
  depth,
  inline,
  onCommit,
  onCancel,
}: {
  label: string;
  initial: string;
  depth: number;
  inline?: boolean;
  onCommit: (name: string) => void;
  onCancel: () => void;
}) {
  const [value, setValue] = useState(initial);
  const ref = useRef<HTMLInputElement>(null);
  const done = useRef(false);
  useEffect(() => {
    ref.current?.focus();
    ref.current?.select();
  }, []);
  const problem = value === '' ? null : folderNameProblem(value);
  const finish = (commit: boolean): void => {
    if (done.current) return;
    if (commit && (value === '' || problem)) return;
    done.current = true;
    if (commit) onCommit(value);
    else onCancel();
  };
  return (
    <span
      className={cn('flex min-w-0 flex-col', inline ? 'flex-1' : 'py-1 pr-2')}
      style={inline ? undefined : { paddingLeft: 4 + depth * 16 + 20 }}
      onClick={(event) => event.stopPropagation()}
    >
      <input
        ref={ref}
        value={value}
        aria-label={label}
        aria-invalid={problem !== null}
        data-testid="folder-name-input"
        maxLength={80}
        onChange={(event) => setValue(event.target.value)}
        onKeyDown={(event) => {
          event.stopPropagation();
          if (event.key === 'Enter') {
            event.preventDefault();
            finish(true);
          } else if (event.key === 'Escape') {
            event.preventDefault();
            finish(false);
          }
        }}
        onBlur={() => finish(false)}
        className="selectable h-7 min-w-0 rounded-md border border-accent bg-surface px-2 text-[13px] text-fg"
      />
      {problem ? (
        <span role="alert" className="mt-0.5 text-xs text-danger" data-testid="folder-name-problem">
          {problem}
        </span>
      ) : null}
    </span>
  );
}

function FolderMenu({
  folder,
  node,
  tree,
  captureFolder,
  onNew,
  onRename,
  onDelete,
  onMoveUp,
}: {
  folder: string | null;
  node: FolderNode | undefined;
  tree: LibraryTree | null;
  captureFolder: string | null;
  onNew: () => void;
  onRename: () => void;
  onDelete: () => void;
  onMoveUp: () => void;
}) {
  const info = node?.info ?? tree?.folders.find((entry) => sameName(entry.path, folder));
  const isSave = sameName(captureFolder, folder);
  const item = (
    testId: string,
    icon: ReactNode,
    label: string,
    onSelect: () => void,
    danger = false,
  ): ReactNode => (
    <DropdownMenu.Item
      key={testId}
      data-testid={testId}
      onSelect={onSelect}
      className={cn(menuItemClass, danger && 'text-danger data-[highlighted]:text-danger')}
    >
      <span className={danger ? '' : 'text-fg-subtle'} aria-hidden="true">
        {icon}
      </span>
      {label}
    </DropdownMenu.Item>
  );
  const ICON = 'size-4';
  return (
    <>
      {item(
        'folder-menu-new',
        <FolderPlus className={ICON} />,
        folder === null ? 'New folder' : 'New subfolder',
        onNew,
      )}
      {folder !== null ? (
        <>
          {item('folder-menu-rename', <Pencil className={ICON} />, 'Rename (F2)', onRename)}
          {item(
            'folder-menu-move-up',
            <ArrowUpToLine className={ICON} />,
            'Move contents to parent',
            onMoveUp,
          )}
          {item(
            'folder-menu-delete',
            <Trash2 className={ICON} />,
            'Delete (empty only)',
            onDelete,
            true,
          )}
        </>
      ) : null}
      <DropdownMenu.Separator className="my-1 h-px bg-line" />
      {folder !== null
        ? isSave
          ? item(
              'folder-menu-clear-save',
              <MapPin className={ICON} />,
              'Clear save location',
              () => void setCaptureFolder(null),
            )
          : item(
              'folder-menu-set-save',
              <MapPin className={ICON} />,
              'Set as save location',
              () => void setCaptureFolder(folder),
            )
        : captureFolder !== null
          ? item(
              'folder-menu-clear-save',
              <MapPin className={ICON} />,
              'Clear save location',
              () => void setCaptureFolder(null),
            )
          : null}
      {folder === null || info?.inScreenshots
        ? item(
            'folder-menu-reveal-shots',
            <FolderOpen className={ICON} />,
            'Show screenshots folder in Explorer',
            () => void revealFolder(folder, 'screenshots'),
          )
        : null}
      {folder === null || info?.inRecordings
        ? item(
            'folder-menu-reveal-videos',
            <FolderOpen className={ICON} />,
            'Show recordings folder in Explorer',
            () => void revealFolder(folder, 'recordings'),
          )
        : null}
    </>
  );
}
