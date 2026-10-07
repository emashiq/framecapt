import type { ReactNode } from 'react';
import { ChevronDown } from 'lucide-react';
import { cn } from '../../lib/cn';

export interface SelectOption<T extends string> {
  value: T;
  label: string;
  hidden?: boolean;
  disabled?: boolean;
}

export interface SelectProps<T extends string> {
  value: T;
  options: readonly SelectOption<T>[];
  onChange: (value: T) => void;
  /** Accessible name (a visible label may also point at it with aria-labelledby). */
  label?: string;
  labelledBy?: string;
  disabled?: boolean;
  className?: string;
  /** Extra options rendered before the list (for example a "Default" entry). */
  children?: ReactNode;
  'data-testid'?: string;
}

/** A native <select> with the app's look: keyboard and screen reader behaviour come for free. */
export function Select<T extends string>({
  value,
  options,
  onChange,
  label,
  labelledBy,
  disabled,
  className,
  children,
  ...rest
}: SelectProps<T>) {
  return (
    <div className={cn('relative', className)}>
      <select
        value={value}
        disabled={disabled}
        aria-label={label}
        aria-labelledby={labelledBy}
        data-testid={rest['data-testid']}
        onChange={(event) => onChange(event.target.value as T)}
        className="selectable h-9 w-full appearance-none truncate rounded-lg border border-control bg-surface pr-8 pl-3 text-[13px] text-fg shadow-card transition-colors duration-150 not-disabled:hover:border-fg-muted disabled:opacity-50"
      >
        {children}
        {options.map((option) => (
          <option
            key={option.value}
            value={option.value}
            hidden={option.hidden}
            disabled={option.disabled}
          >
            {option.label}
          </option>
        ))}
      </select>
      <ChevronDown
        className="pointer-events-none absolute top-1/2 right-2.5 size-4 -translate-y-1/2 text-fg-subtle"
        aria-hidden="true"
      />
    </div>
  );
}
