import { useEffect, useRef, useState, type ReactNode } from 'react';
import {
  GripVertical,
  Loader2,
  Mic,
  MicOff,
  Pause,
  Play,
  Square,
  TriangleAlert,
  Volume2,
  VolumeX,
} from 'lucide-react';
import type { AudioSource } from '../../../shared/recorder-machine';
import type { RecorderSnapshot } from '../../../shared/recorder-ipc';
import { formatDuration } from '../../../shared/recording';
import { cn } from '../../lib/cn';
import { useActiveMs, useRecorderState } from '../../recorder/use-recorder';

/** Levels from the engine (RMS 0..1) as a 0..1 meter fill; a square root makes quiet sound visible. */
function meterFill(level: number): number {
  return Math.min(1, Math.sqrt(Math.max(0, level)) * 1.1);
}

const SILENCE = { mic: 0, system: 0 };

/** Mic and system levels, sent by the engine (10 Hz) only while this toolbar shows a recording. */
function useLevels(active: boolean): { mic: number; system: number } {
  const [levels, setLevels] = useState({ mic: 0, system: 0 });
  useEffect(() => {
    if (!active) return;
    return window.framecapt.on('recorder:levels', (next) => setLevels(next));
  }, [active]);
  return active ? levels : SILENCE;
}

const iconButton =
  'flex size-8 shrink-0 items-center justify-center rounded-full text-fg-muted transition-colors duration-150 hover:bg-surface-3 hover:text-fg disabled:opacity-40';

interface AudioControlProps {
  source: AudioSource;
  snapshot: RecorderSnapshot;
  level: number;
  recording: boolean;
}

const AUDIO_TEXT = {
  mic: { name: 'microphone', lost: 'Microphone disconnected', On: Mic, Off: MicOff },
  system: { name: 'system audio', lost: 'System audio ended', On: Volume2, Off: VolumeX },
} as const;

/** One audio source: mute toggle plus meter, or a warning badge once its device is gone. */
function AudioControl({ source, snapshot, level, recording }: AudioControlProps) {
  const text = AUDIO_TEXT[source];
  if (snapshot.lost[source]) {
    return (
      <span
        role="status"
        data-testid={`badge-lost-${source}`}
        className="flex h-7 shrink-0 items-center gap-1.5 rounded-full bg-warning-soft px-2.5 text-xs font-medium whitespace-nowrap text-warning"
      >
        <TriangleAlert className="size-3.5" aria-hidden="true" />
        {text.lost}
      </span>
    );
  }
  const muted = snapshot.muted[source];
  const Icon = muted ? text.Off : text.On;
  return (
    <div className="flex shrink-0 items-center gap-1.5">
      <button
        type="button"
        className={cn(iconButton, muted && 'text-danger')}
        aria-pressed={muted}
        aria-label={`${muted ? 'Unmute' : 'Mute'} ${text.name}`}
        title={`${muted ? 'Unmute' : 'Mute'} ${text.name}`}
        data-testid={`mute-${source}`}
        onClick={() => void window.framecapt.invoke('recorder:toggleMute', { source })}
      >
        <Icon className="size-4" aria-hidden="true" />
      </button>
      <div
        role="meter"
        aria-label={`${text.name} level`}
        aria-valuemin={0}
        aria-valuemax={1}
        aria-valuenow={muted ? 0 : Number(meterFill(level).toFixed(2))}
        aria-valuetext={muted ? 'Muted' : undefined}
        data-testid={`meter-${source}`}
        className="h-1.5 w-8 overflow-hidden rounded-full bg-surface-3"
      >
        <div
          className={cn(
            'h-full origin-left rounded-full transition-transform duration-100',
            muted || !recording ? 'bg-fg-subtle' : 'bg-accent-solid',
          )}
          style={{
            transform: `scaleX(${muted || !recording ? 0.04 : Math.max(0.04, meterFill(level))})`,
          }}
        />
      </div>
    </div>
  );
}

function Divider(): ReactNode {
  return <span className="h-5 w-px shrink-0 bg-line" aria-hidden="true" />;
}

/**
 * The floating recording toolbar (role 'toolbar'): a frameless always-on-top pill. It never owns
 * state: it renders the snapshot main broadcasts and sends commands back through main. Every
 * control is a real button, so Tab, Enter and Space work.
 */
