import type { EngineCommand, EngineEvent, EnginePrepareCommand } from '../../shared/recorder-ipc';
import { CHUNK_TIMESLICE_MS } from '../../shared/recorder-ipc';
import type { AudioSource } from '../../shared/recorder-machine';
import { AUDIO_BITRATE, qualityLimit, videoBitrate } from '../../shared/recording';
import { createAudioMix, type AudioMix } from '../capture/audio-graph';
import { CaptureError, mapMediaError } from '../capture/errors';
import { detectRecorderFormats } from '../capture/recorder-probe';
import { createCanvasTransform, type CroppedStream } from '../capture/region-crop';
import {
  activeRecorderCount,
  registerLoop,
  registerRecorder,
  registerStream,
  stopStream,
} from '../capture/resource-registry';
import { acquireDisplayStream, acquireMicrophoneStream } from '../capture/stream';
import { ChunkUploader, type AppendFn, type UploadFailure } from './chunk-uploader';

export interface EngineDeps {
  /** Reports to main (`recorder:engineEvent`). */
  send: (event: EngineEvent) => void;
  /** `session:appendChunk` and `session:finish` go through this. */
  invoke: typeof window.framelet.invoke;
}

interface Prepared {
  displayStream: MediaStream;
  micStream: MediaStream | undefined;
  crop: CroppedStream;
  mix: AudioMix | undefined;
  mime: string;
  width: number;
  height: number;
  fps: number;
  audio: { mic: boolean; system: boolean };
  unwatch: () => void;
}

interface Active {
  recorder: MediaRecorder;
  uploader: ChunkUploader;
  sessionId: string;
  recordedStream: MediaStream;
  stopped: Promise<void>;
  unregister: () => void;
  ending: boolean;
}

/** An ordinary microphone list: `audioinput` devices, excluding the virtual "communications" alias. */
async function listMicrophones(): Promise<MediaDeviceInfo[]> {
  const all = await navigator.mediaDevices.enumerateDevices();
  return all.filter((device) => device.kind === 'audioinput');
}

function failure(error: unknown): { code: string; message: string } {
  const mapped = mapMediaError(error);
  return { code: mapped.code, message: mapped.message.slice(0, 400) };
}

/**
 * The only recorder. It lives in the hidden recorder window and does what main tells it
 * (`recorder:engineCommand`): prepare (acquire and check every source, build the pipeline), start,
 * pause, resume, stop, abort, mute. It reports with `recorder:engineEvent`. There is exactly one
 * MediaRecorder at a time (asserted), and every terminal path releases every track, audio context,
 * timer and recorder (the resource-registry counters prove it).
 *
 * Pipeline: display stream -> canvas (crop and/or fit to the quality preset, constant frame rate
 * from a timer) -> video track; microphone and system audio -> explicit audio graph (gain per
 * source, never connected to the speakers) -> one mixed audio track; both -> MediaRecorder
 * (timeslice 1 s) -> ChunkUploader -> main, which appends them to the session file.
 */
export class RecorderEngine {
  private prepared: Prepared | null = null;
  private active: Active | null = null;
  private levelsEnabled = false;
  private sampler: ReturnType<typeof setInterval> | undefined;
  private stopSampler: (() => void) | undefined;
  /** Sources already reported as lost (reported once). */
  private lost = new Set<AudioSource>();
  private queue: Promise<void> = Promise.resolve();

  constructor(private readonly deps: EngineDeps) {}

  /** Commands run strictly one after the other, in the order they arrive. */
  handle(command: EngineCommand): Promise<void> {
    this.queue = this.queue.then(() => this.run(command)).catch(() => undefined);
    return this.queue;
  }

  get hasRecorder(): boolean {
    return this.active !== null;
  }

  private async run(command: EngineCommand): Promise<void> {
    switch (command.cmd) {
      case 'prepare':
        return this.prepare(command);
      case 'start':
        return this.start(command.requestId, command.sessionId);
      case 'pause':
        return this.pause();
      case 'resume':
        return this.resume();
      case 'stop':
        return this.stop(command.requestId);
      case 'abort':
        this.releaseAll();
        return;
      case 'mute':
        this.prepared?.mix?.setGain(command.source, command.muted ? 0 : 1);
        return;
      case 'levels':
        this.levelsEnabled = command.enabled;
        this.updateSampler();
        return;
    }
  }

