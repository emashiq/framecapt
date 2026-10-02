/**
 * Waits for `work`, but not longer than `capMs`: 'done' when it settled in time (even if it
 * failed: the caller only needs to know it is over), 'timeout' otherwise. The work keeps running
 * after a timeout; the caller decides what to do about it.
 */
export async function settleWithin(
  work: Promise<unknown>,
  capMs: number,
): Promise<'done' | 'timeout'> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<'timeout'>((resolve) => {
    timer = setTimeout(() => resolve('timeout'), capMs);
  });
  try {
    return await Promise.race([
      work.then(
        () => 'done' as const,
        () => 'done' as const,
      ),
      timeout,
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
