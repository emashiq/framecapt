import type { KeyboardEvent, MouseEvent, Ref } from 'react';
import { FileX2, Link2, MoreHorizontal, Pencil, Trash2 } from 'lucide-react';
import type { HistoryItemView } from '../../../shared/history-ipc';
import { formatBytes, formatDuration } from '../../../shared/recording';
import { IconButton } from '../../components/ui/IconButton';
import { TypeIcon } from '../../history/type-icon';
import { cn } from '../../lib/cn';
import { formatExact, formatRelative } from '../../lib/time';
import { canEditItem, editLabel, type ItemActions } from '../history/actions';
import { MultiBadge } from '../history/HistoryCard';
import { Thumb } from '../history/Thumb';

const TYPE_LABEL = { screenshot: 'Screenshot', recording: 'Recording', flow: 'Guide' } as const;

/** Column widths shared by the header and the rows; the optional ones drop out as the pane narrows. */
const COL = {
  type: 'hidden w-28 shrink-0 items-center gap-1.5 @2xl:flex',
  size: 'hidden w-20 shrink-0 text-right tabular-nums @2xl:block',
  duration: 'hidden w-16 shrink-0 text-right tabular-nums @3xl:block',
  date: 'w-28 shrink-0 @3xl:w-32',
  folder: 'hidden w-36 shrink-0 truncate @4xl:block',
} as const;

function folderText(item: HistoryItemView): string {
  if (item.outside) return 'Other location';
  return item.folder ? item.folder.split('/').join(' / ') : 'Library';
}

export interface LibraryListProps {
  items: readonly HistoryItemView[];
  now: number;
  /** The row that is the list's one tab stop. */
  activeId: string | undefined;
  selection: ReadonlySet<string>;
  selectMode: boolean;
  actions: ItemActions;
  listRef: Ref<HTMLUListElement>;
  onSelect: (item: HistoryItemView) => void;
  onEdit?: (item: HistoryItemView) => void;
  onSelectClick: (item: HistoryItemView, modifiers: { ctrl: boolean; shift: boolean }) => void;
  onToggleSelect: (item: HistoryItemView) => void;
  onContextMenu: (item: HistoryItemView, point: { x: number; y: number }) => void;
  onDragOut: ((item: HistoryItemView) => void) | null;
  onItemsDrag: (item: HistoryItemView, transfer: DataTransfer) => void;
  onKeyDown: (event: KeyboardEvent<HTMLUListElement>) => void;
  onKeyUp: (event: KeyboardEvent<HTMLUListElement>) => void;
}

/**
 * The Library as a table: a 48 px thumbnail, the name, kind, size, length, age and folder. Same
 * behaviours as the grid (selection, drag to a folder, context menu, arrow keys); rows share the
 * grid's `data-card-main` buttons, so one keyboard handler serves both.
 */
