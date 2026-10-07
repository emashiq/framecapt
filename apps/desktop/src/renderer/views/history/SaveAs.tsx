import { useState } from 'react';
import { Save, X } from 'lucide-react';
import type { HistoryItemView } from '../../../shared/history-ipc';
import {
  COMPRESSION_LABEL,
  COMPRESSION_LEVELS,
  GIF_MAX_SECONDS,
  SAVE_FORMATS,
  SAVE_FORMAT_LABEL,
  formatHint,
  isNoopConversion,
  type Compression,
  type SaveFormat,
} from '../../../shared/recording-format';
import { Loader } from '../../components/Loader';
import { Button } from '../../components/ui/Button';
import { Modal } from '../../components/ui/Dialog';
import { Segmented } from '../../components/ui/Segmented';
import { Select } from '../../components/ui/Select';
import {
  cancelMp4Export,
  startSaveAs,
  useAnyExportActive,
  useExportState,
} from '../../history/export-store';
import { useExportCapabilities } from '../../history/use-export-capabilities';
import { closeSaveAs, useSaveAsTarget } from '../../history/save-as-store';
import { cn } from '../../lib/cn';

const WIDTHS = [
  { value: 'original', label: 'Original size' },
  { value: '1920', label: '1920 px wide' },
  { value: '1280', label: '1280 px wide' },
  { value: '960', label: '960 px wide' },
  { value: '640', label: '640 px wide' },
] as const;

/** Recordings the dialog can convert (a multi-source `.fcap` and a GIF are not sources). */
export function canSaveAs(item: HistoryItemView): boolean {
  return (
    item.type === 'recording' &&
    (item.format === 'webm' || item.format === 'mp4' || item.format === 'mkv')
  );
}

interface DialogProps {
  item: HistoryItemView & { format: 'webm' | 'mp4' | 'mkv' };
  onClose: () => void;
}

