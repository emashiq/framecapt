import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  executeCleanup,
  listRealDir,
  planCaptureCleanup,
  realKindOf,
  type DirEntry,
} from '../../src/main/uninstall';

const pictures = path.resolve('/home/u/Pictures/FrameCapt');
const videos = path.resolve('/home/u/Videos/FrameCapt');
const file = (name: string): DirEntry => ({ name, isFile: true });
const ours = [
  file('FrameCapt 2026-10-02 at 14.05.09.png'),
  file('FrameCapt 2026-10-02 at 14.05.09 (2).jpg'),
  file('FrameCapt 2026-10-02 at 14.05.10 (recovered).webm'),
  file('.framecapt-copy-abc123.partial'),
  file('.FrameCapt 2026-10-02 at 14.05.09.png.1a2b3c4d.tmp'),
  file('desktop.ini'),
];
const history = (...paths: unknown[]): string =>
  JSON.stringify({ version: 1, items: paths.map((p) => ({ path: p })) });

function plan(listing: Record<string, DirEntry[] | null>, historyJson: string | null) {
  return planCaptureCleanup({
    historyJson,
    defaultDirs: [pictures, videos],
    listDir: (dir) => listing[dir] ?? null,
  });
}

describe('planCaptureCleanup', () => {
  it('trashes a default folder as a whole when everything in it is the app’s', () => {
    expect(plan({ [pictures]: ours, [videos]: [file(ours[0]!.name)] }, null)).toEqual({
      folders: [pictures, videos],
      files: [],
    });
  });

  it('goes file by file when a folder holds anything else, a subfolder included', () => {
    const mixed = [...ours, file('holiday.png')];
    const nested = [
      file(ours[0]!.name),
      { name: 'FrameCapt 2026-10-02 at 14.05.09', isFile: false },
    ];
    const inPictures = path.join(pictures, ours[0]!.name);
    const result = plan(
      { [pictures]: mixed, [videos]: nested },
      history(inPictures, path.join(videos, ours[0]!.name)),
    );
    expect(result.folders).toEqual([]);
    expect(result.files).toEqual([inPictures, path.join(videos, ours[0]!.name)]);
  });

  it('does not list files inside a folder that goes whole', () => {
    const inside = path.join(pictures, ours[0]!.name);
    const outside = path.resolve('/data/shots/a.png');
    expect(plan({ [pictures]: ours }, history(inside, outside))).toEqual({
      folders: [pictures],
      files: [outside],
    });
  });

  it('takes custom folders only per file, and only history paths of media files', () => {
    const custom = path.resolve('/data/shots/a.png');
    const result = plan(
      {},
      history(custom, path.resolve('/data/run.exe'), path.resolve('/data/notes.txt'), custom),
    );
    expect(result).toEqual({ folders: [], files: [custom] });
  });

  it('ignores relative paths and junk', () => {
    const json = history('a.png', '..\\a.png', '', 7, null, undefined, { x: 1 }, ['b.png']);
    expect(plan({}, json)).toEqual({ folders: [], files: [] });
  });

  it('plans no files for a missing, corrupt or odd history', () => {
    for (const json of [null, '', '{ nope', '[]', '{"items": 4}', '{"items": null}', 'null']) {
      expect(plan({}, json)).toEqual({ folders: [], files: [] });
    }
  });

  it('leaves missing, empty and unreadable folders alone', () => {
    expect(plan({ [pictures]: [], [videos]: null }, null).folders).toEqual([]);
  });
});

describe('executeCleanup', () => {
  const deps = (kinds: Record<string, 'file' | 'dir'>, clock: () => number = () => 0) => {
    const trashed: string[] = [];
    return {
      trashed,
      deps: {
        trash: (target: string) => {
          trashed.push(target);
          return target.includes('locked') ? Promise.reject(new Error('busy')) : Promise.resolve();
        },
        kindOf: (target: string) => kinds[target] ?? null,
        now: clock,
      },
    };
  };

  it('moves folders then files, skips what is not the planned kind, and survives a failure', async () => {
    const { trashed, deps: d } = deps({ a: 'dir', b: 'file', locked: 'file', c: 'file', d: 'dir' });
    const moved = await executeCleanup(
      { folders: ['a', 'missing'], files: ['b', 'locked', 'c', 'd'] },
      d,
      10,
    );
    expect(trashed).toEqual(['a', 'b', 'locked', 'c']);
    expect(moved).toBe(3);
  });

  it('stops when the deadline has passed', async () => {
    let now = 0;
    const { trashed, deps: d } = deps({ a: 'file', b: 'file', c: 'file' }, () => (now += 5));
    await executeCleanup({ folders: [], files: ['a', 'b', 'c'] }, d, 12);
    expect(trashed).toEqual(['a', 'b']);
  });
});

describe('real file system helpers', () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'framecapt-uninst-'));
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('lists a real folder and reports kinds', () => {
    fs.writeFileSync(path.join(dir, 'a.png'), 'x');
    fs.mkdirSync(path.join(dir, 'sub'));
    expect(listRealDir(dir)?.sort((x, y) => x.name.localeCompare(y.name))).toEqual([
      { name: 'a.png', isFile: true },
      { name: 'sub', isFile: false },
    ]);
    expect(realKindOf(path.join(dir, 'a.png'))).toBe('file');
    expect(realKindOf(path.join(dir, 'sub'))).toBe('dir');
    expect(realKindOf(path.join(dir, 'nope'))).toBeNull();
    expect(listRealDir(path.join(dir, 'nope'))).toBeNull();
    expect(listRealDir(path.join(dir, 'a.png'))).toBeNull();
  });

  it('does not follow a junction or link to a folder', () => {
    const target = path.join(dir, 'target');
    fs.mkdirSync(target);
    fs.writeFileSync(path.join(target, 'a.png'), 'x');
    const link = path.join(dir, 'link');
    fs.symlinkSync(target, link, 'junction');
    expect(listRealDir(link)).toBeNull();
    expect(realKindOf(link)).toBeNull();
    // A file reached through the link is not "direct" either.
    expect(realKindOf(path.join(link, 'a.png'))).toBeNull();
    expect(realKindOf(path.join(target, 'a.png'))).toBe('file');
  });
});
