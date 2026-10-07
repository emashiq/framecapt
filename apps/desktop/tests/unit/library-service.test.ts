/**
 * The capture library against real folders in a temp directory: the tree, creating, renaming (with
 * the history paths following and a rollback), deleting only empty folders, moving captures
 * (collisions, a cross-volume fallback, guides) and the "save new captures to" folder.
 */
import { vi } from 'vitest';

vi.mock('../../src/main/logger', () => ({
  log: { info: () => undefined, warn: () => undefined, error: () => undefined },
}));

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { HistoryService } from '../../src/main/history/service';
import { LibraryService } from '../../src/main/library/service';
import { LibraryStore } from '../../src/main/library/store';
import { ProjectStore } from '../../src/main/projects/store';
import { fakeTools } from './fake-tools';
import { pngBytes, SAMPLE_DOC } from './project-fixtures';

let base: string;
let shots: string;
let videos: string;
beforeEach(() => {
  base = fs.mkdtempSync(path.join(os.tmpdir(), 'framecapt-lib-'));
  shots = path.join(base, 'Pictures');
  videos = path.join(base, 'Videos');
  fs.mkdirSync(shots);
  fs.mkdirSync(videos);
});
afterEach(() => fs.rmSync(base, { recursive: true, force: true }));

interface Options {
  rename?: (from: string, to: string) => Promise<void>;
  failRewrite?: boolean;
}

function setup(options: Options = {}) {
  const history = new HistoryService({
    dir: path.join(base, 'history'),
    projects: new ProjectStore(path.join(base, 'projects')),
    tools: fakeTools(),
    trashItem: async () => undefined,
    folderOf: (dir) => library.folderOfDir(dir),
  });
  const rewrite = history.rewritePaths.bind(history);
  const capture = { value: null as string | null };
  const trashed: string[] = [];
  const store = new LibraryStore(path.join(base, 'userdata'));
  const library: LibraryService = new LibraryService({
    roots: () => ({ screenshotsDir: shots, recordingsDir: videos }),
    history: {
      ready: Promise.all([history.ready, store.load()]).then(() => undefined),
      items: () => history.items(),
      rewritePaths: (changes) =>
        options.failRewrite ? Promise.reject(new Error('disk full')) : rewrite(changes),
    },
    store,
    captureFolder: {
      get: () => capture.value,
      set: (folder) => {
        capture.value = folder;
      },
    },
    trashItem: async (file) => {
      trashed.push(file);
      fs.rmSync(file, { recursive: true, force: true });
    },
    ...(options.rename && { rename: options.rename }),
  });
  return { history, library, capture, trashed, store };
}

type Setup = ReturnType<typeof setup>;

async function addShot(s: Setup, dir: string, name: string, project = false): Promise<string> {
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, name);
  fs.writeFileSync(file, pngBytes(10, 10, name));
  const { id } = await s.history.addScreenshot({
    path: file,
    width: 10,
    height: 10,
    sizeBytes: 50,
    format: 'png',
    source: 'region',
    ...(project && {
      project: {
        png: pngBytes(10, 10, 'orig'),
        doc: SAMPLE_DOC,
        width: 10,
        height: 10,
        appVersion: '1',
      },
    }),
  });
  return id;
}

async function addVideo(s: Setup, dir: string, name: string): Promise<string> {
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, name);
  fs.writeFileSync(file, 'video-bytes');
  const { id } = await s.history.addVideo({
    path: file,
    format: 'webm',
    durationMs: 1000,
    width: 10,
    height: 10,
    sizeBytes: 11,
    hasAudio: false,
    source: 'screen',
  });
  return id;
}

async function addGuide(s: Setup, dir: string, name: string): Promise<string> {
  const guide = path.join(dir, name);
  fs.mkdirSync(guide, { recursive: true });
  fs.writeFileSync(path.join(guide, 'flow.json'), '{}');
  fs.writeFileSync(path.join(guide, 'step-01.png'), pngBytes(10, 10, 'step'));
  const { id } = await s.history.addFlow({
    path: path.join(guide, 'flow.json'),
    width: 10,
    height: 10,
    sizeBytes: 100,
    stepCount: 1,
  });
  return id;
}

const pathOf = (s: Setup, id: string): string => s.history.get(id)?.path ?? '';
const names = (dir: string): string[] => fs.readdirSync(dir).sort();

