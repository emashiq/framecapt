import { cn } from '../../lib/cn';

export interface SegmentedOption<T extends string | number> {
  value: T;
  label: string;
}

export interface SegmentedProps<T extends string | number> {
  value: T;
  options: readonly SegmentedOption<T>[];
  onChange: (value: T) => void;
  /** Accessible name of the group. */
  label: string;
  disabled?: boolean;
  className?: string;
  'data-testid'?: string;
}

function stepFor(key: string): number {
  if (key === 'ArrowRight' || key === 'ArrowDown') return 1;
  if (key === 'ArrowLeft' || key === 'ArrowUp') return -1;
  return 0;
}

/** A small single-choice control (role="radiogroup"); arrow keys move between options. */
export function Segmented<T extends string | number>({
  value,
  options,
  onChange,
  label,
  disabled,
  className,
  ...rest
}: SegmentedProps<T>) {
  return (
    <div
      role="radiogroup"
      aria-label={label}
      data-testid={rest['data-testid']}
      className={cn(
        'inline-flex self-start rounded-lg border border-line bg-surface-2 p-0.5',
        className,
      )}
    >
      {options.map((option, index) => {
        const selected = option.value === value;
        return (
          <button
            key={String(option.value)}
            type="button"
            role="radio"
            aria-checked={selected}
            disabled={disabled}
            tabIndex={selected ? 0 : -1}
            data-value={String(option.value)}
            onClick={() => onChange(option.value)}
            onKeyDown={(event) => {
              const step = stepFor(event.key);
              if (step === 0) return;
              event.preventDefault();
              const next = options[(index + step + options.length) % options.length];
              if (!next) return;
              onChange(next.value);
              event.currentTarget.parentElement
                ?.querySelector<HTMLButtonElement>(`[data-value="${String(next.value)}"]`)
                ?.focus();
            }}
            className={cn(
              'h-8 min-w-11 rounded-md px-3 text-[13px] font-medium transition-colors duration-150 disabled:opacity-50',
              selected ? 'bg-surface text-fg shadow-card' : 'text-fg-muted hover:text-fg',
            )}
          >
            {option.label}
          </button>
        );
      })}
    </div>
  );
}
