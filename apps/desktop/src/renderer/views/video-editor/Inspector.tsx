import { useId, useState, type ReactNode } from 'react';
import { Crop, RotateCcw, Scissors, Trash2, Volume2, VolumeX } from 'lucide-react';
import {
  MIN_BOX_PX,
  MIN_CROP_PX,
  MIN_CUT_MS,
  MIN_ITEM_MS,
  TEXT_ALIGNS,
  TEXT_FONTS,
  TEXT_MAX_CHARS,
  isVisual,
  outputDurationMs,
  outputGeometry,
  projectSegments,
  type AudioItem,
  type Item,
  type ItemPatch,
  type PixelRect,
  type TextFont,
  type TextItem,
  type VideoCommand,
  type VideoProject,
} from '../../../shared/video-edit';
import { Button } from '../../components/ui/Button';
import { Segmented } from '../../components/ui/Segmented';
import { Select, type SelectOption } from '../../components/ui/Select';
import { Switch } from '../../components/ui/Switch';
import { KIND_STYLES } from './item-kinds';
import { FONT_LABELS } from './text-layout';
import type { Player } from './player';
import { ASPECTS, fitAspect, type AspectId } from './rect-drag';
import type { TimeRange, TimelineSelection } from './Timeline';
import { formatTimecode } from './timeline-math';

const SWATCHES = ['#000000', '#ffffff', '#ef4444', '#f59e0b', '#22c55e', '#3b82f6'];

export interface InspectorProps {
  project: VideoProject;
  player: Player;
  selection: TimelineSelection;
  range: TimeRange | null;
  commit: (command: VideoCommand, gesture?: string) => void;
  endGesture: () => void;
  onRemoveSelection: () => void;
  onCutRange: () => void;
  cropMode: boolean;
  onCropMode: (on: boolean) => void;
  cropAspect: AspectId;
  onCropAspect: (aspect: AspectId) => void;
}

const inputClass =
  'selectable h-8 w-full rounded-lg border border-control bg-surface px-2 text-[13px] text-fg tabular-nums shadow-card transition-colors duration-150 not-disabled:hover:border-fg-muted disabled:opacity-50';

/** A number that is committed when the field is left or Enter is pressed (not on every key). */
function NumberField(props: {
  label: string;
  value: number;
  onCommit: (value: number) => void;
  min?: number;
  max?: number;
  step?: number;
  /** Digits after the point shown. */
  digits?: number;
  disabled?: boolean;
  testId?: string;
}) {
  const id = useId();
  const digits = props.digits ?? 0;
  const text = props.value.toFixed(digits);
  // What the user is typing; null while the field just shows the value.
  const [draft, setDraft] = useState<string | null>(null);
  const commit = (): void => {
    const parsed = Number((draft ?? text).replace(',', '.'));
    setDraft(null);
    if (!Number.isFinite(parsed)) return;
    const clamped = Math.min(props.max ?? Infinity, Math.max(props.min ?? -Infinity, parsed));
    if (clamped !== props.value) props.onCommit(clamped);
  };
  return (
    <div className="min-w-0">
      <label htmlFor={id} className="mb-1 block text-[11px] font-medium text-fg-muted">
        {props.label}
      </label>
      <input
        id={id}
        type="text"
        inputMode="decimal"
        value={draft ?? text}
        disabled={props.disabled}
        data-testid={props.testId}
        onChange={(event) => setDraft(event.target.value)}
        onBlur={commit}
        onKeyDown={(event) => {
          if (event.key === 'Enter') commit();
          else if (event.key === 'Escape') {
            event.stopPropagation();
            setDraft(null);
          } else if ((event.key === 'ArrowUp' || event.key === 'ArrowDown') && props.step) {
            event.preventDefault();
            const next = props.value + (event.key === 'ArrowUp' ? props.step : -props.step);
            props.onCommit(Math.min(props.max ?? Infinity, Math.max(props.min ?? -Infinity, next)));
          }
        }}
        className={inputClass}
      />
    </div>
  );
}

