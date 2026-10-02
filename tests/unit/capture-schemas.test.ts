import { describe, expect, it } from 'vitest';
import {
  CaptureGrantRequestSchema,
  DIAGNOSTICS_MAX_BYTES,
  ListSourcesRequestSchema,
  SaveDiagnosticsRequestSchema,
} from '../../src/shared/capture-schemas';
import { ipcContract } from '../../src/shared/ipc-contract';

describe('capture contract', () => {
  it('only allows main and recorder to request grants', () => {
    expect([...ipcContract['capture:grant'].roles]).toEqual(['main', 'recorder']);
    expect([...ipcContract['diagnostics:saveRecording'].roles]).toEqual(['main']);
  });

  it('grant requests need a well-formed desktopCapturer source id', () => {
    const ok = (sourceId: string) =>
      CaptureGrantRequestSchema.safeParse({ sourceId, systemAudio: false }).success;
    expect(ok('screen:0:0')).toBe(true);
    expect(ok('window:12062870:0')).toBe(true);
    expect(ok('')).toBe(false);
    expect(ok('screen:x:0')).toBe(false);
    expect(ok('../../etc/passwd')).toBe(false);
    expect(CaptureGrantRequestSchema.safeParse({ sourceId: 'screen:0:0' }).success).toBe(false);
  });

  it('caps thumbnail width and requires at least one source type', () => {
    expect(
      ListSourcesRequestSchema.safeParse({ types: ['screen'], thumbnailWidth: 320 }).success,
    ).toBe(true);
    expect(
      ListSourcesRequestSchema.safeParse({ types: ['screen'], thumbnailWidth: 321 }).success,
    ).toBe(false);
    expect(ListSourcesRequestSchema.safeParse({ types: [] }).success).toBe(false);
  });

  it('diagnostics saves take bytes only (no path), non-empty and size-capped', () => {
    const parse = (value: unknown) => SaveDiagnosticsRequestSchema.safeParse(value).success;
    expect(parse({ ext: 'webm', data: new ArrayBuffer(10) })).toBe(true);
    expect(parse({ ext: 'webm', data: new ArrayBuffer(0) })).toBe(false);
    expect(parse({ ext: 'exe', data: new ArrayBuffer(10) })).toBe(false);
    expect(parse({ ext: 'webm', data: 'not bytes' })).toBe(false);
    expect(DIAGNOSTICS_MAX_BYTES).toBe(200 * 1024 * 1024);
    const unknownKeys = SaveDiagnosticsRequestSchema.parse({
      ext: 'png',
      data: new ArrayBuffer(1),
      path: 'C:/x',
    });
    expect('path' in unknownKeys).toBe(false);
  });
});