  // --- prepare -----------------------------------------------------------------------------

  private async prepare(command: EnginePrepareCommand): Promise<void> {
    this.releaseAll();
    const { requestId, options } = command;
    const choice = (
      kind: 'system-audio-unavailable' | 'mic-missing' | 'mic-denied' | 'mic-unavailable',
      canUseDefaultMic = false,
    ): void => {
      this.releaseAll();
      this.deps.send({ type: 'needsChoice', requestId, choice: kind, canUseDefaultMic });
    };

    let displayStream: MediaStream | undefined;
    let micStream: MediaStream | undefined;
    try {
      const formats = detectRecorderFormats();
      if (!formats.defaultMime) {
        throw new CaptureError(
          'unknown',
          'This computer cannot record video (no supported format).',
        );
      }
      if (activeRecorderCount() > 0) {
        throw new CaptureError('unknown', 'A recording is already running.');
      }

      // Microphone: the chosen device must exist (and any device must exist at all).
      let micDeviceId = options.mic.deviceId;
      let defaultMicExists = false;
      if (options.mic.enabled) {
        const microphones = await listMicrophones();
        defaultMicExists = microphones.length > 0;
        if (!defaultMicExists) return choice('mic-missing', false);
        if (micDeviceId && !microphones.some((device) => device.deviceId === micDeviceId)) {
          return choice('mic-missing', true);
        }
      } else {
        micDeviceId = undefined;
      }

      // The picture (and system audio). A missing loopback track is a choice, never silence.
      try {
        displayStream = await this.acquireDisplay(command);
      } catch (error) {
        if (error instanceof CaptureError && error.code === 'system-audio-unavailable') {
          return choice('system-audio-unavailable');
        }
        throw error;
      }

      if (options.mic.enabled) {
        try {
          micStream = await acquireMicrophoneStream(micDeviceId, { processing: true });
        } catch (error) {
          const mapped = mapMediaError(error);
          stopStream(displayStream);
          displayStream = undefined;
          if (mapped.code === 'denied') return choice('mic-denied');
          if (mapped.code === 'source-gone') return choice('mic-unavailable', defaultMicExists);
          throw mapped;
        }
      }

      const crop = await createCanvasTransform(
        displayStream,
        {
          rect: command.region ?? undefined,
          limit: qualityLimit(options.quality),
        },
        options.fps,
        'timer',
      );
      const { outWidth: width, outHeight: height } = crop.stats();

      const mic = micStream !== undefined;
      const system = options.systemAudio;
      const mix =
        mic || system ? createAudioMix({ micStream, systemStream: displayStream }) : undefined;

      this.lost = new Set();
      const prepared: Prepared = {
        displayStream,
        micStream,
        crop,
        mix,
        mime: formats.defaultMime,
        width,
        height,
        fps: options.fps,
        audio: { mic, system },
        unwatch: () => undefined,
      };
      prepared.unwatch = this.watchSources(prepared);
      this.prepared = prepared;
      this.deps.send({
        type: 'prepared',
        requestId,
        mime: prepared.mime,
        width,
        height,
        audio: prepared.audio,
      });
    } catch (error) {
      stopStream(micStream);
      stopStream(displayStream);
      this.releaseAll();
      const { code, message } = failure(error);
      this.deps.send({ type: 'prepareFailed', requestId, code, message });
    }
  }

  private async acquireDisplay(command: EnginePrepareCommand): Promise<MediaStream> {
    if (__FRAMELET_E2E__ && command.synthetic) {
      const { createSyntheticDisplayStream } = await import('../capture/synthetic-stream');
      if (command.options.systemAudio) {
        // The mock has no loopback audio: exercises the "system audio isn't available" choice.
        throw new CaptureError('system-audio-unavailable', 'Synthetic: no system audio.');
      }
      return createSyntheticDisplayStream(command.synthetic.width, command.synthetic.height);
    }
    return acquireDisplayStream({
      sourceId: command.sourceId,
      systemAudio: command.options.systemAudio,
      maxFrameRate: command.options.fps,
    });
  }

