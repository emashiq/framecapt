import type { ReactNode } from 'react';
import { cn } from '../lib/cn';

export function PageHeader({
  title,
  description,
  className,
}: {
  title: string;
  description?: ReactNode;
  className?: string;
}) {
  return (
    <header className={cn('mb-7', className)}>
      <h1 className="text-2xl font-semibold tracking-tight text-fg">{title}</h1>
      {description ? (
        <p className="mt-1.5 max-w-xl text-[15px] text-fg-muted">{description}</p>
      ) : null}
    </header>
  );
}
