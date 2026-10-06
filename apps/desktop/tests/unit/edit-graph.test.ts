import { describe, expect, it } from 'vitest';
import { buildEditArgs, buildFilterScript } from '../../src/main/media/edit-graph';
import {
  applyCommand,
  createProject,
  newItem,
  type VideoProject,
} from '../../src/shared/video-edit';

const ID = '11111111-1111-4111-8111-111111111111';
const SOURCE = { durationMs: 10_000, width: 1280, height: 720, hasAudio: true };
const rect = { x: 100, y: 50, width: 300, height: 200 };
const project = (changes: Partial<VideoProject> = {}): VideoProject => ({
  ...createProject(ID, SOURCE),
  ...changes,
});
const withItem = (kind: Parameters<typeof newItem>[0], start = 1000, end = 4000) =>
  applyCommand(project(), { type: 'addItem', item: newItem(kind, 'i1', rect, start, end) });
const lines = (script: string): string[] => script.split(';\n');

describe('buildFilterScript: the base graph', () => {
  it('is fps -> one segment -> concat -> format, with the audio built beside it', () => {
    const script = buildFilterScript(project());
    expect(lines(script)).toEqual([
      '[0:v]fps=30,format=yuv420p[v0]',
      '[v0]null[vs0]',
      '[vs0]trim=start=0.000:end=10.000,setpts=PTS-STARTPTS[vt0]',
      '[0:a]anull[as0]',
      '[as0]atrim=start=0.000:end=10.000,asetpts=PTS-STARTPTS[at0]',
      '[vt0][at0]concat=n=1:v=1:a=1[vcat][acat]',
      '[vcat]format=yuv420p[vout]',
      '[acat]aformat=sample_rates=48000:channel_layouts=stereo[aout]',
    ]);
  });

  it('uses the source frame rate rounded, within 1..60', () => {
    const at = (fps: number) =>
      buildFilterScript(project({ source: { ...SOURCE, fps } })).split('\n')[0];
    expect(at(29.97)).toBe('[0:v]fps=30,format=yuv420p[v0];');
    expect(at(60)).toBe('[0:v]fps=60,format=yuv420p[v0];');
    expect(at(144)).toBe('[0:v]fps=60,format=yuv420p[v0];');
  });
});

