import { useRef, useState } from 'react';
import { FolderOpen, Scissors, X } from 'lucide-react';
import type { ExtractFormat, HistoryItemView } from '../../../shared/history-ipc';
import type { RecordingLayout } from '../../../shared/recording-layout';
import { Loader } from '../../components/Loader';
import { Button } from '../../components/ui/Button';
import { Modal } from '../../components/ui/Dialog';
import { Segmented } from '../../components/ui/Segmented';
import {
  cancelMp4Export,
  dismissExport,
  startFcapExtract,
  useAnyExportActive,
  useExportState,
} from '../../history/export-store';
import { useExportCapabilities } from '../../history/use-export-capabilities';
import { fileUrl, newNonce } from '../../history/media-url';
import { formatClock, parseClock } from '../../lib/clock';
import { cn } from '../../lib/cn';
import { notify } from '../../lib/notify';
import { CroppedVideo, type TileChoice } from './FcapPlayer';

/** The shortest part that can be extracted. */
const MIN_PART_MS = 100;
const STEP_MS = 100;

const FORMATS: readonly { value: ExtractFormat; label: string }[] = [
  { value: 'mp4', label: 'MP4' },
  { value: 'webm', label: 'WebM' },
];

interface TimeFieldProps {
  label: string;
  testId: string;
  valueMs: number;
  maxMs: number;
  minMs: number;
  onChange: (ms: number) => void;
}

/** A time field and a slider for one end of the part: they edit the same value. */
function TimeField({ label, testId, valueMs, minMs, maxMs, onChange }: TimeFieldProps) {
  // While the field is being typed in (`draft` is set) it shows the draft; otherwise the value.
  const [draft, setDraft] = useState<string | null>(null);
  const text = draft ?? formatClock(valueMs);

  function commit(): void {
    const parsed = draft === null ? null : parseClock(draft);
    setDraft(null);
    if (parsed !== null) onChange(Math.min(maxMs, Math.max(minMs, parsed)));
  }

  return (
    <div className="flex items-center gap-3">
      <label className="flex w-28 shrink-0 flex-col gap-1 text-[13px] text-fg-muted">
        {label}
        <input
          type="text"
          inputMode="decimal"
          value={text}
          data-testid={`${testId}-text`}
          aria-label={`${label} time`}
          onChange={(event) => setDraft(event.target.value)}
          onBlur={commit}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              event.preventDefault();
              commit();
            }
          }}
          className="selectable h-9 rounded-lg border border-control bg-surface-2 px-2.5 text-sm text-fg tabular-nums focus-visible:border-accent"
        />
      </label>
      <input
        type="range"
        aria-label={`${label} position`}
        data-testid={`${testId}-slider`}
        min={0}
        max={Math.max(MIN_PART_MS, Math.round(maxMs))}
        step={STEP_MS}
        value={Math.round(valueMs)}
        onChange={(event) => onChange(Math.min(maxMs, Math.max(minMs, Number(event.target.value))))}
        className="mt-5 h-2 min-w-0 flex-1 cursor-pointer accent-[var(--color-accent-solid)]"
      />
    </div>
  );
}

interface DialogProps {
  item: HistoryItemView;
  layout: RecordingLayout;
  open: boolean;
  onClose: () => void;
  mp4Available: boolean;
}

function ExtractDialog({ item, layout, open, onClose, mp4Available }: DialogProps) {
  const durationMs = Math.max(MIN_PART_MS * 2, item.durationMs ?? 0);
  const [choice, setChoice] = useState<TileChoice>(null);
  const [startMs, setStartMs] = useState(0);
  const [endMs, setEndMs] = useState(durationMs);
  const [format, setFormat] = useState<ExtractFormat>(mp4Available ? 'mp4' : 'webm');
  const [nonce] = useState(newNonce);
  const videoRef = useRef<HTMLVideoElement>(null);

  const seek = (ms: number): void => {
    const video = videoRef.current;
    if (video) video.currentTime = ms / 1000;
  };

  const sourceOptions = [
    { value: 'all', label: 'All' },
    ...layout.sources.map((source, index) => ({ value: String(index), label: source.name })),
  ];

  return (
    <Modal
      open={open}
      onClose={onClose}
      label="Extract from this recording"
      className="w-[min(640px,94vw)]"
      data-testid="extract-dialog"
    >
      <div className="flex flex-col gap-4 p-5">
        <header>
          <h2 className="text-lg font-semibold text-fg">Extract from this recording</h2>
          <p className="text-[13px] text-fg-muted">
            Saves a new video next to the recording. The recording itself is not changed.
          </p>
        </header>

        <fieldset className="flex flex-col gap-1.5">
          <legend className="mb-1 text-[13px] font-medium text-fg">Source</legend>
          <Segmented
            label="Source to extract"
            data-testid="extract-source"
            value={choice === null ? 'all' : String(choice)}
            options={sourceOptions}
            onChange={(value) => setChoice(value === 'all' ? null : Number(value))}
          />
        </fieldset>

        <CroppedVideo
          ref={videoRef}
          src={fileUrl(item.id, nonce)}
          layout={layout}
          tile={choice}
          maxHeight="min(34vh, 260px)"
        />

        <div className="flex flex-col gap-3">
          <TimeField
            label="Start"
            testId="extract-start"
            valueMs={startMs}
            minMs={0}
            maxMs={Math.max(0, endMs - MIN_PART_MS)}
            onChange={(ms) => {
              setStartMs(ms);
              seek(ms);
            }}
          />
          <TimeField
            label="End"
            testId="extract-end"
            valueMs={endMs}
            minMs={Math.min(durationMs, startMs + MIN_PART_MS)}
            maxMs={durationMs}
            onChange={(ms) => {
              setEndMs(ms);
              seek(ms);
            }}
          />
          <p className="text-xs text-fg-subtle" data-testid="extract-length">
            Length {formatClock(endMs - startMs)}
          </p>
        </div>

        <div className="flex flex-col gap-1.5">
          <span className="text-[13px] font-medium text-fg">Format</span>
          <Segmented
            label="Format"
            data-testid="extract-format"
            value={format}
            options={FORMATS.map((entry) => ({
              ...entry,
              label: entry.value === 'mp4' && !mp4Available ? 'MP4 (unavailable)' : entry.label,
            }))}
            onChange={(value) => setFormat(value === 'mp4' && !mp4Available ? 'webm' : value)}
          />
        </div>

        <footer className="flex justify-end gap-2 pt-1">
          <Button variant="ghost" onClick={onClose} data-testid="extract-cancel-dialog">
            Cancel
          </Button>
          <Button
            variant="primary"
            data-testid="extract-go"
            disabled={endMs - startMs < MIN_PART_MS}
            icon={<Scissors className="size-4" aria-hidden="true" />}
            onClick={() => {
              onClose();
              dismissExport(item.id);
              void startFcapExtract({
                id: item.id,
                sourceIndex: choice,
                startMs: Math.round(startMs),
                endMs: Math.round(endMs),
                format,
              });
            }}
          >
            Extract
          </Button>
        </footer>
      </div>
    </Modal>
  );
}

