import { Fragment } from 'react';
import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import {
  ArrowUpDown,
  Check,
  ChevronRight,
  FolderSearch,
  LayoutGrid,
  List,
  MoreHorizontal,
  PanelLeftOpen,
  Search,
  Trash2,
  X,
} from 'lucide-react';
import { folderBaseName } from '../../../shared/library';
import { Button } from '../../components/ui/Button';
import { IconButton } from '../../components/ui/IconButton';
import { cn } from '../../lib/cn';
import type { FolderSelection } from '../../library/tree';
import type { LibrarySort, LibraryViewMode } from '../../library/view-prefs';
import { menuItemClass } from '../history/HistoryCard';

const SORTS: { value: LibrarySort; label: string }[] = [
  { value: 'newest', label: 'Newest first' },
  { value: 'oldest', label: 'Oldest first' },
  { value: 'name', label: 'Name' },
  { value: 'size', label: 'Size' },
];

const TYPE_LABEL = { screenshot: 'Screenshots', recording: 'Recordings', flow: 'Guides' } as const;

interface Crumb {
  label: string;
  /** Where a click goes; null for the last crumb (where you are). */
  to: FolderSelection | null;
}

/** "Library > Clients > Acme": every crumb but the last takes you there. */
export function crumbsFor(scope: FolderSelection): Crumb[] {
  const root: Crumb = { label: 'Library', to: { kind: 'all' } };
  switch (scope.kind) {
    case 'all':
      return [{ ...root, to: null }];
    case 'recent':
      return [root, { label: 'Recent', to: null }];
    case 'type':
      return [root, { label: TYPE_LABEL[scope.type], to: null }];
    case 'other':
      return [root, { label: 'Other locations', to: null }];
    case 'folder': {
      const parts = scope.path.split('/');
      return [
        root,
        ...parts.map((part, index) => ({
          label: index === parts.length - 1 ? folderBaseName(scope.path) : part,
          to:
            index === parts.length - 1
              ? null
              : ({ kind: 'folder', path: parts.slice(0, index + 1).join('/') } as const),
        })),
      ];
    }
  }
}

export interface LibraryHeaderProps {
  scope: FolderSelection;
  onScope: (scope: FolderSelection) => void;
  /** The sidebar is hidden: a button brings it back. */
  sidebarHidden: boolean;
  onShowSidebar: () => void;
  /** The count line ("12 items"); empty until the list has loaded. */
  countText: string;
  /** Search, sort, view and the menu show once there is something to look at. */
  showControls: boolean;
  query: string;
  onQuery: (query: string) => void;
  sort: LibrarySort;
  onSort: (sort: LibrarySort) => void;
  view: LibraryViewMode;
  onView: (view: LibraryViewMode) => void;
  includeSubfolders: boolean;
  onIncludeSubfolders: (value: boolean) => void;
  onFindExisting: () => void;
  missingCount: number;
  onClearMissing: () => void;
}

/**
 * The top of the Library's content: breadcrumb and count on the left; search, sort, the grid or
 * list switch and a menu (include subfolders, find existing captures) on the right.
 */
