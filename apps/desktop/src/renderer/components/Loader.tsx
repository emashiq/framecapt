import type { CSSProperties } from 'react';
import { cn } from '../lib/cn';
import { Logo } from './Logo';

const SIZES = {
  sm: { box: 20, logo: 12, ring: 2 },
  md: { box: 36, logo: 22, ring: 3 },
  lg: { box: 64, logo: 40, ring: 4 },
} as const;

export interface LoaderProps {
  size?: keyof typeof SIZES;
  /** What is loading, for screen readers (and shown beside the ring when `showLabel` is set). */
  label?: string;
  showLabel?: boolean;
  /** Next to text that already announces the work (a status line): hides the loader from assistive tech. */
  decorative?: boolean;
  className?: string;
}

/**
 * The brand loader: the logo mark inside a rotating cyan to indigo to violet ring. For a brand
 * moment (the app finishing a recording, an export starting), never for instant work. With
 * prefers-reduced-motion the ring stands still.
 */
export function Loader({
  size = 'md',
  label = 'Loading',
  showLabel = false,
  decorative = false,
  className,
}: LoaderProps) {
  const { box, logo, ring } = SIZES[size];
  return (
    <span
      {...(decorative ? { 'aria-hidden': true } : { role: 'status', 'aria-busy': true })}
      data-testid="loader"
      data-size={size}
      className={cn('inline-flex items-center gap-2.5', className)}
    >
      <span
        className="relative inline-flex shrink-0 items-center justify-center"
        style={{ width: box, height: box, '--ring': `${ring}px` } as CSSProperties}
      >
        <span className="loader-ring" />
        <Logo size={logo} />
      </span>
      {showLabel ? (
        <span className="text-sm text-fg-muted">{label}</span>
      ) : decorative ? null : (
        <span className="sr-only">{label}</span>
      )}
    </span>
  );
}
