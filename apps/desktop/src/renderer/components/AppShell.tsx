import { useEffect, useRef, type ReactNode } from 'react';
import { Camera, History, Keyboard, Settings, type LucideIcon } from 'lucide-react';
import { cn } from '../lib/cn';
import { TitleBar, type TitleBarProps } from './titlebar/TitleBar';

/** `flow` is a saved step guide, reached from History: it has no sidebar entry. */
export type ViewId = 'capture' | 'history' | 'settings' | 'flow';

const NAV_ITEMS: {
  id: Exclude<ViewId, 'flow'>;
  label: string;
  icon: LucideIcon;
}[] = [
  { id: 'capture', label: 'Capture', icon: Camera },
  { id: 'history', label: 'History', icon: History },
  { id: 'settings', label: 'Settings', icon: Settings },
];

export interface AppShellProps {
  view: ViewId;
  onNavigate: (view: ViewId) => void;
  children: ReactNode;
  /** A wider content column (the History grid). */
  wide?: boolean;
  /** Opens the keyboard shortcuts help. */
  onHelp?: () => void;
  /** The title bar's menus and command center (what a command does is up to the app, see App.tsx). */
  titleBar: TitleBarProps;
}

export function AppShell({
  view,
  onNavigate,
  children,
  wide = false,
  onHelp,
  titleBar,
}: AppShellProps) {
  const mainRef = useRef<HTMLElement>(null);
  const firstRender = useRef(true);

  // After navigating, move focus into the content so keyboard and screen reader users land there.
  useEffect(() => {
    if (firstRender.current) {
      firstRender.current = false;
      return;
    }
    mainRef.current?.focus({ preventScroll: true });
  }, [view]);

  return (
    <div className="flex h-full flex-col">
      <button
        type="button"
        data-testid="skip-link"
        onClick={() => mainRef.current?.focus()}
        className="sr-only z-50 rounded-lg bg-accent-solid px-4 py-2 text-sm font-medium text-white focus:not-sr-only focus:fixed focus:top-3 focus:left-3"
      >
        Skip to content
      </button>
      <TitleBar {...titleBar} />
      <div className="flex min-h-0 flex-1">
        <aside className="flex w-60 shrink-0 flex-col border-r border-line bg-surface-2 px-3 py-3">
          <nav aria-label="Primary" className="flex flex-col gap-1">
            {NAV_ITEMS.map(({ id, label, icon: Icon }) => {
              const active = id === (view === 'flow' ? 'history' : view);
              return (
                <button
                  key={id}
                  type="button"
                  aria-current={active ? 'page' : undefined}
                  onClick={() => onNavigate(id)}
                  className={cn(
                    'flex h-10 items-center gap-3 rounded-lg px-3 text-sm font-medium transition-colors duration-150',
                    active
                      ? 'bg-accent-soft text-accent-fg'
                      : 'text-fg-muted hover:bg-surface-3 hover:text-fg',
                  )}
                >
                  <Icon className="size-[18px]" aria-hidden="true" />
                  {label}
                </button>
              );
            })}
          </nav>
          <div className="mt-auto flex flex-col gap-2">
            {onHelp ? (
              <button
                type="button"
                onClick={onHelp}
                data-testid="help-button"
                title="Keyboard shortcuts (?)"
                className="flex h-10 items-center gap-3 rounded-lg px-3 text-sm font-medium text-fg-muted transition-colors duration-150 hover:bg-surface-3 hover:text-fg"
              >
                <Keyboard className="size-[18px]" aria-hidden="true" />
                Keyboard shortcuts
              </button>
            ) : null}
            <p className="px-2 text-xs text-fg-muted">Captures stay on this device.</p>
          </div>
        </aside>
        <main
          id="main-content"
          ref={mainRef}
          tabIndex={-1}
          className="min-w-0 flex-1 overflow-y-auto bg-bg outline-none focus-visible:outline-none"
        >
          <div
            key={view}
            className={cn('view-in mx-auto px-8 py-8', wide ? 'max-w-6xl' : 'max-w-4xl')}
          >
            {children}
          </div>
        </main>
      </div>
    </div>
  );
}
