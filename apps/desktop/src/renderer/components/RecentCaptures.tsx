import { FileX2, Images } from 'lucide-react';
import { TypeIcon } from '../history/type-icon';
import type { HistoryItemView } from '../../shared/history-ipc';
import { formatDuration } from '../../shared/recording';
import { useHistory } from '../history/use-history';
import { cn } from '../lib/cn';
import { formatExact, formatRelative } from '../lib/time';
import { useNow } from '../views/history/use-now';
import { Thumb } from '../views/history/Thumb';
import { Button } from './ui/Button';
import { EmptyState } from './ui/EmptyState';

export interface RecentCapturesProps {
  /** Opens History with this item selected. */
  onOpen: (id: string) => void;
  onViewAll: () => void;
}

const RECENT_COUNT = 6;

function Tile({ item, now, onOpen }: { item: HistoryItemView; now: number; onOpen: () => void }) {
  return (
    <li>
      <button
        type="button"
        data-testid="recent-item"
        data-id={item.id}
        data-type={item.type}
        onClick={onOpen}
        title={`${item.fileName} · ${formatExact(item.createdAt)}`}
        aria-label={`${item.fileName}, ${formatRelative(item.createdAt, now)}${item.exists ? '' : ', file missing'}`}
        className="group block w-full overflow-hidden rounded-xl border border-line bg-surface text-left shadow-card transition-[border-color,box-shadow] duration-150 hover:border-line-strong hover:shadow-raised"
      >
        <span className="relative block">
          <Thumb item={item} className="aspect-video w-full" />
          <span className="absolute top-1.5 left-1.5 flex size-5 items-center justify-center rounded-md bg-bg/85 text-fg-muted shadow-card backdrop-blur-sm">
            <TypeIcon type={item.type} className="size-3" aria-hidden="true" />
          </span>
          {item.durationMs !== null ? (
            <span className="absolute right-1.5 bottom-1.5 rounded-md bg-black/70 px-1.5 py-0.5 text-xs font-medium text-white tabular-nums">
              {formatDuration(item.durationMs)}
            </span>
          ) : null}
          {!item.exists ? (
            <span className="absolute inset-0 flex items-center justify-center bg-bg/55 text-fg-muted">
              <FileX2 className="size-5" aria-hidden="true" />
            </span>
          ) : null}
        </span>
        <span className={cn('block px-2.5 py-2 text-xs text-fg-muted', !item.exists && 'italic')}>
          {item.exists ? formatRelative(item.createdAt, now) : 'File missing'}
        </span>
      </button>
    </li>
  );
}

/** The latest captures on the home view, linking to History. */
export function RecentCaptures({ onOpen, onViewAll }: RecentCapturesProps) {
  const { items, total, loaded } = useHistory({ limit: RECENT_COUNT });
  const now = useNow();
  return (
    <section aria-labelledby="recent-heading" className="mt-6" data-testid="recent-captures">
      <div className="mb-3 flex items-center justify-between">
        <h2 id="recent-heading" className="text-sm font-semibold text-fg">
          Recent captures
        </h2>
        {total > 0 ? (
          <Button size="sm" variant="ghost" data-testid="recent-view-all" onClick={onViewAll}>
            View all
          </Button>
        ) : null}
      </div>
      {loaded && total === 0 ? (
        <EmptyState
          icon={<Images className="size-6" />}
          title="No captures yet"
          description="Take a screenshot or start a recording above: it shows up here for quick access."
        />
      ) : (
        <ul className="grid grid-cols-3 gap-3 sm:grid-cols-6">
          {items.map((item) => (
            <Tile key={item.id} item={item} now={now} onOpen={() => onOpen(item.id)} />
          ))}
        </ul>
      )}
    </section>
  );
}
