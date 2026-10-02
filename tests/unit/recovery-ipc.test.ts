import { describe, expect, it } from 'vitest';
import { RecoverResponseSchema, RecoverySessionIdSchema } from '../../src/shared/recovery-ipc';

describe('recovery IPC schemas', () => {
  const ok = '0f0e0d0c-0b0a-4908-8706-050403020100';

  it('only plain session uuids are accepted (no paths, no traversal)', () => {
    expect(RecoverySessionIdSchema.safeParse({ sessionId: ok }).success).toBe(true);
    const bad = ['', '../x', `${ok}/..`, 'C:/Windows', ok.toUpperCase(), `${ok} `, ok.slice(1)];
    for (const sessionId of bad) {
      expect(RecoverySessionIdSchema.safeParse({ sessionId }).success, sessionId).toBe(false);
    }
  });

  it('extra keys (a path smuggled in by a renderer) are rejected', () => {
    expect(RecoverySessionIdSchema.safeParse({ sessionId: ok, path: 'C:/x' }).success).toBe(false);
  });

  it('a recover response is either recovered (with a result id) or unrecoverable (with where it was kept)', () => {
    const recovered = {
      outcome: 'recovered',
      resultId: 'r',
      fileName: 'f.webm',
      path: 'C:/f.webm',
      durationMs: 1,
      bytes: 2,
    };
    expect(RecoverResponseSchema.safeParse(recovered).success).toBe(true);
    expect(
      RecoverResponseSchema.safeParse({ outcome: 'unrecoverable', keptAt: 'C:/x' }).success,
    ).toBe(true);
    expect(RecoverResponseSchema.safeParse({ outcome: 'recovered' }).success).toBe(false);
  });
});