describe('tree', () => {
  it('is the union of the folders in both roots and the recorded ones, with counts', async () => {
    const s = setup();
    fs.mkdirSync(path.join(shots, 'Clients', 'Acme'), { recursive: true });
    fs.mkdirSync(path.join(videos, 'Clients', 'Beta'), { recursive: true });
    fs.mkdirSync(path.join(videos, 'Solo'));
    await s.library.createFolder('Only/Recorded').then(() => {
      fs.rmSync(path.join(shots, 'Only'), { recursive: true });
      fs.rmSync(path.join(videos, 'Only'), { recursive: true });
    });
    await addShot(s, path.join(shots, 'Clients', 'Acme'), 'a.png');
    await addShot(s, shots, 'root.png');
    await addVideo(s, path.join(videos, 'Solo'), 'v.webm');
    await addShot(s, path.join(base, 'Elsewhere'), 'x.png');

    const tree = await s.library.tree();
    expect(tree.folders.map((f) => f.path)).toEqual([
      'Clients',
      'Clients/Acme',
      'Clients/Beta',
      'Only',
      'Only/Recorded',
      'Solo',
    ]);
    const info = (p: string) => tree.folders.find((f) => f.path === p);
    expect(info('Clients/Acme')).toMatchObject({
      inScreenshots: true,
      inRecordings: false,
      count: 1,
    });
    expect(info('Clients/Beta')).toMatchObject({
      inScreenshots: false,
      inRecordings: true,
      count: 0,
    });
    expect(info('Solo')?.count).toBe(1);
    expect(info('Only/Recorded')).toMatchObject({ inScreenshots: false, inRecordings: false });
    expect(tree.rootCount).toBe(1);
    expect(tree.otherCount).toBe(1);
  });

  it('ignores hidden folders, step-guide folders and links, and lists a guide as an item', async () => {
    const s = setup();
    fs.mkdirSync(path.join(shots, '.hidden'));
    fs.mkdirSync(path.join(shots, 'Visible'));
    const guideId = await addGuide(s, shots, 'FrameCapt Steps 2026-10-07 at 14.05.09');
    const outside = path.join(base, 'target');
    fs.mkdirSync(outside);
    try {
      fs.symlinkSync(outside, path.join(shots, 'Link'), 'junction');
    } catch {
      /* no permission for links here: the rest still runs */
    }
    const tree = await s.library.tree();
    expect(tree.folders.map((f) => f.path)).toEqual(['Visible']);
    expect(tree.rootCount).toBe(1);
    const view = (await s.history.list()).items.find((i) => i.id === guideId);
    expect(view?.folder).toBeUndefined();
    expect(view?.outside).toBeUndefined();
  });

  it('shows the folder of an item in the history view, and "outside" for other locations', async () => {
    const s = setup();
    const inFolder = await addShot(s, path.join(shots, 'A', 'B'), 'a.png');
    const other = await addShot(s, path.join(base, 'Else'), 'o.png');
    const list = (await s.history.list()).items;
    expect(list.find((i) => i.id === inFolder)?.folder).toBe('A/B');
    expect(list.find((i) => i.id === other)?.outside).toBe(true);
  });
});

describe('createFolder', () => {
  it('creates the folder in both roots and records it; a duplicate is refused', async () => {
    const s = setup();
    await s.library.createFolder('Clients');
    await s.library.createFolder('Clients/Acme');
    expect(fs.statSync(path.join(shots, 'Clients', 'Acme')).isDirectory()).toBe(true);
    expect(fs.statSync(path.join(videos, 'Clients', 'Acme')).isDirectory()).toBe(true);
    await expect(s.library.createFolder('clients')).rejects.toThrow(/already exists/);
    expect(
      JSON.parse(fs.readFileSync(path.join(base, 'userdata', 'library.json'), 'utf8')).folders,
    ).toEqual(['Clients', 'Clients/Acme']);
  });

  it('refuses an invalid path even when the schema was bypassed, and does not create through a link', async () => {
    const s = setup();
    await expect(s.library.createFolder('../escape')).rejects.toThrow();
    expect(fs.existsSync(path.join(base, 'escape'))).toBe(false);
    const target = path.join(base, 'target');
    fs.mkdirSync(target);
    try {
      fs.symlinkSync(target, path.join(shots, 'Link'), 'junction');
    } catch {
      return;
    }
    await expect(s.library.createFolder('Link/Inner')).rejects.toThrow(/link/);
    expect(fs.readdirSync(target)).toEqual([]);
  });
});

