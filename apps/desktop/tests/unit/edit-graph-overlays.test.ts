import { describe, expect, it } from 'vitest';
import { buildEditArgs, buildFilterScript, plannedInputs } from '../../src/main/media/edit-graph';
import {
  applyCommand,
  createProject,
  newAudio,
  newImage,
  newItem,
  newText,
  type Item,
  type VideoProject,
} from '../../src/shared/video-edit';

const ID = '11111111-1111-4111-8111-111111111111';
const ASSET = 'b'.repeat(64);
const SOURCE = { durationMs: 10_000, width: 1280, height: 720, hasAudio: true };
const lines = (script: string): string[] => script.split(';\n');
const withItems = (...items: Item[]): VideoProject =>
  items.reduce(
    (project, item) => applyCommand(project, { type: 'addItem', item }),
    createProject(ID, SOURCE),
  );
const text = (id = 't1', start = 1000, end = 3000) =>
  newText(id, { x: 10, y: 20, width: 200, height: 80 }, start, end);
const image = (id = 'i1', start = 1000, end = 3000) =>
  newImage(id, ASSET, { x: 300, y: 200, width: 100, height: 50 }, start, end);
const clip = (id = 'a1', start = 2000) =>
  newAudio(id, { assetId: ASSET, ext: 'mp3', name: 'song.mp3', clipMs: 3000 }, start);

describe('text and image overlays', () => {
  it('a text item is an extra input overlaid at its box while it is on', () => {
    const script = buildFilterScript(withItems(text()));
    expect(lines(script)).toEqual(
      expect.arrayContaining([
        '[1:v]format=rgba[ov0]',
        "[v0][ov0]overlay=10:20:enable='between(t,1.000,3.000)'[v1]",
        '[v1]null[vs0]',
      ]),
    );
  });

  it('fades go on the overlay picture as alpha, on its own clock (source time)', () => {
    const faded = { ...text('t1', 1000, 4000), fadeInMs: 500, fadeOutMs: 1000 };
    expect(buildFilterScript(withItems(faded))).toContain(
      '[1:v]format=rgba,fade=t=in:st=1.000:d=0.500:alpha=1,fade=t=out:st=3.000:d=1.000:alpha=1[ov0]',
    );
  });

  it('an image is scaled to its box, given its opacity and fades', () => {
    const picture = { ...image(), opacity: 0.5, fadeInMs: 250 };
    expect(buildFilterScript(withItems(picture))).toContain(
      '[1:v]format=rgba,scale=100:50,colorchannelmixer=aa=0.50,fade=t=in:st=1.000:d=0.250:alpha=1[ov0]',
    );
    expect(buildFilterScript(withItems(image()))).toContain('[1:v]format=rgba,scale=100:50[ov0]');
  });

  it('input numbers follow the order of the items; labels follow their place in the list', () => {
    const project = withItems(
      newItem('redact', 'r1', { x: 0, y: 0, width: 10, height: 10 }, 0, 1000),
      text(),
      image(),
      clip(),
    );
    expect(plannedInputs(project).map(({ item, index }) => [item.id, item.kind, index])).toEqual([
      ['t1', 'text', 1],
      ['i1', 'image', 2],
      ['a1', 'audio', 3],
    ]);
    const script = lines(buildFilterScript(project));
    expect(script).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/^\[v0\]drawbox=.*\[v1\]$/),
        '[1:v]format=rgba[ov1]',
        "[v1][ov1]overlay=10:20:enable='between(t,1.000,3.000)'[v2]",
        '[2:v]format=rgba,scale=100:50[ov2]',
        "[v2][ov2]overlay=300:200:enable='between(t,1.000,3.000)'[v3]",
        '[v3]null[vs0]',
      ]),
    );
  });

  it('puts every overlay file in as a looped input that lasts as long as its item', () => {
    const project = withItems(text('t1', 1000, 3000), image('i1', 500, 7500));
    const { args } = buildEditArgs(project, 'C:\\v\\in.webm', 'C:\\v\\out.mp4', {
      filterScriptPath: 'C:\\tmp\\graph.txt',
      inputFiles: { t1: 'C:\\tmp\\text-1.png', i1: 'C:\\a\\assets\\x.png' },
    });
    const at = args.indexOf('C:\\v\\in.webm');
    expect(args.slice(at + 1, at + 13)).toEqual([
      '-loop',
      '1',
      '-framerate',
      '30',
      '-t',
      '3.000',
      '-protocol_whitelist',
      'file',
      '-i',
      'C:\\tmp\\text-1.png',
      '-loop',
      '1',
    ]);
    expect(args).toEqual(
      expect.arrayContaining([
        '-t',
        '7.500',
        '-protocol_whitelist',
        'file',
        '-i',
        'C:\\a\\assets\\x.png',
      ]),
    );
    expect(args.indexOf('-/filter_complex')).toBeGreaterThan(args.lastIndexOf('-i'));
  });

  it('uses the source frame rate for the looped pictures', () => {
    const project = { ...withItems(text()), source: { ...SOURCE, fps: 60 } };
    const { args } = buildEditArgs(project, 'C:\\v\\in.webm', 'C:\\v\\out.mp4', {
      filterScriptPath: 'C:\\g.txt',
      inputFiles: { t1: 'C:\\t.png' },
    });
    expect(args[args.indexOf('-framerate') + 1]).toBe('60');
  });

  it('refuses to build when an overlay has no file', () => {
    expect(() =>
      buildEditArgs(withItems(text()), 'C:\\v\\in.webm', 'C:\\v\\out.mp4', {
        filterScriptPath: 'C:\\g.txt',
      }),
    ).toThrow();
  });
});

