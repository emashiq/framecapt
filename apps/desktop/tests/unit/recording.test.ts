import { describe, expect, it } from 'vitest';
import {
  AUDIO_BITRATE,
  defaultRecordingFileName,
  fitWithin,
  floorEven,
  formatBytes,
  formatDuration,
  MAX_1080P,
  nearestEven,
  qualityLimit,
  videoBitrate,
  withCollisionSuffix,
} from '../../src/shared/recording';

describe('fitWithin (1080p preset sizing)', () => {
  it('fits a 3440x1440 ultrawide into 1920 wide, even sides, aspect kept', () => {
    const out = fitWithin({ width: 3440, height: 1440 }, MAX_1080P);
    expect(out).toEqual({ width: 1920, height: 804 });
    expect(out.width % 2).toBe(0);
    expect(out.height % 2).toBe(0);
    // aspect within one pixel of the source
    expect(Math.abs(out.height - (1440 * 1920) / 3440)).toBeLessThan(1);
  });

  it('fits 2560x1440 (16:9) exactly into 1920x1080', () => {
    expect(fitWithin({ width: 2560, height: 1440 }, MAX_1080P)).toEqual({
      width: 1920,
      height: 1080,
    });
  });

  it('fits 3840x2160 and portrait sources', () => {
    expect(fitWithin({ width: 3840, height: 2160 }, MAX_1080P)).toEqual({
      width: 1920,
      height: 1080,
    });
    expect(fitWithin({ width: 1440, height: 2560 }, MAX_1080P)).toEqual({
      width: 608,
      height: 1080,
    });
  });

  it('never upscales: a source inside the limit keeps its size (rounded down to even)', () => {
    expect(fitWithin({ width: 1280, height: 720 }, MAX_1080P)).toEqual({
      width: 1280,
      height: 720,
    });
    expect(fitWithin({ width: 641, height: 433 }, MAX_1080P)).toEqual({ width: 640, height: 432 });
  });

  it('"source" keeps the full size with even sides', () => {
    expect(fitWithin({ width: 3440, height: 1440 }, null)).toEqual({ width: 3440, height: 1440 });
    expect(fitWithin({ width: 3439, height: 1441 }, null)).toEqual({ width: 3438, height: 1440 });
  });

  it('always returns even, positive sides within the limit for many sizes', () => {
    for (let w = 100; w < 5000; w += 137) {
      for (let h = 100; h < 3000; h += 211) {
        const out = fitWithin({ width: w, height: h }, MAX_1080P);
        expect(out.width % 2).toBe(0);
        expect(out.height % 2).toBe(0);
        expect(out.width).toBeGreaterThan(0);
        expect(out.width).toBeLessThanOrEqual(1920);
        expect(out.height).toBeLessThanOrEqual(1080);
      }
    }
  });

  it('even helpers', () => {
    expect(nearestEven(803.7)).toBe(804);
    expect(nearestEven(0.2)).toBe(2);
    expect(floorEven(803.9)).toBe(802);
    expect(floorEven(1)).toBe(2);
  });

  it('maps the quality preset to a limit', () => {
    expect(qualityLimit('1080p')).toEqual({ width: 1920, height: 1080 });
    expect(qualityLimit('source')).toBeNull();
  });
});

describe('videoBitrate', () => {
  it('is 8 Mbps for 1080p30 and scales with pixels and frame rate within bounds', () => {
    expect(videoBitrate({ width: 1920, height: 1080 }, 30)).toBe(8_000_000);
    expect(videoBitrate({ width: 1920, height: 1080 }, 60)).toBe(16_000_000);
    expect(videoBitrate({ width: 3440, height: 1440 }, 30)).toBeGreaterThan(8_000_000);
    expect(videoBitrate({ width: 320, height: 240 }, 30)).toBe(2_500_000);
    expect(videoBitrate({ width: 7680, height: 4320 }, 60)).toBe(30_000_000);
    expect(AUDIO_BITRATE).toBe(128_000);
  });
});

describe('formatDuration', () => {
  it('uses mm:ss and h:mm:ss after one hour', () => {
    expect(formatDuration(0)).toBe('00:00');
    expect(formatDuration(999)).toBe('00:00');
    expect(formatDuration(65_000)).toBe('01:05');
    expect(formatDuration(3_599_999)).toBe('59:59');
    expect(formatDuration(3_600_000)).toBe('1:00:00');
    expect(formatDuration(3_723_000)).toBe('1:02:03');
    expect(formatDuration(-5)).toBe('00:00');
  });
});

describe('output file names', () => {
  it('formats "FrameCapt YYYY-MM-DD at HH.mm.ss.webm" in local time', () => {
    expect(defaultRecordingFileName(new Date(2026, 9, 2, 14, 5, 9))).toBe(
      'FrameCapt 2026-10-02 at 14.05.09.webm',
    );
    expect(defaultRecordingFileName(new Date(2026, 0, 3, 0, 0, 0), 'mp4')).toBe(
      'FrameCapt 2026-01-03 at 00.00.00.mp4',
    );
  });

  it('never contains characters Windows forbids in a file name', () => {
    expect(defaultRecordingFileName(new Date(2026, 11, 31, 23, 59, 59))).not.toMatch(
      /[<>:"/\\|?*]/,
    );
  });

  it('adds a collision suffix before the extension', () => {
    const name = 'FrameCapt 2026-10-02 at 14.05.09.webm';
    expect(withCollisionSuffix(name, 0)).toBe(name);
    expect(withCollisionSuffix(name, 1)).toBe('FrameCapt 2026-10-02 at 14.05.09 (2).webm');
    expect(withCollisionSuffix(name, 2)).toBe('FrameCapt 2026-10-02 at 14.05.09 (3).webm');
    expect(withCollisionSuffix('noext', 1)).toBe('noext (2)');
  });
});

describe('formatBytes', () => {
  it('uses KB, MB, GB', () => {
    expect(formatBytes(512)).toBe('512 B');
    expect(formatBytes(2048)).toBe('2.0 KB');
    expect(formatBytes(5 * 1024 * 1024)).toBe('5.0 MB');
    expect(formatBytes(250 * 1024 * 1024)).toBe('250 MB');
    expect(formatBytes(3 * 1024 ** 3)).toBe('3.0 GB');
  });
});
