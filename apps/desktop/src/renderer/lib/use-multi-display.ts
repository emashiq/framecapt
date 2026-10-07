import { useEffect, useState } from 'react';

/** True when more than one display is connected (re-checked when the window gets focus). */
export function useMultiDisplay(): boolean {
  const [multi, setMulti] = useState(false);
  useEffect(() => {
    let live = true;
    const load = (): void => {
      void window.framecapt.invoke('capture:listDisplays').then((result) => {
        if (live && result.ok) setMulti(result.data.length > 1);
      });
    };
    load();
    window.addEventListener('focus', load);
    return () => {
      live = false;
      window.removeEventListener('focus', load);
    };
  }, []);
  return multi;
}