describe('buildFilterScript: items', () => {
  it('redact: a filled box with its colour, enabled by source time', () => {
    const script = buildFilterScript(withItem('redact'));
    expect(script).toContain(
      "[v0]drawbox=x=100:y=50:w=300:h=200:color=0x000000@1:t=fill:enable='between(t,1.000,4.000)'[v1]",
    );
    const red = applyCommand(withItem('redact'), {
      type: 'updateItem',
      id: 'i1',
      patch: { color: '#ff0000' },
    });
    expect(buildFilterScript(red)).toContain('color=0xFF0000@1');
  });

  it('blur: split, crop and blur a copy, overlay it back while enabled', () => {
    const script = buildFilterScript(withItem('blur'));
    expect(lines(script)).toEqual(
      expect.arrayContaining([
        '[v0]split[i0a][i0b]',
        '[i0b]crop=300:200:100:50,gblur=sigma=24.00:steps=2[i0c]',
        "[i0a][i0c]overlay=100:50:enable='between(t,1.000,4.000)'[v1]",
      ]),
    );
  });

  it('pixelate: pixelize on the cropped copy, block limited to the box', () => {
    const script = buildFilterScript(withItem('pixelate'));
    expect(script).toContain('[i0b]crop=300:200:100:50,pixelize=w=16:h=16[i0c]');
    const tiny = applyCommand(project(), {
      type: 'addItem',
      item: newItem('pixelate', 'p', { x: 0, y: 0, width: 10, height: 10 }, 0, 1000),
    });
    const big = applyCommand(tiny, { type: 'updateItem', id: 'p', patch: { block: 100 } });
    expect(buildFilterScript(big)).toContain('pixelize=w=10:h=10');
  });

  it('blur and pixelate boxes are rounded outward to even coordinates', () => {
    const odd = applyCommand(project(), {
      type: 'addItem',
      item: newItem('blur', 'b', { x: 101, y: 51, width: 301, height: 201 }, 0, 1000),
    });
    expect(buildFilterScript(odd)).toContain('crop=302:202:100:50');
  });

  it('highlight (spotlight): four dark bands around the box, none over it', () => {
    const script = buildFilterScript(withItem('highlight'));
    const enable = "enable='between(t,1.000,4.000)'";
    expect(script).toContain(
      `[v0]drawbox=x=0:y=0:w=1280:h=50:color=black@0.60:t=fill:${enable},` +
        `drawbox=x=0:y=250:w=1280:h=470:color=black@0.60:t=fill:${enable},` +
        `drawbox=x=0:y=50:w=100:h=200:color=black@0.60:t=fill:${enable},` +
        `drawbox=x=400:y=50:w=880:h=200:color=black@0.60:t=fill:${enable}[v1]`,
    );
  });

  it('highlight skips bands with no size (a box on the frame edge)', () => {
    const edge = applyCommand(project(), {
      type: 'addItem',
      item: newItem('highlight', 'h', { x: 0, y: 0, width: 1280, height: 360 }, 0, 1000),
    });
    const script = buildFilterScript(edge);
    expect(script.match(/drawbox/g)).toHaveLength(1);
    expect(script).toContain('x=0:y=360:w=1280:h=360');
  });

  it('chains items in the order of the project (v1 -> v2 -> ...)', () => {
    let p = withItem('redact');
    p = applyCommand(p, { type: 'addItem', item: newItem('blur', 'i2', rect, 0, 500) });
    const script = buildFilterScript(p);
    expect(script.indexOf('[v0]drawbox')).toBeLessThan(script.indexOf('[v1]split'));
    expect(script).toContain("overlay=100:50:enable='between(t,0.000,0.500)'[v2]");
    expect(script).toContain('[v2]null[vs0]');
  });
});

describe('buildFilterScript: crop, scale, cuts', () => {
  it('crops after the items, in source pixels', () => {
    const p = applyCommand(withItem('redact'), {
      type: 'setCrop',
      crop: { x: 200, y: 100, width: 640, height: 360 },
    });
    const script = buildFilterScript(p);
    expect(script.indexOf('drawbox')).toBeLessThan(script.indexOf('crop=640:360:200:100[vc]'));
    expect(script).toContain('[vc]null[vs0]');
  });

  it('scales to the max width with even sizes and lanczos, only when it is smaller', () => {
    const scaled = applyCommand(project(), { type: 'setExport', patch: { scale: 641 } });
    expect(buildFilterScript(scaled)).toContain('scale=640:360:flags=lanczos,format=yuv420p');
    const wide = applyCommand(project(), { type: 'setExport', patch: { scale: 4000 } });
    expect(buildFilterScript(wide)).not.toContain('scale=');
  });

  it('makes an odd source even with the output size', () => {
    const odd = project({ source: { ...SOURCE, width: 1281, height: 721 } });
    const script = buildFilterScript(odd);
    expect(script).toContain('[v0]crop=1280:720:0:0[vc]');
  });

  it('builds one trim per kept segment, audio and video in lockstep', () => {
    let p = project();
    p = applyCommand(p, { type: 'addCut', id: 'a', startMs: 2000, endMs: 3000 });
    p = applyCommand(p, { type: 'addCut', id: 'b', startMs: 6000, endMs: 7000 });
    p = applyCommand(p, { type: 'setTrim', startMs: 500, endMs: 9500 });
    const script = buildFilterScript(p);
    const l = lines(script);
    expect(l).toContain('[v0]split=3[vs0][vs1][vs2]');
    expect(l).toContain('[0:a]asplit=3[as0][as1][as2]');
    for (const [i, [a, b]] of [
      [0.5, 2],
      [3, 6],
      [7, 9.5],
    ].entries()) {
      expect(script).toContain(
        `[vs${i}]trim=start=${a?.toFixed(3)}:end=${b?.toFixed(3)},setpts=PTS-STARTPTS[vt${i}]`,
      );
      expect(script).toContain(
        `[as${i}]atrim=start=${a?.toFixed(3)}:end=${b?.toFixed(3)},asetpts=PTS-STARTPTS[at${i}]`,
      );
    }
    expect(script).toContain('[vt0][at0][vt1][at1][vt2][at2]concat=n=3:v=1:a=1[vcat][acat]');
    expect(script.match(/\btrim=/g)).toHaveLength(3);
    expect(script.match(/\batrim=/g)).toHaveLength(3);
  });

  it('refuses a project with nothing left to export', () => {
    const empty = { ...project(), trim: { startMs: 5000, endMs: 5000 } };
    expect(() => buildFilterScript(empty)).toThrow();
  });
});

