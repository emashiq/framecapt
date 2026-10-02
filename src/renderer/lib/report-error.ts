import { ERROR_REPORT_LIMITS, type ReportErrorRequest } from '../../shared/ipc-contract';

const MAX_REPORTS_PER_SESSION = 20;
let sent = 0;
let lastMessage = '';

function cap(value: string | undefined, max: number): string | undefined {
  return value === undefined ? undefined : value.slice(0, max);
}

/** Sends an error to main for logging. Capped, de-duplicated and never throws. */
export function reportError(
  source: ReportErrorRequest['source'],
  error: unknown,
  componentStack?: string,
): void {
  try {
    const message = error instanceof Error ? error.message : String(error);
    if (sent >= MAX_REPORTS_PER_SESSION || message === lastMessage) return;
    sent += 1;
    lastMessage = message;

    const stack = error instanceof Error ? error.stack : undefined;
    const report: ReportErrorRequest = {
      source,
      message: message.slice(0, ERROR_REPORT_LIMITS.message),
    };
    const cappedStack = cap(stack, ERROR_REPORT_LIMITS.stack);
    const cappedComponentStack = cap(componentStack, ERROR_REPORT_LIMITS.componentStack);
    if (cappedStack !== undefined) report.stack = cappedStack;
    if (cappedComponentStack !== undefined) report.componentStack = cappedComponentStack;

    void window.framelet.invoke('app:reportError', report).catch(() => undefined);
  } catch {
    // Reporting must never cause another error.
  }
}

export function installGlobalErrorReporting(): void {
  window.addEventListener('error', (event) => {
    reportError('window-error', event.error ?? event.message);
  });
  window.addEventListener('unhandledrejection', (event) => {
    reportError('unhandled-rejection', event.reason);
  });
}
