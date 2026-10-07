import { useEffect, useRef, useState } from 'react';
import { FolderOpen, Pencil } from 'lucide-react';
import { Button } from '../../components/ui/Button';
import { fileUrl, newNonce } from '../../history/media-url';
import { notify } from '../../lib/notify';
import { revealDuration } from '../../lib/reveal-duration';

export interface ViewerViewProps {
  historyId: string;
  media: 'image' | 'video';
  title: string;
  /** The tab is the one showing: a hidden video is paused. */
  active: boolean;
  /** Edit: this tab becomes the editor of the item. */
  onEdit: () => Promise<void> | void;
}

/**
 * A screenshot or recording as it is saved: the picture fitted to the tab, or a player (both served
 * by the main-owned `framecapt-media:` protocol). Edit turns the same tab into the editor.
 */
export function ViewerView({ historyId, media, title, active, onEdit }: ViewerViewProps) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [src] = useState(() => fileUrl(historyId, newNonce()));
  const [editing, setEditing] = useState(false);

  useEffect(() => {
    if (!active) videoRef.current?.pause();
  }, [active]);

  const edit = async (): Promise<void> => {
    setEditing(true);
    try {
      await onEdit();
    } finally {
      setEditing(false);
    }
  };

  const reveal = (): void => {
    void window.framecapt.invoke('history:reveal', { id: historyId }).then((response) => {
      if (!response.ok) notify.error(response.error);
    });
  };

  return (
    <div className="flex h-full flex-col" data-testid="viewer" data-media={media}>
      <div className="flex h-12 shrink-0 items-center gap-3 border-b border-line px-4">
        <h1
          className="min-w-0 flex-1 truncate text-sm font-semibold text-fg"
          data-testid="viewer-title"
          title={title}
        >
          {title}
        </h1>
        <Button
          variant="secondary"
          size="sm"
          icon={<FolderOpen className="size-4" aria-hidden="true" />}
          data-testid="viewer-show"
          onClick={reveal}
        >
          Show in folder
        </Button>
        <Button
          variant="primary"
          size="sm"
          icon={<Pencil className="size-4" aria-hidden="true" />}
          loading={editing}
          data-testid="viewer-edit"
          onClick={() => void edit()}
        >
          Edit
        </Button>
      </div>
      <div className="flex min-h-0 flex-1 items-center justify-center bg-surface-2 p-6">
        {media === 'image' ? (
          <img
            src={src}
            alt={title}
            data-testid="viewer-image"
            draggable={false}
            className="max-h-full max-w-full rounded-lg object-contain shadow-card"
          />
        ) : (
          <video
            ref={videoRef}
            src={src}
            controls
            preload="metadata"
            data-testid="viewer-video"
            onLoadedMetadata={(event) => revealDuration(event.currentTarget)}
            className="max-h-full max-w-full rounded-lg bg-black"
          />
        )}
      </div>
    </div>
  );
}
