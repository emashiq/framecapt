import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type RefObject,
} from 'react';
import { Search } from 'lucide-react';
import { acceleratorKeys, matchEditorAction } from '../../../shared/shortcuts';
import type { HistoryItemView } from '../../../shared/history-ipc';
import { buildCommands, type Command, type CommandActions } from '../../commands/registry';
import { titleBarLayout, type TitleBarLayout } from '../../commands/layout';
import { loadRecents, pushRecent } from '../../commands/recents';
import { notify } from '../../lib/notify';
import { useMultiDisplay } from '../../lib/use-multi-display';
import { useRecorderState } from '../../recorder/use-recorder';
import { getSettings, updateSettings, useSettings } from '../../settings/store';
import { createItemActions } from '../../views/history/actions';
import { Logo } from '../Logo';
import { Kbd } from '../ui/Kbd';
import { CommandPalette } from './CommandPalette';
import { MenuBar } from './MenuBar';

export interface TitleBarProps {
  /** What the app itself does for a command: the same functions as its buttons (see App.tsx). */
  actions: Pick<
    CommandActions,
    'startCapture' | 'navigate' | 'showKeyboardHelp' | 'editVideo' | 'openImage'
  >;
  /** Opens a saved capture in History. */
  onOpenCapture: (id: string) => void;
}

const FULL_LAYOUT: TitleBarLayout = { collapsedMenus: false, iconSearch: false };
const noop = (): void => undefined;

/** The width the bar may use: the window without the window-button overlay. */
function useBarLayout(areaRef: RefObject<HTMLDivElement | null>): TitleBarLayout {
  const [layout, setLayout] = useState(FULL_LAYOUT);
  useLayoutEffect(() => {
    const area = areaRef.current;
    if (!area) return;
    const measure = (): void => {
      const next = titleBarLayout(area.clientWidth);
      setLayout((current) =>
        current.collapsedMenus === next.collapsedMenus && current.iconSearch === next.iconSearch
          ? current
          : next,
      );
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(area);
    return () => observer.disconnect();
  }, [areaRef]);
  return layout;
}

/**
 * The main window's title bar: logo and menus on the left, the command center in the middle. With the window-controls overlay the OS draws minimize, maximize
 * and close over the right end of this bar; the content stays left of them (`.title-bar-area`).
 */
export function TitleBar({ actions, onOpenCapture }: TitleBarProps) {
  const settings = useSettings();
  const recorder = useRecorderState();
  const multiDisplay = useMultiDisplay();
  const areaRef = useRef<HTMLDivElement>(null);
  const layout = useBarLayout(areaRef);
  const [palette, setPalette] = useState<'all' | 'commands' | null>(null);
  const [recents, setRecents] = useState<string[]>([]);

  const openPalette = useCallback((mode: 'all' | 'commands') => {
    setRecents(loadRecents());
    setPalette(mode);
  }, []);

  // Ctrl+K and Ctrl+Shift+P (editable in Settings, Shortcuts): everywhere in the main window.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.repeat || event.defaultPrevented) return;
      const action = matchEditorAction(event, getSettings().editorShortcuts);
      if (action !== 'commandCenter' && action !== 'commandPalette') return;
      // A dialog (this one, keyboard help, a confirmation) owns the keyboard while it is open.
      if (document.querySelector('dialog[open]')) return;
      event.preventDefault();
      openPalette(action === 'commandCenter' ? 'all' : 'commands');
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [openPalette]);

  const commandActions = useMemo<CommandActions>(
    () => ({
      ...actions,
      stopRecording: () =>
        void window.framecapt.invoke('recorder:stop').then((response) => {
          if (!response.ok) notify.error(response.error);
        }),
      togglePause: () =>
        void window.framecapt
          .invoke(recorder.status === 'paused' ? 'recorder:resume' : 'recorder:pause')
          .then((response) => {
            if (!response.ok) notify.error(response.error);
          }),
      toggleTheme: () => {
        const { theme } = getSettings().general;
        const dark =
          theme === 'dark' ||
          (theme === 'system' && window.matchMedia('(prefers-color-scheme: dark)').matches);
        void updateSettings({ general: { theme: dark ? 'light' : 'dark' } });
      },
      quit: () =>
        void window.framecapt.invoke('app:requestQuit').then((response) => {
          if (!response.ok) notify.error(response.error);
        }),
      openCommandCenter: () => openPalette('all'),
    }),
    [actions, recorder.status, openPalette],
  );

  const commands = useMemo(
    () => buildCommands({ recorderStatus: recorder.status, multiDisplay }, commandActions),
    [recorder.status, multiDisplay, commandActions],
  );

  const runFromPalette = (command: Command): void => {
    setRecents(pushRecent(command.id));
    command.run();
  };

  const openShortcut = settings.editorShortcuts.commandCenter;
  const icons = layout.iconSearch;

  const history = createItemActions(noop);

  return (
    <>
      <header
        data-testid="title-bar"
        className="title-bar flex shrink-0 items-stretch border-b border-line bg-surface-2"
      >
        <div ref={areaRef} className="title-bar-area flex min-w-0 items-center gap-2 px-3">
          <div className="flex shrink-0 items-center gap-2 pr-1">
            <Logo size={20} />
            <span className="text-[13px] font-semibold tracking-tight text-fg">FrameCapt</span>
          </div>
          <MenuBar
            commands={commands}
            settings={settings}
            collapsed={layout.collapsedMenus}
            onRun={(command) => command.run()}
          />
          <div className="flex min-w-0 flex-1 justify-center">
            <button
              type="button"
              aria-haspopup="dialog"
              aria-label={icons ? 'Search commands and captures' : undefined}
              aria-keyshortcuts={openShortcut ?? undefined}
              title={icons ? 'Search commands and captures' : undefined}
              data-testid="command-center-button"
              onClick={() => openPalette('all')}
              className={
                icons
                  ? 'no-drag flex size-7 items-center justify-center rounded-md text-fg-muted hover:bg-surface-3 hover:text-fg'
                  : 'no-drag flex h-7 w-full max-w-xl min-w-0 items-center gap-2 rounded-lg border border-line bg-surface px-2.5 text-left text-[13px] text-fg-muted transition-colors duration-150 hover:border-line-strong hover:text-fg'
              }
            >
              <Search className="size-3.5 shrink-0" aria-hidden="true" />
              {icons ? null : (
                <>
                  <span className="min-w-0 flex-1 truncate">Search commands and captures…</span>
                  {openShortcut ? <Kbd keys={acceleratorKeys(openShortcut)} /> : null}
                </>
              )}
            </button>
          </div>
        </div>
      </header>
      <CommandPalette
        open={palette !== null}
        mode={palette ?? 'all'}
        commands={commands}
        settings={settings}
        recents={recents}
        onClose={() => setPalette(null)}
        onRun={runFromPalette}
        onOpenCapture={(item: HistoryItemView) => onOpenCapture(item.id)}
        onRevealCapture={history.reveal}
      />
    </>
  );
}
