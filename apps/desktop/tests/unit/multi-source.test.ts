/** Multi-source recording: the mosaic caps, the schemas, the manifest, the crop and the time fields. */
import { describe, expect, it } from 'vitest';
import { fitInside, mosaicLimit, multiSourceLayout } from '../../src/shared/compositor-layout';
import {
  CompletionRecordSchema,
  fcapPartialFileName,
  partialFileName,
  partialNameFor,
  SessionManifestSchema,
} from '../../src/main/recording/manifest';
import {
  DEFAULT_RECORD_OPTIONS,
  EngineEventSchema,
  EnginePrepareSchema,
  RecorderSnapshotSchema,
  RecorderStartRequestSchema,
} from '../../src/shared/recorder-ipc';
import { HISTORY_FORMATS, HistorySourceSchema } from '../../src/shared/history-ipc';
import {
  layoutSourceName,
  RecordingLayoutSchema,
  type RecordingLayout,
} from '../../src/shared/recording-layout';
import { formatClock, parseClock } from '../../src/renderer/lib/clock';
import { tileCropStyle } from '../../src/renderer/lib/tile-crop';

const evenAll = (rects: { x: number; y: number; width: number; height: number }[]): boolean =>
  rects.every((rect) => [rect.x, rect.y, rect.width, rect.height].every((v) => v % 2 === 0));

describe('mosaic caps (the WHOLE picture is capped, per quality)', () => {
  it('the limits', () => {
    expect(mosaicLimit('1080p')).toEqual({
      maxWidth: 3840,
      maxHeight: 2160,
      maxPixels: 3840 * 1080,
    });
    expect(mosaicLimit('source')).toEqual({
      maxWidth: 7680,
      maxHeight: 4320,
      maxPixels: 8_300_000,
    });
  });

  const screen = (x: number, y: number, width: number, height: number) => ({
    kind: 'screen' as const,
    size: { width, height },
    position: { x, y },
  });

  it('two 1080p screens side by side keep their size at 1080p', () => {
    const layout = multiSourceLayout(
      [screen(0, 0, 1920, 1080), screen(1920, 0, 1920, 1080)],
      '1080p',
    );
    expect(layout.width).toBe(3840);
    expect(layout.height).toBe(1080);
    expect(layout.rects).toEqual([
      { x: 0, y: 0, width: 1920, height: 1080 },
      { x: 1920, y: 0, width: 1920, height: 1080 },
    ]);
  });

  it('1080p: four 4K screens (2 x 2 on the virtual desktop) fit 3840 x 2160 and 4.1 million pixels', () => {
    const layout = multiSourceLayout(
      [
        screen(0, 0, 3840, 2160),
        screen(3840, 0, 3840, 2160),
        screen(0, 2160, 3840, 2160),
        screen(3840, 2160, 3840, 2160),
      ],
      '1080p',
    );
    expect(layout.width).toBeLessThanOrEqual(3840);
    expect(layout.height).toBeLessThanOrEqual(2160);
    expect(layout.width * layout.height).toBeLessThanOrEqual(3840 * 1080);
    expect(evenAll(layout.rects)).toBe(true);
    // The grid keeps the 2 x 2 shape.
    expect(layout.rects[3]!.x).toBeGreaterThan(layout.rects[0]!.x);
    expect(layout.rects[3]!.y).toBeGreaterThan(layout.rects[0]!.y);
  });

  it('source: capped at 8.3 million pixels and 7680 across, even sides, never upscaled', () => {
    const wide = multiSourceLayout(
      [screen(0, 0, 7680, 2160), screen(7680, 0, 7680, 2160)],
      'source',
    );
    expect(wide.width).toBeLessThanOrEqual(7680);
    expect(wide.width * wide.height).toBeLessThanOrEqual(8_300_000);
    expect(wide.width % 2).toBe(0);
    expect(wide.height % 2).toBe(0);
    const small = multiSourceLayout(
      [screen(0, 0, 1280, 720), screen(1280, 0, 1280, 720)],
      'source',
    );
    expect(small).toMatchObject({ width: 2560, height: 720 });
  });

  it('screens only keep their places (negative origins too); any window makes it a grid', () => {
    const left = multiSourceLayout(
      [screen(-1920, 0, 1920, 1080), screen(0, 0, 2560, 1080)],
      'source',
    );
    expect(left.rects[0]!.x).toBe(0);
    expect(left.rects[1]!.x).toBe(1920);

    const mixed = multiSourceLayout(
      [
        screen(0, 0, 1920, 1080),
        { kind: 'window', size: { width: 1000, height: 700 }, position: null },
        screen(1920, 0, 1920, 1080),
      ],
      '1080p',
    );
    // Three tiles in a 2 x 2 grid of equal cells: not side by side on one row.
    expect(mixed.rects[1]!.x).toBeGreaterThan(mixed.rects[0]!.x - 1);
    expect(mixed.rects[2]!.y).toBeGreaterThan(mixed.rects[0]!.y);
    expect(evenAll(mixed.rects)).toBe(true);
    for (const rect of mixed.rects) {
      expect(rect.x + rect.width).toBeLessThanOrEqual(mixed.width);
      expect(rect.y + rect.height).toBeLessThanOrEqual(mixed.height);
    }
  });
});

