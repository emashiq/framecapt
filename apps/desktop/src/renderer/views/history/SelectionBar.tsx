import { CheckSquare, Download, FolderInput, Loader2, Trash2, X } from 'lucide-react';
import { Button } from '../../components/ui/Button';
import type { BulkState } from '../../history/bulk-store';
import { selectionLabel } from './selection';

export interface SelectionBarProps {
  count: number;
  /** Items the current list shows (for "Select all"). */
  listed: number;
  bulk: BulkState;
  onSaveCopies: () => void;
  onRemove: () => void;
  /** Opens the folder picker for the selection. */
  onMoveTo?: () => void;
  onSelectAll: () => void;
  onClear: () => void;
  onCancelBulk: () => void;
}

/**
 * The bar above the grid while cards are selected: how many, and what to do with them.
 */
export function SelectionBar({
  count,
  listed,
  bulk,
  onSaveCopies,
  onRemove,
  onMoveTo,
  onSelectAll,
  onClear,
  onCancelBulk,
}: SelectionBarProps) {
  const busy = bulk.status !== 'idle';
  return (
    <div
      role="region"
      aria-label="Selection"
      data-testid="selection-bar"
      className="sticky top-0 z-10 mb-4 flex flex-wrap items-center gap-x-3 gap-y-2 rounded-xl border border-line-strong bg-surface px-3 py-2 shadow-raised"
    >
      <span data-testid="selection-count" className="text-sm font-medium text-fg tabular-nums">
        {selectionLabel(count)}
      </span>
      {bulk.status === 'running' ? (
        <span
          data-testid="bulk-progress"
          className="inline-flex items-center gap-2 text-[13px] text-fg-muted tabular-nums"
        >
          <Loader2 className="size-4 animate-spin motion-reduce:animate-none" aria-hidden="true" />
          Saving {Math.min(bulk.done + 1, bulk.total)} of {bulk.total}…
        </span>
      ) : null}
      <div className="ml-auto flex flex-wrap items-center gap-2">
        {bulk.status === 'running' ? (
          <Button size="sm" variant="secondary" data-testid="bulk-cancel" onClick={onCancelBulk}>
            Cancel
          </Button>
        ) : (
          <Button
            size="sm"
            variant="secondary"
            data-testid="bulk-save"
            icon={<Download className="size-4" aria-hidden="true" />}
            unavailable={busy}
            onClick={onSaveCopies}
          >
            Save copies…
          </Button>
        )}
        {onMoveTo ? (
          <Button
            size="sm"
            variant="secondary"
            data-testid="bulk-move"
            icon={<FolderInput className="size-4" aria-hidden="true" />}
            disabled={bulk.status === 'running'}
            onClick={onMoveTo}
          >
            Move to…
          </Button>
        ) : null}
        <Button
          size="sm"
          variant="secondary"
          data-testid="bulk-remove"
          icon={<Trash2 className="size-4" aria-hidden="true" />}
          disabled={bulk.status === 'running'}
          onClick={onRemove}
        >
          Remove from history
        </Button>
        {count < listed ? (
          <Button
            size="sm"
            variant="ghost"
            data-testid="bulk-select-all"
            icon={<CheckSquare className="size-4" aria-hidden="true" />}
            onClick={onSelectAll}
          >
            Select all {listed}
          </Button>
        ) : null}
        <Button
          size="sm"
          variant="ghost"
          data-testid="bulk-clear"
          icon={<X className="size-4" aria-hidden="true" />}
          onClick={onClear}
        >
          Clear selection
        </Button>
      </div>
    </div>
  );
}