/** A slider whose drag is one undo step: the gesture ends when the pointer or key is released. */
function SliderField(props: {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  display: string;
  onChange: (value: number) => void;
  onEnd: () => void;
  disabled?: boolean;
  testId?: string;
}) {
  const id = useId();
  return (
    <div>
      <div className="mb-1 flex items-baseline justify-between">
        <label htmlFor={id} className="text-[11px] font-medium text-fg-muted">
          {props.label}
        </label>
        <span className="text-[11px] text-fg-muted tabular-nums">{props.display}</span>
      </div>
      <input
        id={id}
        type="range"
        min={props.min}
        max={props.max}
        step={props.step}
        value={props.value}
        disabled={props.disabled}
        data-testid={props.testId}
        onChange={(event) => props.onChange(Number(event.target.value))}
        onPointerUp={props.onEnd}
        onKeyUp={props.onEnd}
        onBlur={props.onEnd}
        className="h-1.5 w-full accent-(--accent-solid) disabled:opacity-50"
      />
    </div>
  );
}

function Section(props: { title: string; children: ReactNode; testId?: string }) {
  return (
    <section data-testid={props.testId} className="border-b border-line px-4 py-3.5">
      <h3 className="mb-2.5 text-[11px] font-semibold tracking-wide text-fg-muted uppercase">
        {props.title}
      </h3>
      <div className="flex flex-col gap-3">{props.children}</div>
    </section>
  );
}

const seconds = (ms: number): number => ms / 1000;
const toMs = (value: number): number => Math.round(value * 1000);

