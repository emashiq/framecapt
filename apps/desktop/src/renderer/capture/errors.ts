export type CaptureErrorCode =
  'denied' | 'cancelled' | 'source-gone' | 'system-audio-unavailable' | 'unknown';

export class CaptureError extends Error {
  readonly code: CaptureErrorCode;
  /** The underlying DOMException name, when there was one (kept for diagnostics). */
  readonly domName: string | undefined;

  constructor(code: CaptureErrorCode, message: string, domName?: string) {
    super(message);
    this.name = 'CaptureError';
    this.code = code;
    this.domName = domName;
  }
}

/** Maps a getDisplayMedia / getUserMedia rejection to a typed capture error. */
export function mapMediaError(error: unknown): CaptureError {
  if (error instanceof CaptureError) return error;
  const name = error instanceof DOMException || error instanceof Error ? error.name : '';
  const detail = error instanceof Error ? error.message : String(error);
  switch (name) {
    case 'NotAllowedError':
    case 'SecurityError':
      return new CaptureError('denied', `Capture was not allowed. ${detail}`, name);
    case 'AbortError':
      // Observed in Electron 44: main answering the display-media request with no streams (our
      // deny path) rejects getDisplayMedia with AbortError. There is no picker to cancel, so this
      // means "denied by main". `cancelled` is reserved for the caller aborting its own flow.
      return new CaptureError('denied', `Capture was denied by the app. ${detail}`, name);
    case 'NotFoundError':
    case 'NotReadableError':
    case 'OverconstrainedError':
      return new CaptureError(
        'source-gone',
        `The capture source is not available. ${detail}`,
        name,
      );
    default:
      return new CaptureError('unknown', `Capture failed. ${detail}`, name || undefined);
  }
}
