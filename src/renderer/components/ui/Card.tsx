import type { ComponentProps } from 'react';
import { cn } from '../../lib/cn';

export interface CardProps extends ComponentProps<'div'> {
  padding?: 'none' | 'md' | 'lg';
}

export function Card({ padding = 'md', className, ...rest }: CardProps) {
  return (
    <div
      className={cn(
        'rounded-xl border border-line bg-surface shadow-card',
        padding === 'md' && 'p-5',
        padding === 'lg' && 'p-6',
        className,
      )}
      {...rest}
    />
  );
}
