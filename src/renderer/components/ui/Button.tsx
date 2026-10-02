import type { ComponentProps, ReactNode } from 'react';
import { Loader2 } from 'lucide-react';
import { cn } from '../../lib/cn';

export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger';
export type ButtonSize = 'sm' | 'md' | 'lg';

export interface ButtonProps extends ComponentProps<'button'> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  /** Shows a spinner and blocks clicks while work is in progress. */
  loading?: boolean;
  /**
   * Looks and behaves disabled but stays focusable (aria-disabled), so a Tooltip can explain why.
   * Prefer this over `disabled` for features that are not available yet.
   */
  unavailable?: boolean;
  icon?: ReactNode;
}

const base =
  'inline-flex shrink-0 items-center justify-center gap-2 rounded-lg font-medium whitespace-nowrap ' +
  'transition-colors duration-150 disabled:opacity-50 aria-disabled:opacity-55 aria-disabled:cursor-not-allowed';

const variants: Record<ButtonVariant, string> = {
  primary:
    'bg-accent-solid text-white shadow-card not-aria-disabled:hover:bg-accent-solid-hover not-disabled:not-aria-disabled:active:brightness-95',
  secondary:
    'border border-line bg-surface text-fg shadow-card not-aria-disabled:hover:border-line-strong not-aria-disabled:hover:bg-surface-2',
  ghost: 'text-fg-muted not-aria-disabled:hover:bg-surface-3 not-aria-disabled:hover:text-fg',
  danger: 'bg-danger-solid text-white shadow-card not-aria-disabled:hover:bg-danger-solid-hover',
};

const sizes: Record<ButtonSize, string> = {
  sm: 'h-8 px-3 text-[13px]',
  md: 'h-10 px-4 text-sm',
  lg: 'h-12 px-5 text-base',
};

export function Button({
  variant = 'secondary',
  size = 'md',
  loading = false,
  unavailable = false,
  icon,
  className,
  children,
  disabled,
  onClick,
  type = 'button',
  ...rest
}: ButtonProps) {
  const blocked = loading || unavailable;
  return (
    <button
      type={type}
      className={cn(base, variants[variant], sizes[size], className)}
      disabled={disabled || loading}
      aria-disabled={unavailable || undefined}
      aria-busy={loading || undefined}
      onClick={(event) => {
        if (blocked) event.preventDefault();
        else onClick?.(event);
      }}
      {...rest}
    >
      {loading ? <Loader2 className="size-4 animate-spin" aria-hidden="true" /> : icon}
      {children}
    </button>
  );
}