function SaveAsDialog({ item, onClose }: DialogProps) {
  const caps = useExportCapabilities();
  const [format, setFormat] = useState<SaveFormat>(item.format === 'webm' ? 'mp4' : 'webm');
  const [compression, setCompression] = useState<Compression>('off');
  const [width, setWidth] = useState<(typeof WIDTHS)[number]['value']>('original');

  const mp4Unavailable = caps !== null && !caps.mp4Available;
  const webmUnavailable = caps?.webmAvailable === false;
  const gifUnavailable = caps?.gifAvailable === false;
  const tooLongForGif = (item.durationMs ?? 0) > GIF_MAX_SECONDS * 1000;
  const maxWidth = width === 'original' ? undefined : Number(width);
  // A re-encode is needed unless it is a plain MKV re-wrap, so these formats need their encoders.
  const reason = (value: SaveFormat, level: Compression): string | null => {
    if (value === 'gif') {
      if (gifUnavailable) return 'unavailable';
      return tooLongForGif ? `up to ${GIF_MAX_SECONDS} s` : null;
    }
    if (value === 'webm') return webmUnavailable ? 'unavailable' : null;
    if (value === 'mkv' && level === 'off' && maxWidth === undefined) return null;
    return mp4Unavailable ? 'unavailable' : null;
  };
  const formatBlocked = reason(format, compression);
  const noop = isNoopConversion(item.format, { format, compression, maxWidth });
  const problem = formatBlocked
    ? `${SAVE_FORMAT_LABEL[format]} is ${formatBlocked === 'unavailable' ? 'not available in this build' : `only for clips ${formatBlocked}`}.`
    : noop
      ? 'Choose another format, a compression level or a width.'
      : null;

  return (
    <Modal
      open
      onClose={onClose}
      label="Save in another format"
      className="w-[min(520px,94vw)]"
      data-testid="save-as-dialog"
    >
      <div className="flex flex-col gap-4 p-5">
        <header>
          <h2 className="text-lg font-semibold text-fg">Save in another format</h2>
          <p className="text-[13px] text-fg-muted">
            Saves a new video next to the recording. The recording itself is not changed.
          </p>
        </header>

        <div className="flex flex-col gap-1.5">
          <span className="text-[13px] font-medium text-fg">Format</span>
          <Segmented
            label="Format"
            data-testid="save-as-format"
            value={format}
            options={SAVE_FORMATS.map((value) => {
              const blocked = reason(value, 'off');
              return {
                value,
                label: blocked
                  ? `${SAVE_FORMAT_LABEL[value]} (${blocked})`
                  : SAVE_FORMAT_LABEL[value],
              };
            })}
            onChange={setFormat}
          />
        </div>

        <div className="flex flex-col gap-1.5">
          <span className="text-[13px] font-medium text-fg">Compression</span>
          <Segmented
            label="Compression"
            data-testid="save-as-compression"
            value={compression}
            disabled={format === 'gif'}
            options={COMPRESSION_LEVELS.map((value) => ({
              value,
              label: COMPRESSION_LABEL[value],
            }))}
            onChange={setCompression}
          />
          <p className="text-xs text-fg-subtle" data-testid="save-as-hint">
            {formatHint(format, compression)}
          </p>
        </div>

        <div className="flex flex-col gap-1.5">
          <span id="save-as-width-label" className="text-[13px] font-medium text-fg">
            Size
          </span>
          <Select
            className="w-56 max-w-full"
            value={width}
            options={WIDTHS}
            labelledBy="save-as-width-label"
            data-testid="save-as-width"
            onChange={setWidth}
          />
          <p className="text-xs text-fg-subtle">
            Only ever made smaller, never larger than the recording.
          </p>
        </div>

        {problem ? (
          <p role="status" data-testid="save-as-problem" className="text-[13px] text-fg-muted">
            {problem}
          </p>
        ) : null}

        <footer className="flex justify-end gap-2 pt-1">
          <Button variant="ghost" onClick={onClose} data-testid="save-as-cancel">
            Cancel
          </Button>
          <Button
            variant="primary"
            data-testid="save-as-go"
            disabled={problem !== null}
            icon={<Save className="size-4" aria-hidden="true" />}
            onClick={() => {
              onClose();
              void startSaveAs({
                id: item.id,
                format,
                compression: format === 'gif' ? 'off' : compression,
                ...(maxWidth !== undefined && { maxWidth }),
              });
            }}
          >
            Save
          </Button>
        </footer>
      </div>
    </Modal>
  );
}

/** The one "Save in another format" dialog; the History view hosts it. */
export function SaveAsHost() {
  const target = useSaveAsTarget();
  if (!target || !canSaveAs(target)) return null;
  return (
    <SaveAsDialog key={target.id} item={target as DialogProps['item']} onClose={closeSaveAs} />
  );
}

/** Progress and Cancel of a running "Save as…" job (details view); nothing otherwise. */
export function SaveAsProgress({ item, className }: { item: HistoryItemView; className?: string }) {
  const state = useExportState(item.id);
  if (state?.status !== 'running' || !state.converting) return null;
  const percent = state.percent;
  return (
    <div data-testid="save-as-progress" className={cn('flex flex-col gap-2', className)}>
      <div className="flex items-center justify-between text-[13px] text-fg-muted">
        <span aria-live="polite" className="flex items-center gap-2">
          <Loader size="sm" decorative />
          {percent === null ? 'Converting…' : `Converting… ${percent}%`}
        </span>
        <Button
          size="sm"
          variant="ghost"
          data-testid="save-as-cancel-job"
          icon={<X className="size-3.5" aria-hidden="true" />}
          onClick={() => void cancelMp4Export(item.id)}
        >
          Cancel
        </Button>
      </div>
      <div
        role="progressbar"
        aria-label="Conversion progress"
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

/** The "Save in another format…" button of the details view (disabled while any job runs). */
export function SaveAsButton({ onOpen }: { onOpen: () => void }) {
  const busy = useAnyExportActive();
  return (
    <Button
      variant="secondary"
      data-testid="details-save-as"
      disabled={busy}
      icon={<Save className="size-4" aria-hidden="true" />}
      onClick={onOpen}
    >
      Save in another format…
    </Button>
  );
}
