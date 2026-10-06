import { describe, expect, it } from 'vitest';
import {
  CAMERA_MARGIN_DIP,
  CAMERA_WINDOW_DIP,
  CameraSetStyleRequestSchema,
  clampInto,
  cornerBounds,
  cornerCenter,
  cornerOfBubble,
  nextCameraSize,
  normalizedCenter,
} from '../../src/shared/camera';
import { cameraRect } from '../../src/shared/compositor-layout';
import { ipcContract } from '../../src/shared/ipc-contract';
import {
  DEFAULT_RECORD_OPTIONS,
  EngineCommandSchema,
  PreflightChoiceKindSchema,
  RecordOptionsSchema,
  RecorderStartRequestSchema,
} from '../../src/shared/recorder-ipc';
import {
  applyPatch,
  DEFAULT_SETTINGS,
  parseSettings,
  patchFromRecordOptions,
  recordOptionsFromSettings,
  SettingsPatchSchema,
} from '../../src/shared/settings';

const DISPLAY = { x: 0, y: 0, width: 1920, height: 1080 };
const bubble = (x: number, y: number, side = 220) => ({ x, y, width: side, height: side });

describe('camera placement', () => {
  it('a screen recording maps the bubble center into the captured area', () => {
    expect(normalizedCenter(bubble(850, 430), DISPLAY)).toEqual({ nx: 0.5, ny: 0.5 });
    const right = normalizedCenter(bubble(1920 - 220 - 24, 1080 - 220 - 24), DISPLAY);
    expect(right.nx).toBeCloseTo((1920 - 134) / 1920);
    expect(right.ny).toBeCloseTo((1080 - 134) / 1080);
  });

  it('a region offset on a second monitor maps relative to the region', () => {
    const region = { x: -1920, y: 200, width: 800, height: 600 };
    expect(normalizedCenter(bubble(-1920 + 290, 200 + 190), region)).toEqual({ nx: 0.5, ny: 0.5 });
  });

  it('a bubble outside the captured area is pinned to its edge (0..1)', () => {
    const region = { x: 100, y: 100, width: 400, height: 300 };
    expect(normalizedCenter(bubble(-500, -500), region)).toEqual({ nx: 0, ny: 0 });
    expect(normalizedCenter(bubble(5000, 5000), region)).toEqual({ nx: 1, ny: 1 });
  });

  it('window recordings snap to the quadrant of the display the bubble is in', () => {
    const quadrants = [
      [bubble(100, 100), 'tl'],
      [bubble(1500, 100), 'tr'],
      [bubble(100, 800), 'bl'],
      [bubble(1500, 800), 'br'],
    ] as const;
    for (const [rect, corner] of quadrants) expect(cornerOfBubble(rect, DISPLAY)).toBe(corner);
    // A second monitor to the left (negative origin): the quadrant is of that display.
    const left = { x: -1920, y: 0, width: 1920, height: 1080 };
    expect(cornerOfBubble(bubble(-1900, 900), left)).toBe('bl');
  });

  it('the corner is a point of the output, 0 or 1 on each axis', () => {
    expect(cornerCenter('tl')).toEqual({ nx: 0, ny: 0 });
    expect(cornerCenter('tr')).toEqual({ nx: 1, ny: 0 });
    expect(cornerCenter('bl')).toEqual({ nx: 0, ny: 1 });
    expect(cornerCenter('br')).toEqual({ nx: 1, ny: 1 });
    // ... and cameraRect keeps it inside the output, whatever the corner.
    const out = { width: 1280, height: 720 };
    for (const corner of ['tl', 'tr', 'bl', 'br'] as const) {
      const rect = cameraRect(cornerCenter(corner), out, 'l');
      expect(rect.x).toBeGreaterThanOrEqual(0);
      expect(rect.y).toBeGreaterThanOrEqual(0);
      expect(rect.x + rect.width).toBeLessThanOrEqual(out.width);
      expect(rect.y + rect.height).toBeLessThanOrEqual(out.height);
    }
  });

  it('corner bounds sit a margin from the edges of the area, inside it', () => {
    const side = CAMERA_WINDOW_DIP.m;
    expect(cornerBounds(side, 'br', DISPLAY)).toEqual({
      x: 1920 - side - CAMERA_MARGIN_DIP,
      y: 1080 - side - CAMERA_MARGIN_DIP,
      width: side,
      height: side,
    });
    expect(cornerBounds(side, 'tl', DISPLAY)).toMatchObject({
      x: CAMERA_MARGIN_DIP,
      y: CAMERA_MARGIN_DIP,
    });
    // An area smaller than the bubble: never outside it.
    const tiny = { x: 50, y: 60, width: 100, height: 100 };
    expect(cornerBounds(side, 'br', tiny)).toMatchObject({ x: 50, y: 60 });
  });

  it('clampInto moves a bubble back inside the area, and leaves one that does not fit', () => {
    const area = { x: 0, y: 0, width: 800, height: 600 };
    expect(clampInto(bubble(700, -50), area)).toMatchObject({ x: 580, y: 0 });
    expect(clampInto(bubble(100, 100), area)).toEqual(bubble(100, 100));
    expect(clampInto(bubble(0, 0, 900), area)).toEqual(bubble(0, 0, 900));
  });

  it('the size button cycles S, M, L', () => {
    expect(nextCameraSize('s')).toBe('m');
    expect(nextCameraSize('m')).toBe('l');
    expect(nextCameraSize('l')).toBe('s');
  });
});