describe('renameFolder', () => {
  it('renames in both roots and rewrites every history path under it, keeping projects', async () => {
    const s = setup();
    const shot = await addShot(s, path.join(shots, 'Old', 'Sub'), 'a.png', true);
    const video = await addVideo(s, path.join(videos, 'Old'), 'v.webm');
    const outside = await addShot(s, path.join(base, 'Else'), 'o.png');
    await s.library.createFolder('Other');

    const result = await s.library.renameFolder('Old', 'New');
    expect(result.folder).toBe('New');
    expect(names(shots)).toContain('New');
    expect(names(shots)).not.toContain('Old');
    expect(pathOf(s, shot)).toBe(path.join(shots, 'New', 'Sub', 'a.png'));
    expect(pathOf(s, video)).toBe(path.join(videos, 'New', 'v.webm'));
    expect(pathOf(s, outside)).toBe(path.join(base, 'Else', 'o.png'));
    expect(fs.existsSync(pathOf(s, shot))).toBe(true);
    expect(s.history.get(shot)?.projectId).toBe(shot);
    expect((await s.history.list()).items.find((i) => i.id === shot)).toMatchObject({
      folder: 'New/Sub',
      editable: true,
    });
  });

  it('renames a nested folder, a case-only name, and follows the save folder', async () => {
    const s = setup();
    await s.library.createFolder('A/B');
    await s.library.setCaptureFolder('A/B');
    await s.library.renameFolder('A', 'a');
    expect(names(shots)).toEqual(['a']);
    expect(s.capture.value).toBe('a/B');
    await s.library.renameFolder('a/B', 'C');
    expect(s.capture.value).toBe('a/C');
    expect(names(path.join(shots, 'a'))).toEqual(['C']);
  });

  it('refuses an existing name and an invalid one', async () => {
    const s = setup();
    await s.library.createFolder('A');
    await s.library.createFolder('B');
    await expect(s.library.renameFolder('A', 'b')).rejects.toThrow(/already exists/);
    await expect(s.library.renameFolder('A', 'CON')).rejects.toThrow();
    expect(names(shots)).toEqual(['A', 'B']);
  });

  it('puts the first rename back when the second root fails', async () => {
    const calls: string[] = [];
    const s = setup({
      rename: async (from, to) => {
        calls.push(`${from}>${to}`);
        if (from.startsWith(videos) && to.includes('New')) throw new Error('locked');
        fs.renameSync(from, to);
      },
    });
    const id = await addShot(s, path.join(shots, 'Old'), 'a.png');
    fs.mkdirSync(path.join(videos, 'Old'));
    await expect(s.library.renameFolder('Old', 'New')).rejects.toThrow();
    expect(names(shots)).toEqual(['Old']);
    expect(names(videos)).toEqual(['Old']);
    expect(pathOf(s, id)).toBe(path.join(shots, 'Old', 'a.png'));
    expect(calls).toHaveLength(3); // shots forward, videos failed, shots back
  });

  it('puts the renames back when history cannot be written', async () => {
    const s = setup({ failRewrite: true });
    const id = await addShot(s, path.join(shots, 'Old'), 'a.png');
    await expect(s.library.renameFolder('Old', 'New')).rejects.toThrow();
    expect(names(shots)).toEqual(['Old']);
    expect(pathOf(s, id)).toBe(path.join(shots, 'Old', 'a.png'));
  });
});

describe('deleteFolder', () => {
  it('deletes an empty folder (desktop.ini and Thumbs.db aside) in both roots and forgets it', async () => {
    const s = setup();
    await s.library.createFolder('Empty');
    fs.writeFileSync(path.join(shots, 'Empty', 'desktop.ini'), '[x]');
    fs.writeFileSync(path.join(videos, 'Empty', 'Thumbs.db'), 'x');
    await s.library.deleteFolder('Empty');
    expect(names(shots)).toEqual([]);
    expect(names(videos)).toEqual([]);
    expect((await s.library.tree()).folders).toEqual([]);
  });

  it('refuses a folder with a capture, an unknown file or a subfolder, and touches nothing', async () => {
    const s = setup();
    const id = await addShot(s, path.join(shots, 'Full'), 'a.png');
    await expect(s.library.deleteFolder('Full')).rejects.toThrow(/not empty/);
    fs.mkdirSync(path.join(videos, 'Notes'));
    fs.writeFileSync(path.join(videos, 'Notes', 'readme.txt'), 'mine');
    await expect(s.library.deleteFolder('Notes')).rejects.toThrow(/not empty/);
    await s.library.createFolder('Parent/Child');
    await expect(s.library.deleteFolder('Parent')).rejects.toThrow(/not empty|subfolders/);
    expect(fs.existsSync(pathOf(s, id))).toBe(true);
    expect(fs.existsSync(path.join(videos, 'Notes', 'readme.txt'))).toBe(true);
  });

  it('refuses while history still lists missing captures there', async () => {
    const s = setup();
    const id = await addShot(s, path.join(shots, 'Gone'), 'a.png');
    fs.rmSync(pathOf(s, id));
    await expect(s.library.deleteFolder('Gone')).rejects.toThrow(/History still lists/);
  });

  it('clears the save folder when it is deleted', async () => {
    const s = setup();
    await s.library.setCaptureFolder('Save');
    await s.library.deleteFolder('Save');
    expect(s.capture.value).toBeNull();
  });
});

