import { describe, expect, it } from 'vitest';
import {
  MAX_CUTS,
  MIN_ITEM_MS,
  MIN_SEGMENT_MS,
  VideoProjectSchema,
  applyCommand,
  createProject,
  keptSegments,
  newItem,
  normalizeCuts,
  normalizeProject,
  outputDurationMs,
  outputGeometry,
  outputToSource,
  parseProject,
  projectSegments,
  segmentAtOrAfter,
  sourceToOutput,
  type VideoProject,
} from '../../src/shared/video-edit';
import {
  canRedoVideo,
  canUndoVideo,
  commitVideo,
  createVideoHistory,
  endVideoGesture,
  redoVideo,
  undoVideo,
} from '../../src/shared/video-edit-history';

const ID = '11111111-1111-4111-8111-111111111111';
const SOURCE = { durationMs: 60_000, width: 1920, height: 1080, hasAudio: true };
const base = (): VideoProject => createProject(ID, SOURCE);
const cut = (id: string, startMs: number, endMs: number) => ({ id, startMs, endMs });

describe('segments and time mapping', () => {
  it('keeps the whole trim without cuts', () => {
    expect(keptSegments({ startMs: 1000, endMs: 9000 }, [])).toEqual([
      { startMs: 1000, endMs: 9000 },
    ]);
  });

  it('removes cuts from the trim, in order, whatever order they were added in', () => {
    const segments = keptSegments({ startMs: 0, endMs: 10_000 }, [
      cut('b', 6000, 7000),
      cut('a', 2000, 3000),
    ]);
    expect(segments).toEqual([
      { startMs: 0, endMs: 2000 },
      { startMs: 3000, endMs: 6000 },
      { startMs: 7000, endMs: 10_000 },
    ]);
    expect(outputDurationMs(segments)).toBe(8000);
  });

  it('merges overlapping and touching cuts and clamps them to the trim', () => {
    const cuts = normalizeCuts({ startMs: 1000, endMs: 9000 }, [
      cut('a', 0, 3000),
      cut('b', 2500, 4000),
      cut('c', 4000, 5000),
      cut('d', 8800, 12_000),
    ]);
    expect(cuts.map((c) => [c.id, c.startMs, c.endMs])).toEqual([
      ['a', 1000, 5000],
      ['d', 8800, 9000],
    ]);
  });

  it('widens a cut over a sliver the cut would leave behind', () => {
    const trim = { startMs: 0, endMs: 10_000 };
    const [first] = normalizeCuts(trim, [cut('a', 40, 3000)]);
    expect(first?.startMs).toBe(0);
    const [last] = normalizeCuts(trim, [cut('a', 5000, 10_000 - MIN_SEGMENT_MS + 10)]);
    expect(last?.endMs).toBe(10_000);
    const merged = normalizeCuts(trim, [
      cut('a', 1000, 2000),
      cut('b', 2000 + MIN_SEGMENT_MS - 1, 3000),
    ]);
    expect(merged).toHaveLength(1);
  });

  it('drops cuts shorter than one frame or outside the trim', () => {
    const trim = { startMs: 1000, endMs: 5000 };
    expect(normalizeCuts(trim, [cut('a', 2000, 2010), cut('b', 6000, 7000)])).toEqual([]);
  });

  it('maps source time to output time across cuts', () => {
    const segments = keptSegments({ startMs: 0, endMs: 10_000 }, [cut('a', 2000, 3000)]);
    expect(sourceToOutput(segments, 1500)).toBe(1500);
    expect(sourceToOutput(segments, 2500)).toBe(2000); // inside the cut: where it starts
    expect(sourceToOutput(segments, 4000)).toBe(3000);
    expect(sourceToOutput(segments, 99_000)).toBe(9000);
    expect(sourceToOutput(segments, -5)).toBe(0);
  });

  it('maps output time back to source time (round trip inside kept pieces)', () => {
    const segments = keptSegments({ startMs: 500, endMs: 10_000 }, [cut('a', 2000, 3000)]);
    for (const source of [500, 1999, 3000, 6543, 9999]) {
      expect(outputToSource(segments, sourceToOutput(segments, source))).toBe(source);
    }
    expect(outputToSource(segments, 1_000_000)).toBe(10_000);
    expect(outputToSource([], 5)).toBe(0);
  });

  it('finds the piece playback is in, or the next one', () => {
    const segments = keptSegments({ startMs: 0, endMs: 10_000 }, [cut('a', 2000, 3000)]);
    expect(segmentAtOrAfter(segments, 1000)).toEqual({ startMs: 0, endMs: 2000 });
    expect(segmentAtOrAfter(segments, 2500)).toEqual({ startMs: 3000, endMs: 10_000 });
    expect(segmentAtOrAfter(segments, 10_000)).toBeNull();
  });
});

