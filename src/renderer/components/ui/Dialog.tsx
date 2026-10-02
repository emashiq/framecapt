import { useEffect, useRef, type ReactNode } from 'react';
import { cn } from '../../lib/cn';

export interface ModalProps {
  open: boolean;
  onClose: () => void;
  /** Accessible name of the dialog. */
  label: string;
  className?: string;
  children: ReactNode;
  'data-testid'?: string;
}

/**
 * A modal built on the native <dialog>: focus is trapped and restored to the previously focused
 * element by the platform, Esc closes it, and the page behind becomes inert.
 */
export function Modal({ open, onClose, label, className, children, ...rest }: ModalProps) {
  const ref = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (open && !dialog.open) dialog.showModal();
    if (!open && dialog.open) dialog.close();
  }, [open]);

  return (
    <dialog
      ref={ref}
      aria-label={label}
      data-testid={rest['data-testid']}
      className={cn(
        'm-auto rounded-2xl border border-line bg-surface p-0 text-fg shadow-raised backdrop:bg-black/50',
        className,
      )}
      onClose={onClose}
      onClick={(event) => {
        // A click on the backdrop lands on the dialog element itself.
        if (event.target === event.currentTarget) onClose();
      }}
    >
      {open ? children : null}
    </dialog>
  );
}