describe('buildFilterScript: fades and audio', () => {
  it('fades video and audio on the output timeline', () => {
    let p = applyCommand(project(), { type: 'addCut', id: 'a', startMs: 0, endMs: 2000 });
    p = applyCommand(p, { type: 'setFades', fadeInMs: 500, fadeOutMs: 1000 });
    const script = buildFilterScript(p);
    expect(script).toContain(
      '[vcat]fade=t=in:st=0:d=0.500,fade=t=out:st=7.000:d=1.000,format=yuv420p[vout]',
    );
    expect(script).toContain(
      '[acat]afade=t=in:st=0:d=0.500,afade=t=out:st=7.000:d=1.000,aformat=sample_rates=48000:channel_layouts=stereo[aout]',
    );
  });

  it('applies the volume, and only when it is not 1', () => {
    expect(buildFilterScript(project())).not.toContain('volume=');
    const loud = applyCommand(project(), { type: 'setAudio', patch: { volume: 1.5 } });
    expect(buildFilterScript(loud)).toContain('[acat]volume=1.50,aformat=');
  });

  it('uses silence of the output length when muted or when the source has no audio', () => {
    const muted = applyCommand(project(), { type: 'setAudio', patch: { muted: true } });
    const script = buildFilterScript(muted);
    expect(script).toContain('anullsrc=r=48000:cl=stereo:d=10.000[aout]');
    expect(script).not.toContain('[0:a]');
    expect(script).toContain('concat=n=1:v=1:a=0[vcat]');

    const silent = project({ source: { ...SOURCE, hasAudio: false } });
    const cutSilent = applyCommand(silent, { type: 'addCut', id: 'c', startMs: 1000, endMs: 4000 });
    const silentScript = buildFilterScript(cutSilent);
    expect(silentScript).toContain('anullsrc=r=48000:cl=stereo:d=7.000[aout]');
    expect(silentScript).not.toContain('atrim');
  });
});

describe('buildFilterScript: GIF', () => {
  it('limits the frame rate and width, builds one palette and has no audio', () => {
    const gif = applyCommand(project(), { type: 'setExport', patch: { format: 'gif' } });
    const script = buildFilterScript(gif);
    expect(script).toContain('[vcat]fps=12,scale=960:540:flags=lanczos,split[g0][g1]');
    expect(script).toContain('[g0]palettegen=stats_mode=diff[pal]');
    expect(script).toContain(
      '[g1][pal]paletteuse=dither=bayer:bayer_scale=5:diff_mode=rectangle[vout]',
    );
    expect(script).not.toContain('[0:a]');
    expect(script).not.toContain('anullsrc');
    expect(script).not.toContain('format=yuv420p[vout]');
  });

  it('honours the chosen frame rate and width', () => {
    const gif = applyCommand(project(), {
      type: 'setExport',
      patch: { format: 'gif', gifFps: 8, scale: 480 },
    });
    expect(buildFilterScript(gif)).toContain('fps=8,scale=480:270:flags=lanczos');
  });
});

