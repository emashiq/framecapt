import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { AppWindow, Check, Monitor, RefreshCw, Search } from 'lucide-react';
import { THUMBNAIL_MAX_WIDTH, type SourceInfo } from '../../shared/capture-schemas';
import { MAX_MULTI_SOURCES } from '../../shared/recording-layout';
import { cn } from '../lib/cn';
import { filterWindows } from '../lib/filter-windows';
import { Loader } from './Loader';
import { Button } from './ui/Button';
import { Modal } from './ui/Dialog';
import { EmptyState } from './ui/EmptyState';

type Listing =
  | { status: 'loading' }
  | { status: 'ready'; sources: SourceInfo[] }
  | { status: 'error'; message: string };

const GRID = 'grid grid-cols-[repeat(auto-fill,minmax(220px,1fr))] gap-3.5';

function Skeleton() {
  return (
    <div className="rounded-xl border border-line bg-surface-2/60 p-2.5" aria-hidden="true">
      <div className="aspect-video animate-pulse rounded-lg bg-surface-3" />
      <div className="mt-2.5 flex items-center gap-2">
        <div className="size-5 animate-pulse rounded bg-surface-3" />
        <div className="h-3.5 flex-1 animate-pulse rounded bg-surface-3" />
      </div>
    </div>
  );
}

function SourceCard({
  source,
  onPick,
  many,
  order,
  full,
}: {
  source: SourceInfo;
  onPick: (source: SourceInfo) => void;
  /** Several sources are picked: the card is a checkbox with a number. */
  many: boolean;
  /** 1-based place among the picked sources (0: not picked). */
  order: number;
  /** The limit is reached: unpicked cards cannot be picked. */
  full: boolean;
}) {
  const Icon = source.kind === 'screen' ? Monitor : AppWindow;
  const blocked = many && full && order === 0;
  return (
    <button
      type="button"
      data-testid={many ? 'source-card' : 'window-card'}
      data-source-id={source.id}
      data-kind={source.kind}
      data-order={many ? order : undefined}
      title={source.name}
      {...(many && { role: 'checkbox', 'aria-checked': order > 0 })}
      aria-disabled={blocked || undefined}
      onClick={() => {
        if (!blocked) onPick(source);
      }}
      className={cn(
        'relative flex flex-col rounded-xl border bg-surface p-2.5 text-left shadow-card transition-colors duration-150 hover:border-line-strong hover:bg-surface-2 focus-visible:border-accent',
        order > 0 ? 'border-accent bg-accent-soft' : 'border-line',
        blocked && 'opacity-50',
      )}
    >
      <div className="flex aspect-video items-center justify-center overflow-hidden rounded-lg bg-surface-3">
        {source.thumbnail ? (
          <img
            src={source.thumbnail}
            alt=""
            className="size-full object-contain"
            draggable={false}
          />
        ) : (
          <Icon className="size-8 text-fg-subtle" aria-hidden="true" />
        )}
      </div>
      <div className="mt-2.5 flex min-w-0 items-center gap-2">
        {source.appIcon ? (
          <img src={source.appIcon} alt="" className="size-5 shrink-0" draggable={false} />
        ) : (
          <Icon className="size-5 shrink-0 text-fg-subtle" aria-hidden="true" />
        )}
        <span className="truncate text-[13px] font-medium text-fg">{source.name}</span>
      </div>
      {many && order > 0 ? (
        <span
          data-testid="source-order"
          className="absolute top-4 left-4 flex size-6 items-center justify-center gap-0.5 rounded-full bg-accent-solid text-xs font-semibold text-white"
          aria-label={`Source ${order}`}
        >
          {order === 1 ? <Check className="size-3" aria-hidden="true" /> : null}
          {order}
        </span>
      ) : null}
    </button>
  );
}

export interface SourcePickerProps {
  open: boolean;
  /** What the picked window is for: the wording follows. */
  purpose?: 'capture' | 'record';
  /**
   * 'one' (default) picks one window. 'many' picks 2 to 4 screens and windows to record together:
   * the cards are checkboxes numbered in the order they were picked (the first is the primary).
   */
  mode?: 'one' | 'many';
  onClose: () => void;
  onPick: (source: SourceInfo) => void;
  /** Mode 'many': the picked sources, in order. */
  onPickMany?: (sources: SourceInfo[]) => void;
}

