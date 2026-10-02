import type { CSSProperties, ReactNode } from 'react';
import { cn } from '../../lib/cn';

/** A small floating label used on the selection overlays (hint, size readout). */
export function OverlayChip({
  children,
  className,
  style,
  testId,
}: {
  children: ReactNode;
  className?: string;
  style?: CSSProperties;
  testId?: string;
}) {
  return (
    <div
      data-testid={testId}
      className={cn(
        'pointer-events-none w-max rounded-lg border border-line bg-surface/95 px-2.5 py-1 text-xs font-medium text-fg shadow-raised backdrop-blur-sm',
        className,
      )}
      style={style}
    >
      {children}
    </div>
  );
}