describe('what may enter the graph', () => {
  it('only prints numbers and a validated colour', () => {
    const p = withItem('redact');
    const hostile = {
      ...p,
      items: [{ ...p.items[0], color: "#000000';movie=/etc/passwd" }],
    } as unknown as VideoProject;
    expect(() => buildFilterScript(hostile)).toThrow();
    const nan = {
      ...p,
      items: [{ ...p.items[0], rect: { x: Number.NaN, y: 0, width: 1, height: 1 } }],
    } as unknown as VideoProject;
    expect(() => buildFilterScript(nan)).toThrow();
  });

  it('has no quote other than the ones around each enable expression', () => {
    let p = withItem('redact');
    p = applyCommand(p, { type: 'addItem', item: newItem('highlight', 'h', rect, 0, 500) });
    const script = buildFilterScript(p);
    const withoutEnable = script.replace(/enable='between\(t,[0-9.]+,[0-9.]+\)'/g, '');
    expect(withoutEnable).not.toMatch(/['"\\$`]/);
  });
});

describe('buildEditArgs', () => {
  const run = (p: VideoProject, input = 'C:\\videos\\in.webm', out = 'C:\\videos\\out.mp4') =>
    buildEditArgs(p, input, out, { filterScriptPath: 'C:\\tmp\\graph.txt' });

  it('opens the input safely and reads the graph from a script file', () => {
    const { args, filterScript } = run(project());
    expect(filterScript).toBe(buildFilterScript(project()));
    const input = args.indexOf('-i');
    expect(args.slice(input - 4, input + 2)).toEqual([
      '-protocol_whitelist',
      'file',
      '-f',
      'matroska',
      '-i',
      'C:\\videos\\in.webm',
    ]);
    expect(args).toContain('-/filter_complex');
    expect(args[args.indexOf('-/filter_complex') + 1]).toBe('C:\\tmp\\graph.txt');
    expect(args).not.toContain('-filter_complex');
    expect(args.at(-1)).toBe('C:\\videos\\out.mp4');
  });

  it('does not force a demuxer for an MP4 source', () => {
    const { args } = run(project(), 'C:\\videos\\in.mp4');
    expect(args).not.toContain('matroska');
  });

  it('encodes MP4 with x264, AAC and faststart', () => {
    const { args } = run(project());
    expect(args).toEqual(
      expect.arrayContaining(['-c:v', 'libx264', '-preset', 'medium', '-crf', '20', '-pix_fmt']),
    );
    expect(args).toEqual(expect.arrayContaining(['-c:a', 'aac', '-b:a', '160k', '+faststart']));
    expect(args).toEqual(expect.arrayContaining(['-map', '[vout]', '-map', '[aout]']));
  });

  it('encodes WebM with VP9 and Opus', () => {
    const webm = applyCommand(project(), { type: 'setExport', patch: { format: 'webm' } });
    const { args } = run(webm, 'C:\\videos\\in.webm', 'C:\\videos\\out.webm');
    expect(args).toEqual(
      expect.arrayContaining(['libvpx-vp9', '-crf', '32', '-b:v', '0', '-row-mt', '1', 'libopus']),
    );
    expect(args).toContain('webm');
  });

  it('writes a GIF without audio', () => {
    const gif = applyCommand(project(), { type: 'setExport', patch: { format: 'gif' } });
    const { args } = run(gif, 'C:\\videos\\in.webm', 'C:\\videos\\out.gif');
    expect(args).toEqual(expect.arrayContaining(['-an', '-loop', '0', '-f', 'gif']));
    expect(args).not.toContain('[aout]');
  });

  it('refuses relative paths (they could be read as options)', () => {
    expect(() => run(project(), '-i', 'C:\\out.mp4')).toThrow();
    expect(() => run(project(), 'C:\\in.webm', 'out.mp4')).toThrow();
  });

  it('keeps the command line short however many cuts there are', () => {
    let p = project({ source: { ...SOURCE, durationMs: 3_600_000 } });
    p = { ...p, trim: { startMs: 0, endMs: 3_600_000 } };
    for (let i = 0; i < 90; i += 1) {
      p = applyCommand(p, {
        type: 'addCut',
        id: `c${i}`,
        startMs: i * 30_000 + 1000,
        endMs: i * 30_000 + 5000,
      });
    }
    const { args, filterScript } = run(p);
    expect(args.join(' ').length).toBeLessThan(2000);
    expect(filterScript.length).toBeGreaterThan(5000);
  });
});
