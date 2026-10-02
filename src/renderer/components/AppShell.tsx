import { useEffect, useRef, type ReactNode } from 'react';
import { Camera, History, Keyboard, Settings, type LucideIcon } from 'lucide-react';
import { cn } from '../lib/cn';
import { Logo } from './Logo';

export type ViewId = 'capture' | 'history' | 'settings';

const NAV_ITEMS: { id: ViewId; label: string; icon: LucideIcon }[] = [
  { id: 'capture', label: 'Capture', icon: Camera },
  { id: 'history', label: 'History', icon: History },
  { id: 'settings', label: 'Settings', icon: Settings },
];

export interface AppShellProps {
  view: ViewId;
  onNavigate: (view: ViewId) => void;
  children: ReactNode;
  /**
   * Editor mode: the sidebar shrinks to icons and the content area is edge to edge, because the
   * screenshot editor needs the room.
   */
  editor?: boolean;
  /** A wider content column (the History grid). */
  wide?: boolean;
  /** Opens the keyboard shortcuts help. */
  onHelp?: () => void;
}

export function AppShell({
  view,
  onNavigate,
  children,
  editor = false,
  wide = false,
  onHelp,
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
    <div className="flex h-full">
      <button
        type="button"
        data-testid="skip-link"
        onClick={() => mainRef.current?.focus()}
        className="sr-only z-50 rounded-lg bg-accent-solid px-4 py-2 text-sm font-medium text-white focus:not-sr-only focus:fixed focus:top-3 focus:left-3"
      >
        Skip to content
      </button>
      <aside
        className={cn(
          'flex shrink-0 flex-col border-r border-line bg-surface-2 py-4',
          editor ? 'w-16 items-center px-2' : 'w-60 px-3',
        )}
      >
        <div className={cn('mb-6 flex items-center gap-2.5', !editor && 'px-2')}>
          <Logo size={30} />
          {!editor && (
            <span className="text-[17px] font-semibold tracking-tight text-fg">Framelet</span>
          )}
        </div>
        <nav aria-label="Primary" className={cn('flex flex-col gap-1', editor && 'items-center')}>
          {NAV_ITEMS.map(({ id, label, icon: Icon }) => {
            const active = id === view;
            return (
              <button
                key={id}
                type="button"
                aria-current={active ? 'page' : undefined}
                aria-label={editor ? label : undefined}
                title={editor ? label : undefined}
                onClick={() => onNavigate(id)}
                className={cn(
                  'flex h-10 items-center gap-3 rounded-lg text-sm font-medium transition-colors duration-150',
                  editor ? 'w-10 justify-center' : 'px-3',
                  active
                    ? 'bg-accent-soft text-accent-fg'
                    : 'text-fg-muted hover:bg-surface-3 hover:text-fg',
                )}
              >
                <Icon className="size-[18px]" aria-hidden="true" />
                {!editor && label}
              </button>
            );
          })}
        </nav>
        <div className={cn('mt-auto flex flex-col gap-2', editor && 'items-center')}>
          {onHelp ? (
            <button
              type="button"
              onClick={onHelp}
              data-testid="help-button"
              aria-label={editor ? 'Keyboard shortcuts' : undefined}
              title="Keyboard shortcuts (?)"
              className={cn(
                'flex h-10 items-center gap-3 rounded-lg text-sm font-medium text-fg-muted transition-colors duration-150 hover:bg-surface-3 hover:text-fg',
                editor ? 'w-10 justify-center' : 'px-3',
              )}
            >
              <Keyboard className="size-[18px]" aria-hidden="true" />
              {!editor && 'Keyboard shortcuts'}
            </button>
          ) : null}
          {!editor && <p className="px-2 text-xs text-fg-muted">Offline. No account. Yours.</p>}
        </div>
      </aside>
      <main
        id="main-content"
        ref={mainRef}
        tabIndex={-1}
        className={cn(
          'min-w-0 flex-1 bg-bg outline-none focus-visible:outline-none',
          editor ? 'overflow-hidden' : 'overflow-y-auto',
        )}
      >
        <div
          key={view}
          className={cn(
            'view-in',
            editor ? 'h-full' : cn('mx-auto px-8 py-8', wide ? 'max-w-6xl' : 'max-w-4xl'),
          )}
        >
          {children}
        </div>
      </main>
    </div>
  );
}
