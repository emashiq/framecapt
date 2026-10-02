import type { DisplayInfo } from '../../shared/capture-schemas';
import { checkPixelRect, type Rect } from '../../shared/rect';
import { createAudioMix, type AudioMix } from './audio-graph';
import { CaptureError, mapMediaError } from './errors';
import { grabFullResolutionFrame, type FrameMethod, type FrameMethodChoice } from './frame';
import { startFrameCounter, type FrameCounter } from './frame-counter';
import { detectRecorderFormats } from './recorder-probe';
import {
  createCanvasCrop,
  createTrackProcessorCrop,
  type CanvasDriver,
  type CropMethod,
  type CroppedStream,
} from './region-crop';
import { registerLoop, registerStream, stopStream } from './resource-registry';
import { acquireDisplayStream, acquireMicrophoneStream, releaseStream } from './stream';
import { startTestTone, type TestTone } from './test-tone';

/** Diagnostics-only orchestration of the capture library. Not the production recorder. */

async function save(blob: Blob, ext: 'png' | 'webm' | 'mp4' | 'mkv'): Promise<string> {
  const saved = await window.framelet.invoke('diagnostics:saveRecording', {
    ext,
    data: await blob.arrayBuffer(),
  });
  if (!saved.ok) throw new Error(`Saving failed: ${saved.error.message}`);
  return saved.data.path;
}

export interface ScreenshotTestResult {
  displayId: string;
  /** The method that actually produced the frame (relevant when `auto` was chosen). */
  method: FrameMethod;
  width: number;
  height: number;
  expectedWidth: number;
  expectedHeight: number;
  settingsBefore: { width: number | undefined; height: number | undefined };
  settingsAfter: { width: number | undefined; height: number | undefined };
  pass: boolean;
  acquireMs: number;
  firstFrameMs: number;
  totalMs: number;
  bytes: number;
  path: string;
}

/** Captures one live frame of a display and compares its size to the display's physical size. */
export async function runScreenshotTest(
  display: DisplayInfo,
  sourceId: string,
  method: FrameMethodChoice,
): Promise<ScreenshotTestResult> {
  const started = performance.now();
  const stream = await acquireDisplayStream({ sourceId, systemAudio: false, maxFrameRate: 30 });
  try {
    const acquireMs = performance.now() - started;
    const frame = await grabFullResolutionFrame(stream, method);
    const path = await save(frame.blob, 'png');
    const { width: expectedWidth, height: expectedHeight } = display.physicalSize;
    return {
      displayId: display.id,
      method: frame.method,
      width: frame.width,
      height: frame.height,
      expectedWidth,
      expectedHeight,
      settingsBefore: frame.settingsBefore,
      settingsAfter: frame.settingsAfter,
      pass: frame.width === expectedWidth && frame.height === expectedHeight,
      acquireMs,
      firstFrameMs: frame.firstFrameMs,
      totalMs: frame.totalMs,
      bytes: frame.blob.size,
      path,
    };
  } finally {
    releaseStream(stream);
  }
}

export interface RecordingTestOptions {
  sourceId: string;
  /** Optional crop in pixels of the (screen) source. Requires `displaySize`. */
  region?: Rect | undefined;
  displaySize?: { width: number; height: number } | undefined;
  cropMethod: CropMethod;
  canvasDriver: CanvasDriver;
  systemAudio: boolean;
  /** Microphone: undefined = off, '' = default device, otherwise a deviceId. */
  micDeviceId?: string | undefined;
  durationSec: number;
  playTestTone: boolean;
  fps: number;
}

export const RECORDING_LIMITS = { minSec: 3, maxSec: 10 } as const;

export interface TrackState {
  where: string;
  kind: string;
  readyState: string;
  muted: boolean;
  enabled: boolean;
}

export interface RecordingTestResult {
  mimeType: string;
  bytes: number;
  path: string;
  wallMs: number;
  framesDelivered: number;
  measuredFps: number;
  requestedFps: number;
  /** Size of the video source that was recorded (region size, or the full display stream). */
  videoWidth: number | undefined;
  videoHeight: number | undefined;
  hasAudio: boolean;
  audioSources: string[];
  /** Peak RMS level (0..1) seen per audio source during the recording. */
  peakLevels: Record<string, number>;
  tracksAtStop: TrackState[];
  tracksAfterRelease: TrackState[];
  endedEarly: string[];
  cropMethod: CropMethod | 'none';
  cropFramesOut: number | undefined;
}

function describeTracks(where: string, stream: MediaStream | undefined): TrackState[] {
  return (stream?.getTracks() ?? []).map((track) => ({
    where,
    kind: track.kind,
    readyState: track.readyState,
    muted: track.muted,
    enabled: track.enabled,
  }));
}