export function LibraryHeader(props: LibraryHeaderProps) {
  const crumbs = crumbsFor(props.scope);
  return (
    <header
      data-testid="library-header"
      className="flex shrink-0 flex-wrap items-center justify-between gap-x-4 gap-y-2 border-b border-line px-5 py-2.5"
    >
      <div className="flex min-w-0 items-center gap-2">
        {props.sidebarHidden ? (
          <IconButton
            size="sm"
            variant="ghost"
            aria-label="Show sidebar (Ctrl+B)"
            data-testid="folder-pane-expand"
            className="size-7"
            icon={<PanelLeftOpen className="size-4" />}
            onClick={props.onShowSidebar}
          />
        ) : null}
        <nav aria-label="Breadcrumb" data-testid="library-breadcrumb" className="min-w-0">
          <ol className="flex min-w-0 items-center gap-0.5 text-[13px]">
            {crumbs.map((crumb, index) => (
              <Fragment key={`${index}-${crumb.label}`}>
                {index > 0 ? (
                  <li aria-hidden="true" className="text-fg-subtle">
                    <ChevronRight className="size-3.5" />
                  </li>
                ) : null}
                <li className="min-w-0">
                  {crumb.to ? (
                    <button
                      type="button"
                      data-testid="crumb"
                      onClick={() => props.onScope(crumb.to as FolderSelection)}
                      className="max-w-40 truncate rounded-md px-1.5 py-0.5 text-fg-muted hover:bg-surface-3 hover:text-fg"
                    >
                      {crumb.label}
                    </button>
                  ) : (
                    <span
                      aria-current="page"
                      data-testid="crumb-current"
                      className="block max-w-56 truncate px-1.5 py-0.5 text-sm font-semibold text-fg"
                    >
                      {crumb.label}
                    </span>
                  )}
                </li>
              </Fragment>
            ))}
          </ol>
        </nav>
        <p
          className="shrink-0 text-xs text-fg-subtle"
          data-testid="history-count"
          aria-live="polite"
        >
          {props.countText}
        </p>
      </div>

      {props.showControls ? (
        <div className="flex flex-wrap items-center gap-2">
          <label className="relative block">
            <span className="sr-only">Search the library</span>
            <Search
              className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-fg-subtle"
              aria-hidden="true"
            />
            <input
              type="search"
              data-testid="history-search"
              value={props.query}
              onChange={(event) => props.onQuery(event.target.value)}
              placeholder="Search library"
              className="selectable h-8 w-52 rounded-lg border border-control bg-surface pr-7 pl-8 text-[13px] text-fg placeholder:text-fg-subtle focus-visible:border-accent [&::-webkit-search-cancel-button]:hidden"
            />
            {props.query ? (
              <button
                type="button"
                aria-label="Clear search"
                onClick={() => props.onQuery('')}
                className="absolute top-1/2 right-1 flex size-6 -translate-y-1/2 items-center justify-center rounded-md text-fg-subtle hover:bg-surface-3 hover:text-fg"
              >
                <X className="size-3.5" aria-hidden="true" />
              </button>
            ) : null}
          </label>

          <DropdownMenu.Root>
            <DropdownMenu.Trigger asChild>
              <Button
                size="sm"
                variant="ghost"
                data-testid="library-sort"
                icon={<ArrowUpDown className="size-3.5" aria-hidden="true" />}
              >
                {SORTS.find((entry) => entry.value === props.sort)?.label ?? 'Sort'}
              </Button>
            </DropdownMenu.Trigger>
            <DropdownMenu.Portal>
              <DropdownMenu.Content
                align="end"
                sideOffset={6}
                aria-label="Sort by"
                className="z-50 min-w-44 rounded-xl border border-line bg-surface p-1.5 text-fg shadow-raised"
              >
                <DropdownMenu.RadioGroup
                  value={props.sort}
                  onValueChange={(value) => props.onSort(value as LibrarySort)}
                >
                  {SORTS.map((entry) => (
                    <DropdownMenu.RadioItem
                      key={entry.value}
                      value={entry.value}
                      data-testid={`sort-${entry.value}`}
                      className={cn(menuItemClass, 'relative pl-8')}
                    >
                      <DropdownMenu.ItemIndicator className="absolute left-2.5">
                        <Check className="size-4" aria-hidden="true" />
                      </DropdownMenu.ItemIndicator>
                      {entry.label}
                    </DropdownMenu.RadioItem>
                  ))}
                </DropdownMenu.RadioGroup>
              </DropdownMenu.Content>
            </DropdownMenu.Portal>
          </DropdownMenu.Root>

          <div
            role="radiogroup"
            aria-label="View"
            className="inline-flex rounded-lg border border-line bg-surface-2 p-0.5"
          >
            {(
              [
                { value: 'grid', label: 'Grid view', icon: LayoutGrid },
                { value: 'list', label: 'List view', icon: List },
              ] as const
            ).map(({ value, label, icon: Icon }) => (
              <button
                key={value}
                type="button"
                role="radio"
                aria-checked={props.view === value}
                aria-label={label}
                title={label}
                data-testid={`library-view-${value}`}
                onClick={() => props.onView(value)}
                className={cn(
                  'flex size-7 items-center justify-center rounded-md transition-colors duration-150',
                  props.view === value
                    ? 'bg-surface text-fg shadow-card'
                    : 'text-fg-muted hover:text-fg',
                )}
              >
                <Icon className="size-4" aria-hidden="true" />
              </button>
            ))}
          </div>

          <DropdownMenu.Root>
            <DropdownMenu.Trigger asChild>
              <IconButton
                size="sm"
                variant="ghost"
                aria-label="More options"
                data-testid="library-more"
                icon={<MoreHorizontal className="size-4" />}
              />
            </DropdownMenu.Trigger>
            <DropdownMenu.Portal>
              <DropdownMenu.Content
                align="end"
                sideOffset={6}
                className="z-50 min-w-60 rounded-xl border border-line bg-surface p-1.5 text-fg shadow-raised"
              >
                {props.scope.kind === 'folder' ? (
                  <>
                    <DropdownMenu.CheckboxItem
                      checked={props.includeSubfolders}
                      onCheckedChange={props.onIncludeSubfolders}
                      data-testid="folder-include-sub"
                      className={cn(menuItemClass, 'relative pl-8')}
                    >
                      <DropdownMenu.ItemIndicator className="absolute left-2.5">
                        <Check className="size-4" aria-hidden="true" />
                      </DropdownMenu.ItemIndicator>
                      Include subfolders
                    </DropdownMenu.CheckboxItem>
                    <DropdownMenu.Separator className="my-1 h-px bg-line" />
                  </>
                ) : null}
                <DropdownMenu.Item
                  data-testid="history-find-existing"
                  onSelect={props.onFindExisting}
                  className={menuItemClass}
                >
                  <FolderSearch className="size-4 text-fg-subtle" aria-hidden="true" />
                  Find existing captures
                </DropdownMenu.Item>
                {props.missingCount > 0 ? (
                  <DropdownMenu.Item
                    data-testid="history-clear-missing"
                    onSelect={props.onClearMissing}
                    className={menuItemClass}
                  >
                    <Trash2 className="size-4 text-fg-subtle" aria-hidden="true" />
                    Clear {props.missingCount} missing
                  </DropdownMenu.Item>
                ) : null}
              </DropdownMenu.Content>
            </DropdownMenu.Portal>
          </DropdownMenu.Root>
        </div>
      ) : null}
    </header>
  );
}
