import { describe, expect, it } from 'vitest';
import {
  MAX_AUDIO_CLIPS,
  MAX_OVERLAYS,
  TEXT_MAX_CHARS,
  VideoProjectSchema,
  applyCommand,
  createProject,
  estimateSizeBytes,
  fadeAlpha,
  normalizeProject,
  newAudio,
  newImage,
  newText,
  outputDurationMs,
  projectSegments,
  rectOf,
  type Item,
  type VideoProject,
} from '../../src/shared/video-edit';

const ID = '11111111-1111-4111-8111-111111111111';
const ASSET = 'c'.repeat(64);
const SOURCE = { durationMs: 20_000, width: 1280, height: 720, hasAudio: true };
const base = (): VideoProject => createProject(ID, SOURCE);
const box = { x: 10, y: 20, width: 300, height: 100 };
const withItems = (...items: Item[]): VideoProject =>
  items.reduce((project, item) => applyCommand(project, { type: 'addItem', item }), base());
const parses = (project: unknown): boolean => VideoProjectSchema.safeParse(project).success;
const audio = (id = 'a1', start = 1000) =>
  newAudio(id, { assetId: ASSET, ext: 'mp3', name: 'song.mp3', clipMs: 5000 }, start);

describe('text, image and audio items: the schema', () => {
  it('accepts a new project with one of each', () => {
    const project = withItems(
      newText('t1', box, 0, 2000),
      newImage('i1', ASSET, box, 0, 2000),
      audio(),
    );
    expect(parses(project)).toBe(true);
    expect(project.items.map((item) => item.kind)).toEqual(['text', 'image', 'audio']);
  });

  it('bounds the text: 1 to 500 characters, known fonts, sizes and colours', () => {
    const text = newText('t1', box, 0, 2000);
    const check = (changes: object) => parses({ ...base(), items: [{ ...text, ...changes }] });
    expect(check({})).toBe(true);
    expect(check({ text: 'a\nb\nc' })).toBe(true);
    expect(check({ text: '' })).toBe(false);
    expect(check({ text: 'x'.repeat(TEXT_MAX_CHARS) })).toBe(true);
    expect(check({ text: 'x'.repeat(TEXT_MAX_CHARS + 1) })).toBe(false);
    expect(check({ font: 'comic-sans' })).toBe(false);
    expect(check({ font: 'C:\\Windows\\Fonts\\x.ttf' })).toBe(false);
    expect(check({ size: 7 })).toBe(false);
    expect(check({ size: 601 })).toBe(false);
    expect(check({ weight: 450 })).toBe(false);
    expect(check({ color: 'red' })).toBe(false);
    expect(check({ align: 'justify' })).toBe(false);
    expect(check({ background: { color: '#000000', opacity: 2, padding: 1, radius: 1 } })).toBe(
      false,
    );
    expect(check({ background: { color: '#000000', opacity: 0.5, padding: 1, radius: 1 } })).toBe(
      true,
    );
    expect(check({ outline: { color: '#000000', width: 21 } })).toBe(false);
    expect(check({ fadeInMs: -1 })).toBe(false);
    expect(check({ path: 'C:\\x' })).toBe(false);
  });

  it('an asset is only ever a sha256 hex id: no path, no name, no traversal', () => {
    const picture = newImage('i1', ASSET, box, 0, 2000);
    const clip = audio();
    for (const bad of ['../x', 'C:\\x.png', 'a'.repeat(63), 'A'.repeat(64), `${ASSET}.png`, '']) {
      expect(parses({ ...base(), items: [{ ...picture, assetId: bad }] }), bad).toBe(false);
      expect(parses({ ...base(), items: [{ ...clip, assetId: bad }] }), bad).toBe(false);
    }
    for (const bad of ['exe', 'mp4', '../mp3', 'MP3', '']) {
      expect(parses({ ...base(), items: [{ ...clip, ext: bad }] }), bad).toBe(false);
    }
    expect(parses({ ...base(), items: [{ ...picture, path: 'C:\\x.png' }] })).toBe(false);
    expect(parses({ ...base(), items: [{ ...clip, file: 'C:\\x.mp3' }] })).toBe(false);
    expect(parses({ ...base(), items: [{ ...clip, name: 'x'.repeat(121) }] })).toBe(false);
    expect(parses({ ...base(), items: [{ ...picture, opacity: 0 }] })).toBe(false);
    expect(parses({ ...base(), items: [{ ...clip, volume: 2.5 }] })).toBe(false);
    expect(parses({ ...base(), items: [{ ...clip, clipMs: 2 * 3600 * 1000 + 1 }] })).toBe(false);
  });

  it('limits the overlays and the audio clips', () => {
    const many = (count: number, make: (i: number) => Item) =>
      Array.from({ length: count }, (_, i) => make(i));
    const overlays = (count: number) =>
      parses({ ...base(), items: many(count, (i) => newText(`t${i}`, box, 0, 1000)) });
    expect(overlays(MAX_OVERLAYS)).toBe(true);
    expect(overlays(MAX_OVERLAYS + 1)).toBe(false);
    const clips = (count: number) =>
      parses({ ...base(), items: many(count, (i) => audio(`a${i}`)) });
    expect(clips(MAX_AUDIO_CLIPS)).toBe(true);
    expect(clips(MAX_AUDIO_CLIPS + 1)).toBe(false);
  });

  it('the reducer stops adding at the limits', () => {
    let project = base();
    for (let i = 0; i < MAX_OVERLAYS + 5; i += 1) {
      project = applyCommand(project, { type: 'addItem', item: newText(`t${i}`, box, 0, 1000) });
    }
    expect(project.items).toHaveLength(MAX_OVERLAYS);
    let clips = base();
    for (let i = 0; i < MAX_AUDIO_CLIPS + 5; i += 1) {
      clips = applyCommand(clips, { type: 'addItem', item: audio(`a${i}`) });
    }
    expect(clips.items).toHaveLength(MAX_AUDIO_CLIPS);
  });
});

