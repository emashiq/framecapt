import { describe, expect, it } from 'vitest';
import { CloseGuard } from '../../src/main/close-guard';

describe('CloseGuard', () => {
  it('closes at once when nothing is unsaved', () => {
    const guard = new CloseGuard();
    expect(guard.onCloseRequested()).toBe('close');
    guard.setDirty(true);
    guard.setDirty(false);
    expect(guard.onCloseRequested()).toBe('close');
  });

  it('asks once when dirty and lets a second close attempt through (quit stays possible)', () => {
    const guard = new CloseGuard();
    guard.setDirty(true);
    expect(guard.onCloseRequested()).toBe('ask');
    expect(guard.onCloseRequested()).toBe('close');
  });

  it('keep editing resets the question; discard lets the close through', () => {
    const guard = new CloseGuard();
    guard.setDirty(true);
    expect(guard.onCloseRequested()).toBe('ask');
    expect(guard.resolve(false)).toBe(false);
    expect(guard.onCloseRequested()).toBe('ask');
    expect(guard.resolve(true)).toBe(true);
    expect(guard.onCloseRequested()).toBe('close');
  });

  it('becoming clean while the question is open ends the question', () => {
    const guard = new CloseGuard();
    guard.setDirty(true);
    guard.onCloseRequested();
    guard.setDirty(false);
    expect(guard.onCloseRequested()).toBe('close');
  });
});
