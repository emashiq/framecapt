import { useId, useState, type ReactNode } from 'react';
import {
  AlignCenterHorizontal,
  AlignCenterVertical,
  AlignEndHorizontal,
  AlignEndVertical,
  AlignHorizontalSpaceBetween,
  AlignStartHorizontal,
  AlignStartVertical,
  AlignVerticalSpaceBetween,
  ArrowDownToLine,
  ArrowUpToLine,
  ChevronDown,
  ChevronUp,
  Copy,
  Eye,
  Italic,
  Magnet,
  RotateCcw,
  Trash2,
  type LucideIcon,
} from 'lucide-react';
import type { AlignMode, DistributeAxis, ZMove } from '../../editor/model/arrange';
import type { StyleDefaults } from '../../editor/model/create';
import {
  FONT_LABELS_BY_ID,
  STAMP_IDS,
  beautifyActive,
  type Annotation,
  type AnnotationType,
  type Beautify,
  type EditorDoc,
  type FontFamilyId,
  type HeadStyle,
} from '../../editor/model/types';
import {
  ASPECT_PRESETS,
  BACKGROUND_PRESETS,
  DEFAULT_BEAUTIFY,
  STAMP_LABELS,
  type AspectId,
} from '../../editor/presets';
import {
  propsOf,
  supportFor,
  typeForTool,
  type PropField,
  type PropValues,
} from '../../editor/properties';
import { Segmented } from '../../components/ui/Segmented';
import { Select } from '../../components/ui/Select';
import { Switch } from '../../components/ui/Switch';
import { cn } from '../../lib/cn';
import { ColorPicker } from './ColorPicker';
import { BLUR_TIP, type ToolId } from './tools';

export type ArrangeAction =
  | { type: 'z'; move: ZMove }
  | { type: 'duplicate' }
  | { type: 'delete' }
  | { type: 'align'; mode: AlignMode }
  | { type: 'distribute'; axis: DistributeAxis };

export interface PropertiesPanelProps {
  doc: EditorDoc;
  tool: ToolId;
  selected: readonly Annotation[];
  style: StyleDefaults;
  recentColors: readonly string[];
  /** One panel field changed: main editor state decides what it applies to. */
  onProp: <F extends PropField>(field: F, value: PropValues[F]) => void;
  onEndGesture: () => void;
  onArrange: (action: ArrangeAction) => void;
  snap: boolean;
  onSnap: (on: boolean) => void;
  cropAspect: AspectId;
  onCropAspect: (id: AspectId) => void;
  onBeautify: (beautify: Beautify | null) => void;
  previewExport: boolean;
  onPreview: (on: boolean) => void;
  onResetSteps: () => void;
}

// --- small controls ------------------------------------------------------------------------------

function Section({
  title,
  children,
  testId,
  defaultOpen = true,
}: {
  title: string;
  children: ReactNode;
  testId: string;
  defaultOpen?: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const id = useId();
  return (
    <section aria-labelledby={`${id}-h`} data-testid={testId} className="border-b border-line">
      <h3 id={`${id}-h`} className="m-0">
        <button
          type="button"
          aria-expanded={open}
          aria-controls={`${id}-body`}
          onClick={() => setOpen(!open)}
          className="flex w-full items-center justify-between px-4 py-2.5 text-left text-xs font-semibold tracking-wide text-fg-muted uppercase hover:text-fg"
        >
          {title}
          <ChevronDown
            className={cn(
              'size-4 transition-transform motion-reduce:transition-none',
              open && 'rotate-180',
            )}
            aria-hidden="true"
          />
        </button>
      </h3>
      <div id={`${id}-body`} hidden={!open} className="flex flex-col gap-3 px-4 pb-4">
        {children}
      </div>
    </section>
  );
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-1.5">
      <span className="text-xs font-medium text-fg-subtle">{label}</span>
      {children}
    </div>
  );
}