describe('text, image and audio items: normalizing and editing', () => {
  it('a text box stays in the frame with the minimum size; fades fit the item', () => {
    const wild = {
      ...newText('t1', { x: 1200, y: 700, width: 900, height: 900 }, 19_950, 40_000),
      fadeInMs: 9000,
      fadeOutMs: 9000,
    };
    const [item] = normalizeProject({ ...base(), items: [wild] }).items;
    const rect = rectOf(item);
    expect((rect?.x ?? 0) + (rect?.width ?? 0)).toBeLessThanOrEqual(1280);
    expect((rect?.y ?? 0) + (rect?.height ?? 0)).toBeLessThanOrEqual(720);
    expect(item?.endMs).toBeLessThanOrEqual(20_000);
    if (item?.kind === 'text') {
      expect(item.fadeInMs + item.fadeOutMs).toBeLessThanOrEqual(item.endMs - item.startMs);
    }
  });

  it('an audio clip cannot be longer than its file, nor start before it, nor run past the recording', () => {
    const long = { ...audio('a1', 1000), endMs: 15_000 }; // file is 5 s
    const [clipped] = normalizeProject({ ...base(), items: [long] }).items;
    expect(clipped?.endMs).toBe(6000);
    const trimmed = { ...audio('a1', 1000), inMs: 4000, endMs: 9000 }; // 1 s of the file left
    const [shorter] = normalizeProject({ ...base(), items: [trimmed] }).items;
    expect(shorter?.endMs).toBe(2000);
    const late = audio('a1', 19_000); // starts a second before the end
    const [cut] = normalizeProject({ ...base(), items: [late] }).items;
    expect(cut?.endMs).toBeLessThanOrEqual(20_000);
    expect((cut?.endMs ?? 0) - (cut?.startMs ?? 0)).toBeGreaterThan(0);
    const past = { ...audio('a1', 1000), inMs: 99_999 };
    const [inside] = normalizeProject({ ...base(), items: [past] }).items;
    expect(inside?.kind === 'audio' && inside.inMs < inside.clipMs).toBe(true);
  });

  it('updates text fields, an image opacity and a clip, and ignores fields of other kinds', () => {
    let project = withItems(
      newText('t1', box, 0, 3000),
      newImage('i1', ASSET, box, 0, 3000),
      audio(),
    );
    project = applyCommand(project, {
      type: 'updateItem',
      id: 't1',
      patch: {
        text: 'Hello',
        font: 'georgia',
        weight: 700,
        italic: true,
        color: '#ff0000',
        align: 'right',
        shadow: false,
        outline: { color: '#000000', width: 2 },
        background: { color: '#ffffff', opacity: 0.5, padding: 8, radius: 4 },
        fadeInMs: 500,
      },
    });
    expect(project.items[0]).toMatchObject({
      kind: 'text',
      text: 'Hello',
      font: 'georgia',
      weight: 700,
      italic: true,
      color: '#ff0000',
      align: 'right',
      shadow: false,
      fadeInMs: 500,
      outline: { width: 2 },
      background: { padding: 8 },
    });
    project = applyCommand(project, {
      type: 'updateItem',
      id: 't1',
      patch: { outline: null, background: null },
    });
    expect(project.items[0]).toMatchObject({ outline: null, background: null });
    project = applyCommand(project, {
      type: 'updateItem',
      id: 'i1',
      patch: { opacity: 0.4, text: 'no' },
    });
    expect(project.items[1]).toMatchObject({ kind: 'image', opacity: 0.4 });
    expect(project.items[1]).not.toHaveProperty('text');
    project = applyCommand(project, {
      type: 'updateItem',
      id: 'a1',
      patch: { volume: 1.5, muted: true, inMs: 500, fadeOutMs: 300, rect: box },
    });
    expect(project.items[2]).toMatchObject({
      kind: 'audio',
      volume: 1.5,
      muted: true,
      inMs: 500,
      fadeOutMs: 300,
    });
    expect(project.items[2]).not.toHaveProperty('rect');
  });

  it('only visual items have a box', () => {
    const project = withItems(newText('t1', box, 0, 1000), audio());
    expect(rectOf(project.items[0])).toEqual(box);
    expect(rectOf(project.items[1])).toBeUndefined();
    expect(rectOf(undefined)).toBeUndefined();
  });

  it('a clip never changes the length of the result; a cut does not move it on the source timeline', () => {
    const project = applyCommand(withItems(audio('a1', 2000)), {
      type: 'addCut',
      id: 'c',
      startMs: 5000,
      endMs: 8000,
    });
    expect(outputDurationMs(projectSegments(project))).toBe(17_000);
    expect(project.items[0]).toMatchObject({ startMs: 2000, endMs: 7000 });
  });
});