/** The right-hand panel: the selected item, cut or range, then the crop, audio and fades of the project. */
export function Inspector(props: InspectorProps) {
  const { project, selection, range, commit, endGesture } = props;
  const duration = project.source.durationMs;
  const item =
    selection?.kind === 'item' ? project.items.find((i) => i.id === selection.id) : undefined;
  const cut =
    selection?.kind === 'cut' ? project.cuts.find((c) => c.id === selection.id) : undefined;
  const output = outputDurationMs(projectSegments(project));
  const geometry = outputGeometry(project);
  const { hasAudio } = project.source;

  return (
    <aside
      aria-label="Inspector"
      data-testid="video-inspector"
      className="flex w-[300px] shrink-0 flex-col overflow-y-auto border-l border-line bg-surface"
    >
      {item ? (
        <ItemSection item={item} {...props} duration={duration} />
      ) : cut ? (
        <Section title="Cut piece" testId="inspector-cut">
          <p className="text-[13px] text-fg">
            <span className="tabular-nums">
              {formatTimecode(cut.startMs)} – {formatTimecode(cut.endMs)}
            </span>
            <span className="text-fg-muted">
              {' '}
              · {seconds(cut.endMs - cut.startMs).toFixed(2)} s removed
            </span>
          </p>
          <Button
            size="sm"
            data-testid="restore-cut"
            icon={<RotateCcw className="size-4" aria-hidden="true" />}
            onClick={props.onRemoveSelection}
          >
            Restore this piece
          </Button>
        </Section>
      ) : range ? (
        <Section title="Selected range" testId="inspector-range">
          <p className="text-[13px] text-fg tabular-nums">
            {formatTimecode(range.startMs)} – {formatTimecode(range.endMs)}
            <span className="text-fg-muted">
              {' '}
              · {seconds(range.endMs - range.startMs).toFixed(2)} s
            </span>
          </p>
          <Button
            size="sm"
            variant="primary"
            icon={<Scissors className="size-4" aria-hidden="true" />}
            disabled={range.endMs - range.startMs < MIN_CUT_MS}
            onClick={props.onCutRange}
          >
            Cut it out
          </Button>
        </Section>
      ) : (
        <Section title="Getting started">
          <p className="text-[13px] leading-snug text-fg-muted">
            Pick a tool under the preview and drag on the video to hide something or add text for a
            while. Add a picture or a sound with the other tools. Drag on the clip in the timeline
            to select a range to cut out, and drag the ends of the clip to trim.
          </p>
        </Section>
      )}

      <Section title="Crop" testId="inspector-crop">
        <div className="flex items-center gap-2">
          <Button
            size="sm"
            variant={props.cropMode ? 'primary' : 'secondary'}
            data-testid="crop-toggle"
            aria-pressed={props.cropMode}
            icon={<Crop className="size-4" aria-hidden="true" />}
            onClick={() => props.onCropMode(!props.cropMode)}
          >
            {props.cropMode ? 'Done' : project.crop ? 'Adjust crop' : 'Crop'}
          </Button>
          {project.crop ? (
            <Button
              size="sm"
              variant="ghost"
              data-testid="crop-reset"
              onClick={() => {
                commit({ type: 'setCrop', crop: null });
                props.onCropAspect('free');
              }}
            >
              Reset
            </Button>
          ) : null}
        </div>
        {props.cropMode ? (
          <Segmented
            label="Crop shape"
            value={props.cropAspect}
            options={ASPECTS.map((aspect) => ({ value: aspect.id, label: aspect.label }))}
            data-testid="crop-aspect"
            onChange={(id) => {
              props.onCropAspect(id);
              const ratio = ASPECTS.find((aspect) => aspect.id === id)?.ratio;
              if (!ratio) return;
              const area = project.crop ?? {
                x: 0,
                y: 0,
                width: project.source.width,
                height: project.source.height,
              };
              commit({ type: 'setCrop', crop: fitAspect(ratio, area) });
            }}
          />
        ) : null}
        <p className="text-xs text-fg-muted tabular-nums" data-testid="output-size">
          Output {geometry.width} × {geometry.height}
          {project.crop ? ` (cropped from ${project.source.width} × ${project.source.height})` : ''}
        </p>
        {props.cropMode ? (
          <p className="text-xs text-fg-muted">
            Drag the corners and edges on the preview (at least {MIN_CROP_PX} px).
          </p>
        ) : null}
      </Section>

      <Section title="Audio" testId="inspector-audio">
        {hasAudio ? (
          <>
            <div className="flex items-center justify-between gap-3">
              <span className="flex items-center gap-2 text-[13px] text-fg">
                {project.audio.muted ? (
                  <VolumeX className="size-4 text-fg-muted" aria-hidden="true" />
                ) : (
                  <Volume2 className="size-4 text-fg-muted" aria-hidden="true" />
                )}
                Mute
              </span>
              <Switch
                aria-label="Mute audio"
                data-testid="audio-mute"
                checked={project.audio.muted}
                onCheckedChange={(muted) => commit({ type: 'setAudio', patch: { muted } })}
              />
            </div>
            <SliderField
              label="Volume"
              value={Math.round(project.audio.volume * 100)}
              min={0}
              max={200}
              step={5}
              display={`${Math.round(project.audio.volume * 100)}%`}
              disabled={project.audio.muted}
              testId="audio-volume"
              onChange={(value) =>
                commit({ type: 'setAudio', patch: { volume: value / 100 } }, 'audio:volume')
              }
              onEnd={endGesture}
            />
          </>
        ) : (
          <p className="text-[13px] text-fg-muted">This recording has no audio.</p>
        )}
      </Section>

      <Section title="Fades" testId="inspector-fades">
        <div className="grid grid-cols-2 gap-3">
          <NumberField
            label="Fade in (s)"
            value={seconds(project.fadeInMs)}
            digits={1}
            min={0}
            max={Math.min(10, seconds(output))}
            step={0.1}
            testId="fade-in"
            onCommit={(value) => commit({ type: 'setFades', fadeInMs: toMs(value) })}
          />
          <NumberField
            label="Fade out (s)"
            value={seconds(project.fadeOutMs)}
            digits={1}
            min={0}
            max={Math.min(10, seconds(output))}
            step={0.1}
            testId="fade-out"
            onCommit={(value) => commit({ type: 'setFades', fadeOutMs: toMs(value) })}
          />
        </div>
        <p className="text-xs text-fg-muted">
          Picture and sound fade at the start and end of the result.
        </p>
      </Section>

      <div
        className="mt-auto px-4 py-3 text-xs text-fg-muted tabular-nums"
        data-testid="output-length"
      >
        Result {formatTimecode(output)} · from{' '}
        {formatTimecode(project.trim.endMs - project.trim.startMs)}
      </div>
    </aside>
  );
}

