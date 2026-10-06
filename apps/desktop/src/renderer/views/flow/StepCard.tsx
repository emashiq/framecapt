import { useEffect, useRef, useState, type DragEvent } from 'react';
import { ArrowDown, ArrowUp, GripVertical, Pencil, Trash2 } from 'lucide-react';
import { MAX_CAPTION_LENGTH, type FlowStep } from '../../../shared/flow';
import { IconButton } from '../../components/ui/IconButton';
import { drawPointerRing } from '../../flow/ring';
import { cn } from '../../lib/cn';

/** The step's picture with the pointer ring on a canvas above it (the stored PNG never has the ring). */
function StepImage({ step, url, number }: { step: FlowStep; url: string; number: number }) {
  const box = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    const element = box.current;
    const layer = canvas.current;
    if (!element || !layer) return;
    const draw = (): void => {
      const dpr = window.devicePixelRatio || 1;
      const width = Math.max(1, Math.round(element.clientWidth * dpr));
      const height = Math.max(1, Math.round(element.clientHeight * dpr));
      layer.width = width;
      layer.height = height;
      const ctx = layer.getContext('2d');
      if (!ctx) return;
      ctx.clearRect(0, 0, width, height);
      if (step.cursor) drawPointerRing(ctx, step.cursor, step.width, width / step.width);
    };
    const observer = new ResizeObserver(draw);
    observer.observe(element);
    draw();
    return () => observer.disconnect();
  }, [step.cursor, step.width]);

  return (
    <div
      ref={box}
      className="checkerboard relative w-full overflow-hidden bg-surface-3"
      style={{ aspectRatio: `${step.width} / ${step.height}` }}
    >
      {failed ? (
        <p className="absolute inset-0 flex items-center justify-center px-6 text-center text-sm text-fg-muted">
          This step’s picture was moved or deleted.
        </p>
      ) : (
        <img
          src={url}
          alt={`Step ${number} screenshot`}
          draggable={false}
          loading="lazy"
          decoding="async"
          onError={() => setFailed(true)}
          className="absolute inset-0 size-full object-contain"
          data-testid="flow-step-image"
        />
      )}
      <canvas
        ref={canvas}
        aria-hidden="true"
        data-testid="flow-step-ring"
        data-has-cursor={step.cursor ? 'true' : 'false'}
        className="pointer-events-none absolute inset-0 size-full"
      />
    </div>
  );
}

export interface StepCardProps {
  step: FlowStep;
  url: string;
  index: number;
  count: number;
  onCaption: (caption: string) => void;
  onMove: (to: number) => void;
  /** Another card (by its index) was dropped on this one. */
  onDropFrom: (from: number) => void;
  onDelete: () => void;
  onEdit: () => void;
}

const DRAG_TYPE = 'application/x-framecapt-step';

export function StepCard({
  step,
  url,
  index,
  count,
  onCaption,
  onMove,
  onDropFrom,
  onDelete,
  onEdit,
}: StepCardProps) {
  const number = index + 1;
  const [over, setOver] = useState(false);

  const acceptsDrag = (event: DragEvent): boolean => event.dataTransfer.types.includes(DRAG_TYPE);

  return (
    <li
      data-testid="flow-step"
      data-file={step.file}
      className={cn(
        'flex flex-col overflow-hidden rounded-xl border bg-surface shadow-card transition-colors duration-150',
        over ? 'border-accent-solid' : 'border-line',
      )}
      onDragOver={(event) => {
        if (!acceptsDrag(event)) return;
        event.preventDefault();
        event.dataTransfer.dropEffect = 'move';
        setOver(true);
      }}
      onDragLeave={() => setOver(false)}
      onDrop={(event) => {
        setOver(false);
        if (!acceptsDrag(event)) return;
        event.preventDefault();
        const from = Number(event.dataTransfer.getData(DRAG_TYPE));
        // The dragged card takes the place of this one.
        if (Number.isInteger(from) && from !== index) onDropFrom(from);
      }}
    >
      <div className="flex items-center gap-2 px-3 py-2">
        <span
          draggable
          onDragStart={(event) => {
            event.dataTransfer.setData(DRAG_TYPE, String(index));
            event.dataTransfer.effectAllowed = 'move';
          }}
          title="Drag to reorder"
          aria-hidden="true"
          className="flex size-6 shrink-0 cursor-grab items-center justify-center text-fg-subtle"
        >
          <GripVertical className="size-4" />
        </span>
        <span
          data-testid="flow-step-number"
          className="flex h-6 min-w-6 items-center justify-center rounded-full bg-accent-soft px-2 text-xs font-semibold text-accent-fg tabular-nums"
        >
          {number}
        </span>
        <h3 className="min-w-0 flex-1 truncate text-sm font-medium text-fg">Step {number}</h3>
        <IconButton
          size="sm"
          aria-label={`Move step ${number} up`}
          data-testid="flow-step-up"
          disabled={index === 0}
          icon={<ArrowUp className="size-4" />}
          onClick={() => onMove(index - 1)}
        />
        <IconButton
          size="sm"
          aria-label={`Move step ${number} down`}
          data-testid="flow-step-down"
          disabled={index === count - 1}
          icon={<ArrowDown className="size-4" />}
          onClick={() => onMove(index + 1)}
        />
        <IconButton
          size="sm"
          aria-label={`Open step ${number} in the editor`}
          data-testid="flow-step-edit"
          icon={<Pencil className="size-4" />}
          onClick={onEdit}
        />
        <IconButton
          size="sm"
          aria-label={`Delete step ${number}`}
          data-testid="flow-step-delete"
          disabled={count <= 1}
          icon={<Trash2 className="size-4" />}
          onClick={onDelete}
        />
      </div>
      <StepImage step={step} url={url} number={number} />
      <div className="p-3">
        <textarea
          value={step.caption}
          onChange={(event) => onCaption(event.target.value)}
          maxLength={MAX_CAPTION_LENGTH}
          rows={2}
          placeholder={`Describe step ${number}…`}
          aria-label={`Caption for step ${number}`}
          data-testid="flow-step-caption"
          className="selectable w-full resize-y rounded-lg border border-line bg-bg px-3 py-2 text-sm text-fg outline-none placeholder:text-fg-subtle focus-visible:border-accent-solid"
        />
      </div>
    </li>
  );
}
