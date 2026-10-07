import { describe, expect, it } from 'vitest';
import {
  defaultShotFileName,
  detectImageFormat,
  isBlankBitmap,
  isImportableImage,
  MAX_EXPORT_BYTES,
  ShotKindSchema,
  validateImageBytes,
} from '../../src/shared/shots';
import {
  GrabFramesEventSchema,
  StartScreenshotRequestSchema,
  WorkerFrameResultSchema,
} from '../../src/shared/shot-ipc';
import { filterWindows } from '../../src/renderer/lib/filter-windows';

const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0]);
const JPEG = Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 0, 0x10]);

describe('detectImageFormat / validateImageBytes', () => {
  it('recognizes PNG and JPEG by magic bytes', () => {
    expect(detectImageFormat(PNG)).toBe('png');
    expect(detectImageFormat(JPEG)).toBe('jpeg');
  });

  it('rejects everything else, including truncated headers', () => {
    expect(detectImageFormat(Uint8Array.from([0x47, 0x49, 0x46, 0x38]))).toBeNull();
    expect(detectImageFormat(Uint8Array.from([0x89, 0x50, 0x4e]))).toBeNull();
    expect(detectImageFormat(Uint8Array.from([0xff, 0xd8]))).toBeNull();
    expect(detectImageFormat(new Uint8Array())).toBeNull();
    expect(detectImageFormat(Buffer.from('<svg></svg>'))).toBeNull();
  });

  it('accepts matching format and bytes', () => {
    expect(validateImageBytes('png', PNG)).toEqual({ ok: true });
    expect(validateImageBytes('jpeg', JPEG)).toEqual({ ok: true });
  });

  it('rejects a mismatch between claimed format and content', () => {
    expect(validateImageBytes('png', JPEG).ok).toBe(false);
    expect(validateImageBytes('jpeg', PNG).ok).toBe(false);
  });

  it('rejects empty and oversize payloads', () => {
    expect(validateImageBytes('png', new Uint8Array()).ok).toBe(false);
    expect(validateImageBytes('png', PNG, PNG.length - 1).ok).toBe(false);
    expect(validateImageBytes('png', PNG, PNG.length).ok).toBe(true);
    expect(MAX_EXPORT_BYTES).toBe(200 * 1024 * 1024);
  });
});