function ItemSection(props: InspectorProps & { item: Item; duration: number }) {
  const { item, commit, endGesture, player, duration } = props;
  const style = KIND_STYLES[item.kind];
  const Icon = style.icon;
  const patch = (changes: Parameters<typeof updateItem>[1]): void =>
    commit(updateItem(item.id, changes));
  const box = isVisual(item) ? item : null;
  const rectPatch = (changes: Partial<PixelRect>): void => {
    if (box) patch({ rect: { ...box.rect, ...changes } });
  };

  return (
    <Section title={style.label} testId="inspector-item">
      <div className="-mt-1 flex items-center gap-2">
        <span className="flex size-7 items-center justify-center rounded-md bg-surface-3 text-fg-muted">
          <Icon className="size-4" aria-hidden="true" />
        </span>
        <p className="min-w-0 flex-1 truncate text-xs text-fg-muted">{style.hint}</p>
        <Button
          size="sm"
          variant="ghost"
          data-testid="remove-item"
          aria-label={`Remove this ${style.label.toLowerCase()}`}
          icon={<Trash2 className="size-4" aria-hidden="true" />}
          onClick={props.onRemoveSelection}
        />
      </div>
      <div className="grid grid-cols-3 gap-2">
        <NumberField
          label="Start (s)"
          value={seconds(item.startMs)}
          digits={3}
          min={0}
          max={seconds(item.endMs - MIN_ITEM_MS)}
          step={0.1}
          testId="item-start"
          onCommit={(value) => patch({ startMs: toMs(value) })}
        />
        <NumberField
          label="End (s)"
          value={seconds(item.endMs)}
          digits={3}
          min={seconds(item.startMs + MIN_ITEM_MS)}
          max={seconds(duration)}
          step={0.1}
          testId="item-end"
          onCommit={(value) => patch({ endMs: toMs(value) })}
        />
        <NumberField
          label="Length (s)"
          value={seconds(item.endMs - item.startMs)}
          digits={3}
          min={seconds(MIN_ITEM_MS)}
          max={seconds(duration - item.startMs)}
          step={0.1}
          testId="item-length"
          onCommit={(value) => patch({ endMs: item.startMs + toMs(value) })}
        />
      </div>
      <div className="grid grid-cols-2 gap-2">
        <Button
          size="sm"
          data-testid="item-start-playhead"
          onClick={() => {
            const at = player.getSnapshot().timeMs;
            if (at < item.endMs - MIN_ITEM_MS) patch({ startMs: at });
          }}
        >
          Start at playhead
        </Button>
        <Button
          size="sm"
          data-testid="item-end-playhead"
          onClick={() => {
            const at = player.getSnapshot().timeMs;
            if (at > item.startMs + MIN_ITEM_MS) patch({ endMs: at });
          }}
        >
          End at playhead
        </Button>
      </div>
      {box ? (
        <div className="grid grid-cols-4 gap-2">
          <NumberField
            label="X"
            value={box.rect.x}
            min={0}
            step={1}
            testId="rect-x"
            onCommit={(value) => rectPatch({ x: Math.round(value) })}
          />
          <NumberField
            label="Y"
            value={box.rect.y}
            min={0}
            step={1}
            testId="rect-y"
            onCommit={(value) => rectPatch({ y: Math.round(value) })}
          />
          <NumberField
            label="W"
            value={box.rect.width}
            min={MIN_BOX_PX}
            step={1}
            testId="rect-w"
            onCommit={(value) => rectPatch({ width: Math.round(value) })}
          />
          <NumberField
            label="H"
            value={box.rect.height}
            min={MIN_BOX_PX}
            step={1}
            testId="rect-h"
            onCommit={(value) => rectPatch({ height: Math.round(value) })}
          />
        </div>
      ) : null}
      {item.kind === 'text' ? (
        <TextFields item={item} patch={patch} commit={commit} endGesture={endGesture} />
      ) : null}
      {item.kind === 'image' ? (
        <>
          <SliderField
            label="Opacity"
            value={Math.round(item.opacity * 100)}
            min={5}
            max={100}
            step={5}
            display={`${Math.round(item.opacity * 100)}%`}
            testId="image-opacity"
            onChange={(value) =>
              commit(updateItem(item.id, { opacity: value / 100 }), `item:${item.id}:param`)
            }
            onEnd={endGesture}
          />
          <FadeFields item={item} patch={patch} />
        </>
      ) : null}
      {item.kind === 'audio' ? (
        <AudioFields item={item} patch={patch} commit={commit} endGesture={endGesture} />
      ) : null}
      {item.kind === 'redact' ? (
        <div>
          <p className="mb-1.5 text-[11px] font-medium text-fg-muted">Colour</p>
          <div className="flex items-center gap-1.5" role="radiogroup" aria-label="Box colour">
            {SWATCHES.map((color) => (
              <button
                key={color}
                type="button"
                role="radio"
                aria-checked={item.color.toLowerCase() === color}
                aria-label={color}
                data-testid={`swatch-${color.slice(1)}`}
                onClick={() => patch({ color })}
                className="size-6 rounded-full border border-line-strong aria-checked:ring-2 aria-checked:ring-(--accent) aria-checked:ring-offset-1 aria-checked:ring-offset-(--surface)"
                style={{ background: color }}
              />
            ))}
            <input
              type="color"
              aria-label="Custom colour"
              value={item.color}
              onChange={(event) => patch({ color: event.target.value })}
              className="ml-1 size-6 cursor-pointer rounded-md border border-line-strong bg-transparent p-0"
            />
          </div>
        </div>
      ) : null}
      {item.kind === 'blur' ? (
        <SliderField
          label="Strength"
          value={item.amount}
          min={1}
          max={100}
          step={1}
          display={String(item.amount)}
          testId="blur-amount"
          onChange={(amount) => commit(updateItem(item.id, { amount }), `item:${item.id}:param`)}
          onEnd={endGesture}
        />
      ) : null}
      {item.kind === 'pixelate' ? (
        <SliderField
          label="Block size"
          value={item.block}
          min={2}
          max={64}
          step={1}
          display={`${item.block} px`}
          testId="pixelate-block"
          onChange={(block) => commit(updateItem(item.id, { block }), `item:${item.id}:param`)}
          onEnd={endGesture}
        />
      ) : null}
      {item.kind === 'highlight' ? (
        <SliderField
          label="Dim outside"
          value={Math.round(item.dim * 100)}
          min={10}
          max={90}
          step={5}
          display={`${Math.round(item.dim * 100)}%`}
          testId="highlight-dim"
          onChange={(value) =>
            commit(updateItem(item.id, { dim: value / 100 }), `item:${item.id}:param`)
          }
          onEnd={endGesture}
        />
      ) : null}
    </Section>
  );
}