  /** Watches for the picture and the audio sources going away. Returns the unwatcher. */
  private watchSources(prepared: Prepared): () => void {
    const video = prepared.displayStream.getVideoTracks()[0];
    const onVideoEnded = (): void => this.deps.send({ type: 'sourceLost' });
    video?.addEventListener('ended', onVideoEnded);

    const markLost = (source: AudioSource): void => {
      if (this.lost.has(source)) return;
      this.lost.add(source);
      prepared.mix?.setGain(source, 0);
      this.deps.send({ type: 'trackEnded', source });
    };
    const offEnded = prepared.mix?.onTrackEnded(markLost);

    // A removed or unplugged microphone usually ends its track; a device-change event with the
    // device missing from the list is the second line of detection.
    const micTrack = prepared.micStream?.getAudioTracks()[0];
    const micDeviceId = micTrack?.getSettings().deviceId;
    const onDeviceChange = (): void => {
      if (!micTrack || !micDeviceId || this.lost.has('mic')) return;
      void listMicrophones().then((devices) => {
        const gone = !devices.some((device) => device.deviceId === micDeviceId);
        if (gone || micTrack.readyState === 'ended') markLost('mic');
      });
    };
    navigator.mediaDevices.addEventListener('devicechange', onDeviceChange);

    return () => {
      video?.removeEventListener('ended', onVideoEnded);
      offEnded?.();
      navigator.mediaDevices.removeEventListener('devicechange', onDeviceChange);
    };
  }

  // --- start, pause, resume ----------------------------------------------------------------

  private start(requestId: string, sessionId: string): void {
    const prepared = this.prepared;
    if (!prepared)
      return this.reportError('NOT_PREPARED', 'Nothing is prepared to record.', requestId);
    if (this.active || activeRecorderCount() > 0) {
      return this.reportError('ALREADY_RECORDING', 'A recording is already running.', requestId);
    }

    const tracks: MediaStreamTrack[] = [];
    const videoTrack = prepared.crop.stream.getVideoTracks()[0];
    if (!videoTrack)
      return this.reportError('NO_VIDEO', 'There is no picture to record.', requestId);
    tracks.push(videoTrack);
    const audioTrack = prepared.mix?.stream.getAudioTracks()[0];
    if (audioTrack) tracks.push(audioTrack);
    const recordedStream = registerStream(new MediaStream(tracks));

    let recorder: MediaRecorder;
    try {
      recorder = new MediaRecorder(recordedStream, {
        mimeType: prepared.mime,
        videoBitsPerSecond: videoBitrate(
          { width: prepared.width, height: prepared.height },
          prepared.fps,
        ),
        ...(audioTrack && { audioBitsPerSecond: AUDIO_BITRATE }),
      });
    } catch (error) {
      const { code, message } = failure(error);
      return this.reportError(code, message, requestId);
    }

    const append: AppendFn = (request) => this.deps.invoke('session:appendChunk', request);
    const uploader = new ChunkUploader({
      sessionId,
      append,
      onFatal: (fatal) => void this.onUploadFatal(fatal),
    });
    const stopped = new Promise<void>((resolve) => {
      recorder.onstop = () => resolve();
    });
    recorder.ondataavailable = (event) => {
      if (event.data.size > 0) uploader.push(event.data);
    };
    recorder.onerror = (event) => {
      const message = (event as ErrorEvent).message || 'The recorder failed.';
      void this.failActive('RECORDER_ERROR', message);
    };

    const unregister = registerRecorder(recorder);
    this.active = {
      recorder,
      uploader,
      sessionId,
      recordedStream,
      stopped,
      unregister,
      ending: false,
    };
    recorder.start(CHUNK_TIMESLICE_MS);
    this.updateSampler();
    this.deps.send({ type: 'started', requestId });
  }

  private pause(): void {
    const active = this.active;
    if (!active || active.recorder.state !== 'recording') return;
    active.recorder.pause();
    this.updateSampler();
    this.deps.send({ type: 'paused' });
  }

