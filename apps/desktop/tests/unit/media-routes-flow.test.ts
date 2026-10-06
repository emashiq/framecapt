import { describe, expect, it } from 'vitest';
import { MediaRegistry, resolveMediaUrl } from '../../src/main/recording/media-protocol';

const ID = '44444444-4444-4444-8444-444444444444';
const GUIDE = '66666666-6666-4666-8666-666666666666';
const history = {
  thumbPathOf: (id: string) => (id === ID ? 'C:/data/thumbs/t.png' : undefined),
  filePathOf: (id: string) => (id === ID ? 'C:/caps/shot.png' : undefined),
};

describe('framecapt-media flowstep route (step guide pictures)', () => {
  const calls: [string, number][] = [];
  const guides = {
    ...history,
    flowStepPathOf: (id: string, index: number) => {
      calls.push([id, index]);
      if (id !== GUIDE) return undefined;
      return ['C:/caps/FrameCapt Steps 1/step-01.png', 'C:/caps/FrameCapt Steps 1/step-02.png'][
        index
      ];
    },
  };
  const registry = new MediaRegistry();
  const resolve = (url: string, source: typeof guides | typeof history | undefined = guides) =>
    resolveMediaUrl(new URL(url), registry, source);

  it('serves one step image by guide id and index, with an optional nonce', () => {
    expect(resolve(`framecapt-media://flowstep/${GUIDE}/1`)).toBe(
      'C:/caps/FrameCapt Steps 1/step-02.png',
    );
    expect(resolve(`framecapt-media://flowstep/${GUIDE}/0/k3j9x0ab`)).toBe(
      'C:/caps/FrameCapt Steps 1/step-01.png',
    );
  });

  it('serves nothing for an unknown guide, a missing step or a source without the route', () => {
    expect(resolve(`framecapt-media://flowstep/${GUIDE}/2`)).toBeUndefined();
    expect(resolve(`framecapt-media://flowstep/${ID}/0`)).toBeUndefined();
    expect(resolve(`framecapt-media://flowstep/${GUIDE}/0`, history)).toBeUndefined();
    expect(
      resolveMediaUrl(new URL(`framecapt-media://flowstep/${GUIDE}/0`), registry),
    ).toBeUndefined();
  });

  it('rejects every other shape before asking anyone', () => {
    calls.length = 0;
    for (const bad of [
      `framecapt-media://flowstep/${GUIDE}`,
      `framecapt-media://flowstep/${GUIDE}/`,
      `framecapt-media://flowstep/${GUIDE}/-1`,
      `framecapt-media://flowstep/${GUIDE}/1000`,
      `framecapt-media://flowstep/${GUIDE}/01x`,
      `framecapt-media://flowstep/${GUIDE}/0/UPPER`,
      `framecapt-media://flowstep/${GUIDE}/0/a/b`,
      `framecapt-media://flowstep/${GUIDE}/%2E%2E%2Fflow.json`,
      'framecapt-media://flowstep/%2E%2E%2Fsecret/0',
      `framecapt-media://flowstep/${GUIDE}/0?x=1`,
      `framecapt-media://flowstep/${GUIDE}/0#frag`,
      `framecapt-media://user@flowstep/${GUIDE}/0`,
      `framecapt-media://flowstep:80/${GUIDE}/0`,
      'framecapt-media://flowstep/',
      'framecapt-media://flowstep',
    ]) {
      expect(resolve(bad), bad).toBeUndefined();
    }
    expect(calls).toEqual([]);
  });

  it('only ever serves PNG: a source that names anything else is refused', () => {
    const odd = { ...history, flowStepPathOf: () => 'C:/caps/flow.json' };
    expect(resolve(`framecapt-media://flowstep/${GUIDE}/0`, odd)).toBeUndefined();
    const upper = { ...history, flowStepPathOf: () => 'C:/caps/STEP-01.PNG' };
    expect(resolve(`framecapt-media://flowstep/${GUIDE}/0`, upper)).toBe('C:/caps/STEP-01.PNG');
  });
});