describe('output geometry', () => {
  it('rounds odd sizes down to even and keeps the crop origin even', () => {
    const project = { ...base(), source: { ...SOURCE, width: 641, height: 361 } };
    expect(outputGeometry(project)).toMatchObject({ width: 640, height: 360 });
    const cropped = { ...project, crop: { x: 11, y: 5, width: 301, height: 201 } };
    expect(outputGeometry(cropped).cropped).toEqual({ x: 10, y: 4, width: 300, height: 200 });
  });

  it('scales down to the max width, never up, and gives GIFs a default of 960', () => {
    const project = base();
    expect(outputGeometry({ ...project, export: { format: 'mp4', scale: 960 } })).toMatchObject({
      width: 960,
      height: 540,
    });
    expect(outputGeometry({ ...project, export: { format: 'mp4', scale: 4000 } }).width).toBe(1920);
    expect(outputGeometry({ ...project, export: { format: 'gif' } }).width).toBe(960);
    expect(outputGeometry({ ...project, export: { format: 'webm' } }).width).toBe(1920);
  });
});

describe('normalizeProject and the schema', () => {
  it('accepts a new project', () => {
    expect(VideoProjectSchema.safeParse(base()).success).toBe(true);
  });

  it('puts items inside the source with a minimum span and box', () => {
    const project = {
      ...base(),
      items: [
        {
          ...newItem('redact', 'a', { x: 1900, y: 1070, width: 400, height: 300 }, 59_990, 70_000),
        },
      ],
    };
    const [item] = normalizeProject(project).items;
    expect(item?.endMs).toBeLessThanOrEqual(60_000);
    expect((item?.endMs ?? 0) - (item?.startMs ?? 0)).toBeGreaterThanOrEqual(MIN_ITEM_MS);
    expect((item?.rect.x ?? 0) + (item?.rect.width ?? 0)).toBeLessThanOrEqual(1920);
    expect((item?.rect.y ?? 0) + (item?.rect.height ?? 0)).toBeLessThanOrEqual(1080);
  });

  it('keeps trim valid and drops cuts that would remove everything', () => {
    const project = {
      ...base(),
      trim: { startMs: 5000, endMs: 5010 },
      cuts: [cut('a', 0, 60_000)],
    };
    const normalized = normalizeProject(project);
    expect(normalized.trim.endMs - normalized.trim.startMs).toBeGreaterThanOrEqual(MIN_SEGMENT_MS);
    expect(projectSegments(normalized).length).toBeGreaterThan(0);
  });

  it('limits the fades to the output length', () => {
    const project = { ...base(), trim: { startMs: 0, endMs: 1000 }, fadeInMs: 800, fadeOutMs: 800 };
    const normalized = normalizeProject(project);
    expect(normalized.fadeInMs + normalized.fadeOutMs).toBeLessThanOrEqual(1000);
  });

  it('turns a crop of the whole frame into no crop and aligns a crop to even numbers', () => {
    expect(
      normalizeProject({ ...base(), crop: { x: 0, y: 0, width: 1920, height: 1080 } }).crop,
    ).toBeNull();
    const crop = normalizeProject({
      ...base(),
      crop: { x: 101, y: 51, width: 500, height: 301 },
    }).crop;
    expect(crop).toEqual({ x: 100, y: 50, width: 500, height: 300 });
  });

  it('rejects unknown fields, bad colours and out-of-range numbers', () => {
    const item = newItem('redact', 'a', { x: 0, y: 0, width: 10, height: 10 }, 0, 1000);
    const parse = (changes: object) =>
      VideoProjectSchema.safeParse({ ...base(), ...changes }).success;
    expect(parse({ extra: 1 })).toBe(false);
    expect(parse({ items: [{ ...item, color: 'red' }] })).toBe(false);
    expect(parse({ items: [{ ...item, color: "#000000';evil" }] })).toBe(false);
    expect(parse({ audio: { volume: 3, muted: false } })).toBe(false);
    expect(parse({ sourceId: '../../etc' })).toBe(false);
    expect(parse({ items: [{ ...item, id: 'a b' }] })).toBe(false);
    expect(parse({ version: 2 })).toBe(false);
  });

  it('parseProject returns null for garbage and a normalized project otherwise', () => {
    expect(parseProject({ nope: true })).toBeNull();
    expect(parseProject(base())).toEqual(base());
  });
});

