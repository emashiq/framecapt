import { describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({ BrowserWindow: class {} }));
vi.mock('../../src/main/windows', () => ({
  loadRenderer: vi.fn(),
  registerWebContents: vi.fn(),
  securePreferences: vi.fn(),
}));

import { shouldCancelOnBlur } from '../../src/main/overlay';

describe('shouldCancelOnBlur', () => {
  it('cancels when the focus went elsewhere', () => {
    expect(
      shouldCancelOnBlur({ anyShown: true, anyOverlayFocused: false, ownUiFocused: false }),
    ).toBe(true);
  });

  it('does not cancel while an overlay is focused', () => {
    expect(
      shouldCancelOnBlur({ anyShown: true, anyOverlayFocused: true, ownUiFocused: false }),
    ).toBe(false);
  });

  it('does not cancel when the focus is on the recording toolbar or camera bubble', () => {
    expect(
      shouldCancelOnBlur({ anyShown: true, anyOverlayFocused: false, ownUiFocused: true }),
    ).toBe(false);
  });

  it('does not cancel before any overlay is shown', () => {
    expect(
      shouldCancelOnBlur({ anyShown: false, anyOverlayFocused: false, ownUiFocused: false }),
    ).toBe(false);
  });
});
