import { forwardRef, useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { Pause, Play, Volume2, VolumeX } from 'lucide-react';
import type { HistoryItemView } from '../../../shared/history-ipc';
import type { RecordingLayout } from '../../../shared/recording-layout';
import { formatDuration } from '../../../shared/recording';
import { fileUrl, newNonce } from '../../history/media-url';
import { cn } from '../../lib/cn';
import { tileCropStyle } from '../../lib/tile-crop';

/** `null` is the whole picture ("All"); a number is the index of one source. */
export type TileChoice = number | null;

export interface CroppedVideoProps {
  src: string;
  layout: Pick<RecordingLayout, 'width' | 'height' | 'sources'>;
  tile: TileChoice;
  /** The largest height the picture may take. */
  maxHeight?: string;
  controls?: boolean;
  onLoadedMetadata?: () => void;
  onTimeUpdate?: () => void;
  onEnded?: () => void;
  onPlayState?: (playing: boolean) => void;
}

/**
 * The video of a `.fcap`, showing the whole picture or one source's tile (see `tileCropStyle`). It
 * is one <video> element: choosing another tile only changes its CSS, so playback does not restart.
 */
export const CroppedVideo = forwardRef<HTMLVideoElement, CroppedVideoProps>(function CroppedVideo(
  { src, layout, tile, maxHeight = 'min(58vh, 520px)', onPlayState, ...events },
  ref,
) {
  const source = tile === null ? undefined : layout.sources[tile];
  const box = source ? source.rect : { x: 0, y: 0, width: layout.width, height: layout.height };
  const ratio = box.width / box.height;
  return (
    <div
      data-testid="fcap-box"
      data-tile={tile ?? 'all'}
      className="relative mx-auto overflow-hidden rounded-lg bg-black"
      style={{ aspectRatio: String(ratio), width: `min(100%, calc(${maxHeight} * ${ratio}))` }}
    >
      <video
        ref={ref}
        data-testid="history-video"
        src={src}
        preload="metadata"
        playsInline
        onLoadedMetadata={events.onLoadedMetadata}
        onTimeUpdate={events.onTimeUpdate}
        onEnded={events.onEnded}
        onPlay={() => onPlayState?.(true)}
        onPause={() => onPlayState?.(false)}
        className="absolute max-w-none transition-[left,top,width,height] duration-200 ease-out motion-reduce:transition-none"
        style={tileCropStyle(box, layout)}
      />
    </div>
  );
});

const iconButton =
  'flex size-9 shrink-0 items-center justify-center rounded-full text-fg-muted transition-colors duration-150 hover:bg-surface-3 hover:text-fg';

export interface FcapPlayerProps {
  item: HistoryItemView;
  layout: RecordingLayout;
}

/**
 * Plays a multi-source recording: tabs "All", "Screen 1", "Window 2"... choose what is shown, and
 * the controls below are ours (the native ones would be clipped with the video).
 */
export function FcapPlayer({ item, layout }: FcapPlayerProps) {
  const [nonce] = useState(newNonce);
  const src = fileUrl(item.id, nonce);
  const videoRef = useRef<HTMLVideoElement>(null);
  const [tile, setTile] = useState<TileChoice>(null);
  const [playing, setPlaying] = useState(false);
  const [time, setTime] = useState(0);
  const [duration, setDuration] = useState(item.durationMs ?? 0);
  const [muted, setMuted] = useState(false);

  const tabs: { choice: TileChoice; label: string }[] = [
    { choice: null, label: 'All' },
    ...layout.sources.map((source, index) => ({ choice: index, label: source.name })),
  ];

  function readVideo(): void {
    const video = videoRef.current;
    if (!video) return;
    setTime(video.currentTime * 1000);
    if (Number.isFinite(video.duration)) setDuration(video.duration * 1000);
  }

  function onTabKeyDown(event: KeyboardEvent<HTMLDivElement>): void {
    const step = event.key === 'ArrowRight' ? 1 : event.key === 'ArrowLeft' ? -1 : 0;
    if (step === 0) return;
    event.preventDefault();
    const at = tabs.findIndex((entry) => entry.choice === tile);
    const next = tabs[(at + step + tabs.length) % tabs.length];
    if (!next) return;
    setTile(next.choice);
    event.currentTarget
      .querySelector<HTMLButtonElement>(`[data-tab="${next.choice ?? 'all'}"]`)
      ?.focus();
  }

  useEffect(() => {
    if (videoRef.current) videoRef.current.muted = muted;
  }, [muted]);

  const togglePlay = (): void => {
    const video = videoRef.current;
    if (!video) return;
    if (video.paused) void video.play().catch(() => undefined);
    else video.pause();
  };

  return (
    <div className="flex flex-col gap-3" data-testid="fcap-player">
      <div
        role="tablist"
        aria-label="Sources"
        data-testid="fcap-tabs"
        onKeyDown={onTabKeyDown}
        className="flex flex-wrap gap-1.5"
      >
        {tabs.map((entry) => {
          const selected = entry.choice === tile;
          return (
            <button
              key={entry.choice ?? 'all'}
              type="button"
              role="tab"
              aria-selected={selected}
              tabIndex={selected ? 0 : -1}
              data-tab={entry.choice ?? 'all'}
              data-testid={`fcap-tab-${entry.choice ?? 'all'}`}
              onClick={() => setTile(entry.choice)}
              className={cn(
                'h-8 rounded-lg px-3 text-[13px] font-medium transition-colors duration-150',
                selected
                  ? 'bg-accent-solid text-white shadow-card'
                  : 'border border-line bg-surface text-fg-muted hover:border-line-strong hover:text-fg',
              )}
            >
              {entry.label}
            </button>
          );
        })}
      </div>

      <CroppedVideo
        ref={videoRef}
        src={src}
        layout={layout}
        tile={tile}
        onLoadedMetadata={readVideo}
        onTimeUpdate={readVideo}
        onPlayState={setPlaying}
      />

      <div className="flex items-center gap-2" data-testid="fcap-controls">
        <button
          type="button"
          className={iconButton}
          aria-label={playing ? 'Pause' : 'Play'}
          data-testid="fcap-play"
          onClick={togglePlay}
        >
          {playing ? (
            <Pause className="size-4" aria-hidden="true" />
          ) : (
            <Play className="size-4" aria-hidden="true" />
          )}
        </button>
        <span
          className="w-12 text-right text-xs text-fg-muted tabular-nums"
          data-testid="fcap-time"
        >
          {formatDuration(time)}
        </span>
        <input
          type="range"
          aria-label="Seek"
          data-testid="fcap-seek"
          min={0}
          max={Math.max(1, Math.round(duration))}
          step={100}
          value={Math.min(Math.round(time), Math.max(1, Math.round(duration)))}
          onChange={(event) => {
            const video = videoRef.current;
            if (video) video.currentTime = Number(event.target.value) / 1000;
            setTime(Number(event.target.value));
          }}
          className="h-2 min-w-0 flex-1 cursor-pointer accent-[var(--color-accent-solid)]"
        />
        <span className="w-12 text-xs text-fg-muted tabular-nums">{formatDuration(duration)}</span>
        {item.hasAudio ? (
          <button
            type="button"
            className={iconButton}
            aria-label={muted ? 'Unmute' : 'Mute'}
            aria-pressed={muted}
            data-testid="fcap-mute"
            onClick={() => setMuted((value) => !value)}
          >
            {muted ? (
              <VolumeX className="size-4" aria-hidden="true" />
            ) : (
              <Volume2 className="size-4" aria-hidden="true" />
            )}
          </button>
        ) : null}
      </div>
    </div>
  );
}