function updateItem(
  id: string,
  patch: Extract<VideoCommand, { type: 'updateItem' }>['patch'],
): VideoCommand {
  return { type: 'updateItem', id, patch };
}

type PatchFn = (changes: ItemPatch) => void;
type CommitFn = (command: VideoCommand, gesture?: string) => void;

/** A labelled colour input. */
function ColorField(props: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  testId: string;
}) {
  const id = useId();
  return (
    <div className="min-w-0">
      <label htmlFor={id} className="mb-1 block text-[11px] font-medium text-fg-muted">
        {props.label}
      </label>
      <input
        id={id}
        type="color"
        value={props.value}
        data-testid={props.testId}
        onChange={(event) => props.onChange(event.target.value)}
        className="h-8 w-full cursor-pointer rounded-lg border border-control bg-surface p-0.5"
      />
    </div>
  );
}

/** Fade in and fade out of an item (seconds). */
function FadeFields(props: {
  item: { fadeInMs: number; fadeOutMs: number; startMs: number; endMs: number };
  patch: PatchFn;
}) {
  const { item, patch } = props;
  const length = seconds(item.endMs - item.startMs);
  return (
    <div className="grid grid-cols-2 gap-2">
      <NumberField
        label="Fade in (s)"
        value={seconds(item.fadeInMs)}
        digits={1}
        min={0}
        max={length}
        step={0.1}
        testId="item-fade-in"
        onCommit={(value) => patch({ fadeInMs: toMs(value) })}
      />
      <NumberField
        label="Fade out (s)"
        value={seconds(item.fadeOutMs)}
        digits={1}
        min={0}
        max={length}
        step={0.1}
        testId="item-fade-out"
        onCommit={(value) => patch({ fadeOutMs: toMs(value) })}
      />
    </div>
  );
}

