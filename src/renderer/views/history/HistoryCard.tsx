import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import {
  Camera,
  Copy,
  ExternalLink,
  FileX2,
  Film,
  FolderOpen,
  Link2,
  Loader2,
  MoreHorizontal,
  Save,
  Trash2,
  Video,
} from 'lucide-react';
import type { HistoryItemView } from '../../../shared/history-ipc';
import { formatBytes, formatDuration } from '../../../shared/recording';
import { useExportState } from '../../history/export-store';
import { cn } from '../../lib/cn';
import { formatExact, formatRelative } from '../../lib/time';
import { Button } from '../../components/ui/Button';
import { IconButton } from '../../components/ui/IconButton';
import type { ItemActions } from './actions';
import { Thumb } from './Thumb';

export interface HistoryCardProps {
  item: HistoryItemView;
  now: number;
  /** Roving tab stop: only one card in the grid is reachable with Tab. */
  tabStop: boolean;
  mp4Available: boolean;
  actions: ItemActions;
  onSelect: (item: HistoryItemView) => void;
  onAskDelete: (item: HistoryItemView) => void;
}

export function dimensionsText(item: Pick<HistoryItemView, 'width' | 'height'>): string {
  return item.width > 0 && item.height > 0 ? `${item.width} × ${item.height}` : '';
}

export const menuItemClass =
  'flex cursor-default items-center gap-2.5 rounded-lg px-2.5 py-2 text-sm outline-none ' +
  'data-[highlighted]:bg-accent-soft data-[highlighted]:text-accent-fg data-[disabled]:opacity-45';

/** Which kind of file the card is: a quiet badge on the thumbnail. */
export function TypeBadge({ item }: { item: Pick<HistoryItemView, 'type' | 'format'> }) {
  const Icon = item.type === 'screenshot' ? Camera : Video;
  return (
    <span
      data-testid="history-type"
      className="inline-flex items-center gap-1 rounded-md bg-bg/85 px-1.5 py-0.5 text-[11px] font-semibold tracking-wide text-fg-muted uppercase shadow-card backdrop-blur-sm"
    >
      <Icon className="size-3" aria-hidden="true" />
      {item.format}
    </span>
  );
}

export function DurationChip({ durationMs }: { durationMs: number | null }) {
  if (durationMs === null) return null;
  return (
    <span
      data-testid="history-duration"
      className="rounded-md bg-black/70 px-1.5 py-0.5 text-[11px] font-medium text-white tabular-nums"
    >
      {formatDuration(durationMs)}
    </span>
  );
}

