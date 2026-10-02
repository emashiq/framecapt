import { afterEach, describe, expect, it, vi } from 'vitest';
import { settleWithin } from '../../src/main/recorder/quit-cap';

afterEach(() => vi.useRealTimers());

describe('settleWithin (the quit cap)', () => {
  it('done when the work finishes before the cap', async () => {
    vi.useFakeTimers();
    const result = settleWithin(new Promise((resolve) => setTimeout(resolve, 1000)), 15_000);
    await vi.advanceTimersByTimeAsync(1000);
    await expect(result).resolves.toBe('done');
    expect(vi.getTimerCount()).toBe(0); // the cap timer is cleared
  });

  it('timeout when the work is still running at the cap; the work is not cancelled by it', async () => {
    vi.useFakeTimers();
    let finished = false;
    const work = new Promise<void>((resolve) =>
      setTimeout(() => {
        finished = true;
        resolve();
      }, 60_000),
    );
    const result = settleWithin(work, 15_000);
    await vi.advanceTimersByTimeAsync(15_000);
    await expect(result).resolves.toBe('timeout');
    expect(finished).toBe(false);
  });

  it('failed work still counts as over (the caller only needs to know it is no longer running)', async () => {
    await expect(settleWithin(Promise.reject(new Error('x')), 1000)).resolves.toBe('done');
  });
});
