import { useEffect } from 'react';
import { useRecorderState } from '../recorder/use-recorder';

/**
 * The 3-2-1 countdown (role 'countdown'): a translucent disc in a click-through window on the
 * recorded screen. The number comes from the recorder state, so it needs no channel of its own.
 * Esc cancels (main registers it as a global shortcut while the countdown runs, because this
 * window never takes focus). Motion respects prefers-reduced-motion (see styles.css).
 */
export function CountdownView() {
  const snapshot = useRecorderState();

  useEffect(() => {
    document.documentElement.classList.add('overlay-root');
  }, []);

  if (snapshot.countdown === null) return null;
  return (
    <div
      data-testid="countdown"
      role="status"
      aria-live="assertive"
      aria-label={`Recording starts in ${snapshot.countdown}`}
      className="flex size-full flex-col items-center justify-center gap-2 rounded-[2.25rem] bg-black/55 text-white select-none"
    >
      <span
        key={snapshot.countdown}
        data-testid="countdown-number"
        className="countdown-pop text-[104px] leading-none font-semibold tabular-nums"
      >
        {snapshot.countdown}
      </span>
      <span className="text-[13px] font-medium text-white/80">Esc to cancel</span>
    </div>
  );
}