function extensionFor(mime: string): 'webm' | 'mp4' | 'mkv' {
  if (mime.startsWith('video/mp4')) return 'mp4';
  if (mime.startsWith('video/x-matroska')) return 'mkv';
  return 'webm';
}

/**
 * Records a short clip with the options given and always releases every track, audio context,
 * timer and helper element, whether it succeeds, fails or is cancelled through `signal`.
 */
export async function runRecordingTest(
  options: RecordingTestOptions,
  signal?: AbortSignal,
): Promise<RecordingTestResult> {
  const durationSec = Math.min(
    RECORDING_LIMITS.maxSec,
    Math.max(RECORDING_LIMITS.minSec, options.durationSec),
  );
  const formats = detectRecorderFormats();
  if (!formats.defaultMime) {
    throw new CaptureError('unknown', 'No supported MediaRecorder format was found.');
  }
  const mimeType = formats.defaultMime;

  let displayStream: MediaStream | undefined;
  let micStream: MediaStream | undefined;
  let crop: CroppedStream | undefined;
  let mix: AudioMix | undefined;
  let tone: TestTone | undefined;
  let counter: FrameCounter | undefined;
  let levelTimer: ReturnType<typeof setInterval> | undefined;
  let stopLevelLoop: (() => void) | undefined;
  let recordedStream: MediaStream | undefined;

  const tracksAtStop: TrackState[] = [];
  const endedEarly: string[] = [];
  const peakLevels: Record<string, number> = {};

  const cleanup = (): void => {
    if (levelTimer !== undefined) clearInterval(levelTimer);
    levelTimer = undefined;
    stopLevelLoop?.();
    stopLevelLoop = undefined;
    counter?.stop();
    counter = undefined;
    tone?.stop();
    tone = undefined;
    mix?.dispose();
    mix = undefined;
    crop?.dispose();
    crop = undefined;
    stopStream(recordedStream);
    releaseStream(micStream);
    releaseStream(displayStream);
  };

  try {
    if (options.region) {
      if (!options.displaySize) throw new CaptureError('unknown', 'Region needs the display size.');
      const check = checkPixelRect(options.region, options.displaySize, {
        align: options.cropMethod === 'track-processor' ? 2 : 1,
      });
      if (!check.ok) throw new CaptureError('unknown', `Invalid region: ${check.reason}`);
    }

    displayStream = await acquireDisplayStream({
      sourceId: options.sourceId,
      systemAudio: options.systemAudio,
      maxFrameRate: options.fps,
    });
    if (options.micDeviceId !== undefined) {
      micStream = await acquireMicrophoneStream(options.micDeviceId || undefined);
    }
    if (signal?.aborted) throw new CaptureError('cancelled', 'Cancelled.');

    // Video source: the display stream itself, or a cropped stream.
    let videoTrack = displayStream.getVideoTracks()[0];
    if (options.region) {
      crop =
        options.cropMethod === 'track-processor'
          ? createTrackProcessorCrop(displayStream, options.region)
          : await createCanvasCrop(
              displayStream,
              options.region,
              options.fps,
              options.canvasDriver,
            );
      videoTrack = crop.stream.getVideoTracks()[0];
    }
    if (!videoTrack) throw new CaptureError('source-gone', 'No video track to record.');

    // Audio: one mixed track from the requested sources.
    const audioSources: string[] = [];
    const tracks: MediaStreamTrack[] = [videoTrack];
    if (options.systemAudio || micStream) {
      mix = createAudioMix({
        micStream,
        systemStream: options.systemAudio ? displayStream : undefined,
      });
      if (micStream) audioSources.push('mic');
      if (options.systemAudio) audioSources.push('system');
      const mixTrack = mix.stream.getAudioTracks()[0];
      if (mixTrack) tracks.push(mixTrack);
      mix.onTrackEnded((source) => endedEarly.push(`${source}-audio`));
    }
    if (options.playTestTone) tone = startTestTone();

    recordedStream = new MediaStream(tracks);
    registerStream(recordedStream);
    videoTrack.addEventListener('ended', () => endedEarly.push('video'));

    counter = await startFrameCounter(videoTrack);

    stopLevelLoop = registerLoop('level-sampler');
    const activeMix = mix;
    if (activeMix) {
      levelTimer = setInterval(() => {
        for (const source of audioSources as ('mic' | 'system')[]) {
          peakLevels[source] = Math.max(peakLevels[source] ?? 0, activeMix.getLevel(source));
        }
      }, 100);
    }

    const recorder = new MediaRecorder(recordedStream, {
      mimeType,
      videoBitsPerSecond: 8_000_000,
      audioBitsPerSecond: 128_000,
    });
    const chunks: Blob[] = [];
    recorder.ondataavailable = (event) => {
      if (event.data.size > 0) chunks.push(event.data);
    };
    const stopped = new Promise<void>((resolve, reject) => {
      recorder.onstop = () => resolve();
      recorder.onerror = (event) =>
        reject(
          new CaptureError(
            'unknown',
            `MediaRecorder error: ${(event as ErrorEvent).message ?? 'unknown'}`,
          ),
        );
    });

    const startedAt = performance.now();
    recorder.start(1000);
    await new Promise<void>((resolve) => {
      const finish = (): void => {
        clearTimeout(timer);
        signal?.removeEventListener('abort', finish);
        videoTrack.removeEventListener('ended', finish);
        resolve();
      };
      const timer = setTimeout(finish, durationSec * 1000);
      signal?.addEventListener('abort', finish);
      videoTrack.addEventListener('ended', finish);
    });
    const wallMs = performance.now() - startedAt;
    const framesDelivered = counter.count();
    const frameSize = counter.size();
    const measuredFps = framesDelivered / (counter.elapsedMs() / 1000);

    tracksAtStop.push(
      ...describeTracks('display', displayStream),
      ...describeTracks('mic', micStream),
      ...describeTracks('recorded', recordedStream),
    );
    if (recorder.state !== 'inactive') recorder.stop();
    await stopped;
    if (signal?.aborted) throw new CaptureError('cancelled', 'Cancelled.');

    const blob = new Blob(chunks, { type: mimeType });
    const path = await save(blob, extensionFor(mimeType));
    const cropStats = crop?.stats();

    // Release everything now so that the "after release" states are real.
    cleanup();
    const tracksAfterRelease = [
      ...describeTracks('display', displayStream),
      ...describeTracks('mic', micStream),
      ...describeTracks('recorded', recordedStream),
    ];

    return {
      mimeType,
      bytes: blob.size,
      path,
      wallMs,
      framesDelivered,
      measuredFps,
      requestedFps: options.fps,
      videoWidth: cropStats?.outWidth ?? frameSize.width,
      videoHeight: cropStats?.outHeight ?? frameSize.height,
      hasAudio: audioSources.length > 0,
      audioSources,
      peakLevels,
      tracksAtStop,
      tracksAfterRelease,
      endedEarly,
      cropMethod: crop?.method ?? 'none',
      cropFramesOut: cropStats?.framesOut,
    };
  } catch (error) {
    throw mapMediaError(error);
  } finally {
    cleanup();
  }
}