describe('camera engine command and options', () => {
  const good = { cmd: 'camera', nx: 0.5, ny: 1, size: 'm', shape: 'circle', visible: true };

  it('is bounded: 0..1 positions, known sizes and shapes', () => {
    expect(EngineCommandSchema.safeParse(good).success).toBe(true);
    for (const bad of [
      { ...good, nx: -0.01 },
      { ...good, ny: 1.01 },
      { ...good, nx: Number.NaN },
      { ...good, size: 'xl' },
      { ...good, shape: 'square' },
      { ...good, visible: 'yes' },
      { cmd: 'camera', nx: 0.5, ny: 0.5 },
    ]) {
      expect(EngineCommandSchema.safeParse(bad).success, JSON.stringify(bad)).toBe(false);
    }
  });

  it('camera-missing is a preflight choice', () => {
    expect(PreflightChoiceKindSchema.safeParse('camera-missing').success).toBe(true);
  });

  it('record options parse with and without a camera (an old manifest has none)', () => {
    expect(RecordOptionsSchema.safeParse(DEFAULT_RECORD_OPTIONS).success).toBe(true);
    const camera = { shape: 'rounded', size: 'l', corner: 'tl', deviceId: 'abc' };
    expect(RecordOptionsSchema.safeParse({ ...DEFAULT_RECORD_OPTIONS, camera }).success).toBe(true);
    for (const bad of [
      { ...camera, shape: 'hexagon' },
      { ...camera, corner: 'center' },
      { ...camera, extra: 1 },
      { shape: 'circle', size: 'm' },
      { ...camera, deviceId: 'x'.repeat(300) },
    ]) {
      expect(
        RecordOptionsSchema.safeParse({ ...DEFAULT_RECORD_OPTIONS, camera: bad }).success,
        JSON.stringify(bad),
      ).toBe(false);
    }
    expect(
      RecorderStartRequestSchema.safeParse({
        target: 'screen',
        options: { ...DEFAULT_RECORD_OPTIONS, camera },
      }).success,
    ).toBe(true);
  });
});

describe('camera ipc contract', () => {
  it('setStyle and getStyle belong to the camera window alone; the toolbar only toggles', () => {
    expect(ipcContract['camera:setStyle'].roles).toEqual(['camera']);
    expect(ipcContract['camera:getStyle'].roles).toEqual(['camera']);
    expect(ipcContract['recorder:toggleCamera'].roles).toEqual(['toolbar']);
  });

  it('setStyle takes a non-empty subset of size, shape and visible, nothing else', () => {
    const schema = CameraSetStyleRequestSchema;
    expect(schema.safeParse({ size: 's' }).success).toBe(true);
    expect(schema.safeParse({ size: 'l', shape: 'rounded', visible: false }).success).toBe(true);
    for (const bad of [
      {},
      { size: 'xl' },
      { shape: 'square' },
      { visible: 1 },
      { deviceId: 'x' },
    ]) {
      expect(schema.safeParse(bad).success, JSON.stringify(bad)).toBe(false);
    }
  });
});

describe('camera settings', () => {
  it('defaults: off, circle, medium, bottom right; the default device', () => {
    expect(DEFAULT_SETTINGS.recording).toMatchObject({
      cameraEnabled: false,
      cameraShape: 'circle',
      cameraSize: 'm',
      cameraCorner: 'br',
    });
    expect(DEFAULT_SETTINGS.recording.cameraDeviceId).toBeUndefined();
    expect(recordOptionsFromSettings(DEFAULT_SETTINGS.recording).camera).toBeUndefined();
  });

  it('a settings file from before the camera loads with the defaults', () => {
    const { recording } = structuredClone(DEFAULT_SETTINGS);
    for (const key of ['cameraEnabled', 'cameraShape', 'cameraSize', 'cameraCorner'] as const) {
      delete (recording as Partial<typeof recording>)[key];
    }
    const parsed = parseSettings({ ...DEFAULT_SETTINGS, recording });
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.settings.recording.cameraEnabled).toBe(false);
  });

  it('maps to the camera record option and back, device included', () => {
    const on = applyPatch(DEFAULT_SETTINGS, {
      recording: {
        cameraEnabled: true,
        cameraDeviceId: 'cam-1',
        cameraShape: 'rounded',
        cameraSize: 'l',
        cameraCorner: 'tl',
      },
    });
    const options = recordOptionsFromSettings(on.recording);
    expect(options.camera).toEqual({
      deviceId: 'cam-1',
      shape: 'rounded',
      size: 'l',
      corner: 'tl',
    });
    expect(RecordOptionsSchema.safeParse(options).success).toBe(true);

    const back = applyPatch(DEFAULT_SETTINGS, patchFromRecordOptions(options));
    expect(back.recording).toMatchObject({
      cameraEnabled: true,
      cameraDeviceId: 'cam-1',
      cameraShape: 'rounded',
      cameraSize: 'l',
      cameraCorner: 'tl',
    });
  });

  it('switching the camera off keeps its style; the default device clears the id', () => {
    const on = applyPatch(DEFAULT_SETTINGS, {
      recording: { cameraEnabled: true, cameraDeviceId: 'cam-1', cameraShape: 'rounded' },
    });
    const { camera: _camera, ...withoutCamera } = recordOptionsFromSettings(on.recording);
    const off = applyPatch(on, patchFromRecordOptions(withoutCamera));
    expect(off.recording).toMatchObject({ cameraEnabled: false, cameraShape: 'rounded' });
    const cleared = applyPatch(on, { recording: { cameraDeviceId: null } });
    expect(cleared.recording.cameraDeviceId).toBeUndefined();
    expect(SettingsPatchSchema.safeParse({ recording: { cameraDeviceId: null } }).success).toBe(
      true,
    );
    expect(SettingsPatchSchema.safeParse({ recording: { cameraSize: 'xl' } }).success).toBe(false);
  });
});
