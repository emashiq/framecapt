import { describe, expect, it } from 'vitest';
import { mediaContentType, parseRange, planMediaSlice } from '../../src/main/recording/range';

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
  it('maps the containers FrameCapt produces', () => {
    expect(mediaContentType('C:\\x\\a.webm')).toBe('video/webm');
    expect(mediaContentType('a.WEBM')).toBe('video/webm');
    expect(mediaContentType('a.mp4')).toBe('video/mp4');
    expect(mediaContentType('a.mkv')).toBe('video/x-matroska');
    expect(mediaContentType('a.fcap')).toBe('video/webm'); // served as its WebM payload
    expect(mediaContentType('a.GIF')).toBe('image/gif');
    expect(mediaContentType('a.bin')).toBe('application/octet-stream');
    expect(mediaContentType('noext')).toBe('application/octet-stream');
  });
});

describe('planMediaSlice', () => {
  it('without a window it is the file: the same ranges parseRange gives, no shift', () => {
    expect(planMediaSlice(null, 1000)).toEqual({
      status: 200,
      start: 0,
      end: 999,
      length: 1000,
      contentRange: null,
    });
    expect(planMediaSlice('bytes=10-19', 1000)).toEqual({
      status: 206,
      start: 10,
      end: 19,
      length: 10,
      contentRange: 'bytes 10-19/1000',
    });
    expect(planMediaSlice('bytes=1000-', 1000)).toEqual({
      status: 416,
      contentRange: 'bytes */1000',
    });
  });

  it('a payload window: ranges are in the payload own bytes and read from the shifted file offsets', () => {
    // A 5000-byte payload at offset 4096 (so the file is 9096 bytes).
    const payload = { offset: 4096, length: 5000 };
    expect(planMediaSlice(null, 9096, payload)).toEqual({
      status: 200,
      start: 4096,
      end: 9095,
      length: 5000,
      contentRange: null,
    });
    expect(planMediaSlice('bytes=0-99', 9096, payload)).toEqual({
      status: 206,
      start: 4096,
      end: 4195,
      length: 100,
      contentRange: 'bytes 0-99/5000',
    });
    expect(planMediaSlice('bytes=4900-', 9096, payload)).toEqual({
      status: 206,
      start: 8996,
      end: 9095,
      length: 100,
      contentRange: 'bytes 4900-4999/5000',
    });
  });

  it('a suffix range counts from the end of the payload, not of the file', () => {
    const payload = { offset: 4096, length: 5000 };
    expect(planMediaSlice('bytes=-100', 9096, payload)).toEqual({
      status: 206,
      start: 8996,
      end: 9095,
      length: 100,
      contentRange: 'bytes 4900-4999/5000',
    });
    // Larger than the payload: all of the payload, never the header.
    expect(planMediaSlice('bytes=-99999', 9096, payload)).toMatchObject({
      status: 206,
      start: 4096,
      end: 9095,
      contentRange: 'bytes 0-4999/5000',
    });
  });

  it('an end past the payload is clamped; a start past it is 416 with the payload length', () => {
    const payload = { offset: 4096, length: 5000 };
    expect(planMediaSlice('bytes=4990-999999', 9096, payload)).toMatchObject({
      start: 9086,
      end: 9095,
      contentRange: 'bytes 4990-4999/5000',
    });
    expect(planMediaSlice('bytes=5000-', 9096, payload)).toEqual({
      status: 416,
      contentRange: 'bytes */5000',
    });
    expect(planMediaSlice('bytes=-0', 9096, payload)).toEqual({
      status: 416,
      contentRange: 'bytes */5000',
    });
  });
});
