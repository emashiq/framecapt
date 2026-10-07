/**
 * The clipboard rule: files as a `text/uri-list` (Electron 44 has no raw-format writer; the list
 * becomes CF_HDROP on Windows, verified by scripts/check-clipboard-files.mjs), and AutoCopy, the one
 * place that decides what is copied after a capture, a recording, an export or a conversion.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const hoisted = vi.hoisted(() => ({
  store: { items: [] as { types: string[]; data: Record<string, string> }[] },
  failWrites: { value: false },
}));
vi.mock('electron', () => {
  class ClipboardItem {
    readonly types: string[];
    constructor(readonly items: Record<string, unknown>) {
      this.types = Object.keys(items);
    }
    async getType(type: string): Promise<Blob> {
      return new Blob([String(await (this.items[type] as Blob).text())]);
    }
  }
  return {
    ClipboardItem,
    clipboard: {
      write: async (items: InstanceType<typeof ClipboardItem>[]) => {
        if (hoisted.failWrites.value) throw new Error('clipboard is locked');
        hoisted.store.items = items.map((item) => ({ types: item.types, data: {} }));
        for (const [index, item] of items.entries()) {
          for (const type of item.types) {
            const blob = item.items[type] as Blob;
            (hoisted.store.items[index] as { data: Record<string, string> }).data[type] =
              await blob.text();
          }
        }
      },
      read: async () =>
        hoisted.store.items.map((entry) => ({
          types: entry.types,
          getType: async (type: string) => new Blob([entry.data[type] ?? '']),
        })),
    },
    nativeImage: {},
  };
});
vi.mock('../../src/main/logger', () => ({
  log: { info: () => undefined, warn: () => undefined, error: () => undefined },
}));

import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { AutoCopy } from '../../src/main/clipboard/auto-copy';
import {
  clipboardHoldsFiles,
  fileUriList,
  writeFilesToClipboard,
} from '../../src/main/clipboard/files';
import { DEFAULT_SETTINGS, type Settings } from '../../src/shared/settings';

beforeEach(() => {
  hoisted.store.items = [];
  hoisted.failWrites.value = false;
});

const recordingPath = path.resolve('Videos', 'FrameCapt', 'FrameCapt 2026-10-07 at 14.05.09.mp4');

describe('fileUriList', () => {
  it('is one file:// URI per line, CRLF terminated (RFC 2483)', () => {
    const text = fileUriList([recordingPath, path.resolve('other.webm')]);
    const lines = text.split('\r\n');
    expect(lines).toHaveLength(3);
    expect(lines[2]).toBe('');
    expect(lines[0]).toBe(pathToFileURL(recordingPath).href);
    expect(lines[0]).toMatch(/^file:\/\/\//);
    expect(lines[1]).toBe(pathToFileURL(path.resolve('other.webm')).href);
  });

  it('percent-encodes spaces, hashes and non-ASCII so a path with them survives', () => {
    const text = fileUriList([path.resolve('Ünï cöde', 'a #1 (2).mp4')]);
    expect(text).not.toContain(' ');
    expect(text).toContain('%20');
    expect(text).toContain('%23');
    expect(text).toContain('%C3%9C');
    expect(decodeURIComponent(text)).toContain('a #1 (2).mp4');
  });

  it('writes and reads back the same list, and notices when something else was copied', async () => {
    await writeFilesToClipboard([recordingPath]);
    expect(hoisted.store.items).toHaveLength(1);
    expect(hoisted.store.items[0]?.types).toEqual(['text/uri-list']);
    expect(await clipboardHoldsFiles([recordingPath])).toBe(true);
    expect(await clipboardHoldsFiles([path.resolve('different.mp4')])).toBe(false);
    hoisted.store.items = [{ types: ['text/plain'], data: { 'text/plain': 'hello' } }];
    expect(await clipboardHoldsFiles([recordingPath])).toBe(false);
    hoisted.store.items = [];
    expect(await clipboardHoldsFiles([recordingPath])).toBe(false);
  });

  it('an empty list writes nothing', async () => {
    await writeFilesToClipboard([]);
    expect(hoisted.store.items).toEqual([]);
  });
});

function setup(change: (settings: Settings) => void = () => undefined) {
  const settings = structuredClone(DEFAULT_SETTINGS);
  change(settings);
  const images: Uint8Array[] = [];
  const messages: string[] = [];
  const autoCopy = new AutoCopy({
    settings: () => settings,
    notify: (message) => messages.push(message),
    writeImage: async (png) => {
      if (hoisted.failWrites.value) throw new Error('locked');
      images.push(png);
    },
  });
  return { autoCopy, images, messages, settings };
}

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);

describe('AutoCopy screenshots', () => {
  it('copies the PNG and says so', async () => {
    const { autoCopy, images, messages } = setup();
    expect(await autoCopy.screenshot(PNG)).toBe(true);
    expect(images).toEqual([PNG]);
    expect(messages).toEqual(['Copied to clipboard']);
  });

  it('is on by default for screenshots and recordings', () => {
    expect(DEFAULT_SETTINGS.screenshots.autoCopy).toBe(true);
    expect(DEFAULT_SETTINGS.recording.autoCopy).toBe(true);
  });

  it('a quiet copy (the caller says it itself) shows no toast', async () => {
    const { autoCopy, messages } = setup();
    expect(await autoCopy.screenshot(PNG, { quiet: true })).toBe(true);
    expect(messages).toEqual([]);
  });

  it('does nothing when the screenshot setting is off (the recording setting does not matter)', async () => {
    const { autoCopy, images, messages } = setup((settings) => {
      settings.screenshots.autoCopy = false;
    });
    expect(await autoCopy.screenshot(PNG)).toBe(false);
    expect(images).toEqual([]);
    expect(messages).toEqual([]);
  });

  it('a locked clipboard is not an error and gives no toast', async () => {
    const { autoCopy, messages } = setup();
    hoisted.failWrites.value = true;
    expect(await autoCopy.screenshot(PNG)).toBe(false);
    expect(messages).toEqual([]);
  });
});

describe('AutoCopy files (recordings, exported videos, guide folders)', () => {
  it('puts the file on the clipboard as a file list', async () => {
    const { autoCopy, messages } = setup();
    expect(await autoCopy.file(recordingPath)).toBe(true);
    expect(await clipboardHoldsFiles([recordingPath])).toBe(true);
    expect(messages).toEqual(['Copied to clipboard']);
  });

  it('does nothing when the recording setting is off (the screenshot setting does not matter)', async () => {
    const { autoCopy, messages } = setup((settings) => {
      settings.recording.autoCopy = false;
    });
    expect(await autoCopy.file(recordingPath)).toBe(false);
    expect(hoisted.store.items).toEqual([]);
    expect(messages).toEqual([]);
  });

  it('a locked clipboard is not an error', async () => {
    const { autoCopy } = setup();
    hoisted.failWrites.value = true;
    expect(await autoCopy.file(recordingPath)).toBe(false);
  });

  it('after a conversion the new file replaces the old one, silently, only while the old one is still copied', async () => {
    const oldFile = path.resolve('Clip.webm');
    const newFile = path.resolve('Clip.mp4');
    const { autoCopy, messages } = setup();
    await autoCopy.file(oldFile);
    messages.length = 0;
    await autoCopy.replaced({ from: oldFile, to: newFile });
    expect(await clipboardHoldsFiles([newFile])).toBe(true);
    expect(messages).toEqual([]);
  });

  it('leaves the clipboard alone when the user copied something else meanwhile', async () => {
    const oldFile = path.resolve('Clip.webm');
    const { autoCopy } = setup();
    await autoCopy.file(oldFile);
    hoisted.store.items = [{ types: ['text/plain'], data: { 'text/plain': 'my own copy' } }];
    await autoCopy.replaced({ from: oldFile, to: path.resolve('Clip.mp4') });
    expect(hoisted.store.items[0]?.data['text/plain']).toBe('my own copy');
    // And when nothing was copied at all.
    hoisted.store.items = [];
    await autoCopy.replaced({ from: oldFile, to: path.resolve('Clip.mp4') });
    expect(hoisted.store.items).toEqual([]);
  });

  it('does not re-copy when the setting is off', async () => {
    const oldFile = path.resolve('Clip.webm');
    const { autoCopy, settings } = setup();
    await autoCopy.file(oldFile);
    settings.recording.autoCopy = false;
    await autoCopy.replaced({ from: oldFile, to: path.resolve('Clip.mp4') });
    expect(await clipboardHoldsFiles([oldFile])).toBe(true);
  });
});
