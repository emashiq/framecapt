import { describe, expect, it } from 'vitest';
import { parseFrameRate, parseProbe } from '../../src/main/media/ffmpeg';
import { MediaRegistry, resolveMediaUrl } from '../../src/main/recording/media-protocol';
import { mediaContentType, parseRange } from '../../src/main/recording/range';
import { assetUrl } from '../../src/renderer/views/video-editor/clip-spec';

const ID = '44444444-4444-4444-8444-444444444444';
const ASSET = 'f'.repeat(64);
const seen: string[] = [];
const history = {
  thumbPathOf: () => undefined,
  filePathOf: () => undefined,
  videoAssetPathOf: (id: string, name: string) => {
    seen.push(`${id}/${name}`);
    return id === ID && name === `${ASSET}.mp3` ? 'C:/data/video-projects/a.mp3' : undefined;
  },
};

describe('framecapt-media: video project assets', () => {
  const registry = new MediaRegistry();
  const resolve = (url: string) => resolveMediaUrl(new URL(url), registry, history);

  it('serves //vproject/<history id>/<sha256>.<ext> through the history lookup', () => {
    expect(resolve(`framecapt-media://vproject/${ID}/${ASSET}.mp3`)).toBe(
      'C:/data/video-projects/a.mp3',
    );
    expect(resolve(assetUrl(ID, ASSET, 'mp3'))).toBe('C:/data/video-projects/a.mp3');
  });

  it('serves nothing else on that host: other names, other ids, extra segments, queries', () => {
    const other = '55555555-5555-4555-8555-555555555555';
    for (const url of [
      `framecapt-media://vproject/${other}/${ASSET}.mp3`,
      `framecapt-media://vproject/${ID}/${ASSET}.wav`,
      `framecapt-media://vproject/${ID}/${ASSET}`,
      `framecapt-media://vproject/${ID}/${ASSET.toUpperCase()}.mp3`,
      `framecapt-media://vproject/${ID}/${ASSET.slice(1)}.mp3`,
      `framecapt-media://vproject/${ID}/..%2F${ASSET}.mp3`,
      `framecapt-media://vproject/${ID}/x/${ASSET}.mp3`,
      `framecapt-media://vproject/${ID}/${ASSET}.mp3/extra`,
      `framecapt-media://vproject/${ID}/${ASSET}.mp3?x=1`,
      `framecapt-media://vproject/${ID}/${ASSET}.mp3#t=1`,
      `framecapt-media://vproject/${ID}`,
      'framecapt-media://vproject/',
      'framecapt-media://vproject',
      `framecapt-media://user@vproject/${ID}/${ASSET}.mp3`,
    ]) {
      expect(resolve(url), url).toBeUndefined();
    }
  });

  it('has no such route without a history lookup for it', () => {
    const url = new URL(`framecapt-media://vproject/${ID}/${ASSET}.mp3`);
    expect(
      resolveMediaUrl(url, registry, { thumbPathOf: () => undefined, filePathOf: () => undefined }),
    ).toBeUndefined();
    expect(resolveMediaUrl(url, registry)).toBeUndefined();
  });

  it('serves the audio and picture types with the right content type, and ranges work', () => {
    expect(mediaContentType('x.mp3')).toBe('audio/mpeg');
    expect(mediaContentType('x.WAV')).toBe('audio/wav');
    expect(mediaContentType('x.m4a')).toBe('audio/mp4');
    expect(mediaContentType('x.opus')).toBe('audio/ogg');
    expect(mediaContentType('x.flac')).toBe('audio/flac');
    expect(mediaContentType('x.png')).toBe('image/png');
    expect(parseRange('bytes=100-', 1000)).toEqual({ start: 100, end: 999 });
  });
});

describe('the frame rate of a probed file', () => {
  it('accepts 10 to 120 fps and rounds to two places', () => {
    expect(parseFrameRate('30/1')).toBe(30);
    expect(parseFrameRate('60/1')).toBe(60);
    expect(parseFrameRate('30000/1001')).toBe(29.97);
    expect(parseFrameRate('10/1')).toBe(10);
    expect(parseFrameRate('120/1')).toBe(120);
  });

  it('refuses the 1000 fps timebase, nonsense and anything outside the range', () => {
    for (const bad of [
      '1000/1',
      '0/0',
      '5/1',
      '240/1',
      '121/1',
      'N/A',
      '',
      '30',
      '30/0',
      '-30/1',
      undefined,
    ]) {
      expect(parseFrameRate(bad), String(bad)).toBeUndefined();
    }
  });

  it('is part of the probe result only when believable', () => {
    const probe = (rate: string | undefined) =>
      parseProbe({
        streams: [
          { codec_type: 'video', codec_name: 'vp9', width: 10, height: 10, r_frame_rate: rate },
        ],
        format: { format_name: 'matroska,webm', duration: '2.0' },
      });
    expect(probe('60/1').frameRate).toBe(60);
    expect(probe('1000/1')).not.toHaveProperty('frameRate');
    expect(probe(undefined)).not.toHaveProperty('frameRate');
  });
});