export interface FcapExtractProps {
  item: HistoryItemView;
  layout: RecordingLayout;
  className?: string;
}

/**
 * "Extract…" for a multi-source recording: the dialog (source, part, format), then inline
 * progress with Cancel and the result, like the MP4 export. The hook for editing later: a source's
 * rectangle is `layoutSourceRect(layout, index)` (src/shared/recording-layout.ts).
 */
export function FcapExtract({ item, layout, className }: FcapExtractProps) {
  const [open, setOpen] = useState(false);
  const state = useExportState(item.id);
  const otherActive = useAnyExportActive();
  const caps = useExportCapabilities();
  const busy = state?.status === 'starting' || state?.status === 'running';

  if (busy) {
    const percent = state.status === 'running' ? state.percent : null;
    return (
      <div data-testid="extract-progress" className={cn('flex flex-col gap-2', className)}>
        <div className="flex items-center justify-between text-[13px] text-fg-muted">
          <span aria-live="polite" className="flex items-center gap-2">
            <Loader size="sm" decorative />
            {percent === null ? 'Extracting…' : `Extracting… ${percent}%`}
          </span>
          {state.status === 'running' ? (
            <Button
              size="sm"
              variant="ghost"
              data-testid="extract-cancel"
              icon={<X className="size-3.5" aria-hidden="true" />}
              onClick={() => void cancelMp4Export(item.id)}
            >
              Cancel
            </Button>
          ) : null}
        </div>
        <div
          role="progressbar"
          aria-label="Extract progress"
          aria-valuemin={0}
          aria-valuemax={100}
          {...(percent !== null && { 'aria-valuenow': percent })}
          className="h-2 overflow-hidden rounded-full bg-surface-3"
        >
          <div
            className={cn(
              'h-full rounded-full bg-accent-solid transition-[width] duration-300',
              percent === null && 'w-1/3 animate-pulse',
            )}
            style={percent === null ? undefined : { width: `${percent}%` }}
          />
        </div>
      </div>
    );
  }

  return (
    <div className={cn('flex flex-col items-start gap-2', className)}>
      {state?.status === 'failed' ? (
        <p
          role="alert"
          data-testid="extract-error"
          className="self-stretch rounded-lg bg-danger-soft px-3 py-2 text-[13px] text-danger"
        >
          Extract failed. {state.message} Your recording was not changed.
        </p>
      ) : null}
      {state?.status === 'done' ? (
        <p
          role="status"
          data-testid="extract-done"
          className="flex items-center justify-between gap-2 self-stretch rounded-lg bg-accent-soft px-3 py-2 text-[13px] text-accent-fg"
        >
          Extract saved
          {state.itemId ? (
            <Button
              size="sm"
              variant="ghost"
              icon={<FolderOpen className="size-3.5" aria-hidden="true" />}
              onClick={() => {
                const id = state.itemId;
                if (!id) return;
                void window.framecapt.invoke('history:reveal', { id }).then((response) => {
                  if (!response.ok) notify.error(response.error);
                });
              }}
            >
              Show in folder
            </Button>
          ) : null}
        </p>
      ) : null}
      <Button
        variant="primary"
        data-testid="details-extract"
        className="w-full"
        disabled={otherActive}
        icon={<Scissors className="size-4" aria-hidden="true" />}
        onClick={() => setOpen(true)}
      >
        Extract…
      </Button>
      <ExtractDialog
        item={item}
        layout={layout}
        open={open}
        onClose={() => setOpen(false)}
        mp4Available={caps?.mp4Available ?? true}
      />
    </div>
  );
}
