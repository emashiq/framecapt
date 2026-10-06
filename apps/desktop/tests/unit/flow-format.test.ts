import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  createdAtFromFlowFolder,
  cursorToFramePixels,
  drawRing,
  FlowFileSchema,
  flowFolderName,
  isFlowFolderName,
  isOnlyFlowFiles,
  ringGeometry,
  stepFileName,
  STEP_FILE_PATTERN,
  type FlowFile,
} from '../../src/shared/flow';
import {
  FlowSessions,
  readFlowFile,
  writeFlowFile,
  writeGuideFolder,
  type GuideStep,
} from '../../src/main/flows/flow-store';

let root: string;
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'framecapt-flow-'));
});
afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

const sample: FlowFile = {
  version: 1,
  createdAt: 1_790_000_000_000,
  steps: [
    {
      file: 'step-01.png',
      width: 1920,
      height: 1080,
      cursor: { x: 10, y: 20 },
      caption: '',
      at: 1,
    },
    { file: 'step-02.png', width: 1920, height: 1080, cursor: null, caption: 'Click Save', at: 2 },
  ],
};

describe('flow.json schema', () => {
  it('accepts a version 1 guide and keeps its fields', () => {
    expect(FlowFileSchema.parse(sample)).toEqual(sample);
    expect(FlowFileSchema.parse({ ...sample, title: 'Set up' }).title).toBe('Set up');
  });

  it('refuses another version, no steps, odd file names, a long caption and too many steps', () => {
    expect(FlowFileSchema.safeParse({ ...sample, version: 2 }).success).toBe(false);
    expect(FlowFileSchema.safeParse({ ...sample, steps: [] }).success).toBe(false);
    for (const file of [
      '../step-01.png',
      'step-1.png',
      'step-01.jpg',
      'evil.exe',
      'a/step-01.png',
    ]) {
      const steps = [{ ...sample.steps[0], file }];
      expect(FlowFileSchema.safeParse({ ...sample, steps }).success, file).toBe(false);
    }
    const long = [{ ...sample.steps[0], caption: 'x'.repeat(501) }];
    expect(FlowFileSchema.safeParse({ ...sample, steps: long }).success).toBe(false);
    const many = Array.from({ length: 201 }, (_, i) => ({
      ...sample.steps[0],
      file: stepFileName(i),
    }));
    expect(FlowFileSchema.safeParse({ ...sample, steps: many }).success).toBe(false);
  });

  it('step file names are numbered from 01 and fit 200 steps', () => {
    expect(stepFileName(0)).toBe('step-01.png');
    expect(stepFileName(8)).toBe('step-09.png');
    expect(stepFileName(199)).toBe('step-200.png');
    expect(STEP_FILE_PATTERN.test(stepFileName(199))).toBe(true);
  });
});

describe('guide folders', () => {
  it('are named FrameCapt Steps YYYY-MM-DD at HH.MM.SS and read back', () => {
    const date = new Date(2026, 9, 7, 14, 5, 9);
    expect(flowFolderName(date)).toBe('FrameCapt Steps 2026-10-07 at 14.05.09');
    expect(createdAtFromFlowFolder('FrameCapt Steps 2026-10-07 at 14.05.09')).toBe(date.getTime());
    expect(createdAtFromFlowFolder('FrameCapt Steps 2026-10-07 at 14.05.09 (2)')).toBe(
      date.getTime(),
    );
    expect(isFlowFolderName('FrameCapt Steps 2026-10-07 at 14.05.09')).toBe(true);
    for (const other of ['FrameCapt 2026-10-07 at 14.05.09', 'My steps', 'FrameCapt Steps']) {
      expect(isFlowFolderName(other), other).toBe(false);
      expect(createdAtFromFlowFolder(other)).toBeNull();
    }
  });

  it('are deleted whole only when they hold nothing but flow.json and step images', () => {
    expect(isOnlyFlowFiles(['flow.json', 'step-01.png', 'step-02.png'])).toBe(true);
    expect(isOnlyFlowFiles(['flow.json', 'notes.txt'])).toBe(false);
    expect(isOnlyFlowFiles(['flow.json', 'step-01.png', 'photo.png'])).toBe(false);
    expect(isOnlyFlowFiles(['flow.json', 'sub'])).toBe(false);
  });
});

