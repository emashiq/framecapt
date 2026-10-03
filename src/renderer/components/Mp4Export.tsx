import { notify } from '../lib/notify';
import { Film, FolderOpen, RotateCcw, X } from 'lucide-react';
import {
  cancelMp4Export,
  dismissExport,
  startMp4Export,
  useAnyExportActive,
  useExportState,
} from '../history/export-store';
import { useExportCapabilities } from '../history/use-export-capabilities';
import { cn } from '../lib/cn';
import { Loader } from './Loader';
import { Button } from './ui/Button';

export interface Mp4ExportProps {
  historyId: string;
  className?: string;
}

/**
 * Convert a recording to MP4: the button, then inline progress with Cancel, then the result. If
 * this FFmpeg build has no H.264 encoder it says so instead, and the WebM stays the deliverable.
 */
export function Mp4Export({ historyId, className }: Mp4ExportProps) {
  const caps = useExportCapabilities();
  const state = useExportState(historyId);
  const otherActive = useAnyExportActive();

  if (caps && !caps.mp4Available) {
    return (
      <p
        data-testid="mp4-unavailable"
        className={cn('rounded-lg bg-surface-2 px-3 py-2 text-[13px] text-fg-muted', className)}
      >
        {caps.reason ??
          'MP4 export needs an FFmpeg build with H.264 — your recording is saved as WebM'}
      </p>
    );
  }

  if (state?.status === 'running' || state?.status === 'starting') {
    const percent = state.status === 'running' ? state.percent : null;
    return (
      <div data-testid="mp4-progress" className={cn('flex flex-col gap-2', className)}>
        <div className="flex items-center justify-between text-[13px] text-fg-muted">
          <span aria-live="polite" className="flex items-center gap-2">
            <Loader size="sm" decorative />
            {state.status === 'starting'
              ? 'Choose where to save…'
              : percent === null
                ? 'Converting to MP4…'
                : `Converting to MP4… ${percent}%`}
          </span>
          {state.status === 'running' ? (
            <Button
              size="sm"
              variant="ghost"
              data-testid="mp4-cancel"
              icon={<X className="size-3.5" aria-hidden="true" />}
              onClick={() => void cancelMp4Export(historyId)}
            >
              Cancel
            </Button>
          ) : null}
        </div>
        <div
          role="progressbar"
          aria-label="MP4 export progress"
          aria-valuemin={0}
          aria-valuemax={100}
          {...(percent !== null && { 'aria-valuenow': percent })}
          className="h-2 overflow-hidden rounded-full bg-surface-3"
        >
          <div
            data-testid="mp4-progress-bar"
            className={cn(
              'h-full rounded-full bg-accent-solid transition-[width] duration-300',
              percent === null && 'w-1/3 animate-pulse',
            )}
            style={percent === null ? undefined : { width: `${percent}%` }}
          />
        </div>
      </div>
    );
  }

  return (
    <div className={cn('flex flex-col items-start gap-2', className)}>
      {state?.status === 'failed' ? (
        <p
          role="alert"
          data-testid="mp4-error"
          className="self-stretch rounded-lg bg-danger-soft px-3 py-2 text-[13px] text-danger"
        >
          MP4 export failed. {state.message} Your recording was not changed.
        </p>
      ) : null}
      {state?.status === 'done' ? (
        <p
          role="status"
          data-testid="mp4-done"
          className="flex items-center justify-between gap-2 self-stretch rounded-lg bg-accent-soft px-3 py-2 text-[13px] text-accent-fg"
        >
          MP4 saved
          {state.itemId ? (
            <Button
              size="sm"
              variant="ghost"
              icon={<FolderOpen className="size-3.5" aria-hidden="true" />}
              onClick={() => {
                const id = state.itemId;
                if (!id) return;
                void window.framecapt.invoke('history:reveal', { id }).then((response) => {
                  if (!response.ok) notify.error(response.error);
                });
              }}
            >
              Show in folder
            </Button>
          ) : null}
        </p>
      ) : null}
      <Button
        variant="secondary"
        data-testid="mp4-export"
        disabled={otherActive}
        icon={
          state?.status === 'failed' ? (
            <RotateCcw className="size-4" aria-hidden="true" />
          ) : (
            <Film className="size-4" aria-hidden="true" />
          )
        }
        onClick={() => {
          dismissExport(historyId);
          void startMp4Export(historyId);
        }}
      >
        {state?.status === 'failed'
          ? 'Try again'
          : state?.status === 'done'
            ? 'Export again…'
            : 'Export MP4…'}
      </Button>
    </div>
  );
}
