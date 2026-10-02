import { describe, expect, it } from 'vitest';
import { mediaContentType, parseRange } from '../../src/main/recording/range';

describe('parseRange', () => {
  it('serves the whole file without a header', () => {
    expect(parseRange(null, 1000)).toBeNull();
    expect(parseRange('', 1000)).toBeNull();
  });

  it('parses start-end, open ended and suffix ranges (inclusive)', () => {
    expect(parseRange('bytes=0-99', 1000)).toEqual({ start: 0, end: 99 });
    expect(parseRange('bytes=500-', 1000)).toEqual({ start: 500, end: 999 });
    expect(parseRange('bytes=-100', 1000)).toEqual({ start: 900, end: 999 });
    expect(parseRange('bytes=-5000', 1000)).toEqual({ start: 0, end: 999 });
  });

  it('clamps an end past the file', () => {
    expect(parseRange('bytes=990-5000', 1000)).toEqual({ start: 990, end: 999 });
  });

  it('is unsatisfiable when it starts past the end, is backwards, or the file is empty', () => {
    expect(parseRange('bytes=1000-', 1000)).toBe('unsatisfiable');
    expect(parseRange('bytes=900-100', 1000)).toBe('unsatisfiable');
    expect(parseRange('bytes=0-10', 0)).toBe('unsatisfiable');
    expect(parseRange('bytes=-0', 1000)).toBe('unsatisfiable');
  });

  it('ignores headers it does not understand (multi-range, other units, garbage)', () => {
    expect(parseRange('bytes=0-10,20-30', 1000)).toBeNull();
    expect(parseRange('items=0-10', 1000)).toBeNull();
    expect(parseRange('bytes=-', 1000)).toBeNull();
    expect(parseRange('bytes=a-b', 1000)).toBeNull();
  });
});

describe('mediaContentType', () => {
  it('maps the containers Framelet produces', () => {
    expect(mediaContentType('C:\\x\\a.webm')).toBe('video/webm');
    expect(mediaContentType('a.WEBM')).toBe('video/webm');
    expect(mediaContentType('a.mp4')).toBe('video/mp4');
    expect(mediaContentType('a.bin')).toBe('application/octet-stream');
    expect(mediaContentType('noext')).toBe('application/octet-stream');
  });
});
