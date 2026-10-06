import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { announce, notify } from '../lib/notify';
import { Camera, Clock, FolderSearch, Search, SearchX, Video, X } from 'lucide-react';
import type { HistoryItemView, HistoryType } from '../../shared/history-ipc';
import { AlertConfirm } from '../components/ui/AlertConfirm';
import { Button } from '../components/ui/Button';
import { EmptyState } from '../components/ui/EmptyState';
import { Segmented } from '../components/ui/Segmented';
import {
  cancelBulk,
  dismissBulkSummary,
  startBulkExport,
  useBulkState,
  useBulkSummary,
} from '../history/bulk-store';
import { useExportCapabilities } from '../history/use-export-capabilities';
import { useHistory } from '../history/use-history';
import { recordOptionsFromSettings } from '../../shared/settings';
import { getSettings } from '../settings/store';
import {
  createItemActions,
  deleteItemFile,
  deleteItemProject,
  removeItems,
  startItemDrag,
} from './history/actions';
import { BulkResultDialog } from './history/BulkResultDialog';
import { HistoryContextMenu, type ContextTarget } from './history/HistoryContextMenu';
import {
  clickSelect,
  EMPTY_SELECTION,
  prune,
  selectAll,
  selectionLabel,
  selectRange,
  toggle,
  type Selection,
} from './history/selection';
import { SelectionBar } from './history/SelectionBar';
import { HistoryCard } from './history/HistoryCard';
import { HistoryDetails } from './history/HistoryDetails';
import { useNow } from './history/use-now';

type Filter = 'all' | HistoryType;

const FILTERS = [
  { value: 'all', label: 'All' },
  { value: 'screenshot', label: 'Screenshots' },
  { value: 'recording', label: 'Recordings' },
] as const;

export interface HistoryViewProps {
  /** An item to open right away (chosen in the Recent captures strip). */
  focusId?: string | null;
  onFocusConsumed?: () => void;
  /** Opens a screenshot of history in the editor again. */
  onEditItem?: (id: string) => void;
}

/**
 * Everything FrameCapt captured, newest first: filter, search, a keyboard-navigable grid and a
 * details view with a preview and every action. Entries come from main by id; moved or deleted
 * files stay listed in a calm "File moved or deleted" state until the user re-links or removes
 * them. Removing an entry never touches its file; deleting a file is a separate confirmed action.
 */
