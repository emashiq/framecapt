import { cn } from '../../lib/cn';

export interface KbdProps {
  /** Key labels in order, for example ['Ctrl', 'Shift', '1']. */
  keys: string[];
  className?: string;
}

/** Keyboard shortcut hint. Label only: it does not register a shortcut. */
export function Kbd({ keys, className }: KbdProps) {
  return (
    <span
      className={cn('inline-flex items-center gap-1', className)}
      role="img"
      aria-label={keys.join(' plus ')}
    >
      {keys.map((key, index) => (
        <kbd
          key={`${key}-${index}`}
          className="inline-flex h-6 min-w-6 items-center justify-center rounded-md border border-b-2 border-line-strong bg-surface-2 px-1.5 font-sans text-xs font-medium text-fg-muted"
        >
          {key}
        </kbd>
      ))}
    </span>
  );
}