describe('moveContentsUp', () => {
  it('moves captures and subfolders to the parent, renaming clashes, and removes the folder', async () => {
    const s = setup();
    const a = await addShot(s, path.join(shots, 'P', 'F'), 'same.png');
    const b = await addShot(s, path.join(shots, 'P'), 'same.png');
    const c = await addShot(s, path.join(shots, 'P', 'F', 'Deep'), 'deep.png');
    const v = await addVideo(s, path.join(videos, 'P', 'F'), 'v.webm');
    fs.writeFileSync(path.join(shots, 'P', 'F', 'desktop.ini'), '[x]');

    const { moved } = await s.library.moveContentsUp('P/F');
    expect(moved).toBe(3);
    expect(fs.existsSync(path.join(shots, 'P', 'F'))).toBe(false);
    expect(fs.existsSync(path.join(videos, 'P', 'F'))).toBe(false);
    expect(pathOf(s, b)).toBe(path.join(shots, 'P', 'same.png'));
    expect(pathOf(s, a)).toBe(path.join(shots, 'P', 'same (2).png'));
    expect(pathOf(s, c)).toBe(path.join(shots, 'P', 'Deep', 'deep.png'));
    expect(pathOf(s, v)).toBe(path.join(videos, 'P', 'v.webm'));
    for (const id of [a, b, c, v]) expect(fs.existsSync(pathOf(s, id))).toBe(true);
  });

  it('moves to the library root when the folder is top level', async () => {
    const s = setup();
    const id = await addShot(s, path.join(shots, 'Top'), 'a.png');
    await s.library.moveContentsUp('Top');
    expect(pathOf(s, id)).toBe(path.join(shots, 'a.png'));
    expect(names(shots)).toEqual(['a.png']);
  });
});

