import { useEffect, useState } from 'react';
import type { OverlayInit } from '../../../shared/shot-ipc';
import { DisplayPicker } from './DisplayPicker';
import { RegionSelector } from './RegionSelector';

/**
 * Root of an overlay window (role 'overlay', one per display). Asks main what to draw: the region
 * selector (on the frozen frame, or live for a recording) or the display picker. The page is
 * transparent so the live modes show the desktop through it.
 */
export function OverlayView() {
  const [init, setInit] = useState<OverlayInit | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    document.documentElement.classList.add('overlay-root');
    let active = true;
    void window.framelet.invoke('overlay:getInit').then((result) => {
      if (!active) return;
      if (result.ok) setInit(result.data);
      else {
        setFailed(true);
        void window.framelet.invoke('overlay:cancel');
      }
    });
    return () => {
      active = false;
    };
  }, []);

  if (failed || !init) return null;
  return init.mode === 'pick-display' ? (
    <DisplayPicker init={init} />
  ) : (
    <RegionSelector init={init} />
  );
}
