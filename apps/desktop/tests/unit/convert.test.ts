import { describe, expect, it } from 'vitest';
import {
  canConvert,
  convertArgs,
  detectEncoders,
  isRemux,
  verifyConvert,
  type ConvertSpec,
  type EncoderCapability,
} from '../../src/main/media/convert';
import type { ProbeResult } from '../../src/main/media/ffmpeg';
import {
  COMPRESSION_LEVELS,
  SAVE_FORMATS,
  formatHint,
  isNoopConversion,
  needsFinalize,
} from '../../src/shared/recording-format';
import { ENCODERS_WITH_H264, fakeTools, PLAYABLE } from './fake-tools';

const IN = '/in.webm';
const OUT = '/out.partial.bin';

/** The value after `flag` (first occurrence). */
function after(args: string[], flag: string): string | undefined {
  return args[args.indexOf(flag) + 1];
}

/** The output muxer: the last `-f` (an earlier one forces the input demuxer). */
function muxer(args: string[]): string | undefined {
  return args[args.lastIndexOf('-f') + 1];
}

const spec = (
  format: ConvertSpec['format'],
  compression: ConvertSpec['compression'],
  maxWidth?: number,
) => ({ format, compression, ...(maxWidth !== undefined && { maxWidth }) }) as ConvertSpec;

describe('convertArgs: H.264 formats (MP4 and MKV)', () => {
  it.each([
    ['light', '23', '128k'],
    ['balanced', '28', '96k'],
    ['strong', '32', '64k'],
  ] as const)('%s: libx264 preset medium, crf %s, AAC %s', (compression, crf, audio) => {
    for (const format of ['mp4', 'mkv'] as const) {
      const args = convertArgs(spec(format, compression), IN, OUT, 'matroska');
      expect(after(args, '-c:v')).toBe('libx264');
      expect(after(args, '-preset')).toBe('medium');
      expect(after(args, '-crf')).toBe(crf);
      expect(after(args, '-pix_fmt')).toBe('yuv420p');
      expect(after(args, '-c:a')).toBe('aac');
      expect(after(args, '-b:a')).toBe(audio);
      expect(after(args, '-vf')).toBe('scale=trunc(iw/2)*2:trunc(ih/2)*2');
      expect(muxer(args)).toBe(format === 'mp4' ? 'mp4' : 'matroska');
      // Fast start only makes sense for MP4.
      expect(args.includes('+faststart')).toBe(format === 'mp4');
    }
  });

  it('MP4 without compression is a high-quality re-encode at crf 20 (MP4 needs H.264)', () => {
    const args = convertArgs(spec('mp4', 'off'), IN, OUT, 'matroska');
    expect(after(args, '-c:v')).toBe('libx264');
    expect(after(args, '-crf')).toBe('20');
    expect(after(args, '-b:a')).toBe('160k');
  });

  it('keeps the first video and the first audio stream (audio optional)', () => {
    const args = convertArgs(spec('mp4', 'balanced'), IN, OUT);
    expect(args.slice(args.indexOf('-map'), args.indexOf('-map') + 4)).toEqual([
      '-map',
      '0:v:0',
      '-map',
      '0:a:0?',
    ]);
  });
});

describe('convertArgs: WebM', () => {
  it.each([
    ['light', '33', '96k'],
    ['balanced', '38', '64k'],
    ['strong', '43', '48k'],
  ] as const)(
    '%s: libvpx-vp9 constant quality crf %s, row-mt, good/cpu-used 4, Opus %s',
    (compression, crf, audio) => {
      const args = convertArgs(spec('webm', compression), IN, OUT, 'matroska');
      expect(after(args, '-c:v')).toBe('libvpx-vp9');
      expect(after(args, '-b:v')).toBe('0');
      expect(after(args, '-crf')).toBe(crf);
      expect(after(args, '-row-mt')).toBe('1');
      expect(after(args, '-deadline')).toBe('good');
      expect(after(args, '-cpu-used')).toBe('4');
      expect(after(args, '-c:a')).toBe('libopus');
      expect(after(args, '-b:a')).toBe(audio);
      expect(muxer(args)).toBe('webm');
    },
  );

  it('WebM from another container without compression uses the light profile', () => {
    expect(after(convertArgs(spec('webm', 'off'), '/in.mp4', OUT), '-crf')).toBe('33');
  });
});

