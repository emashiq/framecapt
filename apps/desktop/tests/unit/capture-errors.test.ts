import { describe, expect, it } from 'vitest';
import { CaptureError, mapMediaError } from '../../src/renderer/capture/errors';

describe('mapMediaError', () => {
  it.each([
    ['NotAllowedError', 'denied'],
    ['SecurityError', 'denied'],
    ['AbortError', 'denied'],
    ['NotFoundError', 'source-gone'],
    ['NotReadableError', 'source-gone'],
    ['SomethingElse', 'unknown'],
  ])('maps %s to %s', (name, code) => {
    expect(mapMediaError(new DOMException('x', name)).code).toBe(code);
  });

  it('keeps typed capture errors and handles non-errors', () => {
    const typed = new CaptureError('system-audio-unavailable', 'no audio');
    expect(mapMediaError(typed)).toBe(typed);
    expect(mapMediaError('boom').code).toBe('unknown');
  });
});