export interface DenialProbeResult {
  id: 'bogus-grant' | 'no-grant' | 'one-shot';
  pass: boolean;
  detail: string;
}

async function tryDisplayMedia(): Promise<
  { ok: true } | { ok: false; name: string; message: string }
> {
  try {
    const stream = await navigator.mediaDevices.getDisplayMedia({ video: true });
    stopStream(stream);
    return { ok: true };
  } catch (error) {
    const name = error instanceof Error ? error.name : 'Error';
    return { ok: false, name, message: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * Proves the denial paths. Must run inside one user gesture so that a rejection is caused by main's
 * handler and not by missing transient activation (main logs "no active grant" for each).
 */
export async function runDenialProbes(
  sourceIdForOneShot: string | undefined,
): Promise<DenialProbeResult[]> {
  const results: DenialProbeResult[] = [];

  const bogus = await window.framelet.invoke('capture:grant', {
    sourceId: 'screen:987654:0',
    systemAudio: false,
  });
  results.push({
    id: 'bogus-grant',
    pass: !bogus.ok && bogus.error.code === 'NOT_FOUND',
    detail: bogus.ok
      ? 'A grant was issued for an unknown source.'
      : `${bogus.error.code}: ${bogus.error.message}`,
  });

  const ungranted = await tryDisplayMedia();
  results.push({
    id: 'no-grant',
    pass: !ungranted.ok,
    detail: ungranted.ok
      ? 'getDisplayMedia succeeded without a grant.'
      : `${ungranted.name}: ${ungranted.message}`,
  });

  if (sourceIdForOneShot) {
    const first = await acquireDisplayStream({
      sourceId: sourceIdForOneShot,
      systemAudio: false,
      maxFrameRate: 5,
    }).then(
      (stream) => {
        releaseStream(stream);
        return true;
      },
      () => false,
    );
    const second = await tryDisplayMedia();
    results.push({
      id: 'one-shot',
      pass: first && !second.ok,
      detail: !first
        ? 'The first (granted) request failed.'
        : second.ok
          ? 'A second request succeeded without a new grant.'
          : `second request rejected: ${second.name}`,
    });
  }
  return results;
}
