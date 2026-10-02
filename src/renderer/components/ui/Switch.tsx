import type { ComponentProps } from 'react';
import { cn } from '../../lib/cn';

export interface SwitchProps extends Omit<ComponentProps<'button'>, 'onChange' | 'role'> {
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
}

/** An on/off switch (role="switch"). Needs an accessible name from aria-label or aria-labelledby. */
export function Switch({ checked, onCheckedChange, className, disabled, ...rest }: SwitchProps) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      disabled={disabled}
      onClick={() => onCheckedChange(!checked)}
      className={cn(
        // The ::after widens the hit area to 44 x 32 px without changing the look.
        'relative inline-flex h-5 w-9 shrink-0 items-center rounded-full border transition-colors duration-150 after:absolute after:-inset-x-1 after:-inset-y-1.5 disabled:opacity-50',
        checked ? 'border-accent-solid bg-accent-solid' : 'border-control bg-surface-3',
        className,
      )}
      {...rest}
    >
      <span
        aria-hidden="true"
        className={cn(
          'block size-3.5 rounded-full bg-white shadow-card transition-transform duration-150',
          checked ? 'translate-x-[18px]' : 'translate-x-[2px]',
        )}
      />
    </button>
  );
}
