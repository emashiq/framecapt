import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import { Check, ChevronDown, Download, X } from 'lucide-react';
import {
  GIF_DEFAULT_FPS,
  type VideoCommand,
  type VideoExportFormat,
  type VideoProject,
} from '../../../shared/video-edit';
import { Button } from '../../components/ui/Button';
import type { VideoExportState } from '../../history/video-export-store';

const FORMATS: { value: VideoExportFormat; label: string; hint: string }[] = [
  { value: 'mp4', label: 'MP4', hint: 'H.264 + AAC, plays everywhere' },
  { value: 'webm', label: 'WebM', hint: 'VP9 + Opus, smaller' },
  { value: 'gif', label: 'GIF', hint: 'Animated, no sound' },
];
const WIDTHS: { value: string; label: string }[] = [
  { value: 'original', label: 'Original size' },
  { value: '1920', label: 'Up to 1920 px wide' },
  { value: '1280', label: 'Up to 1280 px wide' },
  { value: '960', label: 'Up to 960 px wide' },
  { value: '640', label: 'Up to 640 px wide' },
];
const GIF_RATES = [8, 12, 15, 24];

const itemClass =
  'relative flex cursor-default items-center gap-2 rounded-lg py-1.5 pr-2.5 pl-7 outline-none data-[highlighted]:bg-accent-soft data-[highlighted]:text-accent-fg';

function Radio({
  value,
  label,
  hint,
  testId,
}: {
  value: string;
  label: string;
  hint?: string;
  testId?: string;
}) {
  return (
    <DropdownMenu.RadioItem value={value} data-testid={testId} className={itemClass}>
      <DropdownMenu.ItemIndicator className="absolute left-2">
        <Check className="size-4" aria-hidden="true" />
      </DropdownMenu.ItemIndicator>
      <span className="flex-1">{label}</span>
      {hint ? <span className="text-xs text-fg-subtle">{hint}</span> : null}
    </DropdownMenu.RadioItem>
  );
}

export interface ExportControlsProps {
  project: VideoProject;
  state: VideoExportState | undefined;
  commit: (command: VideoCommand) => void;
  onExport: () => void;
  onCancel: () => void;
}

/** "Export MP4" with a menu for the format, the size and (GIF) the frame rate; progress and Cancel while it runs. */
export function ExportControls({
  project,
  state,
  commit,
  onExport,
  onCancel,
}: ExportControlsProps) {
  const { format, scale, gifFps } = project.export;
  const running = state?.status === 'starting' || state?.status === 'running';
  const label = FORMATS.find((entry) => entry.value === format)?.label ?? 'MP4';

  if (running) {
    const percent = state.status === 'running' ? state.percent : null;
    return (
      <div className="flex items-center gap-2" data-testid="video-export-progress">
        <div
          role="progressbar"
          aria-label={`Exporting ${label}`}
          aria-valuemin={0}
          aria-valuemax={100}
          {...(percent !== null && { 'aria-valuenow': percent })}
          className="h-1.5 w-32 overflow-hidden rounded-full bg-surface-3"
        >
          <div
            className={`h-full rounded-full bg-accent-solid transition-[width] duration-300 ${percent === null ? 'w-1/3 animate-pulse' : ''}`}
            style={percent === null ? undefined : { width: `${percent}%` }}
          />
        </div>
        <span className="min-w-20 text-[13px] text-fg-muted tabular-nums">
          {state.status === 'starting' || percent === null ? 'Exporting…' : `Exporting ${percent}%`}
        </span>
        <Button
          size="sm"
          variant="secondary"
          data-testid="video-export-cancel"
          icon={<X className="size-4" aria-hidden="true" />}
          onClick={onCancel}
        >
          Cancel
        </Button>
      </div>
    );
  }

  return (
    <div className="flex items-center">
      <Button
        size="sm"
        variant="primary"
        data-testid="video-export"
        className="rounded-r-none"
        icon={<Download className="size-4" aria-hidden="true" />}
        onClick={onExport}
      >
        Export {label}
      </Button>
      <DropdownMenu.Root>
        <DropdownMenu.Trigger asChild>
          <button
            type="button"
            data-testid="video-export-options"
            aria-label="Export options"
            className="-ml-px inline-flex h-8 w-8 items-center justify-center rounded-r-lg border-l border-white/25 bg-accent-solid text-white shadow-card transition-colors duration-150 hover:bg-accent-solid-hover"
          >
            <ChevronDown className="size-4" aria-hidden="true" />
          </button>
        </DropdownMenu.Trigger>
        <DropdownMenu.Portal>
          <DropdownMenu.Content
            align="end"
            sideOffset={6}
            className="z-50 min-w-72 rounded-xl border border-line bg-surface p-1.5 text-[13px] text-fg shadow-raised"
          >
            <DropdownMenu.Label className="px-2.5 pt-1 pb-1 text-[11px] font-semibold tracking-wide text-fg-muted uppercase">
              Format
            </DropdownMenu.Label>
            <DropdownMenu.RadioGroup
              value={format}
              onValueChange={(value) =>
                commit({ type: 'setExport', patch: { format: value as VideoExportFormat } })
              }
            >
              {FORMATS.map((entry) => (
                <Radio
                  key={entry.value}
                  value={entry.value}
                  label={entry.label}
                  hint={entry.hint}
                  testId={`export-format-${entry.value}`}
                />
              ))}
            </DropdownMenu.RadioGroup>
            <DropdownMenu.Separator className="my-1 h-px bg-line" />
            <DropdownMenu.Label className="px-2.5 pt-1 pb-1 text-[11px] font-semibold tracking-wide text-fg-muted uppercase">
              Size
            </DropdownMenu.Label>
            <DropdownMenu.RadioGroup
              value={scale === undefined ? 'original' : String(scale)}
              onValueChange={(value) =>
                commit({
                  type: 'setExport',
                  patch: { scale: value === 'original' ? undefined : Number(value) },
                })
              }
            >
              {WIDTHS.map((entry) => (
                <Radio
                  key={entry.value}
                  value={entry.value}
                  label={entry.label}
                  testId={`export-size-${entry.value}`}
                />
              ))}
            </DropdownMenu.RadioGroup>
            {format === 'gif' ? (
              <>
                <DropdownMenu.Separator className="my-1 h-px bg-line" />
                <DropdownMenu.Label className="px-2.5 pt-1 pb-1 text-[11px] font-semibold tracking-wide text-fg-muted uppercase">
                  GIF frame rate
                </DropdownMenu.Label>
                <DropdownMenu.RadioGroup
                  value={String(gifFps ?? GIF_DEFAULT_FPS)}
                  onValueChange={(value) =>
                    commit({ type: 'setExport', patch: { gifFps: Number(value) } })
                  }
                >
                  {[...new Set([...GIF_RATES, GIF_DEFAULT_FPS])]
                    .sort((a, b) => a - b)
                    .map((rate) => (
                      <Radio
                        key={rate}
                        value={String(rate)}
                        label={`${rate} frames per second`}
                        testId={`export-gif-fps-${rate}`}
                      />
                    ))}
                </DropdownMenu.RadioGroup>
                <p className="px-2.5 pt-1.5 pb-1 text-xs text-fg-subtle">
                  GIFs are large: keep them short and small. Their width is limited to 960 px unless
                  you choose another size.
                </p>
              </>
            ) : null}
          </DropdownMenu.Content>
        </DropdownMenu.Portal>
      </DropdownMenu.Root>
    </div>
  );
}
