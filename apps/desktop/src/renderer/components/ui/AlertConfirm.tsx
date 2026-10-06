import * as AlertDialog from '@radix-ui/react-alert-dialog';
import { Button } from './Button';

export interface AlertConfirmProps {
  open: boolean;
  title: string;
  description: string;
  cancelLabel: string;
  confirmLabel: string;
  onConfirm: () => void;
  onCancel: () => void;
}

/**
 * A destructive-action confirmation on Radix AlertDialog: focus is trapped, Esc and the cancel
 * button both mean "no", and focus starts on the safe choice.
 */
export function AlertConfirm({
  open,
  title,
  description,
  cancelLabel,
  confirmLabel,
  onConfirm,
  onCancel,
}: AlertConfirmProps) {
  return (
    <AlertDialog.Root open={open} onOpenChange={(next) => !next && onCancel()}>
      <AlertDialog.Portal>
        <AlertDialog.Overlay className="fixed inset-0 z-40 bg-black/50" />
        <AlertDialog.Content
          data-testid="confirm-dialog"
          className="fixed top-1/2 left-1/2 z-50 w-[min(420px,90vw)] -translate-x-1/2 -translate-y-1/2 rounded-2xl border border-line bg-surface p-6 text-fg shadow-raised"
        >
          <AlertDialog.Title className="text-lg font-semibold text-fg">{title}</AlertDialog.Title>
          <AlertDialog.Description className="mt-1.5 text-sm text-fg-muted">
            {description}
          </AlertDialog.Description>
          <div className="mt-6 flex justify-end gap-2.5">
            <AlertDialog.Cancel asChild>
              <Button variant="secondary" data-testid="confirm-no">
                {cancelLabel}
              </Button>
            </AlertDialog.Cancel>
            <AlertDialog.Action asChild>
              <Button variant="danger" onClick={onConfirm} data-testid="confirm-yes">
                {confirmLabel}
              </Button>
            </AlertDialog.Action>
          </div>
        </AlertDialog.Content>
      </AlertDialog.Portal>
    </AlertDialog.Root>
  );
}
