import { useId, useState } from 'react';
import { Check, Pipette } from 'lucide-react';
import { BLACK, COLORS, WHITE, normalizeHex } from '../../editor/presets';
import { Tooltip } from '../../components/ui/Tooltip';
import { cn } from '../../lib/cn';

/** The browser's EyeDropper API (Chromium): not in every TypeScript lib, so typed here. */
interface EyeDropperLike {
  open(): Promise<{ sRGBHex: string }>;
}
type EyeDropperCtor = new () => EyeDropperLike;
const eyeDropper = (): EyeDropperCtor | undefined =>
  (window as unknown as { EyeDropper?: EyeDropperCtor }).EyeDropper;

const PALETTE: readonly { value: string; label: string }[] = [
  ...COLORS,
  { value: BLACK, label: 'Black' },
  { value: WHITE, label: 'White' },
];

function Swatch({
  color,
  label,
  checked,
  onSelect,
  testId,
}: {
  color: string;
  label: string;
  checked: boolean;
  onSelect: () => void;
  testId?: string;
}) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={checked}
      aria-label={label}
      title={label}
      data-testid={testId}
      onClick={onSelect}
      className={cn(
        'relative size-6 rounded-full border border-black/15 transition-transform duration-150 hover:scale-110 motion-reduce:transition-none dark:border-white/25',
        checked && 'ring-2 ring-accent ring-offset-2 ring-offset-surface',
      )}
      style={{ background: color }}
    >
      {checked && (
        <Check
          className={cn(
            'absolute inset-0 m-auto size-3.5',
            color.toUpperCase() === WHITE ? 'text-black' : 'text-white',
          )}
          aria-hidden="true"
        />
      )}
    </button>
  );
}

export interface ColorPickerProps {
  /** The current color as `#RRGGBB`. */
  value: string;
  onChange: (color: string) => void;
  /** Colors used recently, newest first. */
  recent: readonly string[];
  label: string;
  testId: string;
  /** Offers "No color" (for fills and backgrounds). */
  allowNone?: boolean;
  onNone?: () => void;
  none?: boolean;
}

/**
 * The palette, a hex field, the colors used lately and (where the browser has it) an eyedropper
 * that picks a color from anywhere on the screen.
 */
export function ColorPicker({
  value,
  onChange,
  recent,
  label,
  testId,
  allowNone,
  onNone,
  none,
}: ColorPickerProps) {
  const id = useId();
  // What is being typed (null: show the current value). An unfinished or wrong code is flagged.
  const [draft, setDraft] = useState<string | null>(null);
  const text = draft ?? value;
  const invalid = draft !== null && normalizeHex(draft) === null;

  const pick = (color: string): void => {
    setDraft(null);
    onChange(color);
  };
  const apply = (raw: string): void => {
    const hex = normalizeHex(raw);
    if (!hex) return; // stays on screen, flagged
    setDraft(null);
    if (hex !== value.toUpperCase()) onChange(hex);
  };
  const Dropper = eyeDropper();
  const current = value.toUpperCase();

  return (
    <div className="flex flex-col gap-2" data-testid={testId}>
      <div role="radiogroup" aria-label={`${label} swatches`} className="flex flex-wrap gap-2">
        {allowNone && (
          <button
            type="button"
            role="radio"
            aria-checked={none === true}
            aria-label="No color"
            title="None"
            data-testid={`${testId}-none`}
            onClick={onNone}
            className={cn(
              'relative size-6 rounded-full border border-line-strong bg-surface',
              none && 'ring-2 ring-accent ring-offset-2 ring-offset-surface',
            )}
          >
            <span
              aria-hidden="true"
              className="absolute inset-x-0.5 top-1/2 h-px -rotate-45 bg-danger"
            />
          </button>
        )}
        {PALETTE.map((swatch) => (
          <Swatch
            key={swatch.value}
            color={swatch.value}
            label={swatch.label}
            checked={!none && current === swatch.value.toUpperCase()}
            onSelect={() => pick(swatch.value)}
            testId={`${testId}-${swatch.label.toLowerCase()}`}
          />
        ))}
      </div>
      <div className="flex items-center gap-2">
        <label htmlFor={id} className="sr-only">
          {label} as a hex code
        </label>
        <input
          id={id}
          value={text}
          spellCheck={false}
          maxLength={7}
          aria-invalid={invalid || undefined}
          data-testid={`${testId}-hex`}
          onChange={(event) => {
            setDraft(event.target.value);
            const hex = normalizeHex(event.target.value);
            if (hex && hex !== current) onChange(hex);
          }}
          onBlur={() => (draft === null ? undefined : apply(draft))}
          onKeyDown={(event) => {
            event.stopPropagation();
            if (event.key === 'Enter' && draft !== null) apply(draft);
          }}
          className={cn(
            'h-8 w-24 rounded-md border bg-surface px-2 font-mono text-xs text-fg uppercase',
            invalid ? 'border-danger' : 'border-control',
          )}
        />
        {Dropper && (
          <Tooltip content="Pick a color from the screen">
            <button
              type="button"
              aria-label={`Pick ${label.toLowerCase()} from the screen`}
              data-testid={`${testId}-eyedropper`}
              onClick={() => {
                void new Dropper()
                  .open()
                  .then((result) => {
                    const hex = normalizeHex(result.sRGBHex);
                    if (hex) pick(hex);
                  })
                  .catch(() => undefined);
              }}
              className="inline-flex size-8 items-center justify-center rounded-md border border-line bg-surface text-fg-muted hover:bg-surface-3 hover:text-fg"
            >
              <Pipette className="size-4" aria-hidden="true" />
            </button>
          </Tooltip>
        )}
      </div>
      {invalid && (
        <p role="alert" className="text-xs text-danger">
          Use a hex color such as #3B82F6.
        </p>
      )}
      {recent.length > 0 && (
        <div role="group" aria-label="Recent colors" className="flex flex-wrap gap-1.5">
          {recent.map((color) => (
            <button
              key={color}
              type="button"
              aria-label={`Recent color ${color}`}
              title={color}
              data-testid={`${testId}-recent`}
              onClick={() => pick(color)}
              className="size-5 rounded-full border border-black/15 dark:border-white/25"
              style={{ background: color }}
            />
          ))}
        </div>
      )}
    </div>
  );
}