  private resume(): void {
    const active = this.active;
    if (!active || active.recorder.state !== 'paused') return;
    active.recorder.resume();
    this.updateSampler();
    this.deps.send({ type: 'resumed' });
  }

  // --- stop --------------------------------------------------------------------------------

  /**
   * Stops the recorder, waits for its final chunk AND the acknowledgement of every chunk, then
   * tells main to finish the session (it verifies the last sequence number).
   */
  private async stop(requestId: string): Promise<void> {
    const active = this.active;
    if (!active) {
      return this.reportError('NOT_RECORDING', 'There is no recording to stop.', requestId);
    }
    active.ending = true;
    this.stopLevels();
    if (active.recorder.state !== 'inactive') active.recorder.stop();
    await active.stopped;
    await active.uploader.flush();

    const failed = active.uploader.failed;
    if (failed) {
      this.releaseAll();
      return this.reportError(failed.code, failed.message, requestId);
    }
    const finished = await this.deps.invoke('session:finish', {
      sessionId: active.sessionId,
      lastSeq: active.uploader.lastSeq,
    });
    const summary = {
      lastSeq: active.uploader.lastSeq,
      chunks: active.uploader.chunkCount,
      bytes: active.uploader.bytesAccepted,
    };
    this.releaseAll();
    if (!finished.ok)
      return this.reportError(finished.error.code, finished.error.message, requestId);
    this.deps.send({ type: 'stopped', requestId, ...summary });
  }

  /** The uploader gave up (queue overflow, failed write): stop recording, keep what was acked. */
  private async onUploadFatal(fatal: UploadFailure): Promise<void> {
    await this.failActive(fatal.code, fatal.message);
  }

  private async failActive(code: string, message: string): Promise<void> {
    const active = this.active;
    if (!active || active.ending) return;
    active.ending = true;
    this.stopLevels();
    if (active.recorder.state !== 'inactive') active.recorder.stop();
    await active.stopped;
    // Chunks accepted before an overflow are still written; after a failed write there are none.
    await active.uploader.flush();
    this.releaseAll();
    this.reportError(code, message);
  }

  private reportError(code: string, message: string, requestId?: string): void {
    this.deps.send({
      type: 'error',
      code,
      message: message.slice(0, 400),
      ...(requestId && { requestId }),
    });
  }

  // --- levels ------------------------------------------------------------------------------

  /** Levels are sampled (10 Hz) only while recording and only when main says a toolbar shows them. */
  private updateSampler(): void {
    const recording = this.active?.recorder.state === 'recording' && !this.active.ending;
    const mix = this.prepared?.mix;
    if (!(recording && this.levelsEnabled && mix)) return this.stopLevels();
    if (this.sampler !== undefined) return;
    this.stopSampler = registerLoop('level-sampler');
    this.sampler = setInterval(() => {
      this.deps.send({
        type: 'levels',
        mic: mix.getLevel('mic'),
        system: mix.getLevel('system'),
      });
    }, 100);
  }

  private stopLevels(): void {
    if (this.sampler !== undefined) clearInterval(this.sampler);
    this.sampler = undefined;
    this.stopSampler?.();
    this.stopSampler = undefined;
  }

  // --- cleanup -----------------------------------------------------------------------------

  /** Every terminal path ends here: nothing stays open. Safe to call at any time, repeatedly. */
  releaseAll(): void {
    this.stopLevels();
    const active = this.active;
    this.active = null;
    if (active) {
      active.recorder.ondataavailable = null;
      active.recorder.onerror = null;
      if (active.recorder.state !== 'inactive') {
        try {
          active.recorder.stop();
        } catch {
          // already inactive
        }
      }
      active.unregister();
      stopStream(active.recordedStream);
    }
    const prepared = this.prepared;
    this.prepared = null;
    if (prepared) {
      prepared.unwatch();
      prepared.mix?.dispose();
      prepared.crop.dispose();
      stopStream(prepared.micStream);
      stopStream(prepared.displayStream);
    }
  }
}