describe('convertArgs: MKV remux', () => {
  it('MKV without compression or a size change copies every stream (no re-encode)', () => {
    const args = convertArgs(spec('mkv', 'off'), IN, OUT, 'matroska');
    expect(isRemux(spec('mkv', 'off'))).toBe(true);
    expect(args.slice(args.indexOf('-map'), args.indexOf('-map') + 4)).toEqual([
      '-map',
      '0',
      '-c',
      'copy',
    ]);
    expect(args).not.toContain('-c:v');
    expect(muxer(args)).toBe('matroska');
  });

  it('a width cap or a compression level turns it into a re-encode', () => {
    expect(isRemux(spec('mkv', 'off', 1280))).toBe(false);
    expect(after(convertArgs(spec('mkv', 'off', 1280), IN, OUT), '-c:v')).toBe('libx264');
    expect(isRemux(spec('mkv', 'light'))).toBe(false);
    expect(isRemux(spec('mp4', 'off'))).toBe(false);
    expect(isRemux(spec('webm', 'off'))).toBe(false);
  });
});

describe('convertArgs: GIF', () => {
  it('is a palette GIF: 12 fps, at most 1280 wide, looping, no sound', () => {
    const args = convertArgs(spec('gif', 'off'), IN, OUT, 'matroska');
    const filter = after(args, '-vf') as string;
    expect(filter).toContain('fps=12');
    expect(filter).toContain('scale=min(1280\\,iw):-2');
    expect(filter).toContain('palettegen');
    expect(filter).toContain('paletteuse');
    expect(args).toContain('-an');
    expect(args).not.toContain('0:a:0?');
    expect(after(args, '-loop')).toBe('0');
    expect(muxer(args)).toBe('gif');
  });

  it('a smaller width cap applies, a larger one never exceeds 1280', () => {
    expect(after(convertArgs(spec('gif', 'off', 640), IN, OUT), '-vf')).toContain('min(640\\,iw)');
    expect(after(convertArgs(spec('gif', 'off', 1920), IN, OUT), '-vf')).toContain(
      'min(1280\\,iw)',
    );
  });
});

describe('convertArgs: width cap and safety', () => {
  it('caps the width, keeps the sides even and only shrinks', () => {
    expect(after(convertArgs(spec('mp4', 'light', 1280), IN, OUT), '-vf')).toBe(
      'scale=trunc(min(1280\\,iw)/2)*2:-2',
    );
  });

  it('is an argument array with the file protocol whitelist and absolute paths only', () => {
    const args = convertArgs(spec('mp4', 'balanced'), IN, OUT, 'matroska');
    expect(
      args.slice(args.indexOf('-protocol_whitelist'), args.indexOf('-protocol_whitelist') + 5),
    ).toEqual(['-protocol_whitelist', 'file', '-f', 'matroska', '-i']);
    expect(args.at(-1)).toBe(OUT);
    expect(() => convertArgs(spec('mp4', 'light'), 'relative.webm', OUT)).toThrow();
    expect(() => convertArgs(spec('mp4', 'light'), IN, '-out.mp4')).toThrow();
  });

  it('every format and level builds', () => {
    for (const format of SAVE_FORMATS) {
      for (const compression of COMPRESSION_LEVELS) {
        expect(convertArgs(spec(format, compression), IN, OUT).length).toBeGreaterThan(8);
      }
    }
  });
});