describe('reducer', () => {
  const rect = { x: 10, y: 20, width: 200, height: 100 };

  it('adds, updates and removes items', () => {
    let project = applyCommand(base(), {
      type: 'addItem',
      item: newItem('blur', 'i1', rect, 1000, 3000),
    });
    expect(project.items).toHaveLength(1);
    project = applyCommand(project, {
      type: 'updateItem',
      id: 'i1',
      patch: { amount: 80, startMs: 500, endMs: 4000 },
    });
    expect(project.items[0]).toMatchObject({ kind: 'blur', amount: 80, startMs: 500, endMs: 4000 });
    // A field of another kind is ignored.
    const same = applyCommand(project, { type: 'updateItem', id: 'i1', patch: { block: 50 } });
    expect(same).toBe(project);
    project = applyCommand(project, { type: 'removeItem', id: 'i1' });
    expect(project.items).toEqual([]);
  });

  it('refuses a duplicate item id and an update of an unknown id', () => {
    const project = applyCommand(base(), {
      type: 'addItem',
      item: newItem('redact', 'i1', rect, 0, 1000),
    });
    expect(
      applyCommand(project, { type: 'addItem', item: newItem('redact', 'i1', rect, 0, 1000) }),
    ).toBe(project);
    expect(applyCommand(project, { type: 'updateItem', id: 'zz', patch: { startMs: 5 } })).toBe(
      project,
    );
  });

  it('clamps an update that sticks out of the source', () => {
    let project = applyCommand(base(), {
      type: 'addItem',
      item: newItem('pixelate', 'p', rect, 0, 1000),
    });
    project = applyCommand(project, {
      type: 'updateItem',
      id: 'p',
      patch: { rect: { x: 1900, y: 1000, width: 500, height: 500 } },
    });
    expect(project.items[0]?.rect).toEqual({ x: 1420, y: 580, width: 500, height: 500 });
  });

  it('sets the trim and re-normalizes the cuts', () => {
    let project = applyCommand(base(), { type: 'addCut', id: 'c', startMs: 1000, endMs: 5000 });
    project = applyCommand(project, { type: 'setTrim', startMs: 3000, endMs: 50_000 });
    expect(project.trim).toEqual({ startMs: 3000, endMs: 50_000 });
    expect(project.cuts[0]).toMatchObject({ startMs: 3000, endMs: 5000 });
  });

  it('adds cuts (merging touching ones), removes them, and refuses to cut everything', () => {
    let project = applyCommand(base(), { type: 'addCut', id: 'a', startMs: 1000, endMs: 2000 });
    project = applyCommand(project, { type: 'addCut', id: 'b', startMs: 1900, endMs: 4000 });
    expect(project.cuts).toEqual([{ id: 'a', startMs: 1000, endMs: 4000 }]);
    expect(applyCommand(project, { type: 'addCut', id: 'x', startMs: 0, endMs: 60_000 })).toBe(
      project,
    );
    project = applyCommand(project, { type: 'removeCut', id: 'a' });
    expect(project.cuts).toEqual([]);
  });

  it('limits the number of cuts', () => {
    let project = base();
    for (let i = 0; i < MAX_CUTS + 5; i += 1) {
      project = applyCommand(project, {
        type: 'addCut',
        id: `c${i}`,
        startMs: i * 500,
        endMs: i * 500 + 200,
      });
    }
    expect(project.cuts.length).toBeLessThanOrEqual(MAX_CUTS);
  });

  it('sets crop, audio, fades and export options', () => {
    let project = applyCommand(base(), {
      type: 'setCrop',
      crop: { x: 100, y: 100, width: 800, height: 450 },
    });
    expect(project.crop).toEqual({ x: 100, y: 100, width: 800, height: 450 });
    project = applyCommand(project, { type: 'setAudio', patch: { volume: 1.5, muted: true } });
    expect(project.audio).toEqual({ volume: 1.5, muted: true });
    project = applyCommand(project, { type: 'setFades', fadeInMs: 500 });
    expect(project).toMatchObject({ fadeInMs: 500, fadeOutMs: 0 });
    project = applyCommand(project, { type: 'setExport', patch: { format: 'gif', gifFps: 10 } });
    expect(project.export).toEqual({ format: 'gif', gifFps: 10 });
    project = applyCommand(project, { type: 'setExport', patch: { gifFps: undefined } });
    expect(project.export).toEqual({ format: 'gif' });
  });

  it('returns the same object for a no-op', () => {
    const project = base();
    expect(applyCommand(project, { type: 'setCrop', crop: null })).toBe(project);
    expect(applyCommand(project, { type: 'removeCut', id: 'nope' })).toBe(project);
  });
});

