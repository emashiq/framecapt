import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import type { AppOriginConfig } from '../../src/main/app-origin';
import { checkSender, fail, IpcError, ok, runChannel } from '../../src/main/ipc-core';
import type { ChannelDef } from '../../src/shared/ipc-contract';

const origin: AppOriginConfig = {};
const goodUrl = 'app://framecapt/index.html';
const trusted = { role: 'main', frameUrl: goodUrl, isTopFrame: true } as const;

describe('checkSender', () => {
  it('accepts a registered role on the app origin in the top frame', () => {
    expect(checkSender(trusted, ['main'], origin)).toBeNull();
  });

  it('rejects unregistered senders and roles not allowed for the channel', () => {
    expect(checkSender({ ...trusted, role: undefined }, ['main'], origin)?.error.code).toBe(
      'FORBIDDEN',
    );
    expect(checkSender({ ...trusted, role: 'overlay' }, ['main'], origin)?.error.code).toBe(
      'FORBIDDEN',
    );
    expect(checkSender(trusted, [], origin)?.error.code).toBe('FORBIDDEN');
  });

  it('rejects subframes and foreign or missing frame URLs', () => {
    expect(checkSender({ ...trusted, isTopFrame: false }, ['main'], origin)?.ok).toBe(false);
    for (const frameUrl of [
      'http://evil.example/',
      'about:blank',
      'file:///C:/other/index.html',
      'app://evil/index.html',
      undefined,
    ]) {
      expect(checkSender({ ...trusted, frameUrl }, ['main'], origin)?.ok).toBe(false);
    }
  });
});

describe('runChannel', () => {
  const def = {
    request: z.object({ n: z.number() }),
    response: z.number(),
    roles: ['main'],
  } satisfies ChannelDef;
  const noop = (): void => undefined;

  it('wraps handler output as { ok: true, data }', async () => {
    const result = await runChannel(def, { n: 2 }, (p) => (p as { n: number }).n * 2, noop);
    expect(result).toEqual({ ok: true, data: 4 });
    expect(ok(1)).toEqual({ ok: true, data: 1 });
  });

  it('awaits async handlers', async () => {
    const result = await runChannel(def, { n: 1 }, async () => 7, noop);
    expect(result).toEqual({ ok: true, data: 7 });
  });

  it('rejects invalid payloads without calling the handler', async () => {
    const handler = vi.fn();
    const result = await runChannel(def, { n: 'x' }, handler, noop);
    expect(result).toMatchObject({ ok: false, error: { code: 'INVALID_PAYLOAD' } });
    expect(handler).not.toHaveBeenCalled();
    expect((await runChannel(def, undefined, handler, noop)).ok).toBe(false);
  });

  it('never leaks raw error details', async () => {
    const onInternalError = vi.fn();
    const result = await runChannel(
      def,
      { n: 1 },
      () => {
        throw new Error('secret path C:\\Users\\someone');
      },
      onInternalError,
    );
    expect(result).toEqual({
      ok: false,
      error: { code: 'INTERNAL', message: 'Something went wrong.' },
    });
    expect(JSON.stringify(result)).not.toContain('secret');
    expect(onInternalError).toHaveBeenCalledTimes(1);
  });

  it('passes IpcError codes through', async () => {
    const result = await runChannel(
      def,
      { n: 1 },
      () => {
        throw new IpcError('FORBIDDEN', 'Nope.');
      },
      noop,
    );
    expect(result).toEqual(fail('FORBIDDEN', 'Nope.'));
  });
});
