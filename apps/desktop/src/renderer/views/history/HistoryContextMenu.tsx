import { useEffect, useRef, type ReactNode } from 'react';
import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import {
  CheckSquare,
  Copy,
  Download,
  ExternalLink,
  FileX2,
  Film,
  FolderOpen,
  Link2,
  Pencil,
  Save,
  Trash2,
  X,
} from 'lucide-react';
import type { HistoryItemView } from '../../../shared/history-ipc';
import { cn } from '../../lib/cn';
import { canEditItem, editLabel, type ItemActions } from './actions';
import { menuItemClass } from './HistoryCard';
import { selectionLabel } from './selection';

export interface ContextTarget {
  item: HistoryItemView;
  /** Viewport position of the menu: the pointer, or the card for the keyboard. */
  x: number;
  y: number;
}

export interface HistoryContextMenuProps {
  target: ContextTarget | null;
  /** Ids selected right now; a menu on a card inside a selection of 2 or more acts on all of them. */
  selectedIds: ReadonlySet<string>;
  mp4Available: boolean;
  actions: ItemActions;
  onEdit?: ((item: HistoryItemView) => void) | undefined;
  onAskDelete: (item: HistoryItemView) => void;
  onAskDeleteProject: (item: HistoryItemView) => void;
  onToggleSelect: (item: HistoryItemView) => void;
  onSaveCopies: (ids: string[]) => void;
  onRemoveMany: (ids: string[]) => void;
  onClearSelection: () => void;
  onClose: () => void;
}

const MISSING = 'File moved or deleted';
const ICON = 'size-4';

function Entry({
  testId,
  icon,
  label,
  reason,
  danger,
  onSelect,
}: {
  testId: string;
  icon: ReactNode;
  label: string;
  /** Set when the entry is not available: it stays visible, disabled, with the reason. */
  reason?: string | null | undefined;
  danger?: boolean;
  onSelect: () => void;
}) {
  return (
    <DropdownMenu.Item
      data-testid={testId}
      disabled={Boolean(reason)}
      onSelect={onSelect}
      className={cn(menuItemClass, danger && 'text-danger data-[highlighted]:text-danger')}
    >
      <span className="text-fg-subtle" aria-hidden="true">
        {icon}
      </span>
      <span className="flex-1">{label}</span>
      {reason ? <span className="text-xs text-fg-subtle">{reason}</span> : null}
    </DropdownMenu.Item>
  );
}

/**
 * The right-click (and Shift+F10 / Menu key) menu of a history card. It is a dropdown anchored at
 * the pointer, built on the same Radix menu as "More actions", so it is keyboard and screen reader
 * accessible. It only calls the actions the card buttons use: nothing here is new authority, and
 * main still checks every one. Entries that are not available stay listed, disabled, with the reason.
 */
