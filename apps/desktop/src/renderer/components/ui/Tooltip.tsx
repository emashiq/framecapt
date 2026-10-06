import type { ReactElement, ReactNode } from 'react';
import * as RadixTooltip from '@radix-ui/react-tooltip';

/** Wrap the app once so tooltips share hover-delay behavior. */
export function TooltipProvider({ children }: { children: ReactNode }) {
  return (
    <RadixTooltip.Provider delayDuration={250} skipDelayDuration={300}>
      {children}
    </RadixTooltip.Provider>
  );
}

export interface TooltipProps {
  content: ReactNode;
  /** A single element that accepts a ref and pointer/focus props (for example a button). */
  children: ReactElement;
  side?: 'top' | 'right' | 'bottom' | 'left';
  /**
   * The tip never takes the pointer: controls under it stay clickable. For tips that open over a
   * toolbar, where a hoverable tip would block the neighbouring buttons.
   */
  passthrough?: boolean;
}

export function Tooltip({ content, children, side = 'top', passthrough = false }: TooltipProps) {
  return (
    <RadixTooltip.Root>
      <RadixTooltip.Trigger asChild>{children}</RadixTooltip.Trigger>
      <RadixTooltip.Portal>
        <RadixTooltip.Content
          side={side}
          sideOffset={6}
          className={`z-50 rounded-lg bg-fg px-2.5 py-1.5 text-xs font-medium text-bg shadow-raised${passthrough ? ' tooltip-passthrough pointer-events-none' : ''}`}
        >
          {content}
          <RadixTooltip.Arrow className="fill-fg" />
        </RadixTooltip.Content>
      </RadixTooltip.Portal>
    </RadixTooltip.Root>
  );
}
