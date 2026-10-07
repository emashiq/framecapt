import { ArrowRight, Images } from 'lucide-react';
import type { HistoryItemView } from '../../shared/history-ipc';
import { useHistory } from '../history/use-history';
import { cn } from '../lib/cn';
import { formatExact, formatRelative } from '../lib/time';
import { useNow } from '../views/history/use-now';
import { CardFace } from '../views/history/HistoryCard';
import { Button } from './ui/Button';
import { EmptyState } from './ui/EmptyState';

export interface RecentCapturesProps {
  /** Opens the capture (a tab for what the editors take, the Library's details otherwise). */
  onOpen: (item: HistoryItemView) => void;
  onViewAll: () => void;
}

const RECENT_COUNT = 8;

/** The latest captures on Home: the Library's card, linking to the item itself. */
export function RecentCaptures({ onOpen, onViewAll }: RecentCapturesProps) {
  const { items, total, loaded } = useHistory({ limit: RECENT_COUNT });
  const now = useNow();
  return (
    <section aria-labelledby="recent-heading" className="mt-7" data-testid="recent-captures">
      <div className="mb-3 flex items-center justify-between">
        <h2 id="recent-heading" className="text-[13px] font-semibold text-fg">
          Recent captures
        </h2>
        {total > 0 ? (
          <Button
            size="sm"
            variant="ghost"
            data-testid="recent-view-all"
            icon={<ArrowRight className="order-last size-3.5" aria-hidden="true" />}
            onClick={onViewAll}
          >
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
        <ul className="grid grid-cols-[repeat(auto-fill,minmax(190px,1fr))] gap-4">
          {items.map((item) => (
            <li key={item.id}>
              <button
                type="button"
                data-testid="recent-item"
                data-id={item.id}
                data-type={item.type}
                onClick={() => onOpen(item)}
                title={`${item.fileName} · ${formatExact(item.createdAt)}`}
                aria-label={`${item.fileName}, ${formatRelative(item.createdAt, now)}${item.exists ? '' : ', file missing'}`}
                className={cn(
                  'flex w-full flex-col overflow-hidden rounded-xl border border-line bg-surface text-left shadow-card',
                  'transition-[border-color,box-shadow] duration-150 hover:border-line-strong hover:shadow-raised',
                )}
              >
                <CardFace item={item} now={now} />
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