describe('fitInside (a window that changes size is letterboxed in its tile)', () => {
  const box = { x: 100, y: 50, width: 800, height: 450 };
  it('a frame of the tile aspect fills it', () => {
    expect(fitInside({ width: 1600, height: 900 }, box)).toEqual(box);
  });
  it('a taller frame is centered with side bars; a wider one with bars above and below', () => {
    expect(fitInside({ width: 450, height: 450 }, box)).toEqual({
      x: 100 + 175,
      y: 50,
      width: 450,
      height: 450,
    });
    expect(fitInside({ width: 1600, height: 450 }, box)).toEqual({
      x: 100,
      y: 50 + Math.round((450 - 225) / 2),
      width: 800,
      height: 225,
    });
  });
  it('scales a small frame up to the tile, and ignores an empty frame', () => {
    expect(fitInside({ width: 80, height: 45 }, box)).toEqual(box);
    expect(fitInside({ width: 0, height: 0 }, box)).toEqual(box);
  });
});

describe('recorder:start with several sources', () => {
  const schema = RecorderStartRequestSchema;
  const sources = (n: number, offset = 0) =>
    Array.from({ length: n }, (_, i) => ({ sourceId: `screen:${i + 1 + offset}:0` }));

  it('2 to 4 sources', () => {
    for (const n of [2, 3, 4]) {
      expect(
        schema.safeParse({ target: 'multi', sources: sources(n), options: DEFAULT_RECORD_OPTIONS })
          .success,
        String(n),
      ).toBe(true);
    }
    expect(
      schema.safeParse({
        target: 'multi',
        sources: [{ sourceId: 'screen:1:0' }, { sourceId: 'window:5:0' }],
        options: DEFAULT_RECORD_OPTIONS,
      }).success,
    ).toBe(true);
  });

  it('refuses fewer than 2, more than 4, duplicates, odd ids and extra keys', () => {
    const opts = DEFAULT_RECORD_OPTIONS;
    expect(schema.safeParse({ target: 'multi', sources: sources(1), options: opts }).success).toBe(
      false,
    );
    expect(schema.safeParse({ target: 'multi', sources: [], options: opts }).success).toBe(false);
    expect(schema.safeParse({ target: 'multi', sources: sources(5), options: opts }).success).toBe(
      false,
    );
    expect(
      schema.safeParse({
        target: 'multi',
        sources: [{ sourceId: 'screen:1:0' }, { sourceId: 'screen:1:0' }],
        options: opts,
      }).success,
    ).toBe(false);
    expect(
      schema.safeParse({
        target: 'multi',
        sources: [{ sourceId: 'screen:1:0' }, { sourceId: '../etc' }],
        options: opts,
      }).success,
    ).toBe(false);
    expect(
      schema.safeParse({
        target: 'multi',
        sources: [{ sourceId: 'screen:1:0', x: 1 }, { sourceId: 'screen:2:0' }],
        options: opts,
      }).success,
    ).toBe(false);
    // Multi needs its sources; the others never take them.
    expect(schema.safeParse({ target: 'multi', options: opts }).success).toBe(false);
    expect(schema.safeParse({ target: 'screen', sources: sources(2), options: opts }).success).toBe(
      false,
    );
  });
});