describe('verifyConvert', () => {
  const MP4: ProbeResult = {
    hasVideo: true,
    hasAudio: true,
    video: { width: 1280, height: 720, codec: 'h264', pixFmt: 'yuv420p' },
    audioCodec: 'aac',
    durationSec: 5.1,
    formatName: 'mov,mp4,m4a,3gp,3g2,mj2',
    sizeBytes: 1,
  };

  it('accepts a matching MP4 and WebM', () => {
    expect(verifyConvert(spec('mp4', 'balanced'), MP4, PLAYABLE)).toBeNull();
    expect(verifyConvert(spec('webm', 'light'), PLAYABLE, MP4)).toBeNull();
  });

  it('rejects the wrong container, codec, lost audio and a different length', () => {
    expect(verifyConvert(spec('webm', 'light'), MP4, PLAYABLE)).toMatch(/not a WEBM/);
    expect(
      verifyConvert(
        spec('mp4', 'light'),
        { ...MP4, video: { ...MP4.video!, codec: 'hevc' } },
        PLAYABLE,
      ),
    ).toMatch(/no video/);
    expect(
      verifyConvert(spec('mp4', 'light'), { ...MP4, hasAudio: false, audioCodec: null }, PLAYABLE),
    ).toMatch(/audio/);
    expect(verifyConvert(spec('mp4', 'light'), { ...MP4, durationSec: 7 }, PLAYABLE)).toMatch(
      /length/,
    );
    expect(verifyConvert(spec('mp4', 'light'), { ...MP4, durationSec: null }, PLAYABLE)).toMatch(
      /duration/,
    );
  });

  it('a silent source needs no audio; a GIF has none and gets a wider length tolerance', () => {
    const silent = { ...PLAYABLE, hasAudio: false, audioCodec: null };
    expect(
      verifyConvert(spec('mp4', 'light'), { ...MP4, hasAudio: false, audioCodec: null }, silent),
    ).toBeNull();
    const gif: ProbeResult = {
      hasVideo: true,
      hasAudio: false,
      video: { width: 640, height: 360, codec: 'gif', pixFmt: 'pal8' },
      audioCodec: null,
      durationSec: 5.4,
      formatName: 'gif',
      sizeBytes: 1,
    };
    expect(verifyConvert(spec('gif', 'off'), gif, PLAYABLE)).toBeNull();
    expect(verifyConvert(spec('gif', 'off'), { ...gif, durationSec: 7 }, PLAYABLE)).toMatch(
      /length/,
    );
  });

  it('a remux keeps whatever codecs the source had (and its audio)', () => {
    const mkv: ProbeResult = { ...PLAYABLE, formatName: 'matroska,webm' };
    expect(verifyConvert(spec('mkv', 'off'), mkv, PLAYABLE)).toBeNull();
    expect(
      verifyConvert(spec('mkv', 'off'), { ...mkv, hasAudio: false, audioCodec: null }, PLAYABLE),
    ).toMatch(/audio/);
    expect(verifyConvert(spec('mkv', 'off'), MP4, PLAYABLE)).toMatch(/not a MKV/);
  });
});

describe('encoders and settings helpers', () => {
  const ALL: EncoderCapability = { h264: true, vp9: true, gif: true };

  it('reads what the build can encode', async () => {
    expect(await detectEncoders(fakeTools({ encoders: ENCODERS_WITH_H264 }))).toEqual({
      h264: true,
      vp9: false,
      gif: false,
    });
    expect(
      await detectEncoders(
        fakeTools({
          encoders: [
            ' V....D libvpx-vp9 libvpx VP9',
            ' A....D libopus libopus Opus',
            ' V....D gif GIF',
            '',
          ].join('\n'),
        }),
      ),
    ).toEqual({ h264: false, vp9: true, gif: true });
    const broken = { ...fakeTools(), encoders: () => Promise.reject(new Error('no ffmpeg')) };
    expect(await detectEncoders(broken)).toEqual({
      h264: false,
      vp9: false,
      gif: false,
    });
  });

  it('canConvert needs the encoder of the target; a remux needs none', () => {
    const none: EncoderCapability = { h264: false, vp9: false, gif: false };
    expect(canConvert(spec('mkv', 'off'), none)).toBe(true);
    expect(canConvert(spec('mkv', 'light'), none)).toBe(false);
    expect(canConvert(spec('mp4', 'off'), { ...none, vp9: true })).toBe(false);
    expect(canConvert(spec('webm', 'balanced'), { ...none, vp9: true })).toBe(true);
    expect(canConvert(spec('gif', 'off'), { ...none, gif: true })).toBe(true);
    for (const format of SAVE_FORMATS) expect(canConvert(spec(format, 'strong'), ALL)).toBe(true);
  });

  it('only WebM with no compression needs no job; a conversion to the same format with nothing to change is a no-op', () => {
    expect(needsFinalize('webm', 'off')).toBe(false);
    expect(needsFinalize('webm', 'light')).toBe(true);
    expect(needsFinalize('mkv', 'off')).toBe(true);
    expect(needsFinalize('mp4', 'off')).toBe(true);
    expect(needsFinalize('gif', 'off')).toBe(true);
    expect(isNoopConversion('webm', spec('webm', 'off'))).toBe(true);
    expect(isNoopConversion('webm', spec('webm', 'off', 640))).toBe(false);
    expect(isNoopConversion('webm', spec('webm', 'light'))).toBe(false);
    expect(isNoopConversion('webm', spec('mkv', 'off'))).toBe(false);
  });

  it('the hint says the expected effect', () => {
    expect(formatHint('mp4', 'balanced')).toContain('40–60 % smaller');
    expect(formatHint('webm', 'off')).toContain('no extra processing');
    expect(formatHint('mkv', 'off')).toContain('without re-encoding');
    expect(formatHint('gif', 'off')).toMatch(/no sound/);
    expect(formatHint('gif', 'off')).toContain('60 s');
  });
});