describe('fades and the size estimate', () => {
  const item = { startMs: 1000, endMs: 5000, fadeInMs: 1000, fadeOutMs: 2000 };

  it('fadeAlpha ramps in and out and is 1 in between', () => {
    expect(fadeAlpha(item, 1000)).toBe(0);
    expect(fadeAlpha(item, 1500)).toBeCloseTo(0.5);
    expect(fadeAlpha(item, 2000)).toBe(1);
    expect(fadeAlpha(item, 3000)).toBe(1);
    expect(fadeAlpha(item, 4000)).toBeCloseTo(0.5);
    expect(fadeAlpha(item, 5000)).toBe(0);
    expect(fadeAlpha({ ...item, fadeInMs: 0, fadeOutMs: 0 }, 1000)).toBe(1);
  });

  it('estimates a larger file for a longer, bigger, faster result, and less for WebM', () => {
    const project = base();
    const mp4 = estimateSizeBytes(project, 10_000);
    expect(mp4).toBeGreaterThan(0);
    expect(estimateSizeBytes(project, 20_000)).toBeGreaterThan(mp4);
    const small = applyCommand(project, { type: 'setExport', patch: { scale: 640 } });
    expect(estimateSizeBytes(small, 10_000)).toBeLessThan(mp4);
    const fast = { ...project, source: { ...SOURCE, fps: 60 } };
    expect(estimateSizeBytes(fast, 10_000)).toBeGreaterThan(mp4);
    const webm = applyCommand(project, { type: 'setExport', patch: { format: 'webm' } });
    expect(estimateSizeBytes(webm, 10_000)).toBeLessThan(mp4);
    const gif = applyCommand(project, { type: 'setExport', patch: { format: 'gif', gifFps: 10 } });
    expect(estimateSizeBytes(gif, 10_000)).toBeGreaterThan(0);
  });
});
