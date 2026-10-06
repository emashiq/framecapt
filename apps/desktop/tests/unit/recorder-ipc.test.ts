import { describe, expect, it } from 'vitest';
import { ipcContract } from '../../src/shared/ipc-contract';
import {
  AppendChunkRequestSchema,
  DEFAULT_RECORD_OPTIONS,
  EngineCommandSchema,
  EngineEventSchema,
  FinishSessionRequestSchema,
  MAX_CHUNK_BYTES,
  RecorderStartRequestSchema,
} from '../../src/shared/recorder-ipc';

describe('recorder:start', () => {
  const schema = RecorderStartRequestSchema;

  it('accepts screen, region and window requests with options', () => {
    expect(schema.safeParse({ target: 'screen', options: DEFAULT_RECORD_OPTIONS }).success).toBe(
      true,
    );
    expect(
      schema.safeParse({
        target: 'screen',
        displayId: '3590684614',
        options: DEFAULT_RECORD_OPTIONS,
      }).success,
    ).toBe(true);
    expect(schema.safeParse({ target: 'region', options: DEFAULT_RECORD_OPTIONS }).success).toBe(
      true,
    );
    expect(
      schema.safeParse({
        target: 'window',
        sourceId: 'window:123:0',
        options: DEFAULT_RECORD_OPTIONS,
      }).success,
    ).toBe(true);
  });

  it('needs a sourceId for a window and rejects odd source ids', () => {
    expect(schema.safeParse({ target: 'window', options: DEFAULT_RECORD_OPTIONS }).success).toBe(
      false,
    );
    expect(
      schema.safeParse({ target: 'window', sourceId: '../etc', options: DEFAULT_RECORD_OPTIONS })
        .success,
    ).toBe(false);
  });

  it('validates the options', () => {
    const base = { target: 'screen' as const };
    expect(
      schema.safeParse({ ...base, options: { ...DEFAULT_RECORD_OPTIONS, fps: 45 } }).success,
    ).toBe(false);
    expect(
      schema.safeParse({ ...base, options: { ...DEFAULT_RECORD_OPTIONS, quality: '4k' } }).success,
    ).toBe(false);
    expect(schema.safeParse({ ...base }).success).toBe(false);
    expect(
      schema.safeParse({
        ...base,
        options: { ...DEFAULT_RECORD_OPTIONS, mic: { enabled: true, deviceId: 'x'.repeat(300) } },
      }).success,
    ).toBe(false);
    expect(
      schema.safeParse({
        ...base,
        options: { ...DEFAULT_RECORD_OPTIONS, fps: 60, quality: 'source' },
      }).success,
    ).toBe(true);
  });

  it('only the main window may start a recording, the toolbar only controls it', () => {
    expect([...ipcContract['recorder:start'].roles]).toEqual(['main']);
    for (const channel of [
      'recorder:pause',
      'recorder:resume',
      'recorder:stop',
      'recorder:toggleMute',
    ] as const) {
      expect([...ipcContract[channel].roles]).toEqual(['main', 'toolbar']);
    }
  });
});

describe('session channels', () => {
  it('append: validates session id, seq and the chunk size', () => {
    const bytes = new ArrayBuffer(10);
    expect(AppendChunkRequestSchema.safeParse({ sessionId: 's', seq: 0, bytes }).success).toBe(
      true,
    );
    expect(
      AppendChunkRequestSchema.safeParse({
        sessionId: 's',
        seq: 0,
        bytes,
        queued: { chunks: 3, bytes: 4096 },
      }).success,
    ).toBe(true);
    expect(
      AppendChunkRequestSchema.safeParse({
        sessionId: 's',
        seq: 0,
        bytes,
        queued: { chunks: -1, bytes: 0 },
      }).success,
    ).toBe(false);
    expect(AppendChunkRequestSchema.safeParse({ sessionId: '', seq: 0, bytes }).success).toBe(
      false,
    );
    expect(AppendChunkRequestSchema.safeParse({ sessionId: 's', seq: -1, bytes }).success).toBe(
      false,
    );
    expect(AppendChunkRequestSchema.safeParse({ sessionId: 's', seq: 1.5, bytes }).success).toBe(
      false,
    );
    expect(
      AppendChunkRequestSchema.safeParse({ sessionId: 's', seq: 0, bytes: new ArrayBuffer(0) })
        .success,
    ).toBe(false);
    expect(
      AppendChunkRequestSchema.safeParse({
        sessionId: 's',
        seq: 0,
        bytes: new ArrayBuffer(MAX_CHUNK_BYTES),
      }).success,
    ).toBe(true);
    expect(
      AppendChunkRequestSchema.safeParse({
        sessionId: 's',
        seq: 0,
        bytes: new ArrayBuffer(MAX_CHUNK_BYTES + 1),
      }).success,
    ).toBe(false);
    // A typed array or a plain array is not accepted in place of an ArrayBuffer.
    expect(
      AppendChunkRequestSchema.safeParse({ sessionId: 's', seq: 0, bytes: new Uint8Array(4) })
        .success,
    ).toBe(false);
    expect(
      AppendChunkRequestSchema.safeParse({ sessionId: 's', seq: 0, bytes: [1, 2] }).success,
    ).toBe(false);
  });

  it('finish: lastSeq may be -1 (nothing recorded) but not lower', () => {
    expect(FinishSessionRequestSchema.safeParse({ sessionId: 's', lastSeq: -1 }).success).toBe(
      true,
    );
    expect(FinishSessionRequestSchema.safeParse({ sessionId: 's', lastSeq: -2 }).success).toBe(
      false,
    );
  });
});

describe('engine messages', () => {
  it('commands are a closed set', () => {
    for (const command of [
      { cmd: 'pause' },
      { cmd: 'resume' },
      { cmd: 'abort' },
      { cmd: 'mute', source: 'mic', muted: true },
      { cmd: 'levels', enabled: false },
      { cmd: 'start', requestId: 'r', sessionId: 's' },
      { cmd: 'stop', requestId: 'r' },
    ]) {
      expect(EngineCommandSchema.safeParse(command).success, JSON.stringify(command)).toBe(true);
    }
    expect(EngineCommandSchema.safeParse({ cmd: 'eval', code: 'x' }).success).toBe(false);
    expect(
      EngineCommandSchema.safeParse({ cmd: 'mute', source: 'camera', muted: true }).success,
    ).toBe(false);
  });

  it('events carry only what main needs', () => {
    expect(
      EngineEventSchema.safeParse({
        type: 'prepared',
        requestId: 'r',
        mime: 'video/webm;codecs=vp9,opus',
        width: 1920,
        height: 804,
        audio: { mic: false, system: true },
      }).success,
    ).toBe(true);
    expect(EngineEventSchema.safeParse({ type: 'trackEnded', source: 'mic' }).success).toBe(true);
    expect(EngineEventSchema.safeParse({ type: 'levels', mic: 0.1, system: 0 }).success).toBe(true);
    expect(EngineEventSchema.safeParse({ type: 'sourceLost' }).success).toBe(true);
    expect(EngineEventSchema.safeParse({ type: 'nope' }).success).toBe(false);
    expect(EngineEventSchema.safeParse({ type: 'trackEnded', source: 'camera' }).success).toBe(
      false,
    );
  });
});