describe('writeGuideFolder', () => {
  function makeSteps(count: number): GuideStep[] {
    const source = path.join(root, 'session');
    fs.mkdirSync(source, { recursive: true });
    return Array.from({ length: count }, (_, index) => {
      const file = path.join(source, `s${index}.png`);
      fs.writeFileSync(file, `png-${index}`);
      return {
        source: file,
        width: 100,
        height: 50,
        cursor: index === 0 ? { x: 5, y: 6 } : null,
        at: 1000 + index,
      };
    });
  }

  it('writes step-NN.png and flow.json into a folder named from the time, with empty captions', async () => {
    const created = new Date(2026, 9, 7, 14, 5, 9).getTime();
    const out = path.join(root, 'shots');
    const written = await writeGuideFolder({
      parentDir: out,
      createdAt: created,
      steps: makeSteps(3),
    });
    expect(path.basename(written.dir)).toBe('FrameCapt Steps 2026-10-07 at 14.05.09');
    expect(fs.readdirSync(written.dir).sort()).toEqual([
      'flow.json',
      'step-01.png',
      'step-02.png',
      'step-03.png',
    ]);
    expect(fs.readFileSync(path.join(written.dir, 'step-02.png'), 'utf8')).toBe('png-1');
    const flow = await readFlowFile(written.file);
    expect(flow?.version).toBe(1);
    expect(flow?.createdAt).toBe(created);
    expect(flow?.steps.map((s) => [s.file, s.caption, s.cursor])).toEqual([
      ['step-01.png', '', { x: 5, y: 6 }],
      ['step-02.png', '', null],
      ['step-03.png', '', null],
    ]);
  });

  it('leaves no temporary folder behind, and a second guide in the same second gets (2)', async () => {
    const created = new Date(2026, 9, 7, 14, 5, 9).getTime();
    const out = path.join(root, 'shots');
    await writeGuideFolder({ parentDir: out, createdAt: created, steps: makeSteps(1) });
    const second = await writeGuideFolder({
      parentDir: out,
      createdAt: created,
      steps: makeSteps(1),
    });
    expect(path.basename(second.dir)).toBe('FrameCapt Steps 2026-10-07 at 14.05.09 (2)');
    expect(fs.readdirSync(out).filter((name) => name.startsWith('.'))).toEqual([]);
  });

  it('a failure part way removes the temporary folder and publishes nothing', async () => {
    const out = path.join(root, 'shots');
    const steps = makeSteps(2);
    fs.rmSync(steps[1]?.source ?? '', { force: true }); // the second picture is gone
    await expect(writeGuideFolder({ parentDir: out, createdAt: 1, steps })).rejects.toThrow();
    expect(fs.readdirSync(out)).toEqual([]);
  });
});

describe('readFlowFile and writeFlowFile', () => {
  it('round-trips atomically and rejects damaged or foreign files', async () => {
    const file = path.join(root, 'flow.json');
    await writeFlowFile(file, sample);
    expect(await readFlowFile(file)).toEqual(sample);
    expect(fs.readdirSync(root).filter((name) => name.endsWith('.tmp'))).toEqual([]);
    fs.writeFileSync(file, '{ not json');
    expect(await readFlowFile(file)).toBeNull();
    fs.writeFileSync(file, JSON.stringify({ version: 1, createdAt: 1, steps: [] }));
    expect(await readFlowFile(file)).toBeNull();
    expect(await readFlowFile(path.join(root, 'missing.json'))).toBeNull();
  });
});