describe('audio clips', () => {
  it('mixes every clip with the original before the cuts, on the source timeline', () => {
    const script = buildFilterScript(withItems(clip()));
    expect(lines(script)).toEqual([
      '[0:v]fps=30,format=yuv420p[v0]',
      '[0:a]aformat=sample_rates=48000:channel_layouts=stereo[ab]',
      '[1:a]atrim=start=0.000:duration=3.000,asetpts=PTS-STARTPTS,aformat=sample_rates=48000:channel_layouts=stereo,adelay=2000|2000[ac0]',
      '[ab][ac0]amix=inputs=2:normalize=0:duration=first[amixed]',
      '[v0]null[vs0]',
      '[vs0]trim=start=0.000:end=10.000,setpts=PTS-STARTPTS[vt0]',
      '[amixed]anull[as0]',
      '[as0]atrim=start=0.000:end=10.000,asetpts=PTS-STARTPTS[at0]',
      '[vt0][at0]concat=n=1:v=1:a=1[vcat][acat]',
      '[vcat]format=yuv420p[vout]',
      '[acat]aformat=sample_rates=48000:channel_layouts=stereo[aout]',
    ]);
  });

  it('applies the clip volume, fades and in-offset; the original keeps its own volume', () => {
    const shaped = {
      ...clip(),
      inMs: 500,
      endMs: 4500,
      volume: 0.5,
      fadeInMs: 200,
      fadeOutMs: 400,
    };
    let project = withItems(shaped);
    project = applyCommand(project, { type: 'setAudio', patch: { volume: 1.5 } });
    const script = buildFilterScript(project);
    expect(script).toContain(
      '[0:a]volume=1.50,aformat=sample_rates=48000:channel_layouts=stereo[ab]',
    );
    expect(script).toContain(
      '[1:a]atrim=start=0.500:duration=2.500,asetpts=PTS-STARTPTS,aformat=sample_rates=48000:channel_layouts=stereo,volume=0.50,afade=t=in:st=0:d=0.200,afade=t=out:st=2.100:d=0.400,adelay=2000|2000[ac0]',
    );
    // The volume is not applied twice.
    expect(script).not.toMatch(/\[acat\]volume=/);
  });

  it('several clips: one input and one branch each, all into one amix', () => {
    const script = buildFilterScript(withItems(clip('a1', 0), clip('a2', 4000)));
    expect(script).toContain('[1:a]atrim=');
    expect(script).toContain('[2:a]atrim=');
    expect(script).toContain('adelay=4000|4000[ac1]');
    expect(script).toContain('[ab][ac0][ac1]amix=inputs=3:normalize=0:duration=first[amixed]');
  });

  it('uses silence of the recording length as the base when the source has no audio or is muted', () => {
    const silent = { ...withItems(clip()), source: { ...SOURCE, hasAudio: false } };
    expect(buildFilterScript(silent)).toContain('anullsrc=r=48000:cl=stereo:d=10.000[ab]');
    const muted = applyCommand(withItems(clip()), { type: 'setAudio', patch: { muted: true } });
    const script = buildFilterScript(muted);
    expect(script).toContain('anullsrc=r=48000:cl=stereo:d=10.000[ab]');
    expect(script).not.toContain('[0:a]');
  });

  it('cuts the mixed audio and the picture from the same segment list', () => {
    let project = withItems(clip());
    project = applyCommand(project, { type: 'addCut', id: 'c1', startMs: 1000, endMs: 2000 });
    project = applyCommand(project, { type: 'addCut', id: 'c2', startMs: 5000, endMs: 6000 });
    const script = buildFilterScript(project);
    expect(script).toContain('[amixed]asplit=3[as0][as1][as2]');
    expect(script).toContain('[v0]split=3[vs0][vs1][vs2]');
    expect(script.match(/\batrim=start=[\d.]+:end=/g)).toHaveLength(3);
    expect(script.match(/\btrim=start=/g)).toHaveLength(3);
    // The clip's delay is on the source timeline: it is unchanged by the cuts.
    expect(script).toContain('adelay=2000|2000');
    expect(script).toContain('[vt0][at0][vt1][at1][vt2][at2]concat=n=3:v=1:a=1[vcat][acat]');
  });

  it('a muted clip is not an input, and a GIF has no audio inputs', () => {
    const muted = { ...clip(), muted: true };
    expect(plannedInputs(withItems(muted))).toEqual([]);
    expect(buildFilterScript(withItems(muted))).not.toContain('amix');
    const gif = applyCommand(withItems(clip(), text()), {
      type: 'setExport',
      patch: { format: 'gif' },
    });
    expect(plannedInputs(gif).map((planned) => planned.item.kind)).toEqual(['text']);
    expect(buildFilterScript(gif)).not.toContain('amix');
  });

  it('opens audio files like any input: file protocol only, no loop', () => {
    const { args } = buildEditArgs(withItems(clip()), 'C:\\v\\in.webm', 'C:\\v\\out.mp4', {
      filterScriptPath: 'C:\\g.txt',
      inputFiles: { a1: 'C:\\a\\assets\\song.mp3' },
    });
    const at = args.indexOf('C:\\v\\in.webm');
    expect(args.slice(at + 1, at + 5)).toEqual([
      '-protocol_whitelist',
      'file',
      '-i',
      'C:\\a\\assets\\song.mp3',
    ]);
    expect(args).not.toContain('-loop');
    expect(args).toEqual(expect.arrayContaining(['-map', '[aout]', 'aac']));
  });
});