const WEIGHT_OPTIONS: readonly SelectOption<string>[] = [
  { value: '300', label: 'Light' },
  { value: '400', label: 'Regular' },
  { value: '500', label: 'Medium' },
  { value: '600', label: 'Semibold' },
  { value: '700', label: 'Bold' },
  { value: '800', label: 'Extra bold' },
];
const FONT_OPTIONS: readonly SelectOption<TextFont>[] = TEXT_FONTS.map((font) => ({
  value: font,
  label: FONT_LABELS[font],
}));

function ToggleRow(props: {
  label: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
  testId: string;
}) {
  return (
    <div className="flex items-center justify-between gap-3">
      <span className="text-[13px] text-fg">{props.label}</span>
      <Switch
        aria-label={props.label}
        data-testid={props.testId}
        checked={props.checked}
        onCheckedChange={props.onChange}
      />
    </div>
  );
}

/** Everything about a text item: the words, the look, the background, the outline and shadow. */
function TextFields(props: {
  item: TextItem;
  patch: PatchFn;
  commit: CommitFn;
  endGesture: () => void;
}) {
  const { item, patch, commit, endGesture } = props;
  const gesture = `item:${item.id}:text`;
  const typed = (changes: ItemPatch): void => commit(updateItem(item.id, changes), gesture);
  const background = item.background ?? { color: '#000000', opacity: 0.6, padding: 12, radius: 8 };
  const outline = item.outline ?? { color: '#000000', width: 3 };
  const textId = useId();
  return (
    <>
      <div>
        <label htmlFor={textId} className="mb-1 block text-[11px] font-medium text-fg-muted">
          Text
        </label>
        <textarea
          id={textId}
          data-testid="text-content"
          value={item.text}
          maxLength={TEXT_MAX_CHARS}
          rows={3}
          onChange={(event) => typed({ text: event.target.value || ' ' })}
          onBlur={endGesture}
          className="selectable w-full resize-y rounded-lg border border-control bg-surface px-2 py-1.5 text-[13px] text-fg shadow-card"
        />
        <p className="mt-0.5 text-right text-[11px] text-fg-subtle tabular-nums">
          {item.text.length} / {TEXT_MAX_CHARS}
        </p>
      </div>
      <div className="grid grid-cols-2 gap-2">
        <div>
          <p className="mb-1 text-[11px] font-medium text-fg-muted">Font</p>
          <Select
            label="Font"
            value={item.font}
            options={FONT_OPTIONS}
            data-testid="text-font"
            onChange={(font) => patch({ font })}
          />
        </div>
        <div>
          <p className="mb-1 text-[11px] font-medium text-fg-muted">Weight</p>
          <Select
            label="Weight"
            value={String(item.weight)}
            options={WEIGHT_OPTIONS}
            data-testid="text-weight"
            onChange={(weight) => patch({ weight: Number(weight) as TextItem['weight'] })}
          />
        </div>
      </div>
      <div className="grid grid-cols-2 gap-2">
        <NumberField
          label="Size (px)"
          value={item.size}
          min={8}
          max={600}
          step={1}
          testId="text-size"
          onCommit={(value) => patch({ size: Math.round(value) })}
        />
        <ColorField
          label="Colour"
          value={item.color}
          testId="text-color"
          onChange={(color) => typed({ color })}
        />
      </div>
      <Segmented
        label="Alignment"
        value={item.align}
        options={TEXT_ALIGNS.map((align) => ({
          value: align,
          label: align.charAt(0).toUpperCase() + align.slice(1),
        }))}
        data-testid="text-align"
        onChange={(align) => patch({ align })}
      />
      <ToggleRow
        label="Italic"
        checked={item.italic}
        testId="text-italic"
        onChange={(italic) => patch({ italic })}
      />
      <ToggleRow
        label="Shadow"
        checked={item.shadow}
        testId="text-shadow"
        onChange={(shadow) => patch({ shadow })}
      />
      <ToggleRow
        label="Outline"
        checked={item.outline !== null}
        testId="text-outline"
        onChange={(on) => patch({ outline: on ? outline : null })}
      />
      {item.outline ? (
        <div className="grid grid-cols-2 gap-2">
          <ColorField
            label="Outline colour"
            value={item.outline.color}
            testId="text-outline-color"
            onChange={(color) => typed({ outline: { ...outline, color } })}
          />
          <NumberField
            label="Outline (px)"
            value={item.outline.width}
            min={1}
            max={20}
            step={1}
            testId="text-outline-width"
            onCommit={(value) => patch({ outline: { ...outline, width: Math.round(value) } })}
          />
        </div>
      ) : null}
      <ToggleRow
        label="Background"
        checked={item.background !== null}
        testId="text-background"
        onChange={(on) => patch({ background: on ? background : null })}
      />
      {item.background ? (
        <>
          <ColorField
            label="Background colour"
            value={item.background.color}
            testId="text-background-color"
            onChange={(color) => typed({ background: { ...background, color } })}
          />
          <SliderField
            label="Background opacity"
            value={Math.round(item.background.opacity * 100)}
            min={0}
            max={100}
            step={5}
            display={`${Math.round(item.background.opacity * 100)}%`}
            testId="text-background-opacity"
            onChange={(value) => typed({ background: { ...background, opacity: value / 100 } })}
            onEnd={endGesture}
          />
          <div className="grid grid-cols-2 gap-2">
            <NumberField
              label="Padding (px)"
              value={item.background.padding}
              min={0}
              max={200}
              step={1}
              testId="text-background-padding"
              onCommit={(value) =>
                patch({ background: { ...background, padding: Math.round(value) } })
              }
            />
            <NumberField
              label="Corners (px)"
              value={item.background.radius}
              min={0}
              max={200}
              step={1}
              testId="text-background-radius"
              onCommit={(value) =>
                patch({ background: { ...background, radius: Math.round(value) } })
              }
            />
          </div>
        </>
      ) : null}
      <FadeFields item={item} patch={patch} />
    </>
  );
}