describe('engine messages for several sources', () => {
  it('prepare carries the sources; events carry the tiles and a lost tile', () => {
    const prepare = EnginePrepareSchema.safeParse({
      cmd: 'prepare',
      requestId: 'r',
      sourceId: 'screen:1:0',
      kind: 'screen',
      region: null,
      displaySize: null,
      options: DEFAULT_RECORD_OPTIONS,
      multi: [
        { sourceId: 'screen:1:0', kind: 'screen', rect: { x: 0, y: 0, width: 1920, height: 1080 } },
        { sourceId: 'window:2:0', kind: 'window', rect: null },
      ],
    });
    expect(prepare.success).toBe(true);
    expect(
      EnginePrepareSchema.safeParse({ ...prepare.data, multi: [prepare.data!.multi![0]] }).success,
    ).toBe(false);
    expect(
      EngineEventSchema.safeParse({
        type: 'prepared',
        requestId: 'r',
        mime: 'video/webm',
        width: 3840,
        height: 1080,
        audio: { mic: false, system: false },
        tiles: [
          { x: 0, y: 0, width: 1920, height: 1080 },
          { x: 1920, y: 0, width: 1920, height: 1080 },
        ],
      }).success,
    ).toBe(true);
    expect(EngineEventSchema.safeParse({ type: 'tileLost', index: 1 }).success).toBe(true);
    expect(EngineEventSchema.safeParse({ type: 'tileLost', index: 4 }).success).toBe(false);
    expect(EngineEventSchema.safeParse({ type: 'tileLost', index: 0, extra: 1 }).success).toBe(
      false,
    );
  });

  it('the snapshot lists the lost tiles', () => {
    const base = {
      status: 'recording',
      sessionId: 's',
      target: 'multi',
      startedAt: 1,
      activeMs: 0,
      runningSince: 1,
      error: null,
      stopReason: null,
      audio: { mic: false, system: false },
      muted: { mic: false, system: false },
      lost: { mic: false, system: false },
      lostTiles: [1],
      choice: null,
      choiceCanUseDefault: false,
      quitting: false,
      countdown: null,
      progress: null,
      width: 1,
      height: 1,
      result: null,
    };
    expect(RecorderSnapshotSchema.safeParse(base).success).toBe(true);
    expect(RecorderSnapshotSchema.safeParse({ ...base, lostTiles: [7] }).success).toBe(false);
  });
});

describe('manifest and completion record', () => {
  const layout: RecordingLayout = {
    width: 3840,
    height: 1080,
    sources: [
      { name: 'Screen 1', kind: 'screen', rect: { x: 0, y: 0, width: 1920, height: 1080 } },
      { name: 'Window 2', kind: 'window', rect: { x: 1920, y: 0, width: 1920, height: 1080 } },
    ],
  };
  const manifest = {
    version: 1,
    sessionId: '0f0e0d0c-0b0a-4908-8706-050403020100',
    createdAt: 1,
    updatedAt: 2,
    state: 'recording',
    mime: 'video/webm',
    source: { kind: 'screen', name: 'Screen' },
    options: DEFAULT_RECORD_OPTIONS,
    width: 1920,
    height: 1080,
    chunksWritten: 0,
    bytesWritten: 0,
    lastSeq: -1,
    pausedIntervals: [],
    appVersion: '0.1.0',
  };

  it('an older manifest (no layout, no multi) still parses', () => {
    const parsed = SessionManifestSchema.parse(manifest);
    expect(parsed.layout).toBeUndefined();
  });

  it('a multi manifest has the layout with generic names', () => {
    const parsed = SessionManifestSchema.parse({
      ...manifest,
      source: { kind: 'multi', name: 'Multiple sources' },
      layout,
    });
    expect(parsed.source.kind).toBe('multi');
    expect(parsed.layout?.sources.map((source) => source.name)).toEqual(['Screen 1', 'Window 2']);
    expect(
      SessionManifestSchema.safeParse({
        ...manifest,
        layout: { ...layout, sources: [{ ...layout.sources[0], title: 'Secret plan.docx' }] },
      }).success,
    ).toBe(false);
  });

  it('completion records accept multi and old ones parse', () => {
    const record = {
      sessionId: manifest.sessionId,
      completedAt: 3,
      createdAt: 1,
      outputPath: 'C:\\Videos\\a.fcap',
      durationMs: 1000,
      bytes: 10,
      width: 3840,
      height: 1080,
      source: { kind: 'multi' },
      hasAudio: false,
      mime: 'video/webm',
      recovered: false,
      unindexed: false,
      pausedIntervals: [],
      stats: {
        queueHighWaterChunks: 0,
        queueHighWaterBytes: 0,
        mainQueueHighWater: 0,
        maxWriteMs: 0,
      },
    };
    expect(CompletionRecordSchema.safeParse(record).success).toBe(true);
    expect(
      CompletionRecordSchema.safeParse({ ...record, source: { kind: 'screen' } }).success,
    ).toBe(true);
  });

  it('a session names its own temporary output (an .fcap partial for multi)', () => {
    const id = manifest.sessionId;
    expect(partialNameFor({ sessionId: id })).toBe(partialFileName(id));
    expect(partialNameFor({ sessionId: id, layout })).toBe(fcapPartialFileName(id));
    expect(fcapPartialFileName(id)).toBe(`.framecapt-${id}.fcap.partial`);
  });
});

