import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { notify } from '../lib/notify';
import { Camera, Clock, Search, SearchX, Video, X } from 'lucide-react';
import type { HistoryItemView, HistoryType } from '../../shared/history-ipc';
import { AlertConfirm } from '../components/ui/AlertConfirm';
import { Button } from '../components/ui/Button';
import { EmptyState } from '../components/ui/EmptyState';
import { Segmented } from '../components/ui/Segmented';
import { useExportCapabilities } from '../history/use-export-capabilities';
import { useHistory } from '../history/use-history';
import { recordOptionsFromSettings } from '../../shared/settings';
import { getSettings } from '../settings/store';
import { createItemActions, deleteItemFile } from './history/actions';
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
}

/**
 * Everything FrameCapt captured, newest first: filter, search, a keyboard-navigable grid and a
 * details view with a preview and every action. Entries come from main by id; moved or deleted
 * files stay listed in a calm "File moved or deleted" state until the user re-links or removes
 * them. Removing an entry never touches its file; deleting a file is a separate confirmed action.
 */
export function HistoryView({ focusId = null, onFocusConsumed }: HistoryViewProps) {
  const [filter, setFilter] = useState<Filter>('all');
  const [queryInput, setQueryInput] = useState('');
  const [query, setQuery] = useState('');
  const [selectedId, setSelectedId] = useState<string | null>(focusId);
  const [tabStopId, setTabStopId] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<HistoryItemView | null>(null);
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
  const { items, total, loaded, reload } = list;
  const actions = useMemo(() => createItemActions(reload), [reload]);

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
    }
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
        />
        {confirmDialog}
      </>
    );
  }

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

      {loaded && total === 0 ? (
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
            </div>
          }
        />
      ) : loaded && items.length === 0 ? (
        <EmptyState
          icon={<SearchX className="size-6" />}
          title="No matches"
          description="Nothing in your history fits this filter or search."
          action={
            <Button
              variant="secondary"
              data-testid="history-clear-filters"
              onClick={() => {
                setFilter('all');
                setQueryInput('');
              }}
            >
              Show everything
            </Button>
          }
        />
      ) : (
        <ul
          ref={gridRef}
          data-testid="history-grid"
          aria-label="Captures"
          onKeyDown={onGridKeyDown}
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
            />
          ))}
        </ul>
      )}
      {confirmDialog}
    </div>
  );
}
