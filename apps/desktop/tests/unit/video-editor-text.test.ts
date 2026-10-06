import { describe, expect, it } from 'vitest';
import { clipSpecs } from '../../src/renderer/views/video-editor/clip-spec';
import { fontOf, wrapLines } from '../../src/renderer/views/video-editor/text-layout';
import { newAudio, newImage, newText } from '../../src/shared/video-edit';

/** A context whose every character is 10 px wide. */
const ctx = { measureText: (text: string) => ({ width: text.length * 10 }) };
const wrap = (text: string, width: number): string[] => wrapLines(ctx as never, text, width);

describe('wrapLines', () => {
  it('keeps what fits on one line and honours the new lines of the text', () => {
    expect(wrap('hello world', 500)).toEqual(['hello world']);
    expect(wrap('one\ntwo\r\nthree', 500)).toEqual(['one', 'two', 'three']);
    expect(wrap('a\n\nb', 500)).toEqual(['a', '', 'b']);
  });

  it('breaks at spaces when a line is too wide', () => {
    expect(wrap('aaa bbb ccc', 70)).toEqual(['aaa bbb', 'ccc']);
    expect(wrap('aaa bbb ccc', 30)).toEqual(['aaa', 'bbb', 'ccc']);
  });

  it('breaks a word that is wider than the box between characters', () => {
    expect(wrap('abcdefghij', 40)).toEqual(['abcd', 'efgh', 'ij']);
    expect(wrap('x', 5)).toEqual(['x']);
  });
});

describe('text fonts', () => {
  it('describes the font in source pixels with the weight and style', () => {
    const text = { ...newText('t', { x: 0, y: 0, width: 100, height: 40 }, 0, 1000), size: 48 };
    expect(fontOf({ ...text, weight: 700, italic: true, font: 'georgia' })).toBe(
      "italic 700 48px Georgia, 'Times New Roman', serif",
    );
    expect(fontOf({ ...text, weight: 400, italic: false, font: 'inter' })).toContain(
      "400 48px 'Inter Variable'",
    );
  });
});

describe('the audio clips of the preview', () => {
  it('lists only the clips that are not muted, with the route of their asset', () => {
    const asset = 'a'.repeat(64);
    const loud = {
      ...newAudio('a1', { assetId: asset, ext: 'wav', name: 'x', clipMs: 4000 }, 1000),
      volume: 1.5,
    };
    const muted = {
      ...newAudio('a2', { assetId: asset, ext: 'mp3', name: 'y', clipMs: 1000 }, 0),
      muted: true,
    };
    const picture = newImage('i1', asset, { x: 0, y: 0, width: 10, height: 10 }, 0, 1000);
    const specs = clipSpecs('11111111-1111-4111-8111-111111111111', [loud, muted, picture]);
    expect(specs).toEqual([
      {
        id: 'a1',
        url: `framecapt-media://vproject/11111111-1111-4111-8111-111111111111/${asset}.wav`,
        startMs: 1000,
        endMs: 5000,
        inMs: 0,
        volume: 1.5,
        fadeInMs: 0,
        fadeOutMs: 0,
      },
    ]);
  });
});
