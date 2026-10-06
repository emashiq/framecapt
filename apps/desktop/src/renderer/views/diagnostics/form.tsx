import type { ComponentProps, ReactNode } from 'react';
import { cn } from '../../lib/cn';

const control =
  'h-9 rounded-lg border border-line bg-surface px-3 text-sm text-fg shadow-card ' +
  'focus-visible:outline-2 disabled:opacity-50';

export function Field({
  label,
  children,
  className,
}: {
  label: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <label className={cn('flex flex-col gap-1 text-[13px] font-medium text-fg-muted', className)}>
      {label}
      {children}
    </label>
  );
}

export function SelectInput({ className, ...rest }: ComponentProps<'select'>) {
  return <select className={cn(control, 'pr-8', className)} {...rest} />;
}

export function NumberInput({ className, ...rest }: ComponentProps<'input'>) {
  return <input type="number" className={cn(control, 'w-24 tabular-nums', className)} {...rest} />;
}

export function CheckboxField({
  label,
  className,
  ...rest
}: Omit<ComponentProps<'input'>, 'type'> & { label: string }) {
  return (
    <label className={cn('flex items-center gap-2 text-sm text-fg', className)}>
      <input type="checkbox" className="size-4 accent-[var(--accent-solid)]" {...rest} />
      {label}
    </label>
  );
}

export function StatusPill({ pass, label }: { pass: boolean; label?: string }) {
  return (
    <span
      className={cn(
        'inline-flex items-center rounded-md px-2 py-0.5 text-xs font-semibold',
        pass ? 'bg-accent-soft text-accent-fg' : 'bg-danger-soft text-danger',
      )}
    >
      {label ?? (pass ? 'PASS' : 'FAIL')}
    </span>
  );
}
