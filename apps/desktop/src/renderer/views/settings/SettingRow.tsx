import { useId, type ReactNode } from 'react';
import { Check, RotateCcw } from 'lucide-react';
import { Button } from '../../components/ui/Button';
import { Card } from '../../components/ui/Card';
import { cn } from '../../lib/cn';
import { useSavedVisible } from '../../settings/store';

export interface RowIds {
  /** Give the control `aria-labelledby={labelledBy}` and `aria-describedby={describedBy}`. */
  labelledBy: string;
  describedBy: string;
}

export interface SettingRowProps {
  label: string;
  /** One line that says what the setting does. */
  description: ReactNode;
  /** Stack the control under the text (long controls such as folder paths). */
  stacked?: boolean;
  children: (ids: RowIds) => ReactNode;
  /** An id other places can link to (the editable-data row of Privacy). */
  anchor?: string;
  'data-testid'?: string;
}

/** A label, a one-line description and a control: every setting looks like this. */
export function SettingRow({
  label,
  description,
  stacked,
  anchor,
  children,
  ...rest
}: SettingRowProps) {
  const id = useId();
  const ids: RowIds = { labelledBy: `${id}-label`, describedBy: `${id}-desc` };
  return (
    <div
      id={anchor}
      data-setting-row=""
      data-testid={rest['data-testid']}
      className={cn(
        'flex gap-x-8 gap-y-3 px-6 py-4',
        stacked ? 'flex-col' : 'flex-wrap items-center justify-between',
      )}
    >
      <div className="min-w-0 max-w-md flex-1 basis-48">
        <p id={ids.labelledBy} className="text-sm font-medium text-fg">
          {label}
        </p>
        <p id={ids.describedBy} className="mt-0.5 text-[13px] text-fg-muted">
          {description}
        </p>
      </div>
      <div className={cn('flex min-w-0 shrink-0 items-center gap-2.5', stacked && 'w-full shrink')}>
        {children(ids)}
      </div>
    </div>
  );
}

/** "Saved" for a moment after any change (the change itself is already applied and written). */
export function SavedIndicator() {
  const visible = useSavedVisible();
  return (
    <span
      aria-hidden="true"
      data-testid="settings-saved"
      data-visible={visible}
      className={cn(
        'inline-flex items-center gap-1.5 text-[13px] font-medium text-fg-muted transition-opacity duration-300',
        visible ? 'opacity-100' : 'opacity-0',
      )}
    >
      <Check className="size-4 text-accent-fg" />
      Saved
    </span>
  );
}

export interface SectionCardProps {
  id: string;
  title: string;
  description: string;
  /** Shows "Reset to defaults" (after a confirmation made by the caller). */
  onReset?: () => void;
  /** The text of the reset button (default "Reset to defaults"). */
  resetLabel?: string;
  children: ReactNode;
}

export function SectionCard({
  id,
  title,
  description,
  onReset,
  resetLabel = 'Reset to defaults',
  children,
}: SectionCardProps) {
  return (
    <section id={`settings-${id}`} aria-labelledby={`${id}-heading`} data-testid={`settings-${id}`}>
      <Card padding="none" className="overflow-hidden">
        <header className="flex flex-wrap items-start justify-between gap-3 border-b border-line px-6 py-5">
          <div className="min-w-0 flex-1 basis-72">
            <h2 id={`${id}-heading`} className="text-lg font-semibold text-fg">
              {title}
            </h2>
            <p className="mt-0.5 text-[13px] text-fg-muted">{description}</p>
          </div>
          {onReset ? (
            <Button
              size="sm"
              variant="ghost"
              icon={<RotateCcw className="size-3.5" aria-hidden="true" />}
              onClick={onReset}
              data-testid={`reset-${id}`}
            >
              {resetLabel}
            </Button>
          ) : null}
        </header>
        <div className="divide-y divide-line">{children}</div>
      </Card>
    </section>
  );
}