/**
 * Source picker dialog: a responsive grid of cards with a search box. Arrow keys move between
 * cards, Enter (or Space, picking several) picks, Esc closes (native dialog behaviour).
 */
export function SourcePicker({
  open,
  purpose = 'capture',
  mode = 'one',
  onClose,
  onPick,
  onPickMany,
}: SourcePickerProps) {
  const many = mode === 'many';
  const verb = purpose === 'record' ? 'record' : 'capture';
  const [listing, setListing] = useState<Listing>({ status: 'loading' });
  const [query, setQuery] = useState('');
  /** Mode 'many': the picked source ids, in the order they were picked. */
  const [picked, setPicked] = useState<string[]>([]);
  const gridRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);

  const [nonce, setNonce] = useState(0);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    void (async () => {
      const result = await window.framecapt.invoke('capture:listSources', {
        types: many ? ['screen', 'window'] : ['window'],
        thumbnailWidth: THUMBNAIL_MAX_WIDTH,
      });
      if (cancelled) return;
      setListing(
        result.ok
          ? {
              status: 'ready',
              sources: result.data.filter((source) => many || source.kind === 'window'),
            }
          : { status: 'error', message: result.error.message },
      );
    })();
    return () => {
      cancelled = true;
    };
  }, [open, nonce, many]);

  const refresh = (): void => {
    setListing({ status: 'loading' });
    setNonce((value) => value + 1);
  };

  const windows = useMemo(
    () => (listing.status === 'ready' ? filterWindows(listing.sources, query) : []),
    [listing, query],
  );

  const toggle = (source: SourceInfo): void =>
    setPicked((current) =>
      current.includes(source.id)
        ? current.filter((id) => id !== source.id)
        : current.length < MAX_MULTI_SOURCES
          ? [...current, source.id]
          : current,
    );

  function recordPicked(): void {
    if (listing.status !== 'ready' || picked.length < 2) return;
    const chosen = picked.flatMap((id) => listing.sources.filter((source) => source.id === id));
    reset();
    onPickMany?.(chosen);
  }

  const cards = (): HTMLButtonElement[] =>
    Array.from(
      gridRef.current?.querySelectorAll<HTMLButtonElement>('button[data-source-id]') ?? [],
    );

  function onGridKeyDown(event: KeyboardEvent<HTMLDivElement>): void {
    const items = cards();
    const index = items.indexOf(document.activeElement as HTMLButtonElement);
    if (index === -1) return;
    // Columns = cards sharing the first card's row.
    const firstTop = items[0]?.offsetTop ?? 0;
    const columns = Math.max(1, items.filter((item) => item.offsetTop === firstTop).length);
    let next: number;
    switch (event.key) {
      case 'ArrowRight':
        next = Math.min(items.length - 1, index + 1);
        break;
      case 'ArrowLeft':
        next = Math.max(0, index - 1);
        break;
      case 'ArrowDown':
        next = Math.min(items.length - 1, index + columns);
        break;
      case 'ArrowUp':
        if (index < columns) {
          event.preventDefault();
          searchRef.current?.focus();
          return;
        }
        next = index - columns;
        break;
      case 'Home':
        next = 0;
        break;
      case 'End':
        next = items.length - 1;
        break;
      default:
        return;
    }
    event.preventDefault();
    items[next]?.focus();
  }

  const reset = (): void => {
    setQuery('');
    setPicked([]);
    setListing({ status: 'loading' });
  };

  const close = (): void => {
    reset();
    onClose();
  };

  return (
    <Modal
      open={open}
      onClose={close}
      label={many ? 'Choose sources to record together' : `Choose a window to ${verb}`}
      className="h-[min(640px,88vh)] w-[min(980px,94vw)] flex-col open:flex"
      data-testid="source-picker"
    >
      <header className="flex items-center gap-3 border-b border-line px-5 py-4">
        <div className="min-w-0 flex-1">
          <h2 className="text-lg font-semibold text-fg">
            {many ? 'Choose 2 to 4 sources' : 'Choose a window'}
          </h2>
          <p className="text-[13px] text-fg-muted">
            {many
              ? 'Screens and windows are recorded together into one video. The first one you pick is the main source.'
              : `FrameCapt hides itself, then ${purpose === 'record' ? 'records' : 'captures'} that window.`}
          </p>
        </div>
        <label className="relative w-60">
          <span className="sr-only">{many ? 'Search sources' : 'Search windows'}</span>
          <Search
            className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-fg-subtle"
            aria-hidden="true"
          />
          <input
            ref={searchRef}
            type="search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'ArrowDown') {
                event.preventDefault();
                cards()[0]?.focus();
              }
            }}
            placeholder={many ? 'Search sources' : 'Search windows'}
            autoFocus
            data-testid="window-search"
            className="selectable h-10 w-full rounded-lg border border-control bg-surface-2 pr-3 pl-9 text-sm text-fg placeholder:text-fg-subtle focus-visible:border-accent"
          />
        </label>
        <Button
          variant="secondary"
          icon={
            <RefreshCw
              className={cn('size-4', listing.status === 'loading' && 'animate-spin')}
              aria-hidden="true"
            />
          }
          onClick={refresh}
          disabled={listing.status === 'loading'}
        >
          Refresh
        </Button>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto p-5" onKeyDown={onGridKeyDown}>
        {listing.status === 'loading' ? (
          <>
            <p className="mb-3 flex items-center gap-2 text-[13px] text-fg-muted">
              <Loader size="sm" decorative />
              Looking for windows…
            </p>
            <div
              className={GRID}
              data-testid="window-skeletons"
              role="status"
              aria-label="Loading windows"
            >
              {Array.from({ length: 6 }, (_, index) => (
                <Skeleton key={index} />
              ))}
            </div>
          </>
        ) : listing.status === 'error' ? (
          <EmptyState
            icon={<AppWindow className="size-6" />}
            title={many ? 'Could not list sources' : 'Could not list windows'}
            description={listing.message}
            action={<Button onClick={refresh}>Try again</Button>}
          />
        ) : windows.length === 0 ? (
          <EmptyState
            icon={<AppWindow className="size-6" />}
            title={many ? 'Nothing to record' : 'No windows to capture'}
            description={
              query.trim()
                ? 'No open window matches your search.'
                : 'Open the app you want to capture, then refresh this list.'
            }
          />
        ) : (
          <div ref={gridRef} className={GRID} data-testid={many ? 'source-grid' : 'window-grid'}>
            {windows.map((source) => (
              <SourceCard
                key={source.id}
                source={source}
                many={many}
                order={picked.indexOf(source.id) + 1}
                full={picked.length >= MAX_MULTI_SOURCES}
                onPick={(chosen) => {
                  if (many) {
                    toggle(chosen);
                    return;
                  }
                  reset();
                  onPick(chosen);
                }}
              />
            ))}
          </div>
        )}
      </div>

      <footer className="flex items-center justify-between border-t border-line px-5 py-3 text-[13px] text-fg-muted">
        <span>
          {many
            ? `Arrow keys to move · Space to pick (up to ${MAX_MULTI_SOURCES}) · Esc to close`
            : `Arrow keys to move · Enter to ${verb} · Esc to close`}
        </span>
        <span className="flex items-center gap-3">
          {many ? (
            <span role="status" data-testid="source-count" className="tabular-nums">
              {picked.length} of {MAX_MULTI_SOURCES} picked
            </span>
          ) : null}
          <Button variant="ghost" size="sm" onClick={close}>
            Cancel
          </Button>
          {many ? (
            <Button
              size="sm"
              disabled={picked.length < 2}
              onClick={recordPicked}
              data-testid="record-sources"
            >
              {picked.length >= 2 ? `Record ${picked.length} sources` : 'Pick 2 or more'}
            </Button>
          ) : null}
        </span>
      </footer>
    </Modal>
  );
}
