import { describe, expect, it } from 'vitest';
import {
  DEFAULT_PREFERENCE,
  pickDefaultFormat,
  RECORDER_CANDIDATES,
} from '../../src/shared/recorder-formats';

const none = Object.fromEntries(RECORDER_CANDIDATES.map((mime) => [mime, false]));

describe('pickDefaultFormat', () => {
  it('prefers VP9, then VP8, then H.264 in WebM', () => {
    const all = Object.fromEntries(RECORDER_CANDIDATES.map((mime) => [mime, true]));
    expect(pickDefaultFormat(all)).toBe('video/webm;codecs=vp9,opus');
    expect(pickDefaultFormat({ ...all, 'video/webm;codecs=vp9,opus': false })).toBe(
      'video/webm;codecs=vp8,opus',
    );
    expect(
      pickDefaultFormat({
        ...none,
        'video/webm;codecs=h264,opus': true,
        'video/mp4;codecs=avc1,mp4a.40.2': true,
      }),
    ).toBe('video/webm;codecs=h264,opus');
  });

  it('never defaults to mp4, mkv or av1 and returns null when nothing preferred is supported', () => {
    expect(
      pickDefaultFormat({
        ...none,
        'video/mp4;codecs=avc1,mp4a.40.2': true,
        'video/x-matroska;codecs=avc1,opus': true,
        'video/webm;codecs=av1,opus': true,
      }),
    ).toBeNull();
    expect(pickDefaultFormat({})).toBeNull();
  });

  it('only prefers candidates that are probed', () => {
    for (const mime of DEFAULT_PREFERENCE) expect(RECORDER_CANDIDATES).toContain(mime);
  });
});