describe('FlowSessions', () => {
  it('begins a folder per session, writes numbered steps and discards it', async () => {
    const sessions = new FlowSessions(path.join(root, 'flows'));
    const { dir } = await sessions.begin();
    const file = await sessions.writeStep(dir, 0, new Uint8Array([1, 2, 3]));
    expect(path.basename(file)).toBe('step-01.png');
    expect(fs.readFileSync(file)).toEqual(Buffer.from([1, 2, 3]));
    await sessions.discard(dir);
    expect(fs.existsSync(dir)).toBe(false);
  });

  it('the sweep removes only old session folders', async () => {
    const sessions = new FlowSessions(path.join(root, 'flows'));
    const old = await sessions.begin();
    const fresh = await sessions.begin();
    const other = path.join(root, 'flows', 'export-keep');
    fs.mkdirSync(other);
    const longAgo = new Date(Date.now() - 10 * 24 * 3600 * 1000);
    fs.utimesSync(old.dir, longAgo, longAgo);
    expect(await sessions.sweep(24 * 3600 * 1000)).toBe(1);
    expect(fs.existsSync(old.dir)).toBe(false);
    expect(fs.existsSync(fresh.dir)).toBe(true);
    expect(fs.existsSync(other)).toBe(true);
  });
});

describe('pointer geometry', () => {
  const display = {
    id: '2',
    bounds: { x: -1920, y: 0, width: 1920, height: 1080 },
    scaleFactor: 1.25,
    rotation: 0,
  };

  it('maps a global DIP point (negative origin, scaled display) to the frame pixels', () => {
    expect(cursorToFramePixels({ x: -1920, y: 0 }, display, { width: 2400, height: 1350 })).toEqual(
      { x: 0, y: 0 },
    );
    expect(
      cursorToFramePixels({ x: -960, y: 540 }, display, { width: 2400, height: 1350 }),
    ).toEqual({ x: 1200, y: 675 });
  });

  it('uses the real frame size, not the nominal scale factor', () => {
    expect(
      cursorToFramePixels({ x: -960, y: 540 }, display, { width: 1920, height: 1080 }),
    ).toEqual({ x: 960, y: 540 });
  });

  it('is null outside the display or for unusable input', () => {
    expect(cursorToFramePixels({ x: 5, y: 5 }, display, { width: 2400, height: 1350 })).toBeNull();
    expect(
      cursorToFramePixels({ x: -1, y: 1080 }, display, { width: 2400, height: 1350 }),
    ).toBeNull();
    expect(cursorToFramePixels({ x: -1, y: 1 }, display, { width: 0, height: 0 })).toBeNull();
  });
});

describe('the ring', () => {
  it('scales with the picture and burns an accent ring into a BGRA bitmap', () => {
    expect(ringGeometry(1280).radius).toBeLessThan(ringGeometry(2560).radius);
    const size = { width: 80, height: 80 };
    const bitmap = new Uint8Array(size.width * size.height * 4).fill(255);
    drawRing(bitmap, size, { x: 40, y: 40 }, { radius: 12, stroke: 3 });
    const at = (x: number, y: number): number[] =>
      Array.from(bitmap.slice((y * 80 + x) * 4, (y * 80 + x) * 4 + 4));
    // On the stroke: the accent (indigo, BGRA order).
    expect(at(40 + 13, 40)).toEqual([241, 102, 99, 255]);
    // Inside: a faint tint, not white any more and not the full accent.
    const inside = at(40, 40);
    expect(inside[2]).toBeLessThan(255);
    expect(inside[0]).toBeGreaterThan(200);
    // Far away: untouched.
    expect(at(2, 2)).toEqual([255, 255, 255, 255]);
  });

  it('stays inside the bitmap when the pointer is at an edge', () => {
    const size = { width: 20, height: 20 };
    const bitmap = new Uint8Array(size.width * size.height * 4);
    expect(() => drawRing(bitmap, size, { x: 0, y: 0 }, { radius: 30, stroke: 4 })).not.toThrow();
    expect(() =>
      drawRing(bitmap, size, { x: 500, y: 500 }, { radius: 30, stroke: 4 }),
    ).not.toThrow();
  });
});
