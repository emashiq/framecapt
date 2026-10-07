import { useEffect, useRef, useState } from 'react';
import { Camera, Check, GripVertical, Loader2, Pause, Play, TriangleAlert, X } from 'lucide-react';
import { cn } from '../../lib/cn';
import { Switch } from '../../components/ui/Switch';
import { useStepsState } from '../../steps/use-steps';

const iconButton =
  'flex size-8 shrink-0 items-center justify-center rounded-full text-fg-muted transition-colors duration-150 hover:bg-surface-3 hover:text-fg disabled:opacity-40';

function Divider() {
  return <span className="h-5 w-px shrink-0 bg-line" aria-hidden="true" />;
}

/**
 * The controls of a step guide (role 'toolbar', `?mode=steps`): the recording toolbar's pill with
 * the step count, the Auto switch, Capture step, Pause, Done and Cancel. It never owns state: it
 * renders main's snapshot and sends commands back. Cancel asks first, inside the pill.
 */
export function StepsPill() {
  const snapshot = useStepsState();
  const pillRef = useRef<HTMLDivElement>(null);
  const [confirming, setConfirming] = useState(false);
  // A step was just taken: the camera blinks once so it is clear something happened.
  const [flash, setFlash] = useState(false);
  const previousCount = useRef(0);

  useEffect(() => {
    document.documentElement.classList.add('overlay-root');
  }, []);

  useEffect(() => {
    if (snapshot.count > previousCount.current) {
      setFlash(true);
      const timer = setTimeout(() => setFlash(false), 450);
      previousCount.current = snapshot.count;
      return () => clearTimeout(timer);
    }
    previousCount.current = snapshot.count;
    return undefined;
  }, [snapshot.count]);

  // The window is exactly as wide as the controls need (the same measuring as the recording pill).
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

  const { state, auto, count, notice } = snapshot;
  const paused = state === 'paused';
  const saving = state === 'saving';
  const label = `${count} ${count === 1 ? 'step' : 'steps'}`;

  return (
    <div
      ref={pillRef}
      role="toolbar"
      aria-label="Step capture controls"
      data-testid="steps-pill"
      data-state={state}
      className="app-toolbar flex h-12 w-max items-center gap-2 overflow-hidden rounded-full border border-line-strong bg-surface pr-3 pl-2 text-fg select-none"
    >
      <span
        className="app-drag flex h-full w-4 shrink-0 cursor-grab items-center justify-center text-fg-subtle"
        title="Drag to move"
        aria-hidden="true"
      >
        <GripVertical className="size-4" />
      </span>

      <div className="flex shrink-0 items-center gap-2" data-testid="steps-status">
        <span
          aria-hidden="true"
          className={cn(
            'size-2.5 shrink-0 rounded-full',
            paused ? 'bg-warning' : 'bg-accent-solid',
          )}
        />
        <span
          role="status"
          data-testid="steps-count"
          className="min-w-[4.2rem] text-sm font-semibold tabular-nums"
        >
          {label}
        </span>
        {paused ? (
          <span className="text-xs font-semibold tracking-wide text-warning uppercase">Paused</span>
        ) : null}
        {notice ? (
          <span
            role="status"
            data-testid="steps-notice"
            className="flex max-w-56 items-center gap-1 truncate text-xs font-semibold text-warning"
            title={notice}
          >
            <TriangleAlert className="size-3.5 shrink-0" aria-hidden="true" />
            <span className="truncate">{notice}</span>
          </span>
        ) : null}
      </div>

      {saving ? (
        <span role="status" className="flex items-center gap-2 text-sm font-medium">
          <Loader2 className="size-4 animate-spin text-accent" aria-hidden="true" />
          Saving…
        </span>
      ) : confirming ? (
        <div className="flex items-center gap-2" role="alertdialog" aria-label="Discard the steps?">
          <span className="text-sm font-medium whitespace-nowrap">
            Discard {count === 0 ? 'this guide' : label}?
          </span>
          <button
            type="button"
            data-testid="steps-cancel-confirm"
            className="h-8 rounded-full bg-danger-solid px-3 text-sm font-semibold text-white transition-colors duration-150 hover:bg-danger-solid-hover"
            onClick={() => {
              setConfirming(false);
              void window.framecapt.invoke('steps:cancel');
            }}
          >
            Discard
          </button>
          <button
            type="button"
            data-testid="steps-cancel-keep"
            autoFocus
            className="h-8 rounded-full px-3 text-sm font-medium text-fg-muted transition-colors duration-150 hover:bg-surface-3 hover:text-fg"
            onClick={() => setConfirming(false)}
          >
            Keep
          </button>
        </div>
      ) : (
        <>
          <label className="flex shrink-0 cursor-pointer items-center gap-2 text-sm text-fg-muted">
            Auto
            <Switch
              checked={auto}
              onCheckedChange={(next) =>
                void window.framecapt.invoke('steps:setAuto', { auto: next })
              }
              aria-label="Capture steps automatically"
              data-testid="steps-auto"
            />
          </label>
          <button
            type="button"
            className={cn(iconButton, flash && 'bg-accent-soft text-accent-fg')}
            aria-label="Capture step"
            title="Capture step now"
            data-testid="steps-capture"
            onClick={() => void window.framecapt.invoke('steps:captureStep')}
          >
            {flash ? (
              <Check className="size-4" aria-hidden="true" />
            ) : (
              <Camera className="size-4" aria-hidden="true" />
            )}
          </button>
          <button
            type="button"
            className={iconButton}
            aria-label={paused ? 'Resume step capture' : 'Pause step capture'}
            title={paused ? 'Resume' : 'Pause'}
            data-testid={paused ? 'steps-resume' : 'steps-pause'}
            onClick={() => void window.framecapt.invoke(paused ? 'steps:resume' : 'steps:pause')}
          >
            {paused ? (
              <Play className="size-4" aria-hidden="true" />
            ) : (
              <Pause className="size-4" aria-hidden="true" />
            )}
          </button>
          <button
            type="button"
            className="flex h-8 shrink-0 items-center gap-1.5 rounded-full bg-accent-solid px-3.5 text-sm font-semibold text-white transition-colors duration-150 hover:bg-accent-solid-hover"
            aria-label="Done, save the guide"
            data-testid="steps-done"
            onClick={() => void window.framecapt.invoke('steps:done')}
          >
            <Check className="size-3.5" aria-hidden="true" />
            Done
          </button>
          <Divider />
          <button
            type="button"
            className={iconButton}
            aria-label="Cancel and discard"
            title="Cancel (discards the steps)"
            data-testid="steps-cancel"
            onClick={() =>
              count === 0 ? void window.framecapt.invoke('steps:cancel') : setConfirming(true)
            }
          >
            <X className="size-4" aria-hidden="true" />
          </button>
        </>
      )}
    </div>
  );
}
