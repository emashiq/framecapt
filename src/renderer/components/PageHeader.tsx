import type { ReactNode } from 'react';

export function PageHeader({ title, description }: { title: string; description?: ReactNode }) {
  return (
    <header className="mb-7">
      <h1 className="text-2xl font-semibold tracking-tight text-fg">{title}</h1>
      {description ? (
        <p className="mt-1.5 max-w-xl text-[15px] text-fg-muted">{description}</p>
      ) : null}
    </header>
  );
}