export function HistoryView({ focusId = null, onFocusConsumed, onEditItem }: HistoryViewProps) {
  const [filter, setFilter] = useState<Filter>('all');
  const [queryInput, setQueryInput] = useState('');
  const [query, setQuery] = useState('');
  const [selectedId, setSelectedId] = useState<string | null>(focusId);
  const [tabStopId, setTabStopId] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<HistoryItemView | null>(null);
  const [confirmProject, setConfirmProject] = useState<HistoryItemView | null>(null);
  const [rawSelection, setRawSelection] = useState<Selection>(EMPTY_SELECTION);
  const [menu, setMenu] = useState<ContextTarget | null>(null);
  const [confirmRemove, setConfirmRemove] = useState<string[] | null>(null);
  const bulk = useBulkState();
  const bulkSummary = useBulkSummary();
  const gridRef = useRef<HTMLUListElement>(null);
  const pendingFocus = useRef<string | null>(null);
  const returnFocus = useRef<string | null>(null);
  const now = useNow();
  const caps = useExportCapabilities();

  // While one item is open the whole list is loaded, so "converted from" can find its original.
  const list = useHistory(
    selectedId
      ? {}
      : {
          ...(filter !== 'all' && { filter }),
          ...(query && { query }),
        },
  );
  const { items, total, loaded, failed, reload } = list;
  const actions = useMemo(() => createItemActions(reload), [reload]);
  const order = useMemo(() => items.map((item) => item.id), [items]);
  // Cards that are no longer listed (removed, filtered out) leave the selection, so a bulk action
  // can only ever touch what the grid shows.
  const selection = loaded && !selectedId ? prune(rawSelection, order) : rawSelection;
  if (selection !== rawSelection) setRawSelection(selection);
  const selectedCount = selection.ids.size;
  const previousCount = useRef(0);
  useEffect(() => {
    if (selectedCount === previousCount.current) return;
    announce(selectedCount === 0 ? 'Selection cleared' : selectionLabel(selectedCount));
    previousCount.current = selectedCount;
  }, [selectedCount]);
  const clearSelection = useCallback(() => setRawSelection(EMPTY_SELECTION), []);

  useEffect(() => {
    const timer = window.setTimeout(() => setQuery(queryInput.trim()), 150);
    return () => window.clearTimeout(timer);
  }, [queryInput]);

  useEffect(() => {
    if (focusId) onFocusConsumed?.();
  }, [focusId, onFocusConsumed]);

  const selected = selectedId ? items.find((item) => item.id === selectedId) : undefined;
  // An item that vanished (removed, undone elsewhere) closes the details view.
  if (selectedId && loaded && !selected) setSelectedId(null);

  // After removing a card with the keyboard, focus lands on its neighbour; after closing the
  // details, on the card that was open.
  useEffect(() => {
    const id = pendingFocus.current ?? (selectedId ? null : returnFocus.current);
    if (!id || !gridRef.current) return;
    const button = gridRef.current.querySelector<HTMLButtonElement>(`[data-id="${id}"]`);
    if (button) {
      button.focus();
      pendingFocus.current = null;
      returnFocus.current = null;
    }
  }, [items, selectedId]);

  const select = useCallback((item: HistoryItemView) => {
    returnFocus.current = item.id;
    setTabStopId(item.id);
    setSelectedId(item.id);
  }, []);

  const selectClick = useCallback(
    (item: HistoryItemView, modifiers: { ctrl: boolean; shift: boolean }) => {
      setTabStopId(item.id);
      setRawSelection((current) => clickSelect(current, order, item.id, modifiers));
    },
    [order],
  );
  const toggleSelect = useCallback((item: Pick<HistoryItemView, 'id'>) => {
    setTabStopId(item.id);
    setRawSelection((current) => toggle(current, item.id));
  }, []);
  const saveCopies = useCallback((ids: string[]) => void startBulkExport(ids), []);
  const nameOf = useCallback(
    (id: string) => items.find((item) => item.id === id)?.fileName ?? 'Item',
    [items],
  );

  const mp4Available = caps?.mp4Available ?? false;
  const missingCount = items.filter((item) => !item.exists).length;
  const filtering = filter !== 'all' || query !== '';

  const onGridKeyDown = (event: KeyboardEvent<HTMLUListElement>): void => {
    const target = event.target as HTMLElement;
    if (!target.matches('[data-card-main]')) return;
    const buttons = [
      ...(gridRef.current?.querySelectorAll<HTMLButtonElement>('[data-card-main]') ?? []),
    ];
    const index = buttons.indexOf(target as HTMLButtonElement);
    if (index < 0) return;
    const firstTop = buttons[0]?.parentElement?.offsetTop ?? 0;
    const columns = Math.max(
      1,
      buttons.filter((button) => button.parentElement?.offsetTop === firstTop).length,
    );
    const id = target.dataset.id ?? '';
    const mod = event.ctrlKey || event.metaKey;
    if (mod && event.key.toLowerCase() === 'a') {
      event.preventDefault();
      setRawSelection(selectAll(order));
      return;
    }
    if (mod && event.key === ' ') {
      event.preventDefault(); // Ctrl+Space selects the focused card without opening it
      toggleSelect({ id });
      return;
    }
    let next: number;
    switch (event.key) {
      case 'ArrowRight':
        next = Math.min(buttons.length - 1, index + 1);
        break;
      case 'ArrowLeft':
        next = Math.max(0, index - 1);
        break;
      case 'ArrowDown':
        next = Math.min(buttons.length - 1, index + columns);
        break;
      case 'ArrowUp':
        next = Math.max(0, index - columns);
        break;
      case 'Home':
        next = 0;
        break;
      case 'End':
        next = buttons.length - 1;
        break;
      case 'Delete': {
        // Removes the entry only, with Undo. Files are never deleted from the keyboard.
        event.preventDefault();
        if (selection.ids.size > 1 && selection.ids.has(id)) {
          setConfirmRemove([...selection.ids]);
          return;
        }
        const item = items.find((candidate) => candidate.id === target.dataset.id);
        if (!item) return;
        const neighbour = buttons[index + 1] ?? buttons[index - 1];
        pendingFocus.current = neighbour?.dataset.id ?? null;
        actions.remove(item);
        return;
      }
      default:
        return;
    }
    event.preventDefault();
    const button = buttons[next];
    if (button) {
      button.focus();
      setTabStopId(button.dataset.id ?? null);
      if (event.shiftKey && event.key.startsWith('Arrow') && button.dataset.id) {
        // Shift+arrows grow the selection from the card the move started on.
        const targetId = button.dataset.id;
        setRawSelection((current) =>
          selectRange(
            current.anchor === null ? toggle(EMPTY_SELECTION, id) : current,
            order,
            targetId,
          ),
        );
      }
    }
  };

  // Escape clears the selection from anywhere in the view (menus and dialogs take it first).
  useEffect(() => {
    if (selectedCount === 0) return;
    const onKey = (event: globalThis.KeyboardEvent): void => {
      if (event.key !== 'Escape' || event.defaultPrevented) return;
      if (document.querySelector('dialog[open], [role="menu"], [role="alertdialog"]')) return;
      clearSelection();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [selectedCount, clearSelection]);
  const onGridKeyUp = (event: KeyboardEvent<HTMLUListElement>): void => {
    // The key-up of Ctrl+Space would click the focused card (open it): it only selects.
    if ((event.ctrlKey || event.metaKey) && event.key === ' ') event.preventDefault();
  };

  const startScreenshot = (): void => {
    void window.framecapt
      .invoke('capture:startScreenshot', { target: 'region' })
      .then((response) => {
        if (!response.ok) notify.error(response.error);
      });
  };
  const startRecording = (): void => {
    void window.framecapt
      .invoke('recorder:start', {
        target: 'screen',
        options: recordOptionsFromSettings(getSettings().recording),
      })
      .then((response) => {
        if (!response.ok) notify.error(response.error);
      });
  };

  const confirmDialog = (
    <AlertConfirm
      open={confirmDelete !== null}
      title="Delete file from disk?"
      description={
        confirmDelete
          ? `“${confirmDelete.fileName}” will be moved to the Recycle Bin and removed from history. You can restore it from the Recycle Bin.`
          : ''
      }
      cancelLabel="Keep file"
      confirmLabel="Delete file"
      onConfirm={() => {
        const item = confirmDelete;
        setConfirmDelete(null);
        if (!item) return;
        if (selectedId === item.id) setSelectedId(null);
        void deleteItemFile(item, reload);
      }}
      onCancel={() => setConfirmDelete(null)}
    />
  );
  const projectDialog = (
    <AlertConfirm
      open={confirmProject !== null}
      title="Delete editable data?"
      description="The unredacted original and the annotations of this screenshot will be deleted. The saved image stays, but its annotations can no longer be changed."
      cancelLabel="Keep"
      confirmLabel="Delete editable data"
      onConfirm={() => {
        const item = confirmProject;
        setConfirmProject(null);
        if (item) void deleteItemProject(item, reload);
      }}
      onCancel={() => setConfirmProject(null)}
    />
  );
  const onEdit = onEditItem ? (item: HistoryItemView) => onEditItem(item.id) : undefined;

  if (selected) {
    return (
      <>
        <HistoryDetails
          item={selected}
          original={
            selected.derivedFrom ? items.find((i) => i.id === selected.derivedFrom) : undefined
          }
          now={now}
          actions={actions}
          onBack={() => setSelectedId(null)}
          onSelect={select}
          onAskDelete={setConfirmDelete}
          onEdit={onEdit}
          onAskDeleteProject={setConfirmProject}
        />
        {confirmDialog}
        {projectDialog}
      </>
    );
  }

  const findExisting = (): void => {
    void window.framecapt.invoke('history:rescan').then((response) => {
      if (!response.ok) notify.error(response.error);
      else {
        const { added } = response.data;
        notify.info(
          added > 0
            ? `Added ${added} ${added === 1 ? 'capture' : 'captures'}`
            : 'No new captures found',
        );
        reload();
      }
    });
  };

  const activeId = tabStopId && items.some((i) => i.id === tabStopId) ? tabStopId : items[0]?.id;

  return (
    <div data-testid="history-view">
      <header className="mb-5 flex flex-wrap items-end justify-between gap-x-6 gap-y-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight text-fg">History</h1>
          <p
            className="mt-1 text-[15px] text-fg-muted"
            data-testid="history-count"
            aria-live="polite"
          >
            {!loaded
              ? ' '
              : total === 0
                ? 'Everything you capture is listed here.'
                : filtering
                  ? `${items.length} of ${total} ${total === 1 ? 'item' : 'items'}`
                  : `${total} ${total === 1 ? 'item' : 'items'}`}
          </p>
        </div>
        {total > 0 ? (
          <div className="flex flex-wrap items-center gap-3">
            <Segmented
              label="Filter by type"
              value={filter}
              options={FILTERS}
              onChange={setFilter}
              data-testid="history-filter"
            />
            <label className="relative block">
              <span className="sr-only">Search history</span>
              <Search
                className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-fg-subtle"
                aria-hidden="true"
              />
              <input
                type="search"
                data-testid="history-search"
                value={queryInput}
                onChange={(event) => setQueryInput(event.target.value)}
                placeholder="Search name, date or type"
                className="selectable h-9 w-60 rounded-lg border border-control bg-surface pr-8 pl-8 text-[13px] text-fg shadow-card placeholder:text-fg-subtle focus-visible:border-accent [&::-webkit-search-cancel-button]:hidden"
              />
              {queryInput ? (
                <button
                  type="button"
                  aria-label="Clear search"
                  onClick={() => setQueryInput('')}
                  className="absolute top-1/2 right-1.5 flex size-6 -translate-y-1/2 items-center justify-center rounded-md text-fg-subtle hover:bg-surface-3 hover:text-fg"
                >
                  <X className="size-3.5" aria-hidden="true" />
                </button>
              ) : null}
            </label>
            <Button
              size="sm"
              variant="ghost"
              data-testid="history-find-existing"
              icon={<FolderSearch className="size-4" aria-hidden="true" />}
              onClick={findExisting}
            >
              Find existing captures
            </Button>
            {missingCount > 0 ? (
              <Button
                size="sm"
                variant="ghost"
                data-testid="history-clear-missing"
                onClick={() =>
                  void window.framecapt.invoke('history:clearMissing').then((response) => {
                    if (!response.ok) notify.error(response.error);
                    else {
                      notify.info(
                        `Removed ${response.data.removed} missing ${response.data.removed === 1 ? 'item' : 'items'} from history`,
                      );
                      reload();
                    }
                  })
                }
              >
                Clear {missingCount} missing
              </Button>
            ) : null}
          </div>
        ) : null}
      </header>

      {selectedCount > 0 ? (
        <SelectionBar
          count={selectedCount}
          listed={items.length}
          bulk={bulk}
          onSaveCopies={() => saveCopies([...selection.ids])}
          onRemove={() => setConfirmRemove([...selection.ids])}
          onSelectAll={() => setRawSelection(selectAll(order))}
          onClear={clearSelection}
          onCancelBulk={() => void cancelBulk()}
        />
      ) : null}

      {loaded && failed ? (
        <EmptyState
          icon={<SearchX className="size-6" />}
          title="History could not be loaded"
          description="Something went wrong while reading your history. Your files are safe. Try again, and if it keeps happening open Settings, Advanced to see the log."
          action={
            <Button variant="primary" data-testid="history-retry" onClick={reload}>
              Try again
            </Button>
          }
        />
      ) : loaded && total === 0 ? (
        <EmptyState
          icon={<Clock className="size-6" />}
          title="Your captures will appear here"
          description="Take a screenshot or record your screen. Everything you save is listed here so you can find it again, copy it or open its folder."
          action={
            <div className="flex flex-wrap justify-center gap-2.5">
              <Button
                variant="primary"
                data-testid="history-empty-shot"
                icon={<Camera className="size-4" aria-hidden="true" />}
                onClick={startScreenshot}
              >
                Take a screenshot
              </Button>
              <Button
                variant="secondary"
                data-testid="history-empty-record"
                icon={<Video className="size-4" aria-hidden="true" />}
                onClick={startRecording}
              >
                Record your screen
              </Button>
              <Button
                variant="ghost"
                data-testid="history-empty-find"
                icon={<FolderSearch className="size-4" aria-hidden="true" />}
                onClick={findExisting}
              >
                Find existing captures
              </Button>
            </div>
          }
        />
      ) : loaded && items.length === 0 ? (
        <EmptyState
          icon={<SearchX className="size-6" />}
          title="No matches"
          description={
            query
              ? 'Nothing in your history fits this search.'
              : 'Nothing in your history fits this filter.'
          }
          action={
            <Button
              variant="secondary"
              data-testid="history-clear-filters"
              onClick={() => {
                setFilter('all');
                setQueryInput('');
              }}
            >
              {query ? 'Clear search' : 'Show everything'}
            </Button>
          }
        />
      ) : (
        <ul
          ref={gridRef}
          data-testid="history-grid"
          aria-label="Captures"
          onKeyDown={onGridKeyDown}
          onKeyUp={onGridKeyUp}
          className="grid grid-cols-[repeat(auto-fill,minmax(210px,1fr))] gap-4"
        >
          {items.map((item) => (
            <HistoryCard
              key={item.id}
              item={item}
              now={now}
              tabStop={item.id === activeId}
              mp4Available={mp4Available}
              actions={actions}
              onSelect={select}
              onAskDelete={setConfirmDelete}
              onEdit={onEdit}
              selected={selection.ids.has(item.id)}
              selectMode={selectedCount > 0}
              onSelectClick={selectClick}
              onToggleSelect={toggleSelect}
              onContextMenu={(target, point) => setMenu({ item: target, ...point })}
              onDragOut={startItemDrag}
            />
          ))}
        </ul>
      )}
      {confirmDialog}
      {projectDialog}
      <HistoryContextMenu
        target={menu}
        selectedIds={selection.ids}
        mp4Available={mp4Available}
        actions={actions}
        onEdit={onEdit}
        onAskDelete={setConfirmDelete}
        onAskDeleteProject={setConfirmProject}
        onToggleSelect={toggleSelect}
        onSaveCopies={saveCopies}
        onRemoveMany={setConfirmRemove}
        onClearSelection={clearSelection}
        onClose={() => setMenu(null)}
      />
      <AlertConfirm
        open={confirmRemove !== null}
        title={`Remove ${confirmRemove?.length ?? 0} items from history?`}
        description="The files stay on your disk. You can undo this for a few seconds."
        cancelLabel="Keep them"
        confirmLabel="Remove"
        onConfirm={() => {
          const ids = confirmRemove ?? [];
          setConfirmRemove(null);
          clearSelection();
          void removeItems(ids, reload);
        }}
        onCancel={() => setConfirmRemove(null)}
      />
      <BulkResultDialog summary={bulkSummary} nameOf={nameOf} onClose={dismissBulkSummary} />
    </div>
  );
}
