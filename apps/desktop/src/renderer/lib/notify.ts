import { toast } from 'sonner';
import { friendlyError } from '../../shared/error-messages';
import { announce } from './announce';

/**
 * The one way the app tells the user something: success, info, a warning or an error, each with an
 * optional action button ("Show in folder", "Undo", "Open Settings"). Errors take the typed failure
 * ({ code, message }) and show the friendly copy with a next step (shared/error-messages.ts).
 * The toaster is a polite live region, so screen readers hear every one of these.
 */
export interface NotifyAction {
  label: string;
  onClick: () => void;
}

interface Options {
  action?: NotifyAction | undefined;
  /** Milliseconds; errors stay longer than confirmations. */
  duration?: number;
  id?: string | number;
}

function build(options: Options | undefined, fallback: number) {
  return {
    duration: options?.duration ?? fallback,
    ...(options?.id !== undefined && { id: options.id }),
    ...(options?.action && {
      action: { label: options.action.label, onClick: options.action.onClick },
    }),
  };
}

export const notify = {
  success(message: string, options?: Options): void {
    toast.success(message, build(options, 4000));
  },
  info(message: string, options?: Options): void {
    toast(message, build(options, 5000));
  },
  warning(message: string, options?: Options): void {
    toast.warning(message, build(options, 7000));
  },
  /** A typed failure from an IPC call, or plain text. */
  error(error: { code?: string; message?: string } | string, options?: Options): void {
    const text = typeof error === 'string' ? error : friendlyError(error.code, error.message);
    toast.error(text, build(options, 8000));
  },
};

/** Announces to screen readers without a toast (status changes the UI already shows). */
export { announce };