function NumberField({
  label,
  value,
  min,
  max,
  step = 1,
  onChange,
  onDone,
  testId,
  unit,
  slider,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step?: number;
  onChange: (value: number) => void;
  onDone: () => void;
  testId: string;
  unit?: string;
  slider?: boolean;
}) {
  const id = useId();
  // What is being typed (null: show the current value).
  const [draft, setDraft] = useState<string | null>(null);
  const text = draft ?? String(Math.round(value * 100) / 100);
  const commit = (raw: string): void => {
    const parsed = Number(raw);
    if (raw.trim() === '' || !Number.isFinite(parsed)) return;
    onChange(Math.min(max, Math.max(min, parsed)));
  };
  return (
    <div className="flex items-center gap-2">
      <label htmlFor={id} className="w-20 shrink-0 text-xs font-medium text-fg-subtle">
        {label}
      </label>
      {slider && (
        <input
          type="range"
          aria-label={`${label} slider`}
          min={min}
          max={max}
          step={step}
          value={Math.min(max, Math.max(min, value))}
          data-testid={`${testId}-slider`}
          onChange={(event) => onChange(Number(event.target.value))}
          onPointerUp={onDone}
          onKeyUp={onDone}
          className="min-w-0 flex-1 accent-[var(--accent-solid)]"
        />
      )}
      <input
        id={id}
        type="number"
        inputMode="decimal"
        min={min}
        max={max}
        step={step}
        value={text}
        data-testid={testId}
        onChange={(event) => {
          setDraft(event.target.value);
          commit(event.target.value);
        }}
        onBlur={() => {
          commit(text);
          setDraft(null);
          onDone();
        }}
        onKeyDown={(event) => {
          event.stopPropagation();
          if (event.key === 'Enter') {
            commit(text);
            onDone();
          }
        }}
        className="h-8 w-16 shrink-0 rounded-md border border-control bg-surface px-2 text-right text-xs text-fg tabular-nums"
      />
      {unit && <span className="w-5 text-xs text-fg-subtle">{unit}</span>}
    </div>
  );
}

function IconToggle({
  label,
  icon: Icon,
  pressed,
  onClick,
  testId,
  disabled,
}: {
  label: string;
  icon: LucideIcon;
  pressed?: boolean;
  onClick: () => void;
  testId: string;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      aria-pressed={pressed}
      disabled={disabled}
      data-testid={testId}
      onClick={onClick}
      className={cn(
        'inline-flex size-8 items-center justify-center rounded-md border text-fg-muted transition-colors disabled:opacity-40',
        pressed
          ? 'border-accent/60 bg-accent-soft text-accent-fg'
          : 'border-line bg-surface not-disabled:hover:bg-surface-3 not-disabled:hover:text-fg',
      )}
    >
      <Icon className="size-4" aria-hidden="true" />
    </button>
  );
}

const HEAD_OPTIONS = [
  { value: 'none', label: 'None' },
  { value: 'triangle', label: 'Triangle' },
  { value: 'open', label: 'Open' },
  { value: 'dot', label: 'Dot' },
] as const satisfies readonly { value: HeadStyle; label: string }[];

const FAMILY_OPTIONS = (Object.keys(FONT_LABELS_BY_ID) as FontFamilyId[]).map((value) => ({
  value,
  label: FONT_LABELS_BY_ID[value],
}));

const Z_ACTIONS: { move: ZMove; label: string; icon: LucideIcon }[] = [
  { move: 'front', label: 'Bring to front', icon: ArrowUpToLine },
  { move: 'forward', label: 'Bring forward', icon: ChevronUp },
  { move: 'backward', label: 'Send backward', icon: ChevronDown },
  { move: 'back', label: 'Send to back', icon: ArrowDownToLine },
];

const ALIGN_ACTIONS: { mode: AlignMode; label: string; icon: LucideIcon }[] = [
  { mode: 'left', label: 'Align left', icon: AlignStartVertical },
  { mode: 'center', label: 'Align center', icon: AlignCenterVertical },
  { mode: 'right', label: 'Align right', icon: AlignEndVertical },
  { mode: 'top', label: 'Align top', icon: AlignStartHorizontal },
  { mode: 'middle', label: 'Align middle', icon: AlignCenterHorizontal },
  { mode: 'bottom', label: 'Align bottom', icon: AlignEndHorizontal },
];

// --- the panel -----------------------------------------------------------------------------------

