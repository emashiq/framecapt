import { useRef, type ReactNode } from 'react';
import { TitleBar, type TitleBarProps } from './titlebar/TitleBar';

export interface AppShellProps {
  /** The icon rail (left, full height under the title bar). */
  rail: ReactNode;
  /** The strip of tabs above the content. */
  strip: ReactNode;
  /** The panels: the pinned Home tab and one per edited item, each filling the content area. */
  children: ReactNode;
  /** The title bar's menus and command center (what a command does is up to the app, see App.tsx). */
  titleBar: TitleBarProps;
}

/**
 * The window layout: the title bar on top; below it the icon rail on the left and, to its right,
 * the tab strip over the content. The content holds one absolutely positioned panel per tab so
 * switching tabs never moves anything.
 */
export function AppShell({ rail, strip, children, titleBar }: AppShellProps) {
  const mainRef = useRef<HTMLElement>(null);
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
        {rail}
        <div className="flex min-w-0 flex-1 flex-col">
          {strip}
          <main
            id="main-content"
            ref={mainRef}
            tabIndex={-1}
            className="relative min-h-0 flex-1 bg-bg outline-none focus-visible:outline-none"
          >
            {children}
          </main>
        </div>
      </div>
    </div>
  );
}
