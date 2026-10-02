import { useEffect, useRef, useState } from 'react';
import { Monitor } from 'lucide-react';
import { Kbd } from '../../components/ui/Kbd';
import { cn } from '../../lib/cn';
import type { OverlayInit } from '../../../shared/shot-ipc';

/**
 * Screen picking for Screenshot -> Screen on multi-monitor setups: a translucent overlay per
 * display, the hovered (or keyboard-focused) one is highlighted and shows a "Click to capture"
 * card. A click picks the display; Esc cancels.
 */
export function DisplayPicker({ init }: { init: OverlayInit }) {
  const [hovered, setHovered] = useState(false);
  const [focused, setFocused] = useState(() => document.hasFocus());
  const [picking, setPicking] = useState(false);
  const [ready, setReady] = useState(false);
  const readyRef = useRef(false);

  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        event.preventDefault();
        void window.framelet.invoke('overlay:cancel');
      } else if (event.key === 'Enter' && document.hasFocus()) {
        event.preventDefault();
        pick();
      }
    };
    const onFocus = (): void => setFocused(true);
    const onBlur = (): void => setFocused(false);
    window.addEventListener('keydown', onKey);
    window.addEventListener('focus', onFocus);
    window.addEventListener('blur', onBlur);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('focus', onFocus);
      window.removeEventListener('blur', onBlur);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- pick() reads only stable values
  }, []);

  // Tell main the window is painted so it can show it. Picking waits for the answer: before that
  // the overlay is not on screen, and a click cannot be meant for it.
  useEffect(() => {
    let active = true;
    requestAnimationFrame(() =>
      requestAnimationFrame(
        () =>
          void window.framelet.invoke('overlay:ready').then(() => {
            if (!active) return;
            readyRef.current = true;
            setReady(true);
          }),
      ),
    );
    return () => {
      active = false;
    };
  }, []);

  function pick(): void {
    if (picking || !readyRef.current) return;
    setPicking(true);
    void window.framelet.invoke('overlay:pickDisplay', { displayId: init.displayId });
  }

  const active = hovered || focused;
  const { width, height } = init.frameSize;
  return (
    <div
      data-testid="overlay-pick"
      data-display-id={init.displayId}
      data-active={active}
      data-ready={ready}
      className={cn(
        'fixed inset-0 flex items-center justify-center transition-colors duration-150 select-none',
        active ? 'bg-accent-solid/20' : 'bg-black/40',
      )}
      style={{
        cursor: 'pointer',
        boxShadow: active ? 'inset 0 0 0 4px var(--accent)' : 'none',
      }}
      onPointerEnter={() => setHovered(true)}
      onPointerLeave={() => setHovered(false)}
      onPointerMove={() => setHovered(true)}
      onClick={pick}
      onContextMenu={(event) => {
        event.preventDefault();
        void window.framelet.invoke('overlay:cancel');
      }}
    >
      <div
        className={cn(
          'flex flex-col items-center gap-3 rounded-2xl border border-line bg-surface px-8 py-6 text-center shadow-raised transition-all duration-150',
          active ? 'scale-100 opacity-100' : 'scale-95 opacity-0',
        )}
      >
        <div className="flex size-11 items-center justify-center rounded-xl bg-accent-soft text-accent-fg">
          <Monitor className="size-5" aria-hidden="true" />
        </div>
        <div>
          <p className="text-lg font-semibold text-fg">Click to capture this screen</p>
          <p className="mt-0.5 text-sm text-fg-muted tabular-nums">
            {width} × {height} px
          </p>
        </div>
        <p className="flex items-center gap-2 text-[13px] text-fg-muted">
          <Kbd keys={['Esc']} /> to cancel
        </p>
      </div>
    </div>
  );
}
