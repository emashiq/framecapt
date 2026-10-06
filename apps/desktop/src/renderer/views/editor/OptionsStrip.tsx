import { memo, type ReactNode } from 'react';
import { Check, Info, RotateCcw } from 'lucide-react';
import type { AnnotationType } from '../../editor/model/types';
import { ASPECT_PRESETS, type AspectId } from '../../editor/presets';
import {
  BLACK,
  COLORS,
  HIGHLIGHT_COLORS,
  FONT_LABELS,
  WHITE,
  WIDTH_LABELS,
  type SizeStep,
} from '../../editor/presets';
import { Tooltip } from '../../components/ui/Tooltip';
import { cn } from '../../lib/cn';
import { BLUR_TIP, REDACT_TIP, type ToolId } from './tools';

export interface OptionsStripProps {
  tool: ToolId;
  /** The kind of the selected annotation, if any. */
  selectedType: AnnotationType | 'multiple' | null;
  color: string;
  widthStep: number;
  fontStep: number;
  onColor: (color: string) => void;
  onWidthStep: (step: 0 | 1 | 2) => void;
  onFontStep: (step: SizeStep) => void;
  /** Crop tool. */
  cropSize: { width: number; height: number } | null;
  hasCrop: boolean;
  onApplyCrop: () => void;
  onResetCrop: () => void;
  cropAspect: AspectId;
  onCropAspect: (id: AspectId) => void;
  /** Highlighter: a box or a freehand stroke. */
  highlightMode: 'rect' | 'freehand';
  onHighlightMode: (mode: 'rect' | 'freehand') => void;
  /** Step numbers: the number the next badge gets. */
  nextStep: number;
  onResetSteps: () => void;
}

function Swatch({
  color,
  label,
  checked,
  onSelect,
  split,
}: {
  color: string;
  label: string;
  checked: boolean;
  onSelect: () => void;
  split?: boolean;
}) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={checked}
      aria-label={label}
      data-testid={`color-${label.toLowerCase().replace(/[^a-z]+/g, '-')}`}
      title={label}
      onClick={onSelect}
      className={cn(
        'relative size-6 rounded-full border border-black/15 transition-transform duration-150 hover:scale-110 dark:border-white/25',
        checked && 'ring-2 ring-accent ring-offset-2 ring-offset-surface-2',
      )}
      style={{
        background: split ? `linear-gradient(135deg, ${WHITE} 50%, ${BLACK} 50%)` : color,
      }}
    >
      {checked && (
        <Check
          className={cn(
            'absolute inset-0 m-auto size-3.5',
            color === WHITE && !split ? 'text-black' : 'text-white',
          )}
          aria-hidden="true"
        />
      )}
    </button>
  );
}

function Segmented({
  label,
  options,
  value,
  onChange,
  testId,
  full,
}: {
  label: string;
  options: readonly string[];
  value: number;
  onChange: (index: number) => void;
  testId: string;
  /** Show the whole option text instead of its initial. */
  full?: boolean;
}) {
  const short = (text: string): string =>
    full ? text : text === 'Extra large' ? 'XL' : text.charAt(0);
  return (
    <div
      role="radiogroup"
      aria-label={label}
      data-testid={testId}
      className="inline-flex rounded-lg border border-line bg-surface p-0.5"
    >
      {options.map((option, index) => (
        <button
          key={option}
          type="button"
          role="radio"
          aria-checked={value === index}
          aria-label={`${label}: ${option}`}
          title={option}
          onClick={() => onChange(index)}
          className={cn(
            'h-6 min-w-8 rounded-md px-2 text-xs font-semibold transition-colors duration-150',
            value === index ? 'bg-accent-solid text-white' : 'text-fg-muted hover:bg-surface-3',
          )}
        >
          {short(option)}
        </button>
      ))}
    </div>
  );
}

function Group({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex items-center gap-2">
      <span className="text-xs font-medium text-fg-subtle">{label}</span>
      {children}
    </div>
  );
}