export function HistoryContextMenu(props: HistoryContextMenuProps) {
  const { target, actions } = props;
  const item = target?.item;
  // The target is already gone when the menu hands focus back: remember which card it was for.
  const lastId = useRef<string | null>(null);
  useEffect(() => {
    if (item) lastId.current = item.id;
  }, [item]);
  const bulkIds =
    item && props.selectedIds.has(item.id) && props.selectedIds.size > 1
      ? [...props.selectedIds]
      : null;
  const missing = item ? !item.exists : false;
  return (
    <DropdownMenu.Root
      // Not modal: the page behind stays reachable for assistive tech (no aria-hidden over focusable
      // cards); Escape, an outside click and Tab still close it.
      modal={false}
      open={target !== null}
      onOpenChange={(open) => {
        if (!open) props.onClose();
      }}
    >
      <DropdownMenu.Trigger asChild>
        <span
          aria-hidden="true"
          style={{
            position: 'fixed',
            left: target?.x ?? 0,
            top: target?.y ?? 0,
            width: 1,
            height: 1,
          }}
        />
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content
          data-testid="history-context-menu"
          aria-label={bulkIds ? selectionLabel(bulkIds.length) : (item?.fileName ?? 'Item actions')}
          align="start"
          sideOffset={2}
          collisionPadding={8}
          onCloseAutoFocus={(event) => {
            // Focus goes back to the card, not to the invisible anchor.
            event.preventDefault();
            if (lastId.current) {
              document
                .querySelector<HTMLElement>(`[data-card-main][data-id="${lastId.current}"]`)
                ?.focus();
            }
          }}
          className="z-50 min-w-60 rounded-xl border border-line bg-surface p-1.5 text-fg shadow-raised"
        >
          {item && bulkIds ? (
            <>
              <Entry
                testId="ctx-bulk-save"
                icon={<Download className={ICON} />}
                label={`Save ${bulkIds.length} copies…`}
                onSelect={() => props.onSaveCopies(bulkIds)}
              />
              <Entry
                testId="ctx-bulk-remove"
                icon={<Trash2 className={ICON} />}
                label={`Remove ${bulkIds.length} from history`}
                onSelect={() => props.onRemoveMany(bulkIds)}
              />
              <DropdownMenu.Separator className="my-1 h-px bg-line" />
              <Entry
                testId="ctx-clear-selection"
                icon={<X className={ICON} />}
                label="Clear selection"
                onSelect={props.onClearSelection}
              />
            </>
          ) : item ? (
            <>
              {canEditItem(item) && props.onEdit ? (
                <Entry
                  testId="ctx-edit"
                  icon={<Pencil className={ICON} />}
                  label={editLabel(item)}
                  reason={missing ? MISSING : null}
                  onSelect={() => props.onEdit?.(item)}
                />
              ) : null}
              <Entry
                testId="ctx-open"
                icon={<ExternalLink className={ICON} />}
                label="Open"
                reason={missing ? MISSING : null}
                onSelect={() => actions.open(item)}
              />
              <Entry
                testId="ctx-reveal"
                icon={<FolderOpen className={ICON} />}
                label="Show in folder"
                reason={missing ? MISSING : null}
                onSelect={() => actions.reveal(item)}
              />
              <Entry
                testId="ctx-copy"
                icon={<Copy className={ICON} />}
                label={item.type === 'screenshot' ? 'Copy image' : 'Copy path'}
                reason={missing ? MISSING : null}
                onSelect={() => actions.copy(item)}
              />
              {item.type === 'recording' ? (
                <Entry
                  testId="ctx-save-copy"
                  icon={<Save className={ICON} />}
                  label="Save a copy as…"
                  reason={missing ? MISSING : null}
                  onSelect={() => actions.saveCopy(item)}
                />
              ) : item.type === 'screenshot' ? (
                <Entry
                  testId="ctx-save-copy"
                  icon={<Save className={ICON} />}
                  label="Save a copy to a folder…"
                  reason={missing ? MISSING : null}
                  onSelect={() => props.onSaveCopies([item.id])}
                />
              ) : null}
              {item.type === 'recording' && item.format === 'webm' ? (
                <Entry
                  testId="ctx-mp4"
                  icon={<Film className={ICON} />}
                  label="Export MP4…"
                  reason={missing ? MISSING : !props.mp4Available ? 'MP4 is not available' : null}
                  onSelect={() => actions.exportMp4(item)}
                />
              ) : null}
              {missing ? (
                <Entry
                  testId="ctx-locate"
                  icon={<Link2 className={ICON} />}
                  label="Locate…"
                  onSelect={() => actions.locate(item)}
                />
              ) : null}
              <DropdownMenu.Separator className="my-1 h-px bg-line" />
              <Entry
                testId="ctx-select"
                icon={<CheckSquare className={ICON} />}
                label={props.selectedIds.has(item.id) ? 'Deselect' : 'Select'}
                onSelect={() => props.onToggleSelect(item)}
              />
              <Entry
                testId="ctx-remove"
                icon={<Trash2 className={ICON} />}
                label="Remove from history"
                onSelect={() => actions.remove(item)}
              />
              {item.editable ? (
                <Entry
                  testId="ctx-delete-project"
                  icon={<FileX2 className={ICON} />}
                  label="Delete editable data…"
                  onSelect={() => props.onAskDeleteProject(item)}
                />
              ) : null}
              <Entry
                testId="ctx-delete"
                icon={<Trash2 className={ICON} />}
                label="Delete file…"
                danger
                onSelect={() => props.onAskDelete(item)}
              />
            </>
          ) : null}
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}