/** An audio clip: where it starts in the file, how long it plays, its level and fades. */
function AudioFields(props: {
  item: AudioItem;
  patch: PatchFn;
  commit: CommitFn;
  endGesture: () => void;
}) {
  const { item, patch, commit, endGesture } = props;
  return (
    <>
      <p className="truncate text-[13px] text-fg" data-testid="audio-name" title={item.name}>
        {item.name || 'Audio clip'}
        <span className="text-fg-muted"> · file {formatTimecode(item.clipMs)}</span>
      </p>
      <NumberField
        label="Start in the file (s)"
        value={seconds(item.inMs)}
        digits={3}
        min={0}
        max={seconds(item.clipMs - MIN_ITEM_MS)}
        step={0.1}
        testId="audio-in"
        onCommit={(value) => patch({ inMs: toMs(value) })}
      />
      <ToggleRow
        label="Mute this clip"
        checked={item.muted}
        testId="audio-clip-mute"
        onChange={(muted) => patch({ muted })}
      />
      <SliderField
        label="Volume"
        value={Math.round(item.volume * 100)}
        min={0}
        max={200}
        step={5}
        display={`${Math.round(item.volume * 100)}%`}
        disabled={item.muted}
        testId="audio-clip-volume"
        onChange={(value) =>
          commit(updateItem(item.id, { volume: value / 100 }), `item:${item.id}:param`)
        }
        onEnd={endGesture}
      />
      <FadeFields item={item} patch={patch} />
    </>
  );
}
