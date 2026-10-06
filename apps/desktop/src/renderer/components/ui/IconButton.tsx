import type { ComponentProps, ReactNode } from 'react';
import { cn } from '../../lib/cn';
import { Tooltip } from './Tooltip';

export interface IconButtonProps extends Omit<ComponentProps<'button'>, 'aria-label' | 'children'> {
  /** Required: icon-only buttons have no visible text. Also used as the tooltip. */
  'aria-label': string;
  icon: ReactNode;
  variant?: 'secondary' | 'ghost';
  size?: 'sm' | 'md';
}

export function IconButton({
  icon,
  variant = 'ghost',
  size = 'md',
  className,
  type = 'button',
  ...rest
}: IconButtonProps) {
  return (
    <Tooltip content={rest['aria-label']}>
      <button
        type={type}
        className={cn(
          'inline-flex shrink-0 items-center justify-center rounded-lg transition-colors duration-150 disabled:opacity-50',
          variant === 'secondary'
            ? 'border border-line bg-surface text-fg shadow-card hover:bg-surface-2'
            : 'text-fg-muted hover:bg-surface-3 hover:text-fg',
          size === 'sm' ? 'size-8' : 'size-10',
          className,
        )}
        {...rest}
      >
        {icon}
      </button>
    </Tooltip>
  );
}
