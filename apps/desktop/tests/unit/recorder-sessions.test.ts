import { describe, expect, it } from 'vitest';
import type { RecorderStatus } from '../../src/shared/recorder-machine';
import {
  MAX_CONCURRENT_RECORDINGS,
  allocateCamera,
  allocateSystemAudio,
  canStart,
  primaryOf,
} from '../../src/shared/recorder-sessions';

const s = <T extends Record<string, unknown> = Record<string, never>>(
  status: RecorderStatus,
  extra: T = {} as T,
) => ({ status, ...extra });

describe('canStart', () => {
  it('allows the first recording and up to the cap', () => {
    expect(MAX_CONCURRENT_RECORDINGS).toBe(3);
    expect(canStart([])).toBe(true);
    expect(canStart([s('recording')])).toBe(true);
    expect(canStart([s('recording'), s('paused')])).toBe(true);
    expect(canStart([s('recording'), s('paused'), s('recording')])).toBe(false);
  });

  it('refuses while another recording is in start-up', () => {
    for (const status of ['selecting', 'preflight', 'countdown', 'starting'] as const) {
      expect(canStart([s(status)])).toBe(false);
      expect(canStart([s('recording'), s(status)])).toBe(false);
    }
  });

  it('finishing ones take a slot; finished and idle ones do not', () => {
    expect(canStart([s('recording'), s('processing'), s('stopping')])).toBe(false);
    expect(canStart([s('recording'), s('completed'), s('error'), s('idle')])).toBe(true);
  });
});

describe('primaryOf', () => {
  it('is undefined without sessions', () => {
    expect(primaryOf([])).toBeUndefined();
  });

  it('prefers the start-up session, then the newest live, then finishing, then a result', () => {
    const a = s('recording', { id: 'a' });
    const b = s('paused', { id: 'b' });
    const c = s('processing', { id: 'c' });
    const d = s('completed', { id: 'd' });
    const e = s('selecting', { id: 'e' });
    expect(primaryOf([a, b, c, d, e])).toBe(e);
    expect(primaryOf([a, b, c, d])).toBe(b);
    expect(primaryOf([c, d])).toBe(c);
    expect(primaryOf([d, s('error', { id: 'f' })])).toMatchObject({ id: 'f' });
    expect(primaryOf([s('idle')])).toBeUndefined();
  });
});

describe('allocateSystemAudio', () => {
  it('the first recording that asks keeps it', () => {
    expect(allocateSystemAudio([], true)).toEqual({ systemAudio: true, dropped: false });
    expect(allocateSystemAudio([], false)).toEqual({ systemAudio: false, dropped: false });
  });

  it('a later one asking while it is held gets it dropped', () => {
    const held = [s('recording', { systemAudio: true })];
    expect(allocateSystemAudio(held, true)).toEqual({ systemAudio: false, dropped: true });
    expect(allocateSystemAudio(held, false)).toEqual({ systemAudio: false, dropped: false });
  });

  it('is free again once the holder is done or never had it', () => {
    expect(allocateSystemAudio([s('completed', { systemAudio: true })], true).systemAudio).toBe(
      true,
    );
    expect(allocateSystemAudio([s('recording', { systemAudio: false })], true).systemAudio).toBe(
      true,
    );
    // a holder that is still saving keeps the loopback until its engine is released
    expect(allocateSystemAudio([s('processing', { systemAudio: true })], true).dropped).toBe(true);
  });
});

describe('allocateCamera', () => {
  it('has one owner', () => {
    expect(allocateCamera([s('recording', { camera: true })], true)).toEqual({
      camera: false,
      dropped: true,
    });
    expect(allocateCamera([s('recording', { camera: false })], true).camera).toBe(true);
    expect(allocateCamera([], true).dropped).toBe(false);
  });
});
