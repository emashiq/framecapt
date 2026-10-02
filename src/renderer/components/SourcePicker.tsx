import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { AppWindow, RefreshCw, Search } from 'lucide-react';
import { THUMBNAIL_MAX_WIDTH, type SourceInfo } from '../../shared/capture-schemas';
import { cn } from '../lib/cn';
import { filterWindows } from '../lib/filter-windows';
import { Button } from './ui/Button';
import { Modal } from './ui/Dialog';
import { EmptyState } from './ui/EmptyState';

type Listing =
  | { status: 'loading' }
  | { status: 'ready'; windows: SourceInfo[] }
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

function WindowCard({
  source,
  onPick,
}: {
  source: SourceInfo;
  onPick: (source: SourceInfo) => void;
}) {
  return (
    <button
      type="button"
      data-testid="window-card"
      data-source-id={source.id}
      title={source.name}
      onClick={() => onPick(source)}
      className="flex flex-col rounded-xl border border-line bg-surface p-2.5 text-left shadow-card transition-colors duration-150 hover:border-line-strong hover:bg-surface-2 focus-visible:border-accent"
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
          <AppWindow className="size-8 text-fg-subtle" aria-hidden="true" />
        )}
      </div>
      <div className="mt-2.5 flex min-w-0 items-center gap-2">
        {source.appIcon ? (
          <img src={source.appIcon} alt="" className="size-5 shrink-0" draggable={false} />
        ) : (
          <AppWindow className="size-5 shrink-0 text-fg-subtle" aria-hidden="true" />
        )}
        <span className="truncate text-[13px] font-medium text-fg">{source.name}</span>
      </div>
    </button>
  );
}

export interface SourcePickerProps {
  open: boolean;
  /** What the picked window is for: the wording follows. */
  purpose?: 'capture' | 'record';
  onClose: () => void;
  onPick: (source: SourceInfo) => void;
}

/**
 * Window picker dialog: a responsive grid of window cards with a search box. Arrow keys move
 * between cards, Enter picks, Esc closes (native dialog behaviour).
 */
export function SourcePicker({ open, purpose = 'capture', onClose, onPick }: SourcePickerProps) {
  const verb = purpose === 'record' ? 'record' : 'capture';
  const [listing, setListing] = useState<Listing>({ status: 'loading' });
  const [query, setQuery] = useState('');
  const gridRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);

  const [nonce, setNonce] = useState(0);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    void (async () => {
      const result = await window.framelet.invoke('capture:listSources', {
        types: ['window'],
        thumbnailWidth: THUMBNAIL_MAX_WIDTH,
      });
      if (cancelled) return;
      setListing(
        result.ok
          ? { status: 'ready', windows: result.data.filter((source) => source.kind === 'window') }
          : { status: 'error', message: result.error.message },
      );
    })();
    return () => {
      cancelled = true;
    };
  }, [open, nonce]);

  const refresh = (): void => {
    setListing({ status: 'loading' });
    setNonce((value) => value + 1);
  };

  const windows = useMemo(
    () => (listing.status === 'ready' ? filterWindows(listing.windows, query) : []),
    [listing, query],
  );

  const cards = (): HTMLButtonElement[] =>
    Array.from(
      gridRef.current?.querySelectorAll<HTMLButtonElement>('button[data-testid="window-card"]') ??
        [],
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

  const close = (): void => {
    setQuery('');
    setListing({ status: 'loading' });
    onClose();
  };

  return (
    <Modal
      open={open}
      onClose={close}
      label={`Choose a window to ${verb}`}
      className="h-[min(640px,88vh)] w-[min(980px,94vw)] flex-col open:flex"
      data-testid="source-picker"
    >
      <header className="flex items-center gap-3 border-b border-line px-5 py-4">
        <div className="min-w-0 flex-1">
          <h2 className="text-lg font-semibold text-fg">Choose a window</h2>
          <p className="text-[13px] text-fg-muted">
            Framelet hides itself, then {purpose === 'record' ? 'records' : 'captures'} that window.
          </p>
        </div>
        <label className="relative w-60">
          <span className="sr-only">Search windows</span>
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
            placeholder="Search windows"
            autoFocus
            data-testid="window-search"
            className="selectable h-10 w-full rounded-lg border border-line bg-surface-2 pr-3 pl-9 text-sm text-fg placeholder:text-fg-subtle focus-visible:border-accent"
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
        ) : listing.status === 'error' ? (
          <EmptyState
            icon={<AppWindow className="size-6" />}
            title="Could not list windows"
            description={listing.message}
            action={<Button onClick={refresh}>Try again</Button>}
          />
        ) : windows.length === 0 ? (
          <EmptyState
            icon={<AppWindow className="size-6" />}
            title="No windows to capture"
            description={
              query.trim()
                ? 'No open window matches your search.'
                : 'Open the app you want to capture, then refresh this list.'
            }
          />
        ) : (
          <div ref={gridRef} className={GRID} data-testid="window-grid">
            {windows.map((source) => (
              <WindowCard
                key={source.id}
                source={source}
                onPick={(picked) => {
                  setQuery('');
                  setListing({ status: 'loading' });
                  onPick(picked);
                }}
              />
            ))}
          </div>
        )}
      </div>

      <footer className="flex items-center justify-between border-t border-line px-5 py-3 text-[13px] text-fg-muted">
        <span>Arrow keys to move · Enter to {verb} · Esc to close</span>
        <Button variant="ghost" size="sm" onClick={close}>
          Cancel
        </Button>
      </footer>
    </Modal>
  );
}