describe('defaultShotFileName', () => {
  it('formats local time without colons', () => {
    const date = new Date(2026, 9, 2, 14, 5, 9);
    expect(defaultShotFileName(date, 'png')).toBe('FrameCapt 2026-10-02 at 14.05.09.png');
    expect(defaultShotFileName(date, 'jpeg')).toBe('FrameCapt 2026-10-02 at 14.05.09.jpg');
  });

  it('zero-pads every field', () => {
    const date = new Date(2026, 0, 3, 1, 2, 3);
    expect(defaultShotFileName(date, 'png')).toBe('FrameCapt 2026-01-03 at 01.02.03.png');
  });

  it('never contains characters Windows forbids in file names', () => {
    expect(defaultShotFileName(new Date(), 'png')).not.toMatch(/[<>:"/\\|?*]/);
  });
});

describe('isBlankBitmap', () => {
  const size = 128;
  const bitmap = (fill: number) => new Uint8Array(size * size * 4).fill(fill);

  it('treats an all-black or transparent frame as blank', () => {
    expect(isBlankBitmap(bitmap(0), size, size)).toBe(true);
  });

  it('is not blank when any sampled pixel has colour', () => {
    const data = bitmap(0);
    data[2] = 10; // pixel (0,0) red channel
    expect(isBlankBitmap(data, size, size)).toBe(false);
    expect(isBlankBitmap(bitmap(255), size, size)).toBe(false);
  });

  it('treats a zero-size or short buffer as blank', () => {
    expect(isBlankBitmap(new Uint8Array(0), 0, 0)).toBe(true);
    expect(isBlankBitmap(new Uint8Array(16), 10, 10)).toBe(true);
  });
});

describe('screenshot IPC schemas', () => {
  it('requires a sourceId for window captures and validates its shape', () => {
    expect(StartScreenshotRequestSchema.safeParse({ target: 'region' }).success).toBe(true);
    expect(StartScreenshotRequestSchema.safeParse({ target: 'screen' }).success).toBe(true);
    expect(StartScreenshotRequestSchema.safeParse({ target: 'window' }).success).toBe(false);
    expect(
      StartScreenshotRequestSchema.safeParse({ target: 'window', sourceId: 'window:123:0' })
        .success,
    ).toBe(true);
    expect(
      StartScreenshotRequestSchema.safeParse({ target: 'window', sourceId: '../etc' }).success,
    ).toBe(false);
    expect(StartScreenshotRequestSchema.safeParse({ target: 'video' }).success).toBe(false);
    // "import" is where a session came from, not something to capture.
    expect(StartScreenshotRequestSchema.safeParse({ target: 'import' }).success).toBe(false);
    expect(ShotKindSchema.safeParse('import').success).toBe(true);
  });

  it('isImportableImage knows the opened formats by magic bytes, not by name', () => {
    const bytes = (...values: number[]) => Uint8Array.from([...values, 0, 0, 0, 0, 0, 0]);
    expect(isImportableImage(PNG)).toBe(true);
    expect(isImportableImage(JPEG)).toBe(true);
    expect(isImportableImage(bytes(0x47, 0x49, 0x46, 0x38, 0x39, 0x61))).toBe(true); // GIF89a
    expect(isImportableImage(bytes(0x42, 0x4d))).toBe(true); // BMP
    const webp = Uint8Array.from([0x52, 0x49, 0x46, 0x46, 9, 9, 9, 9, 0x57, 0x45, 0x42, 0x50]);
    expect(isImportableImage(webp)).toBe(true);
    const wav = Uint8Array.from([0x52, 0x49, 0x46, 0x46, 9, 9, 9, 9, 0x57, 0x41, 0x56, 0x45]);
    expect(isImportableImage(wav)).toBe(false); // RIFF, but not WebP
    expect(isImportableImage(Uint8Array.from([0x4d, 0x5a, 0x90, 0]))).toBe(false); // an .exe
    expect(isImportableImage(new Uint8Array())).toBe(false);
  });

  it('bounds worker frames (size and dimensions)', () => {
    const frame = (width: number, height: number, bytes = 8) => ({
      requestId: 'r1',
      frames: [{ sourceId: 'screen:1:0', width, height, png: new ArrayBuffer(bytes) }],
    });
    expect(WorkerFrameResultSchema.safeParse(frame(3440, 1440)).success).toBe(true);
    expect(WorkerFrameResultSchema.safeParse(frame(16384, 16384)).success).toBe(true);
    expect(WorkerFrameResultSchema.safeParse(frame(16385, 100)).success).toBe(false);
    expect(WorkerFrameResultSchema.safeParse(frame(0, 100)).success).toBe(false);
    expect(WorkerFrameResultSchema.safeParse(frame(10, 10, 0)).success).toBe(false);
    expect(WorkerFrameResultSchema.safeParse({ requestId: 'r', frames: [] }).success).toBe(false);
  });

  it('bounds all frames of one answer together, not just each one', () => {
    const png = new ArrayBuffer(100 * 1024 * 1024); // one allocation, listed several times
    const many = (count: number) => ({
      requestId: 'r1',
      frames: Array.from({ length: count }, () => ({
        sourceId: 'screen:1:0',
        width: 100,
        height: 100,
        png,
      })),
    });
    expect(WorkerFrameResultSchema.safeParse(many(5)).success).toBe(true); // 500 MB
    expect(WorkerFrameResultSchema.safeParse(many(6)).success).toBe(false); // 600 MB
  });

  it('accepts a grab request with and without synthetic hints', () => {
    expect(
      GrabFramesEventSchema.safeParse({ requestId: 'x', sources: [{ sourceId: 'screen:1:0' }] })
        .success,
    ).toBe(true);
  });
});

describe('filterWindows', () => {
  const windows = [
    { id: 'window:1:0', name: 'Docs - Browser', kind: 'window' as const },
    { id: 'window:2:0', name: 'Terminal', kind: 'window' as const },
  ];

  it('filters case-insensitively and trims', () => {
    expect(filterWindows(windows, '  DOCS ').map((w) => w.id)).toEqual(['window:1:0']);
  });

  it('keeps everything for an empty query and returns a copy', () => {
    const all = filterWindows(windows, '');
    expect(all).toEqual(windows);
    expect(all).not.toBe(windows);
    expect(filterWindows(windows, 'nothing')).toEqual([]);
  });
});
