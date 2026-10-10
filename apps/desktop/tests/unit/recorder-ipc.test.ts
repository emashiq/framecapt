import { describe, expect, it } from 'vitest';
import { ipcContract } from '../../src/shared/ipc-contract';
import {
  AddPanelRequestSchema,
  AppendChunkRequestSchema,
  DEFAULT_RECORD_OPTIONS,
  EngineCommandSchema,
  EngineEventSchema,
  FinishSessionRequestSchema,
  MAX_CHUNK_BYTES,
  RecorderStartRequestSchema,
  RemovePanelRequestSchema,
  SetPanelHiddenRequestSchema,
} from '../../src/shared/recorder-ipc';

describe('recorder:start', () => {
  const schema = RecorderStartRequestSchema;

  describe('a meeting recording', () => {
    const meeting = { meetingId: 'm-1', app: 'zoom', sourceId: 'window:123:0' } as const;
    const options = DEFAULT_RECORD_OPTIONS;

    it('needs a meeting, and only a meeting recording takes one', () => {
      expect(schema.safeParse({ target: 'meeting', meeting, options }).success).toBe(true);
      expect(schema.safeParse({ target: 'meeting', options }).success).toBe(false);
      expect(schema.safeParse({ target: 'screen', meeting, options }).success).toBe(false);
      expect(
        schema.safeParse({ target: 'window', sourceId: 'window:1:0', meeting, options }).success,
      ).toBe(false);
    });

    it('may name the screen to record beside the meeting', () => {
      expect(
        schema.safeParse({ target: 'meeting', meeting, displayId: '1001', options }).success,
      ).toBe(true);
    });

    it('checks the meeting and rejects extra keys', () => {
      expect(
        schema.safeParse({ target: 'meeting', meeting: { ...meeting, app: 'skype' }, options })
          .success,
      ).toBe(false);
      expect(
        schema.safeParse({ target: 'meeting', meeting: { ...meeting, sourceId: '../x' }, options })
          .success,
      ).toBe(false);
      expect(
        schema.safeParse({ target: 'meeting', meeting: { ...meeting, title: 'Q3 plan' }, options })
          .success,
      ).toBe(false);
    });
  });

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

describe('commands on one of several recordings', () => {
  it('accept an optional session id (and nothing else); a toolbar names none', () => {
    for (const channel of [
      'recorder:pause',
      'recorder:resume',
      'recorder:stop',
      'recorder:cancel',
      'recorder:reset',
      'recorder:screenshot',
    ] as const) {
      const schema = ipcContract[channel].request;
      expect(schema.safeParse(undefined).success).toBe(true);
      expect(schema.safeParse({ sessionId: 'abc' }).success).toBe(true);
      expect(schema.safeParse({ sessionId: '' }).success).toBe(false);
      expect(schema.safeParse({ sessionId: 'abc', extra: 1 }).success).toBe(false);
    }
    const mute = ipcContract['recorder:toggleMute'].request;
    expect(mute.safeParse({ source: 'mic' }).success).toBe(true);
    expect(mute.safeParse({ source: 'mic', sessionId: 'abc' }).success).toBe(true);
    expect(mute.safeParse({ source: 'mic', sessionId: 5 }).success).toBe(false);
    const choice = ipcContract['recorder:resolveChoice'].request;
    expect(choice.safeParse({ answer: 'cancel', sessionId: 'abc' }).success).toBe(true);
  });

  it('stopAll is the main window only', () => {
    expect([...ipcContract['recorder:stopAll'].roles]).toEqual(['main']);
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
      {
        cmd: 'addPanel',
        requestId: 'r',
        slot: 1,
        sourceId: 'screen:2:0',
        kind: 'screen',
        region: { x: 0, y: 0, width: 640, height: 360 },
        displaySize: { width: 1920, height: 1080 },
      },
      { cmd: 'removePanel', slot: 3 },
      { cmd: 'setPanelHidden', slot: 0, hidden: true, placeholder: 'meeting-hidden' },
    ]) {
      expect(EngineCommandSchema.safeParse(command).success, JSON.stringify(command)).toBe(true);
    }
    expect(EngineCommandSchema.safeParse({ cmd: 'eval', code: 'x' }).success).toBe(false);
    // Slot 0 is the recording itself: a panel is 1..3, only hiding may name slot 0.
    expect(EngineCommandSchema.safeParse({ cmd: 'removePanel', slot: 0 }).success).toBe(false);
    expect(EngineCommandSchema.safeParse({ cmd: 'removePanel', slot: 4 }).success).toBe(false);
    expect(
      EngineCommandSchema.safeParse({
        cmd: 'setPanelHidden',
        slot: 1,
        hidden: true,
        placeholder: 'free text',
      }).success,
    ).toBe(false);
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
    expect(
      EngineEventSchema.safeParse({ type: 'panelAdded', requestId: 'r', slot: 2 }).success,
    ).toBe(true);
    expect(
      EngineEventSchema.safeParse({ type: 'panelFailed', requestId: 'r', code: 'x', message: 'y' })
        .success,
    ).toBe(true);
    expect(EngineEventSchema.safeParse({ type: 'panelLost', slot: 1 }).success).toBe(true);
    expect(EngineEventSchema.safeParse({ type: 'panelLost', slot: 0 }).success).toBe(false);
    expect(EngineEventSchema.safeParse({ type: 'nope' }).success).toBe(false);
    expect(EngineEventSchema.safeParse({ type: 'trackEnded', source: 'camera' }).success).toBe(
      false,
    );
  });
});

describe('panel requests', () => {
  it('a window panel needs its source, a screen panel a display or a source', () => {
    expect(AddPanelRequestSchema.safeParse({ kind: 'region' }).success).toBe(true);
    expect(AddPanelRequestSchema.safeParse({ kind: 'window' }).success).toBe(false);
    expect(
      AddPanelRequestSchema.safeParse({ kind: 'window', sourceId: 'window:5:0' }).success,
    ).toBe(true);
    expect(AddPanelRequestSchema.safeParse({ kind: 'screen' }).success).toBe(false);
    expect(AddPanelRequestSchema.safeParse({ kind: 'screen', displayId: '2' }).success).toBe(true);
    expect(
      AddPanelRequestSchema.safeParse({ kind: 'screen', sourceId: 'screen:2:0' }).success,
    ).toBe(true);
    expect(
      AddPanelRequestSchema.safeParse({ kind: 'window', sourceId: 'not a source' }).success,
    ).toBe(false);
    expect(AddPanelRequestSchema.safeParse({ kind: 'region', extra: 1 }).success).toBe(false);
  });

  it('remove and hide name a slot', () => {
    expect(RemovePanelRequestSchema.safeParse({ slot: 2 }).success).toBe(true);
    expect(RemovePanelRequestSchema.safeParse({ slot: 0 }).success).toBe(false);
    expect(
      SetPanelHiddenRequestSchema.safeParse({ slot: 0, hidden: true, placeholder: 'share-paused' })
        .success,
    ).toBe(true);
    expect(SetPanelHiddenRequestSchema.safeParse({ slot: 2, hidden: true }).success).toBe(false);
  });
});
