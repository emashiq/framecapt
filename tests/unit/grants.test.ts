import { describe, expect, it } from 'vitest';
import { GrantStore } from '../../src/main/capture/grants';

function setup(ttlMs = 5000) {
  let now = 1_000_000;
  const store = new GrantStore(() => now, ttlMs);
  return {
    store,
    advance: (ms: number) => {
      now += ms;
    },
  };
}

const input = (webContentsId: number, sourceId = 'screen:0:0') => ({
  sourceId,
  sourceName: 'Screen 1',
  systemAudio: false,
  webContentsId,
});

describe('GrantStore', () => {
  it('lets the owning webContents consume a grant exactly once', () => {
    const { store } = setup();
    const grant = store.create(input(1));
    expect(store.consume(1)).toEqual({ ok: true, grant });
    expect(store.consume(1)).toEqual({ ok: false, reason: 'no-grant' });
  });

  it('refuses another webContents and keeps the grant for its owner', () => {
    const { store } = setup();
    store.create(input(1));
    expect(store.consume(2)).toEqual({ ok: false, reason: 'other-webcontents' });
    expect(store.consume(1).ok).toBe(true);
  });

  it('expires grants after the TTL', () => {
    const { store, advance } = setup(5000);
    store.create(input(1));
    advance(4999);
    expect(store.size).toBe(1);
    advance(2);
    expect(store.size).toBe(0);
    expect(store.consume(1)).toEqual({ ok: false, reason: 'no-grant' });
  });

  it('reports an expired grant that was not yet pruned', () => {
    const { store, advance } = setup(5000);
    store.create(input(1));
    advance(6000);
    expect(store.consume(1)).toEqual({ ok: false, reason: 'expired' });
  });

  it('a new grant replaces the previous one of the same webContents', () => {
    const { store } = setup();
    store.create(input(1, 'screen:0:0'));
    const latest = store.create(input(1, 'screen:4:0'));
    expect(store.size).toBe(1);
    expect(store.consume(1)).toEqual({ ok: true, grant: latest });
  });

  it('has no grant to consume before any was created', () => {
    expect(setup().store.consume(1)).toEqual({ ok: false, reason: 'no-grant' });
  });

  it('clearFor drops the grants of a webContents', () => {
    const { store } = setup();
    store.create(input(1));
    store.clearFor(1);
    expect(store.size).toBe(0);
  });
});
