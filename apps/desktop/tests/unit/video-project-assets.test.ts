import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { VideoProjectStore, VIDEO_ASSET_DIR } from '../../src/main/video-projects/store';
import {
  applyCommand,
  createProject,
  newAudio,
  newImage,
  type VideoProject,
} from '../../src/shared/video-edit';
import { pngBytes } from './project-fixtures';

const ID = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';
const SOURCE = { durationMs: 10_000, width: 1280, height: 720, hasAudio: true };
const sha = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');
const rect = { x: 0, y: 0, width: 100, height: 50 };

let root: string;
let store: VideoProjectStore;
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'framecapt-video-assets-'));
  store = new VideoProjectStore(path.join(root, 'video-projects'));
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

const assetDir = (id = ID): string => path.join(store.rootDir, id, VIDEO_ASSET_DIR);
const names = (id = ID): string[] =>
  fs.existsSync(assetDir(id)) ? fs.readdirSync(assetDir(id)) : [];

function projectWith(assets: { image?: string; audio?: string }): VideoProject {
  let project = createProject(ID, SOURCE);
  if (assets.image) {
    project = applyCommand(project, {
      type: 'addItem',
      item: newImage('i1', assets.image, rect, 0, 1000),
    });
  }
  if (assets.audio) {
    project = applyCommand(project, {
      type: 'addItem',
      item: newAudio('a1', { assetId: assets.audio, ext: 'mp3', name: 'x.mp3', clipMs: 3000 }, 0),
    });
  }
  return project;
}

describe('pictures', () => {
  it('stores a PNG by its sha256 and reports the same id for the same picture', async () => {
    const png = pngBytes(64, 32);
    const id = await store.writePicture(ID, png);
    expect(id).toBe(sha(png));
    expect(names()).toEqual([`${id}.png`]);
    expect(fs.readFileSync(store.assetPath(ID, id, 'png') ?? '')).toEqual(png);
    expect(await store.writePicture(ID, png)).toBe(id);
    expect(names()).toHaveLength(1);
  });

  it('refuses what is not a usable PNG', async () => {
    await expect(
      store.writePicture(ID, Buffer.from('not a png at all, no signature')),
    ).rejects.toThrow();
    await expect(store.writePicture(ID, pngBytes(20_000, 10))).rejects.toThrow(); // beyond the frame limit
    await expect(
      store.writePicture(ID, Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0])),
    ).rejects.toThrow(); // JPEG
    await expect(store.writePicture('../x', pngBytes(8, 8))).rejects.toThrow();
    expect(names()).toEqual([]);
  });
});

describe('audio files', () => {
  it('copies a file as <sha256>.<ext> and hashes what it read', async () => {
    const source = path.join(root, 'My Song (1).mp3');
    fs.writeFileSync(source, 'pretend audio bytes');
    const { assetId, file } = await store.importAudio(ID, source, 'mp3');
    expect(assetId).toBe(sha(Buffer.from('pretend audio bytes')));
    expect(path.basename(file)).toBe(`${assetId}.mp3`);
    expect(fs.readFileSync(file, 'utf8')).toBe('pretend audio bytes');
    // The user's own file is left as it was and no temporary file stays behind.
    expect(fs.existsSync(source)).toBe(true);
    expect(names()).toEqual([`${assetId}.mp3`]);
  });

  it('refuses an extension that is not audio and removes a file on request', async () => {
    const source = path.join(root, 'x.exe');
    fs.writeFileSync(source, 'x');
    await expect(store.importAudio(ID, source, 'exe')).rejects.toThrow();
    await expect(store.importAudio('..', source, 'mp3')).rejects.toThrow();
    const wav = path.join(root, 'x.wav');
    fs.writeFileSync(wav, 'RIFF');
    const { assetId } = await store.importAudio(ID, wav, 'wav');
    await store.removeAsset(ID, assetId, 'wav');
    await store.removeAsset(ID, assetId, 'wav');
    expect(names()).toEqual([]);
  });
});

describe('asset names and paths', () => {
  it('only names of the form <64 hex>.<known extension> resolve, inside the project', () => {
    const id = 'd'.repeat(64);
    expect(store.assetPath(ID, id, 'png')).toBe(path.join(assetDir(), `${id}.png`));
    expect(store.assetPath(ID, id, 'flac')).toBe(path.join(assetDir(), `${id}.flac`));
    for (const [asset, ext] of [
      ['..', 'png'],
      [id, 'exe'],
      [id, 'png/../../x'],
      [`${id.slice(1)}`, 'png'],
      ['D'.repeat(64), 'png'],
      [id, ''],
    ] as const) {
      expect(store.assetPath(ID, asset, ext), `${asset}.${ext}`).toBeNull();
    }
    expect(store.assetPath('../x', id, 'png')).toBeNull();
    expect(store.assetPathByName(ID, `${id}.mp3`)).toBe(path.join(assetDir(), `${id}.mp3`));
    expect(store.assetPathByName(ID, `..\\${id}.mp3`)).toBeUndefined();
    expect(store.assetPathByName(ID, 'project.json')).toBeUndefined();
  });
});

describe('pruning stale assets', () => {
  async function setup() {
    const used = await store.writePicture(ID, pngBytes(40, 40, 'a'));
    const stale = await store.writePicture(ID, pngBytes(40, 40, 'b'));
    const song = path.join(root, 's.mp3');
    fs.writeFileSync(song, 'song');
    const clip = await store.importAudio(ID, song, 'mp3');
    fs.writeFileSync(path.join(assetDir(), 'notes.txt'), 'mine');
    return { used, stale, clip: clip.assetId };
  }

  it('deletes assets no item uses (and only those), keeps the ones that are used', async () => {
    const { used, stale, clip } = await setup();
    const removed = await store.pruneAssets(ID, projectWith({ image: used, audio: clip }), 0);
    expect(removed).toBe(1);
    expect(names().sort()).toEqual([`${clip}.mp3`, 'notes.txt', `${used}.png`].sort());
    expect(names()).not.toContain(`${stale}.png`);
  });

  it('keeps a fresh unused asset until it is old enough (Undo, a file just added)', async () => {
    const { used, stale } = await setup();
    const project = projectWith({ image: used });
    expect(await store.pruneAssets(ID, project, 60_000)).toBe(0);
    expect(names()).toContain(`${stale}.png`);
    const old = new Date(Date.now() - 3_600_000);
    fs.utimesSync(path.join(assetDir(), `${stale}.png`), old, old);
    expect(await store.pruneAssets(ID, project, 60_000)).toBe(1);
    expect(names()).not.toContain(`${stale}.png`);
  });

  it('an empty project prunes everything that looks like an asset; other projects are untouched', async () => {
    const { used } = await setup();
    const other = await store.writePicture(OTHER, pngBytes(30, 30));
    await store.pruneAssets(ID, createProject(ID, SOURCE), 0);
    expect(names().filter((name) => name !== 'notes.txt')).toEqual([]);
    expect(names(OTHER)).toEqual([`${other}.png`]);
    expect(used).toBeTruthy();
  });

  it('removing the project removes its assets with it', async () => {
    await setup();
    await store.write(ID, createProject(ID, SOURCE));
    await store.remove(ID);
    expect(fs.existsSync(path.join(store.rootDir, ID))).toBe(false);
  });
});
