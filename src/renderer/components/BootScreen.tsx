import { Logo } from './Logo';

/**
 * The main window's start-up screen: the logo breathing in a soft glow, the name and a thin
 * indeterminate bar in the brand gradient. It covers the app while settings, history and shortcut
 * status load, then fades out (`leaving`). Rendered for the main window role only (MainApp).
 */
export function BootScreen({ leaving }: { leaving: boolean }) {
  return (
    <div
      role="status"
      aria-label="Starting FrameCapt"
      aria-busy={!leaving}
      data-testid="boot-screen"
      data-leaving={leaving}
      className="boot-screen"
    >
      <div className="relative flex size-[96px] items-center justify-center">
        <div className="boot-glow" aria-hidden="true" />
        <Logo size={96} />
      </div>
      <p className="relative text-xl font-semibold tracking-tight text-fg">FrameCapt</p>
      <div className="boot-bar" aria-hidden="true">
        <div className="boot-bar-segment" />
      </div>
    </div>
  );
}