export function HistoryCard({
  item,
  now,
  tabStop,
  mp4Available,
  actions,
  onSelect,
  onAskDelete,
}: HistoryCardProps) {
  const exportState = useExportState(item.id);
  const converting = exportState?.status === 'running' || exportState?.status === 'starting';
  const missing = !item.exists;
  const subtitle = [dimensionsText(item), formatBytes(item.sizeBytes)].filter(Boolean).join(' · ');
  const kind = item.type === 'screenshot' ? 'screenshot' : 'recording';
  // The type badge already says ".png"; the name shows the part that tells captures apart.
  const stem = item.fileName.replace(/[.][^.]+$/, '');
  return (
    <li className="group/card relative" data-testid="history-item">
      <button
        type="button"
        data-card-main=""
        data-id={item.id}
        data-type={item.type}
        data-missing={missing || undefined}
        tabIndex={tabStop ? 0 : -1}
        aria-label={`${item.fileName}, ${kind}, ${formatRelative(item.createdAt, now)}${missing ? ', file missing' : ''}`}
        onClick={() => onSelect(item)}
        className={cn(
          'flex w-full flex-col overflow-hidden rounded-xl border bg-surface text-left shadow-card transition-[border-color,box-shadow] duration-150',
          'border-line hover:border-line-strong group-hover/card:shadow-raised',
        )}
      >
        <span className="relative block">
          <Thumb item={item} className="aspect-video w-full" />
          <span className="absolute top-2 left-2">
            <TypeBadge item={item} />
          </span>
          <span className="absolute right-2 bottom-2 flex items-center gap-1.5">
            {converting ? (
              <span className="inline-flex items-center gap-1 rounded-md bg-accent-solid px-1.5 py-0.5 text-[11px] font-medium text-white tabular-nums">
                <Loader2 className="size-3 animate-spin" aria-hidden="true" />
                {exportState?.status === 'running' && exportState.percent !== null
                  ? `${exportState.percent}%`
                  : 'MP4'}
              </span>
            ) : null}
            <DurationChip durationMs={item.durationMs} />
          </span>
          {missing ? (
            <span
              data-testid="history-missing"
              className="absolute inset-0 flex flex-col items-center justify-center gap-1 bg-bg/55 text-center text-[13px] font-medium text-fg-muted"
            >
              <FileX2 className="size-5" aria-hidden="true" />
              File moved or deleted
            </span>
          ) : null}
        </span>
        <span className={cn('flex flex-col gap-0.5 px-3 pt-2.5 pb-3', missing && 'pb-14')}>
          <span className="truncate text-[13px] font-medium text-fg" title={item.fileName}>
            {stem}
          </span>
          <span
            className="text-xs text-fg-muted"
            title={formatExact(item.createdAt)}
            data-testid="history-time"
          >
            {formatRelative(item.createdAt, now)}
          </span>
          <span className="truncate text-xs text-fg-subtle tabular-nums">{subtitle}</span>
        </span>
      </button>

      {missing ? (
        <div className="absolute inset-x-3 bottom-3 flex gap-2">
          <Button
            size="sm"
            variant="secondary"
            data-testid="history-locate"
            icon={<Link2 className="size-3.5" aria-hidden="true" />}
            onClick={() => actions.locate(item)}
          >
            Locate…
          </Button>
          <Button
            size="sm"
            variant="secondary"
            data-testid="history-remove"
            icon={<Trash2 className="size-3.5" aria-hidden="true" />}
            onClick={() => actions.remove(item)}
          >
            Remove
          </Button>
        </div>
      ) : (
        <div className="absolute top-2 right-2 flex gap-1 opacity-0 transition-opacity duration-150 group-focus-within/card:opacity-100 group-hover/card:opacity-100">
          <IconButton
            size="sm"
            variant="secondary"
            aria-label="Open"
            data-testid="history-open"
            icon={<ExternalLink className="size-4" />}
            onClick={() => actions.open(item)}
          />
          <IconButton
            size="sm"
            variant="secondary"
            aria-label="Show in folder"
            data-testid="history-reveal"
            icon={<FolderOpen className="size-4" />}
            onClick={() => actions.reveal(item)}
          />
          <IconButton
            size="sm"
            variant="secondary"
            aria-label={item.type === 'screenshot' ? 'Copy image' : 'Copy path'}
            data-testid="history-copy"
            icon={<Copy className="size-4" />}
            onClick={() => actions.copy(item)}
          />
          <DropdownMenu.Root>
            <DropdownMenu.Trigger asChild>
              <IconButton
                size="sm"
                variant="secondary"
                aria-label="More actions"
                data-testid="history-more"
                icon={<MoreHorizontal className="size-4" />}
              />
            </DropdownMenu.Trigger>
            <DropdownMenu.Portal>
              <DropdownMenu.Content
                align="end"
                sideOffset={6}
                className="z-50 min-w-56 rounded-xl border border-line bg-surface p-1.5 text-fg shadow-raised"
              >
                {item.type === 'recording' && item.format === 'webm' ? (
                  <DropdownMenu.Item
                    data-testid="history-menu-mp4"
                    disabled={!mp4Available || converting}
                    onSelect={() => actions.exportMp4(item)}
                    className={menuItemClass}
                  >
                    <Film className="size-4 text-fg-subtle" aria-hidden="true" />
                    Export MP4…
                  </DropdownMenu.Item>
                ) : null}
                {item.type === 'recording' ? (
                  <DropdownMenu.Item
                    data-testid="history-menu-save-copy"
                    onSelect={() => actions.saveCopy(item)}
                    className={menuItemClass}
                  >
                    <Save className="size-4 text-fg-subtle" aria-hidden="true" />
                    Save a copy as…
                  </DropdownMenu.Item>
                ) : null}
                <DropdownMenu.Item
                  data-testid="history-menu-remove"
                  onSelect={() => actions.remove(item)}
                  className={menuItemClass}
                >
                  <Trash2 className="size-4 text-fg-subtle" aria-hidden="true" />
                  Remove from history
                </DropdownMenu.Item>
                <DropdownMenu.Separator className="my-1 h-px bg-line" />
                <DropdownMenu.Item
                  data-testid="history-menu-delete"
                  onSelect={() => onAskDelete(item)}
                  className={cn(menuItemClass, 'text-danger data-[highlighted]:text-danger')}
                >
                  <Trash2 className="size-4" aria-hidden="true" />
                  Delete file…
                </DropdownMenu.Item>
              </DropdownMenu.Content>
            </DropdownMenu.Portal>
          </DropdownMenu.Root>
        </div>
      )}
    </li>
  );
}