/**
 * Everything numeric about the selection (or, with nothing selected, about what the active tool
 * will make), arranging marks, the crop shape and the frame around the export.
 */
export function PropertiesPanel(props: PropertiesPanelProps) {
  const { doc, selected, style, tool, onProp, onEndGesture } = props;
  const single = selected.length === 1 ? (selected[0] as Annotation) : null;
  const kind: AnnotationType | null = single
    ? single.type
    : selected.length > 1
      ? null
      : typeForTool(tool);
  const values = propsOf(single, style);
  const support = supportFor(kind);
  const set = onProp;
  const framed = beautifyActive(doc);
  const beautify = doc.beautify ?? null;
  const count = selected.length;

  const shadowOn = values.shadow !== null;
  const withBeautify = (change: Partial<Beautify>): void =>
    props.onBeautify({ ...(beautify ?? DEFAULT_BEAUTIFY), ...change });

  const hasContext = kind !== null && kind !== 'redact';

  return (
    <aside
      aria-label="Properties"
      data-testid="properties-panel"
      className="flex w-72 shrink-0 flex-col overflow-y-auto border-l border-line bg-surface"
    >
      {hasContext && (
        <Section title="Appearance" testId="panel-appearance">
          {support.color && (
            <Field label={support.colorLabel}>
              <ColorPicker
                label={support.colorLabel}
                testId="panel-color"
                value={values.color}
                recent={props.recentColors}
                onChange={(color) => {
                  set('color', color);
                  onEndGesture();
                }}
              />
            </Field>
          )}
          {support.textColor && (
            <Field label="Text color">
              <ColorPicker
                label="Text color"
                testId="panel-text-color"
                value={values.textColor}
                recent={props.recentColors}
                onChange={(color) => {
                  set('textColor', color);
                  onEndGesture();
                }}
              />
            </Field>
          )}
          {support.stroke && (
            <NumberField
              label={kind === 'pen' ? 'Brush size' : 'Stroke'}
              testId="panel-stroke-width"
              value={values.strokeWidth}
              min={kind === 'rect' || kind === 'ellipse' || kind === 'magnifier' ? 0 : 1}
              max={80}
              slider
              unit="px"
              onChange={(v) => set('strokeWidth', v)}
              onDone={onEndGesture}
            />
          )}
          {support.fill && (
            <>
              <Field label="Fill">
                <ColorPicker
                  label="Fill"
                  testId="panel-fill"
                  value={values.fill ?? '#FFFFFF'}
                  none={values.fill === null}
                  allowNone
                  onNone={() => {
                    set('fill', null);
                    onEndGesture();
                  }}
                  recent={props.recentColors}
                  onChange={(color) => {
                    set('fill', color);
                    onEndGesture();
                  }}
                />
              </Field>
              {values.fill !== null && (
                <NumberField
                  label="Fill opacity"
                  testId="panel-fill-opacity"
                  value={Math.round(values.fillOpacity * 100)}
                  min={0}
                  max={100}
                  slider
                  unit="%"
                  onChange={(v) => set('fillOpacity', v / 100)}
                  onDone={onEndGesture}
                />
              )}
            </>
          )}
          {support.radius && (
            <NumberField
              label="Corner radius"
              testId="panel-radius"
              value={values.radius}
              min={0}
              max={200}
              slider
              unit="px"
              onChange={(v) => set('radius', v)}
              onDone={onEndGesture}
            />
          )}
          {support.opacity && (
            <NumberField
              label="Opacity"
              testId="panel-opacity"
              value={Math.round(values.opacity * 100)}
              min={5}
              max={100}
              slider
              unit="%"
              onChange={(v) => set('opacity', v / 100)}
              onDone={onEndGesture}
            />
          )}
          {support.shadow && (
            <div className="flex flex-col gap-2">
              <div className="flex items-center justify-between">
                <span id="panel-shadow-label" className="text-xs font-medium text-fg-subtle">
                  Drop shadow
                </span>
                <Switch
                  aria-labelledby="panel-shadow-label"
                  data-testid="panel-shadow"
                  checked={shadowOn}
                  onCheckedChange={(on) => {
                    set('shadow', on ? { blur: 8, offset: 4 } : null);
                    onEndGesture();
                  }}
                />
              </div>
              {values.shadow && (
                <>
                  <NumberField
                    label="Blur"
                    testId="panel-shadow-blur"
                    value={values.shadow.blur}
                    min={0}
                    max={60}
                    unit="px"
                    onChange={(v) => set('shadow', { blur: v, offset: values.shadow?.offset ?? 4 })}
                    onDone={onEndGesture}
                  />
                  <NumberField
                    label="Offset"
                    testId="panel-shadow-offset"
                    value={values.shadow.offset}
                    min={-60}
                    max={60}
                    unit="px"
                    onChange={(v) => set('shadow', { blur: values.shadow?.blur ?? 8, offset: v })}
                    onDone={onEndGesture}
                  />
                </>
              )}
            </div>
          )}
        </Section>
      )}

      {hasContext && support.text && (
        <Section title="Text" testId="panel-text">
          <NumberField
            label="Size"
            testId="panel-font-size"
            value={values.fontSize}
            min={6}
            max={400}
            unit="px"
            onChange={(v) => set('fontSize', Math.round(v))}
            onDone={onEndGesture}
          />
          {kind === 'text' && (
            <>
              <Field label="Font">
                <Select
                  label="Font family"
                  data-testid="panel-font-family"
                  value={values.family}
                  options={FAMILY_OPTIONS}
                  onChange={(value) => {
                    set('family', value);
                    onEndGesture();
                  }}
                />
              </Field>
              <div className="flex items-center gap-2">
                <Segmented
                  label="Weight"
                  data-testid="panel-font-weight"
                  value={values.fontWeight >= 600 ? 'bold' : 'regular'}
                  options={[
                    { value: 'regular', label: 'Regular' },
                    { value: 'bold', label: 'Bold' },
                  ]}
                  onChange={(value) => {
                    set('fontWeight', value === 'bold' ? 700 : 400);
                    onEndGesture();
                  }}
                />
                <IconToggle
                  label="Italic"
                  icon={Italic}
                  pressed={values.italic}
                  testId="panel-italic"
                  onClick={() => {
                    set('italic', !values.italic);
                    onEndGesture();
                  }}
                />
              </div>
              <Segmented
                label="Alignment"
                data-testid="panel-align"
                value={values.align}
                options={[
                  { value: 'left', label: 'Left' },
                  { value: 'center', label: 'Center' },
                  { value: 'right', label: 'Right' },
                ]}
                onChange={(value) => {
                  set('align', value);
                  onEndGesture();
                }}
              />
              <Field label="Background">
                <ColorPicker
                  label="Text background"
                  testId="panel-text-bg"
                  value={values.textBackground ?? '#111827'}
                  none={values.textBackground === null}
                  allowNone
                  onNone={() => {
                    set('textBackground', null);
                    onEndGesture();
                  }}
                  recent={props.recentColors}
                  onChange={(color) => {
                    set('textBackground', color);
                    onEndGesture();
                  }}
                />
              </Field>
              <Field label="Outline">
                <ColorPicker
                  label="Text outline"
                  testId="panel-text-outline"
                  value={values.outlineColor ?? '#000000'}
                  none={values.outlineColor === null || values.outlineWidth === 0}
                  allowNone
                  onNone={() => {
                    set('outlineColor', null);
                    set('outlineWidth', 0);
                    onEndGesture();
                  }}
                  recent={props.recentColors}
                  onChange={(color) => {
                    set('outlineColor', color);
                    if (values.outlineWidth === 0) set('outlineWidth', 2);
                    onEndGesture();
                  }}
                />
              </Field>
              {values.outlineColor !== null && values.outlineWidth > 0 && (
                <NumberField
                  label="Outline size"
                  testId="panel-outline-width"
                  value={values.outlineWidth}
                  min={1}
                  max={20}
                  unit="px"
                  onChange={(v) => set('outlineWidth', v)}
                  onDone={onEndGesture}
                />
              )}
            </>
          )}
        </Section>
      )}

      {hasContext && (support.arrow || support.dash) && (
        <Section title={support.arrow ? 'Arrow' : 'Line'} testId="panel-arrow">
          {support.arrow && (
            <>
              <Segmented
                label="Arrow style"
                data-testid="panel-arrow-style"
                value={values.arrowStyle}
                options={[
                  { value: 'straight', label: 'Straight' },
                  { value: 'curved', label: 'Curved' },
                ]}
                onChange={(value) => {
                  set('arrowStyle', value);
                  onEndGesture();
                }}
              />
              <Field label="Start">
                <Select
                  label="Start head"
                  data-testid="panel-start-head"
                  value={values.startHead}
                  options={HEAD_OPTIONS}
                  onChange={(value) => {
                    set('startHead', value);
                    onEndGesture();
                  }}
                />
              </Field>
              <Field label="End">
                <Select
                  label="End head"
                  data-testid="panel-end-head"
                  value={values.endHead}
                  options={HEAD_OPTIONS}
                  onChange={(value) => {
                    set('endHead', value);
                    onEndGesture();
                  }}
                />
              </Field>
            </>
          )}
          {support.dash && (
            <Segmented
              label="Line style"
              data-testid="panel-dash"
              value={values.dash}
              options={[
                { value: 'solid', label: 'Solid' },
                { value: 'dashed', label: 'Dashed' },
                { value: 'dotted', label: 'Dotted' },
              ]}
              onChange={(value) => {
                set('dash', value);
                onEndGesture();
              }}
            />
          )}
        </Section>
      )}

      {hasContext &&
        (support.blur ||
          support.spotlight ||
          support.magnifier ||
          support.step ||
          support.stamp) && (
          <Section title="Effect" testId="panel-effect">
            {support.blur && (
              <>
                <Segmented
                  label="Blur mode"
                  data-testid="panel-blur-mode"
                  value={values.blurMode}
                  options={[
                    { value: 'blur', label: 'Blur' },
                    { value: 'pixelate', label: 'Pixelate' },
                  ]}
                  onChange={(value) => {
                    set('blurMode', value);
                    onEndGesture();
                  }}
                />
                <NumberField
                  label="Intensity"
                  testId="panel-blur-amount"
                  value={values.blurAmount}
                  min={1}
                  max={60}
                  slider
                  onChange={(v) => set('blurAmount', Math.round(v))}
                  onDone={onEndGesture}
                />
                <p className="text-xs text-fg-subtle">{BLUR_TIP}.</p>
              </>
            )}
            {support.spotlight && (
              <>
                <Segmented
                  label="Spotlight shape"
                  data-testid="panel-spotlight-shape"
                  value={values.spotlightShape}
                  options={[
                    { value: 'rect', label: 'Rectangle' },
                    { value: 'ellipse', label: 'Ellipse' },
                  ]}
                  onChange={(value) => {
                    set('spotlightShape', value);
                    onEndGesture();
                  }}
                />
                <NumberField
                  label="Dim"
                  testId="panel-spotlight-dim"
                  value={Math.round(values.spotlightDim * 100)}
                  min={10}
                  max={95}
                  slider
                  unit="%"
                  onChange={(v) => set('spotlightDim', v / 100)}
                  onDone={onEndGesture}
                />
              </>
            )}
            {support.magnifier && (
              <NumberField
                label="Zoom"
                testId="panel-magnifier-zoom"
                value={values.magnifierZoom}
                min={1.25}
                max={8}
                step={0.25}
                slider
                unit="×"
                onChange={(v) => set('magnifierZoom', v)}
                onDone={onEndGesture}
              />
            )}
            {support.step && (
              <>
                <NumberField
                  label="Number"
                  testId="panel-step-number"
                  value={values.stepNumber}
                  min={0}
                  max={9999}
                  onChange={(v) => set('stepNumber', Math.round(v))}
                  onDone={onEndGesture}
                />
                <NumberField
                  label="Size"
                  testId="panel-step-size"
                  value={values.markSize}
                  min={12}
                  max={300}
                  unit="px"
                  onChange={(v) => set('markSize', Math.round(v))}
                  onDone={onEndGesture}
                />
                <button
                  type="button"
                  data-testid="panel-step-reset"
                  onClick={props.onResetSteps}
                  className="inline-flex h-8 items-center justify-center gap-1.5 rounded-md border border-line bg-surface px-2.5 text-xs font-medium text-fg-muted hover:bg-surface-3 hover:text-fg"
                >
                  <RotateCcw className="size-3.5" aria-hidden="true" />
                  Restart numbering at 1
                </button>
              </>
            )}
            {support.stamp && (
              <>
                <Field label="Stamp">
                  <div role="radiogroup" aria-label="Stamp" className="flex flex-wrap gap-1.5">
                    {STAMP_IDS.map((id) => (
                      <button
                        key={id}
                        type="button"
                        role="radio"
                        aria-checked={values.stamp === id}
                        data-testid={`stamp-${id}`}
                        onClick={() => {
                          set('stamp', id);
                          onEndGesture();
                        }}
                        className={cn(
                          'h-8 rounded-md border px-2 text-xs font-medium',
                          values.stamp === id
                            ? 'border-accent/60 bg-accent-soft text-accent-fg'
                            : 'border-line bg-surface text-fg-muted hover:bg-surface-3',
                        )}
                      >
                        {STAMP_LABELS[id]}
                      </button>
                    ))}
                  </div>
                </Field>
                <NumberField
                  label="Size"
                  testId="panel-stamp-size"
                  value={values.markSize}
                  min={12}
                  max={400}
                  unit="px"
                  onChange={(v) => set('markSize', Math.round(v))}
                  onDone={onEndGesture}
                />
              </>
            )}
          </Section>
        )}

      <Section title="Arrange" testId="panel-arrange">
        <p className="text-xs text-fg-subtle" data-testid="panel-selection-count">
          {count === 0
            ? 'Nothing selected'
            : count === 1
              ? '1 mark selected'
              : `${count} marks selected`}
        </p>
        <div role="group" aria-label="Stacking order" className="flex gap-1.5">
          {Z_ACTIONS.map(({ move, label, icon }) => (
            <IconToggle
              key={move}
              label={label}
              icon={icon}
              testId={`arrange-${move}`}
              disabled={count === 0}
              onClick={() => props.onArrange({ type: 'z', move })}
            />
          ))}
        </div>
        <div role="group" aria-label="Duplicate and delete" className="flex gap-1.5">
          <IconToggle
            label="Duplicate"
            icon={Copy}
            testId="arrange-duplicate"
            disabled={count === 0}
            onClick={() => props.onArrange({ type: 'duplicate' })}
          />
          <IconToggle
            label="Delete selection"
            icon={Trash2}
            testId="arrange-delete"
            disabled={count === 0}
            onClick={() => props.onArrange({ type: 'delete' })}
          />
        </div>
        <div role="group" aria-label="Align" className="flex flex-wrap gap-1.5">
          {ALIGN_ACTIONS.map(({ mode, label, icon }) => (
            <IconToggle
              key={mode}
              label={count === 1 ? `${label} to the image` : label}
              icon={icon}
              testId={`align-${mode}`}
              disabled={count === 0}
              onClick={() => props.onArrange({ type: 'align', mode })}
            />
          ))}
        </div>
        <div role="group" aria-label="Distribute" className="flex gap-1.5">
          <IconToggle
            label="Distribute horizontally"
            icon={AlignHorizontalSpaceBetween}
            testId="distribute-horizontal"
            disabled={count < 3}
            onClick={() => props.onArrange({ type: 'distribute', axis: 'horizontal' })}
          />
          <IconToggle
            label="Distribute vertically"
            icon={AlignVerticalSpaceBetween}
            testId="distribute-vertical"
            disabled={count < 3}
            onClick={() => props.onArrange({ type: 'distribute', axis: 'vertical' })}
          />
        </div>
        <div className="flex items-center justify-between">
          <span
            id="panel-snap-label"
            className="flex items-center gap-1.5 text-xs font-medium text-fg-subtle"
          >
            <Magnet className="size-3.5" aria-hidden="true" />
            Snap and guides
          </span>
          <Switch
            aria-labelledby="panel-snap-label"
            data-testid="panel-snap"
            checked={props.snap}
            onCheckedChange={props.onSnap}
          />
        </div>
      </Section>

      <Section title="Canvas" testId="panel-canvas">
        <Field label="Crop shape">
          <Segmented
            label="Crop aspect ratio"
            data-testid="panel-crop-aspect"
            value={props.cropAspect}
            options={ASPECT_PRESETS.map((preset) => ({ value: preset.id, label: preset.label }))}
            onChange={props.onCropAspect}
          />
        </Field>
        <div className="flex items-center justify-between">
          <span id="panel-beautify-label" className="text-xs font-medium text-fg-subtle">
            Beautify frame
          </span>
          <Switch
            aria-labelledby="panel-beautify-label"
            data-testid="panel-beautify"
            checked={framed}
            onCheckedChange={(on) =>
              props.onBeautify(
                on
                  ? {
                      ...(beautify ?? DEFAULT_BEAUTIFY),
                      padding: beautify?.padding || DEFAULT_BEAUTIFY.padding,
                    }
                  : beautify
                    ? { ...beautify, padding: 0 }
                    : null,
              )
            }
          />
        </div>
        {framed && beautify && (
          <>
            <Field label="Background">
              <div role="radiogroup" aria-label="Background" className="flex flex-wrap gap-1.5">
                {BACKGROUND_PRESETS.map((preset) => {
                  const bg = preset.background;
                  const css =
                    bg.kind === 'solid'
                      ? bg.color
                      : `linear-gradient(135deg, ${bg.from}, ${bg.to})`;
                  const checked = JSON.stringify(bg) === JSON.stringify(beautify.background);
                  return (
                    <button
                      key={preset.id}
                      type="button"
                      role="radio"
                      aria-checked={checked}
                      aria-label={`${preset.label} background`}
                      title={preset.label}
                      data-testid={`bg-${preset.id}`}
                      onClick={() => withBeautify({ background: bg })}
                      className={cn(
                        'size-7 rounded-md border border-black/15 dark:border-white/25',
                        checked && 'ring-2 ring-accent ring-offset-2 ring-offset-surface',
                      )}
                      style={{ background: css }}
                    />
                  );
                })}
              </div>
            </Field>
            <NumberField
              label="Padding"
              testId="panel-beautify-padding"
              value={beautify.padding}
              min={1}
              max={400}
              slider
              unit="px"
              onChange={(v) => withBeautify({ padding: v })}
              onDone={props.onEndGesture}
            />
            <NumberField
              label="Corners"
              testId="panel-beautify-radius"
              value={beautify.radius}
              min={0}
              max={200}
              slider
              unit="px"
              onChange={(v) => withBeautify({ radius: v })}
              onDone={props.onEndGesture}
            />
            <NumberField
              label="Shadow blur"
              testId="panel-beautify-shadow-blur"
              value={beautify.shadowBlur}
              min={0}
              max={200}
              slider
              unit="px"
              onChange={(v) => withBeautify({ shadowBlur: v })}
              onDone={props.onEndGesture}
            />
            <NumberField
              label="Shadow drop"
              testId="panel-beautify-shadow-offset"
              value={beautify.shadowOffset}
              min={-100}
              max={100}
              slider
              unit="px"
              onChange={(v) => withBeautify({ shadowOffset: v })}
              onDone={props.onEndGesture}
            />
            <NumberField
              label="Shadow"
              testId="panel-beautify-shadow-opacity"
              value={Math.round(beautify.shadowOpacity * 100)}
              min={0}
              max={100}
              slider
              unit="%"
              onChange={(v) => withBeautify({ shadowOpacity: v / 100 })}
              onDone={props.onEndGesture}
            />
          </>
        )}
        <div className="flex items-center justify-between">
          <span
            id="panel-preview-label"
            className="flex items-center gap-1.5 text-xs font-medium text-fg-subtle"
          >
            <Eye className="size-3.5" aria-hidden="true" />
            Preview the result
          </span>
          <Switch
            aria-labelledby="panel-preview-label"
            data-testid="panel-preview"
            checked={props.previewExport}
            onCheckedChange={props.onPreview}
          />
        </div>
      </Section>
    </aside>
  );
}