export function ToolbarView() {
  const snapshot = useRecorderState();
  const activeMs = useActiveMs(snapshot);
  const levels = useLevels(snapshot.status === 'recording');
  const pillRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    document.documentElement.classList.add('overlay-root');
  }, []);

  // The window is exactly as wide as the controls need: the pill reports its measured width
  // (its content decides it, so a new button or a longer label can never be cut off).
  useEffect(() => {
    const pill = pillRef.current;
    if (!pill) return;
    let reported = 0;
    const report = (): void => {
      const width = Math.ceil(pill.getBoundingClientRect().width);
      if (width > 0 && width !== reported) {
        reported = width;
        void window.framecapt.invoke('toolbar:resize', { width });
      }
    };
    const observer = new ResizeObserver(report);
    observer.observe(pill);
    report();
    return () => observer.disconnect();
  }, []);

  const { status } = snapshot;
  const paused = status === 'paused';
  const recording = status === 'recording';
  const saving = status === 'stopping' || status === 'processing';
  const percent = snapshot.progress === null ? null : Math.round(snapshot.progress * 100);
  const label = saving
    ? snapshot.quitting
      ? 'Finishing recording…'
      : percent === null
        ? 'Saving…'
        : `Saving… ${percent}%`
    : paused
      ? 'Paused'
      : 'Recording';

  return (
    <div
      ref={pillRef}
      role="toolbar"
      aria-label="Recording controls"
      data-testid="toolbar"
      data-status={status}
      className="app-toolbar flex h-12 w-max items-center gap-2 overflow-hidden rounded-full border border-line-strong bg-surface pr-3 pl-2 text-fg select-none"
    >
      <span
        className="app-drag flex h-full w-4 shrink-0 cursor-grab items-center justify-center text-fg-subtle"
        title="Drag to move"
        data-testid="toolbar-grip"
        aria-hidden="true"
      >
        <GripVertical className="size-4" />
      </span>

      {saving ? (
        <div
          role="status"
          data-testid="toolbar-saving"
          className="flex min-w-44 items-center gap-2.5 text-sm font-medium tabular-nums"
        >
          {percent === null ? (
            <Loader2 className="size-4 shrink-0 animate-spin text-accent" aria-hidden="true" />
          ) : (
            <span
              role="progressbar"
              aria-label="Saving the recording"
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={percent}
              className="h-1.5 w-16 shrink-0 overflow-hidden rounded-full bg-surface-3"
            >
              <span
                className="block h-full rounded-full bg-accent-solid"
                style={{ width: `${percent}%` }}
              />
            </span>
          )}
          {label}
        </div>
      ) : (
        <>
          <div className="flex shrink-0 items-center gap-2" data-testid="toolbar-status">
            <span
              aria-hidden="true"
              data-testid="toolbar-dot"
              className={cn(
                'size-2.5 shrink-0 rounded-full',
                paused ? 'bg-warning' : 'animate-pulse bg-danger-solid',
              )}
            />
            <span
              role="timer"
              aria-label="Recording time"
              data-testid="toolbar-timer"
              className="min-w-[3.1rem] text-sm font-semibold tabular-nums"
            >
              {formatDuration(activeMs)}
            </span>
            {paused ? (
              <span
                data-testid="toolbar-paused-label"
                className="text-xs font-semibold tracking-wide text-warning uppercase"
              >
                Paused
              </span>
            ) : null}
            <span className="sr-only" role="status" aria-live="polite">
              {label}
            </span>
          </div>

          <button
            type="button"
            className={iconButton}
            aria-label={paused ? 'Resume recording' : 'Pause recording'}
            title={paused ? 'Resume' : 'Pause'}
            data-testid={paused ? 'toolbar-resume' : 'toolbar-pause'}
            disabled={!recording && !paused}
            onClick={() =>
              void window.framecapt.invoke(paused ? 'recorder:resume' : 'recorder:pause')
            }
          >
            {paused ? (
              <Play className="size-4" aria-hidden="true" />
            ) : (
              <Pause className="size-4" aria-hidden="true" />
            )}
          </button>

          <button
            type="button"
            className="flex h-8 shrink-0 items-center gap-1.5 rounded-full bg-danger-solid px-3.5 text-sm font-semibold text-white transition-colors duration-150 hover:bg-danger-solid-hover"
            aria-label="Stop recording"
            data-testid="toolbar-stop"
            onClick={() => void window.framecapt.invoke('recorder:stop')}
          >
            <Square className="size-3 fill-current" aria-hidden="true" />
            Stop
          </button>

          {snapshot.audio.mic || snapshot.audio.system ? <Divider /> : null}
          {snapshot.audio.mic ? (
            <AudioControl
              source="mic"
              snapshot={snapshot}
              level={levels.mic}
              recording={recording}
            />
          ) : null}
          {snapshot.audio.system ? (
            <AudioControl
              source="system"
              snapshot={snapshot}
              level={levels.system}
              recording={recording}
            />
          ) : null}
        </>
      )}
    </div>
  );
}