export function LibraryList(props: LibraryListProps) {
  const { now, actions, listRef, onKeyDown, onKeyUp } = props;
  return (
    <div className="@container" data-testid="history-list-wrap">
      <div
        aria-hidden="true"
        className="sticky top-0 z-[1] flex items-center gap-3 border-b border-line bg-bg px-5 py-2 pl-[6.5rem] text-[11px] font-semibold tracking-wider text-fg-subtle uppercase"
      >
        <span className="min-w-0 flex-1">Name</span>
        <span className={COL.type}>Type</span>
        <span className={COL.size}>Size</span>
        <span className={COL.duration}>Length</span>
        <span className={COL.date}>Date</span>
        <span className={COL.folder}>Folder</span>
        <span className="w-16 shrink-0" />
      </div>
      <ul
        ref={listRef}
        data-testid="history-list"
        aria-label="Captures"
        onKeyDown={onKeyDown}
        onKeyUp={onKeyUp}
      >
        {props.items.map((item) => {
          const selected = props.selection.has(item.id);
          const missing = !item.exists;
          const tabStop = item.id === props.activeId;
          const stem =
            item.type === 'flow' ? item.fileName : item.fileName.replace(/[.][^.]+$/, '');
          const kind = item.projectFile
            ? `${TYPE_LABEL[item.type]} project`
            : TYPE_LABEL[item.type];
          const openMenu = (event: MouseEvent<HTMLElement>): void => {
            event.preventDefault();
            const rect = event.currentTarget.getBoundingClientRect();
            const fromMouse = event.button === 2;
            props.onContextMenu(item, {
              x: fromMouse ? event.clientX : rect.left + 24,
              y: fromMouse ? event.clientY : rect.bottom - 8,
            });
          };
          return (
            <li
              key={item.id}
              className="group/card relative border-b border-line"
              data-testid="history-item"
              data-selected={selected || undefined}
              onContextMenu={openMenu}
            >
              <button
                type="button"
                data-card-main=""
                data-id={item.id}
                data-type={item.type}
                data-missing={missing || undefined}
                tabIndex={tabStop ? 0 : -1}
                aria-label={`${item.fileName}, ${kind.toLowerCase()}, ${formatRelative(item.createdAt, now)}${missing ? ', file missing' : ''}${selected ? ', selected' : ''}`}
                draggable={!missing && (props.onDragOut !== null || item.type !== 'flow')}
                onDragStart={(event) => {
                  const fileDrag = props.onDragOut !== null && item.type !== 'flow';
                  // Inside the window a drag moves the item to a folder; Alt drags the file out.
                  if (!(event.altKey && fileDrag)) {
                    props.onItemsDrag(item, event.dataTransfer);
                    return;
                  }
                  event.preventDefault();
                  if (props.onDragOut && !missing) props.onDragOut(item);
                }}
                onClick={(event) => {
                  if (event.ctrlKey || event.metaKey || event.shiftKey) {
                    props.onSelectClick(item, {
                      ctrl: event.ctrlKey || event.metaKey,
                      shift: event.shiftKey,
                    });
                  } else props.onSelect(item);
                }}
                className={cn(
                  'flex h-14 w-full items-center gap-3 py-1.5 pr-5 pl-[6.5rem] text-left text-[13px] transition-colors duration-100',
                  selected ? 'bg-accent-soft' : 'hover:bg-surface-2',
                )}
              >
                <span className="absolute top-1/2 left-11 flex -translate-y-1/2">
                  <Thumb item={item} className="size-12 rounded-md border border-line" />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="flex items-center gap-2">
                    <span className="truncate font-medium text-fg" title={item.fileName}>
                      {stem}
                    </span>
                    <MultiBadge item={item} />
                  </span>
                  <span className="block truncate text-xs text-fg-subtle">
                    {missing ? (
                      <span className="inline-flex items-center gap-1 text-fg-muted">
                        <FileX2 className="size-3" aria-hidden="true" />
                        File moved or deleted
                      </span>
                    ) : item.width > 0 ? (
                      `${item.width} × ${item.height}`
                    ) : (
                      ''
                    )}
                  </span>
                </span>
                <span className={cn(COL.type, 'text-fg-muted')}>
                  <TypeIcon
                    type={item.type}
                    project={item.projectFile}
                    className="size-3.5 shrink-0"
                    aria-hidden="true"
                  />
                  {kind}
                </span>
                <span className={cn(COL.size, 'text-fg-muted')}>{formatBytes(item.sizeBytes)}</span>
                <span className={cn(COL.duration, 'text-fg-muted')}>
                  {item.durationMs !== null ? formatDuration(item.durationMs) : ''}
                </span>
                <span
                  className={cn(COL.date, 'truncate text-fg-muted')}
                  title={formatExact(item.createdAt)}
                  data-testid="history-time"
                >
                  {formatRelative(item.createdAt, now)}
                </span>
                <span className={cn(COL.folder, 'text-fg-muted')} title={folderText(item)}>
                  {folderText(item)}
                </span>
                <span className="w-16 shrink-0" />
              </button>

              <label
                className={cn(
                  'absolute top-1/2 left-4 flex size-7 -translate-y-1/2 items-center justify-center rounded-md',
                  'transition-opacity duration-150 group-focus-within/card:opacity-100 group-hover/card:opacity-100',
                  selected || props.selectMode ? 'opacity-100' : 'opacity-0',
                )}
              >
                <span className="sr-only">{`Select ${item.fileName}`}</span>
                <input
                  type="checkbox"
                  data-testid="history-select"
                  checked={selected}
                  tabIndex={tabStop ? 0 : -1}
                  onChange={() => props.onToggleSelect(item)}
                  className="size-4 cursor-pointer accent-[var(--color-accent-solid)]"
                />
              </label>

              <div className="absolute top-1/2 right-3 flex -translate-y-1/2 gap-0.5">
                {missing ? (
                  <>
                    <IconButton
                      size="sm"
                      variant="ghost"
                      aria-label="Locate the file"
                      data-testid="history-locate"
                      className="size-7"
                      icon={<Link2 className="size-4" />}
                      onClick={() => actions.locate(item)}
                    />
                    <IconButton
                      size="sm"
                      variant="ghost"
                      aria-label="Remove from history"
                      data-testid="history-remove"
                      className="size-7"
                      icon={<Trash2 className="size-4" />}
                      onClick={() => actions.remove(item)}
                    />
                  </>
                ) : (
                  <div className="flex gap-0.5 opacity-0 transition-opacity duration-150 group-focus-within/card:opacity-100 group-hover/card:opacity-100">
                    {canEditItem(item) && props.onEdit ? (
                      <IconButton
                        size="sm"
                        variant="ghost"
                        aria-label={editLabel(item)}
                        data-testid="history-edit"
                        className="size-7"
                        icon={<Pencil className="size-4" />}
                        onClick={() => props.onEdit?.(item)}
                      />
                    ) : null}
                    <IconButton
                      size="sm"
                      variant="ghost"
                      aria-label="More actions"
                      data-testid="history-more"
                      className="size-7"
                      icon={<MoreHorizontal className="size-4" />}
                      onClick={openMenu}
                    />
                  </div>
                )}
              </div>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
