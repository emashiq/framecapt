import { describe, expect, it } from 'vitest';
import { isOwnWindowSource, windowHandleOf } from '../../src/main/capture/source-id';

describe('source ids', () => {
  it('extracts the window handle', () => {
    expect(windowHandleOf('window:12062870:0')).toBe('12062870');
    expect(windowHandleOf('screen:0:0')).toBeUndefined();
    expect(windowHandleOf('window:abc:0')).toBeUndefined();
  });

  it('recognises our own windows by handle regardless of the trailing number', () => {
    const own = ['window:100:0', 'window:200:0'];
    expect(isOwnWindowSource('window:100:1', own)).toBe(true);
    expect(isOwnWindowSource('window:200:0', own)).toBe(true);
    expect(isOwnWindowSource('window:300:0', own)).toBe(false);
    expect(isOwnWindowSource('screen:100:0', own)).toBe(false);
    expect(isOwnWindowSource('window:100:0', [])).toBe(false);
  });
});