/** Contextual options below the toolbar. Redact has none: it is always solid black. */
export const OptionsStrip = memo(function OptionsStrip(props: OptionsStripProps) {
  const { tool, selectedType } = props;
  // The options that apply: the active drawing tool, or the kind of the selected annotation.
  const kind: AnnotationType | 'multiple' | null =
    tool === 'select' ? selectedType : tool === 'crop' ? null : tool;
  const withStroke =
    kind === 'arrow' ||
    kind === 'rect' ||
    kind === 'ellipse' ||
    kind === 'line' ||
    kind === 'pen' ||
    kind === 'ruler' ||
    kind === 'magnifier';
  const withSize = kind === 'text' || kind === 'callout';
  const withColorOnly = kind === 'step' || kind === 'stamp' || kind === 'highlight';

  let content: ReactNode;
  if (tool === 'crop') {
    content = (
      <>
        <span className="text-xs text-fg-muted">
          Drag to choose the area to keep, <b className="font-semibold">Enter</b> to apply,{' '}
          <b className="font-semibold">Esc</b> to cancel.
        </span>
        <Group label="Shape">
          <Segmented
            label="Crop aspect ratio"
            testId="crop-aspect"
            full
            options={ASPECT_PRESETS.map((preset) => preset.label)}
            value={ASPECT_PRESETS.findIndex((preset) => preset.id === props.cropAspect)}
            onChange={(index) => props.onCropAspect(ASPECT_PRESETS[index]?.id ?? 'free')}
          />
        </Group>
        {props.cropSize && (
          <span
            data-testid="crop-size"
            className="rounded-md border border-line bg-surface px-2 py-0.5 text-xs font-medium text-fg-muted tabular-nums"
          >
            {props.cropSize.width} × {props.cropSize.height}
          </span>
        )}
        <button
          type="button"
          onClick={props.onApplyCrop}
          disabled={!props.cropSize}
          data-testid="crop-apply"
          className="inline-flex h-7 items-center gap-1.5 rounded-md bg-accent-solid px-2.5 text-xs font-medium text-white transition-colors not-disabled:hover:bg-accent-solid-hover disabled:opacity-40"
        >
          <Check className="size-3.5" aria-hidden="true" />
          Apply
        </button>
        <button
          type="button"
          onClick={props.onResetCrop}
          disabled={!props.hasCrop && !props.cropSize}
          data-testid="crop-reset"
          className="inline-flex h-7 items-center gap-1.5 rounded-md border border-line bg-surface px-2.5 text-xs font-medium text-fg-muted transition-colors not-disabled:hover:bg-surface-3 disabled:opacity-40"
        >
          <RotateCcw className="size-3.5" aria-hidden="true" />
          Reset crop
        </button>
      </>
    );
  } else if (kind === 'redact') {
    content = (
      <Tooltip content={REDACT_TIP}>
        <span
          tabIndex={0}
          data-testid="redact-note"
          className="inline-flex items-center gap-2 text-xs text-fg-muted"
        >
          <span className="size-4 rounded-sm bg-black ring-1 ring-white/30" aria-hidden="true" />
          Always solid black. {REDACT_TIP}.
          <Info className="size-3.5 text-fg-subtle" aria-hidden="true" />
        </span>
      </Tooltip>
    );
  } else if (kind === 'blur') {
    content = (
      <span
        data-testid="blur-note"
        className="inline-flex items-center gap-2 text-xs text-fg-muted"
      >
        Drag over the area to blur. Mode and intensity are in the Properties panel. {BLUR_TIP}.
      </span>
    );
  } else if (kind === 'spotlight') {
    content = (
      <span className="text-xs text-fg-muted">
        Drag over the area to keep bright. Everything outside is dimmed.
      </span>
    );
  } else if (kind === 'multiple') {
    content = (
      <span data-testid="multi-note" className="text-xs text-fg-muted">
        Several marks selected: drag to move them together, Delete removes them, align and order
        them in the Properties panel.
      </span>
    );
  } else if (withStroke || withSize || withColorOnly) {
    const whiteOrBlack = props.color === WHITE || props.color === BLACK;
    content = (
      <>
        <Group label="Color">
          <div
            role="radiogroup"
            aria-label="Color"
            className="flex items-center gap-2"
            data-testid="color-group"
          >
            {(kind === 'highlight' ? HIGHLIGHT_COLORS : COLORS).map((color) => (
              <Swatch
                key={color.value}
                color={color.value}
                label={color.label}
                checked={props.color === color.value}
                onSelect={() => props.onColor(color.value)}
              />
            ))}
            <Swatch
              color={props.color === WHITE ? WHITE : BLACK}
              split={!whiteOrBlack}
              label={props.color === WHITE ? 'White (click for black)' : 'Black / white'}
              checked={whiteOrBlack}
              onSelect={() => props.onColor(props.color === WHITE ? BLACK : WHITE)}
            />
          </div>
        </Group>
        {kind === 'highlight' && (
          <Group label="Mode">
            <Segmented
              label="Highlighter mode"
              testId="highlight-mode"
              full
              options={['Rectangle', 'Freehand']}
              value={props.highlightMode === 'rect' ? 0 : 1}
              onChange={(index) => props.onHighlightMode(index === 0 ? 'rect' : 'freehand')}
            />
          </Group>
        )}
        {kind === 'step' && (
          <Group label="Next number">
            <span
              data-testid="step-next"
              className="rounded-md border border-line bg-surface px-2 py-0.5 text-xs font-semibold tabular-nums"
            >
              {props.nextStep}
            </span>
            <button
              type="button"
              data-testid="step-reset"
              onClick={props.onResetSteps}
              className="inline-flex h-7 items-center gap-1.5 rounded-md border border-line bg-surface px-2.5 text-xs font-medium text-fg-muted hover:bg-surface-3"
            >
              <RotateCcw className="size-3.5" aria-hidden="true" />
              Reset
            </button>
          </Group>
        )}
        {withColorOnly ? null : withSize ? (
          <Group label="Size">
            <Segmented
              label="Text size"
              testId="size-group"
              options={FONT_LABELS}
              value={props.fontStep}
              onChange={(index) => props.onFontStep(index as SizeStep)}
            />
          </Group>
        ) : (
          <Group label="Stroke">
            <Segmented
              label="Stroke width"
              testId="width-group"
              options={WIDTH_LABELS}
              value={props.widthStep}
              onChange={(index) => props.onWidthStep(index as 0 | 1 | 2)}
            />
          </Group>
        )}
      </>
    );
  } else {
    content = (
      <span className="text-xs text-fg-subtle">
        Select an annotation to change its color or size. Drag to move, use the handles to resize.
      </span>
    );
  }

  return (
    <div
      data-testid="options-strip"
      className="flex min-h-11 shrink-0 flex-wrap items-center gap-x-5 gap-y-1 border-b border-line bg-surface-2 px-4 py-1.5"
    >
      {content}
    </div>
  );
});
