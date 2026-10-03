import { useEffect, useState } from 'react';
import { App } from './App';
import { BootScreen } from './components/BootScreen';
import { useShortcutStates, useSettingsLoaded } from './settings/store';

/** The boot screen fades out over this long (styles.css, .boot-screen). */
const FADE_MS = 200;
/** Never keep the user behind the boot screen longer than this, whatever failed to load. */
const GIVE_UP_MS = 6000;

/** True once the history list has answered (or failed): the "recent captures" the home view shows. */
function useHistoryReady(): boolean {
  const [ready, setReady] = useState(false);
  useEffect(() => {
    let live = true;
    void window.framecapt
      .invoke('history:list', { limit: 1 })
      .catch(() => undefined)
      .then(() => live && setReady(true));
    return () => {
      live = false;
    };
  }, []);
  return ready;
}

/** E2E builds only: holds the boot screen until a `framecapt:boot-release` event (see brand.spec.ts). */
function useE2eHold(): boolean {
  const [held, setHeld] = useState(() => {
    try {
      return __FRAMECAPT_E2E__ && window.localStorage.getItem('framecapt-boot-hold') === '1';
    } catch {
      return false;
    }
  });
  useEffect(() => {
    if (!__FRAMECAPT_E2E__) return;
    const release = (): void => setHeld(false);
    window.addEventListener('framecapt:boot-release', release);
    return () => window.removeEventListener('framecapt:boot-release', release);
  }, []);
  return held;
}

/**
 * The main window: the app, covered by the boot screen until its first data has loaded. The app
 * mounts straight away underneath (inert), so its own loads run in parallel and there is no
 * artificial delay. Other window roles never render this (main.tsx).
 */
export function MainApp() {
  const settings = useSettingsLoaded();
  const shortcuts = useShortcutStates() !== null;
  const history = useHistoryReady();
  const held = useE2eHold();
  const [gaveUp, setGaveUp] = useState(false);
  const [gone, setGone] = useState(false);
  const ready = ((settings && shortcuts && history) || gaveUp) && !held;
  const phase = gone ? 'gone' : ready ? 'leaving' : 'booting';

  useEffect(() => {
    const timer = setTimeout(() => setGaveUp(true), GIVE_UP_MS);
    return () => clearTimeout(timer);
  }, []);

  useEffect(() => {
    if (!ready) return;
    const timer = setTimeout(() => setGone(true), FADE_MS);
    return () => clearTimeout(timer);
  }, [ready]);

  return (
    <>
      <div className="contents" inert={phase === 'booting'}>
        <App />
      </div>
      {phase === 'gone' ? null : <BootScreen leaving={phase === 'leaving'} />}
    </>
  );
}