describe('what the text may do to the command', () => {
  it('the words of a text item never appear in the graph or the arguments', () => {
    const words = "Hello 'world' \\ $(calc) ; [0:v]movie=C:/secret.png";
    const item = {
      ...text(),
      text: words,
      background: { color: '#112233', opacity: 1, padding: 4, radius: 2 },
    };
    const project = withItems(item);
    const { args, filterScript } = buildEditArgs(project, 'C:\\v\\in.webm', 'C:\\v\\out.mp4', {
      filterScriptPath: 'C:\\g.txt',
      inputFiles: { t1: 'C:\\tmp\\text-1.png' },
    });
    for (const part of ['Hello', 'world', 'calc', 'movie', 'secret', 'sans', 'inter']) {
      expect(filterScript).not.toContain(part);
      expect(args.join(' ')).not.toContain(part);
    }
    // Only the project's own numbers and fixed words are in the overlay line.
    expect(filterScript).toContain('[1:v]format=rgba[ov0]');
  });

  it('an audio file name is a label, never part of the command', () => {
    const named = { ...clip(), name: "evil'; amix=inputs=99 [x]" };
    const { args, filterScript } = buildEditArgs(
      withItems(named),
      'C:\\v\\in.webm',
      'C:\\v\\o.mp4',
      {
        filterScriptPath: 'C:\\g.txt',
        inputFiles: { a1: 'C:\\a\\assets\\song.mp3' },
      },
    );
    expect(filterScript).not.toContain('evil');
    expect(filterScript).not.toContain('inputs=99');
    expect(args.join(' ')).not.toContain('evil');
  });

  it('the overlay lines hold no quote other than the enable expression', () => {
    const script = buildFilterScript(withItems({ ...text(), fadeInMs: 300 }, image(), clip()));
    const without = script.replace(/enable='between\(t,[0-9.]+,[0-9.]+\)'/g, '');
    expect(without).not.toMatch(/['"\\$`]/);
  });
});