describe('undo and redo', () => {
  it('undoes and redoes commands', () => {
    let history = createVideoHistory(base());
    history = commitVideo(history, { type: 'addCut', id: 'a', startMs: 1000, endMs: 2000 });
    history = commitVideo(history, { type: 'setFades', fadeInMs: 400 });
    expect(canUndoVideo(history)).toBe(true);
    history = undoVideo(history);
    expect(history.present.fadeInMs).toBe(0);
    expect(history.present.cuts).toHaveLength(1);
    expect(canRedoVideo(history)).toBe(true);
    history = redoVideo(history);
    expect(history.present.fadeInMs).toBe(400);
    expect(undoVideo(createVideoHistory(base())).past).toEqual([]);
  });

  it('a new command clears the redo stack', () => {
    let history = createVideoHistory(base());
    history = commitVideo(history, { type: 'setFades', fadeInMs: 400 });
    history = undoVideo(history);
    history = commitVideo(history, { type: 'setFades', fadeOutMs: 300 });
    expect(canRedoVideo(history)).toBe(false);
  });

  it('merges the commands of one gesture into one undo step', () => {
    let history = createVideoHistory(
      applyCommand(base(), {
        type: 'addItem',
        item: newItem('redact', 'i', { x: 0, y: 0, width: 50, height: 50 }, 0, 1000),
      }),
    );
    for (const x of [10, 20, 30, 40]) {
      history = commitVideo(
        history,
        { type: 'updateItem', id: 'i', patch: { rect: { x, y: 0, width: 50, height: 50 } } },
        'drag:i',
      );
    }
    expect(history.past).toHaveLength(1);
    expect(history.present.items[0]?.rect.x).toBe(40);
    history = endVideoGesture(history);
    history = commitVideo(
      history,
      { type: 'updateItem', id: 'i', patch: { rect: { x: 60, y: 0, width: 50, height: 50 } } },
      'drag:i',
    );
    expect(history.past).toHaveLength(2);
    history = undoVideo(history);
    expect(history.present.items[0]?.rect.x).toBe(40);
  });

  it('does not add an entry for a no-op', () => {
    const history = createVideoHistory(base());
    expect(commitVideo(history, { type: 'setCrop', crop: null })).toBe(history);
  });
});