describe('history and layout enums', () => {
  it('history knows the fcap format and the multi source', () => {
    expect(HISTORY_FORMATS).toContain('fcap');
    expect(HistorySourceSchema.safeParse('multi').success).toBe(true);
  });

  it('layout names are generic and bounded', () => {
    expect(layoutSourceName('screen', 0)).toBe('Screen 1');
    expect(layoutSourceName('window', 1)).toBe('Window 2');
    expect(
      RecordingLayoutSchema.safeParse({ ...{ width: 4, height: 4 }, sources: [] }).success,
    ).toBe(false);
  });
});

describe('tile crop (CSS for one source of the picture)', () => {
  const picture = { width: 3840, height: 1080 };
  it('the whole picture is the video at 100 %', () => {
    expect(tileCropStyle({ x: 0, y: 0, ...picture }, picture)).toEqual({
      width: '100%',
      height: '100%',
      left: '0%',
      top: '0%',
    });
  });
  it('the right half doubles the width and shifts the video left by one box', () => {
    expect(tileCropStyle({ x: 1920, y: 0, width: 1920, height: 1080 }, picture)).toEqual({
      width: '200%',
      height: '100%',
      left: '-100%',
      top: '0%',
    });
  });
  it('a tile in a grid is scaled and shifted on both axes', () => {
    expect(
      tileCropStyle({ x: 960, y: 540, width: 960, height: 540 }, { width: 1920, height: 1080 }),
    ).toEqual({ width: '200%', height: '200%', left: '-100%', top: '-100%' });
  });
});

describe('time fields', () => {
  it('formats minutes, seconds and tenths, and hours from one hour on', () => {
    expect(formatClock(0)).toBe('0:00.0');
    expect(formatClock(65_300)).toBe('1:05.3');
    expect(formatClock(3_725_000)).toBe('1:02:05.0');
  });
  it('reads what people type', () => {
    expect(parseClock('12')).toBe(12_000);
    expect(parseClock('12.5')).toBe(12_500);
    expect(parseClock('1:05')).toBe(65_000);
    expect(parseClock(' 1:05.3 ')).toBe(65_300);
    expect(parseClock('1:02:03')).toBe(3_723_000);
    expect(parseClock('75')).toBe(75_000);
  });
  it('refuses what is not a time', () => {
    for (const text of ['', 'abc', '1:75', '1:2:3:4', '-5', '1.2.3', '1:61:00']) {
      expect(parseClock(text), text).toBeNull();
    }
  });
  it('formatClock output reads back', () => {
    for (const ms of [0, 100, 59_900, 61_000, 3_600_000, 7_325_400]) {
      expect(parseClock(formatClock(ms))).toBe(ms);
    }
  });
});
