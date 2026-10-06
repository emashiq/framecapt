import { useState } from 'react';
import type { HistoryItemView } from '../../../shared/history-ipc';
import { thumbUrl } from '../../history/media-url';
import { TypeIcon } from '../../history/type-icon';
import { cn } from '../../lib/cn';

export interface ThumbProps {
  item: Pick<HistoryItemView, 'id' | 'type' | 'hasThumb' | 'createdAt' | 'exists'>;
  className?: string;
}

/**
 * The thumbnail of a history item on a neutral background, fitted without cropping. It comes from
 * the main-owned `framecapt-media://thumb/<id>` route and loads lazily; without one (video
 * thumbnails arrive a moment after the recording) a quiet placeholder shows.
 */
export function Thumb({ item, className }: ThumbProps) {
  // A load error counts for this thumbnail only; a new one (new id, new time) gets a fresh try.
  const key = `${item.id}-${item.createdAt}-${item.hasThumb}`;
  const [failedKey, setFailedKey] = useState<string | null>(null);
  const failed = failedKey === key;
  return (
    <div
      className={cn(
        'relative flex items-center justify-center overflow-hidden bg-surface-3',
        className,
      )}
    >
      {item.hasThumb && !failed ? (
        <img
          // A re-saved screenshot keeps its id; the key makes the browser fetch the new thumbnail.
          key={`${item.id}-${item.createdAt}`}
          src={thumbUrl(item.id)}
          alt=""
          loading="lazy"
          decoding="async"
          draggable={false}
          onError={() => setFailedKey(key)}
          className={cn('size-full object-contain', !item.exists && 'opacity-45 grayscale')}
        />
      ) : (
        <TypeIcon type={item.type} className="size-8 text-fg-subtle/60" aria-hidden="true" />
      )}
    </div>
  );
}