describe('moveItems', () => {
  it('moves screenshots, recordings and guides with a rename and updates history', async () => {
    const s = setup();
    const shot = await addShot(s, shots, 'a.png', true);
    const video = await addVideo(s, videos, 'v.webm');
    const guide = await addGuide(s, shots, 'FrameCapt Steps 2026-10-07 at 14.05.09');
    const result = await s.library.moveItems([shot, video, guide], 'Clients/Acme');
    expect(result).toEqual({ moved: 3, failed: [] });
    expect(pathOf(s, shot)).toBe(path.join(shots, 'Clients', 'Acme', 'a.png'));
    expect(pathOf(s, video)).toBe(path.join(videos, 'Clients', 'Acme', 'v.webm'));
    expect(pathOf(s, guide)).toBe(
      path.join(shots, 'Clients', 'Acme', 'FrameCapt Steps 2026-10-07 at 14.05.09', 'flow.json'),
    );
    expect(fs.existsSync(path.join(path.dirname(pathOf(s, guide)), 'step-01.png'))).toBe(true);
    expect(fs.existsSync(path.join(shots, 'FrameCapt Steps 2026-10-07 at 14.05.09'))).toBe(false);
    // The editable project is keyed by the history id, which did not change.
    expect(s.history.get(shot)?.projectId).toBe(shot);
    expect((await s.history.list()).items.find((i) => i.id === shot)?.editable).toBe(true);
  });

  it('gives a free name on a collision and never overwrites', async () => {
    const s = setup();
    const keep = await addShot(s, path.join(shots, 'Dest'), 'a.png');
    const mover = await addShot(s, shots, 'a.png');
    await s.library.moveItems([mover], 'Dest');
    expect(pathOf(s, mover)).toBe(path.join(shots, 'Dest', 'a (2).png'));
    expect(fs.readFileSync(pathOf(s, keep)).equals(pngBytes(10, 10, 'a.png'))).toBe(true);
    expect(names(path.join(shots, 'Dest'))).toEqual(['a (2).png', 'a.png']);
  });

  it('moves back to the root with null, and skips what is already there', async () => {
    const s = setup();
    const id = await addShot(s, path.join(shots, 'F'), 'a.png');
    expect((await s.library.moveItems([id], 'F')).moved).toBe(0);
    expect((await s.library.moveItems([id], null)).moved).toBe(1);
    expect(pathOf(s, id)).toBe(path.join(shots, 'a.png'));
  });

  it('brings a capture from another location into the folder of its kind', async () => {
    const s = setup();
    const id = await addVideo(s, path.join(base, 'Else'), 'v.webm');
    await s.library.moveItems([id], 'Imported');
    expect(pathOf(s, id)).toBe(path.join(videos, 'Imported', 'v.webm'));
  });

  it('reports a missing file and unknown ids without stopping the rest', async () => {
    const s = setup();
    const gone = await addShot(s, shots, 'gone.png');
    const fine = await addShot(s, shots, 'fine.png');
    fs.rmSync(pathOf(s, gone));
    const result = await s.library.moveItems(
      [gone, fine, '0f0e0d0c-0b0a-4908-8706-050403020100'],
      'F',
    );
    expect(result.moved).toBe(1);
    expect(result.failed.map((f) => f.id).sort()).toEqual(
      [gone, '0f0e0d0c-0b0a-4908-8706-050403020100'].sort(),
    );
    expect(pathOf(s, fine)).toBe(path.join(shots, 'F', 'fine.png'));
  });

  it('falls back to copy, size check and the Recycle Bin when the rename crosses volumes (EXDEV)', async () => {
    const s = setup({
      rename: async (from, to) => {
        if (from.includes('Else')) {
          throw Object.assign(new Error('cross-device'), { code: 'EXDEV' });
        }
        fs.renameSync(from, to);
      },
    });
    const id = await addShot(s, path.join(base, 'Else'), 'a.png');
    const original = path.join(base, 'Else', 'a.png');
    await s.library.moveItems([id], 'F');
    expect(pathOf(s, id)).toBe(path.join(shots, 'F', 'a.png'));
    expect(fs.existsSync(pathOf(s, id))).toBe(true);
    expect(s.trashed).toEqual([original]);
    expect(fs.existsSync(original)).toBe(false);
  });

  it('keeps the original (and removes only its own copy) when the Recycle Bin refuses', async () => {
    const s = setup({
      rename: async (from, to) => {
        if (from.includes('Else')) throw Object.assign(new Error('x'), { code: 'EXDEV' });
        fs.renameSync(from, to);
      },
    });
    const id = await addShot(s, path.join(base, 'Else'), 'a.png');
    const original = path.join(base, 'Else', 'a.png');
    (s.library as unknown as { deps: { trashItem: () => Promise<void> } }).deps.trashItem = () =>
      Promise.reject(new Error('bin full'));
    const result = await s.library.moveItems([id], 'F');
    expect(result.moved).toBe(0);
    expect(result.failed).toHaveLength(1);
    expect(fs.existsSync(original)).toBe(true);
    expect(fs.existsSync(path.join(shots, 'F', 'a.png'))).toBe(false);
    expect(pathOf(s, id)).toBe(original);
  });

  it('puts renames back when history cannot be written', async () => {
    const s = setup({ failRewrite: true });
    const id = await addShot(s, shots, 'a.png');
    await expect(s.library.moveItems([id], 'F')).rejects.toThrow();
    expect(fs.existsSync(path.join(shots, 'a.png'))).toBe(true);
    expect(pathOf(s, id)).toBe(path.join(shots, 'a.png'));
  });
});

describe('the save folder', () => {
  it('saveDir is the root, or the folder inside it, per kind', async () => {
    const s = setup();
    expect(s.library.saveDir('screenshots')).toBe(shots);
    await s.library.setCaptureFolder('Clients/Acme');
    expect(s.capture.value).toBe('Clients/Acme');
    expect(s.library.saveDir('screenshots')).toBe(path.join(shots, 'Clients', 'Acme'));
    expect(s.library.saveDir('recordings')).toBe(path.join(videos, 'Clients', 'Acme'));
    expect(fs.existsSync(path.join(shots, 'Clients', 'Acme'))).toBe(true);
    await s.library.setCaptureFolder(null);
    expect(s.library.saveDir('recordings')).toBe(videos);
  });

  it('falls back to the root for a stored value that is not a valid folder', () => {
    const s = setup();
    s.capture.value = '../../Windows';
    expect(s.library.saveDir('screenshots')).toBe(shots);
  });

  it('refuses an invalid folder', async () => {
    const s = setup();
    await expect(s.library.setCaptureFolder('..')).rejects.toThrow();
    expect(s.capture.value).toBeNull();
  });
});
