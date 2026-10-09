import type {
  EngineAddPanelCommand,
  EngineCommand,
  EngineEvent,
  EngineMultiSource,
  EnginePrepareCommand,
} from '../../shared/recorder-ipc';
import { CHUNK_TIMESLICE_MS } from '../../shared/recorder-ipc';
import type { AudioSource } from '../../shared/recorder-machine';
import { cornerCenter } from '../../shared/camera';
import {
  followCrop,
  followCropSize,
  multiSourceLayout,
  scaleRegion,
  type FollowZoom,
  type MosaicLayout,
} from '../../shared/compositor-layout';
import type { Size } from '../../shared/geometry';
import type { PanelPlaceholder } from '../../shared/panels';
import type { Rect } from '../../shared/rect';
import { AUDIO_BITRATE, fitWithin, qualityLimit, videoBitrate } from '../../shared/recording';
import { bitrateFactorOf } from '../../shared/recording-format';
import { createAudioMix, type AudioMix } from '../capture/audio-graph';
import type { CameraLayerState } from '../capture/camera-layer';
import {
  createCompositor,
  createDynamicCompositor,
  type CompositorCamera,
  type DynamicCompositor,
  type DynamicTileOptions,
} from '../capture/compositor';
import { CaptureError, mapMediaError } from '../capture/errors';
import { detectRecorderFormats } from '../capture/recorder-probe';
import type { CroppedStream } from '../capture/region-crop';
import {
  activeRecorderCount,
  registerLoop,
  registerRecorder,
  registerStream,
  stopStream,
} from '../capture/resource-registry';
import {
  acquireCameraStream,
  acquireDisplayStream,
  acquireMicrophoneStream,
} from '../capture/stream';
import { ChunkUploader, type AppendFn, type UploadFailure } from './chunk-uploader';

export interface EngineDeps {
  /** Reports to main (`recorder:engineEvent`). */
  send: (event: EngineEvent) => void;
  /** `session:appendChunk` and `session:finish` go through this. */
  invoke: typeof window.framecapt.invoke;
}

interface Prepared {
  /** One stream per source (a single-source recording has one); the first carries the system audio. */
  displayStreams: MediaStream[];
  /** Each source's tile in the picture (multi-source recordings only). */
  tiles: Rect[] | undefined;
  micStream: MediaStream | undefined;
  cameraStream: MediaStream | undefined;
  crop: CroppedStream;
  /** The compositor when the recording can take panels (every recording except a multi-source one). */
  dynamic: DynamicCompositor | undefined;
  mix: AudioMix | undefined;
  mime: string;
  width: number;
  height: number;
  fps: number;
  bitrateFactor: number;
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

/** A picture in a slot of the compositor, and how to get a fresh stream of its source. */
interface SlotSource {
  kind: 'screen' | 'window';
  stream: MediaStream;
  tile: DynamicTileOptions;
  acquireFresh: () => Promise<MediaStream>;
}

/** A frozen window capture (after a minimize and restore) shows no new frame within this time. */
const FRAME_WAIT_MS = 1500;
/** Panels of a whole screen or window are captured no larger than this: they fill a third of the picture. */
const PANEL_MAX_SIZE = { width: 1920, height: 1080 };

/** The zoom of a follow-mouse recording; only a whole-screen recording follows. */
function followZoom(command: EnginePrepareCommand): FollowZoom | undefined {
  return command.kind === 'screen' && !command.region ? command.options.follow?.zoom : undefined;
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
  /** Multi-source recordings: the sources that ended, and how many there are. */
  private lostTiles = new Set<number>();
  private tileCount = 0;
  private queue: Promise<void> = Promise.resolve();
  /** The mouse on the recorded display (0..1), from main; the follow window aims at it. */
  private cursor = { nx: 0.5, ny: 0.5 };
  /** The webcam overlay as main last placed it (`camera` command). */
  private camera: CameraLayerState = { nx: 1, ny: 1, size: 'm', shape: 'circle', visible: true };
  /** The camera's track ended mid-recording: the overlay stays hidden. */
  private cameraLost = false;
  private fps = 30;
  /** The source of every slot of the compositor (0 = the recording itself, 1..3 = panels). */
  private slotSources = new Map<number, SlotSource>();
  /** Streams with more than one user (a panel of the recorded display shares the recording's stream). */
  private streamRefs = new Map<MediaStream, number>();
  private sourceStreams = new Map<string, MediaStream>();
  /** Whether a slot should be hidden once its window picture is verified (a hide beats a pending show). */
  private hiddenWanted = new Map<number, boolean>();
  private reviving = new Set<number>();

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
      case 'cursor':
        this.cursor = { nx: command.nx, ny: command.ny };
        return;
      case 'addPanel':
        return this.addPanel(command);
      case 'removePanel':
        return this.removePanel(command.slot);
      case 'setPanelHidden':
        return this.setPanelHidden(command.slot, command.hidden, command.placeholder);
      case 'camera':
        this.camera = {
          nx: command.nx,
          ny: command.ny,
          size: command.size,
          shape: command.shape,
          visible: command.visible && !this.cameraLost,
        };
        return;
    }
  }

  // --- prepare -----------------------------------------------------------------------------

  private async prepare(command: EnginePrepareCommand): Promise<void> {
    this.releaseAll();
    const { requestId, options } = command;
    let displayStreams: MediaStream[] = [];
    let micStream: MediaStream | undefined;
    let cameraStream: MediaStream | undefined;
    const choice = (
      kind:
        | 'system-audio-unavailable'
        | 'mic-missing'
        | 'mic-denied'
        | 'mic-unavailable'
        | 'camera-missing',
      canUseDefaultMic = false,
    ): void => {
      stopStream(cameraStream);
      this.releaseAll();
      this.deps.send({ type: 'needsChoice', requestId, choice: kind, canUseDefaultMic });
    };
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

      // The camera: a chosen device that is gone falls back to the default one; no camera at all is a choice.
      this.cameraLost = false;
      if (options.camera) {
        try {
          cameraStream = await acquireCameraStream(options.camera.deviceId);
        } catch {
          return choice('camera-missing');
        }
        this.camera = {
          ...cornerCenter(options.camera.corner),
          size: options.camera.size,
          shape: options.camera.shape,
          visible: true,
        };
      }

      // The picture (and system audio). A missing loopback track is a choice, never silence.
      try {
        displayStreams = await this.acquireDisplays(command);
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
          displayStreams.forEach((stream) => stopStream(stream));
          displayStreams = [];
          if (mapped.code === 'denied') return choice('mic-denied');
          if (mapped.code === 'source-gone') return choice('mic-unavailable', defaultMicExists);
          throw mapped;
        }
      }

      const follow = followZoom(command);
      const displayStream = displayStreams[0] as MediaStream;
      this.cursor = { nx: 0.5, ny: 0.5 };
      const camera: CompositorCamera | undefined = cameraStream && {
        stream: cameraStream,
        state: () => this.camera,
      };
      this.lostTiles = new Set();
      this.tileCount = command.multi?.length ?? 0;
      this.fps = options.fps;
      let tiles: Rect[] | undefined;
      let dynamic: DynamicCompositor | undefined;
      let crop: CroppedStream;
      if (command.multi) {
        const made = await this.createMultiCompositor(
          displayStreams,
          command.multi,
          command,
          camera,
        );
        tiles = made.tiles;
        crop = made.crop;
      } else {
        const tile = this.primaryTile(command, follow);
        dynamic = await createDynamicCompositor({
          primary: { stream: displayStream, ...tile.options },
          outSize: (frame) => fitWithin(tile.sourceSize(frame), qualityLimit(options.quality)),
          fps: options.fps,
          onTileLost: (slot) => this.onPanelTileLost(slot),
          camera,
        });
        crop = dynamic;
        const synthetic = __FRAMECAPT_E2E__ && command.synthetic !== undefined;
        this.slotSources.set(0, {
          kind: command.kind,
          stream: this.holdStream(synthetic ? undefined : command.sourceId, displayStream),
          tile: tile.options,
          acquireFresh: async () =>
            this.holdStream(
              synthetic ? undefined : command.sourceId,
              await this.acquireDisplay(command),
            ),
        });
      }
      const { outWidth: width, outHeight: height } = crop.stats();

      const mic = micStream !== undefined;
      const system = options.systemAudio;
      const mix =
        mic || system ? createAudioMix({ micStream, systemStream: displayStream }) : undefined;

      this.lost = new Set();
      const prepared: Prepared = {
        displayStreams,
        tiles,
        micStream,
        cameraStream,
        crop,
        dynamic,
        mix,
        mime: formats.defaultMime,
        width,
        height,
        fps: options.fps,
        bitrateFactor: bitrateFactorOf(options),
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
        ...(tiles && { tiles }),
      });
    } catch (error) {
      stopStream(micStream);
      displayStreams.forEach((stream) => stopStream(stream));
      stopStream(cameraStream);
      this.releaseAll();
      const { code, message } = failure(error);
      this.deps.send({ type: 'prepareFailed', requestId, code, message });
    }
  }

  /**
   * The streams of a recording: one, or (multi-source) one per source, acquired SEQUENTIALLY (a
   * grant is one-shot and belongs to one request at a time). Only the first carries system audio.
   * On any failure the streams already acquired are released.
   */
  private async acquireDisplays(command: EnginePrepareCommand): Promise<MediaStream[]> {
    if (!command.multi) return [await this.acquireDisplay(command)];
    const streams: MediaStream[] = [];
    try {
      for (const [index, source] of command.multi.entries()) {
        streams.push(await this.acquireDisplay(command, source, index === 0));
      }
    } catch (error) {
      streams.forEach((stream) => stopStream(stream));
      throw error;
    }
    return streams;
  }

  private async acquireDisplay(
    command: EnginePrepareCommand,
    source?: EngineMultiSource,
    primary = true,
  ): Promise<MediaStream> {
    const systemAudio = command.options.systemAudio && primary;
    const synthetic = source?.synthetic ?? command.synthetic;
    if (__FRAMECAPT_E2E__ && synthetic) {
      const { createSyntheticDisplayStream } = await import('../capture/synthetic-stream');
      if (systemAudio) {
        // The mock has no loopback audio: exercises the "system audio isn't available" choice.
        throw new CaptureError('system-audio-unavailable', 'Synthetic: no system audio.');
      }
      return createSyntheticDisplayStream(synthetic.width, synthetic.height);
    }
    return acquireDisplayStream({
      sourceId: source?.sourceId ?? command.sourceId,
      systemAudio,
      maxFrameRate: command.options.fps,
      // A region and a follow-mouse window are cut from the unscaled frame, and so are the sources
      // of a mosaic (the whole mosaic is scaled to its cap afterwards).
      maxSize:
        command.region || followZoom(command) || command.multi
          ? undefined
          : (qualityLimit(command.options.quality) ?? undefined),
    });
  }

  /**
   * The picture of the recording itself (slot 0): the whole frame, a region of it, or (follow
   * mouse) a window of frame/zoom pixels that eases toward the mouse, fitted to the quality preset
   * (so 3440x1440 at 2x is 1720x720 and fits 1080p unchanged).
   */
  private primaryTile(
    command: EnginePrepareCommand,
    follow: FollowZoom | undefined,
  ): { options: DynamicTileOptions; sourceSize: (frame: Size) => Size } {
    const { region } = command;
    if (follow) {
      let crop: Rect | null = null;
      let last = performance.now();
      return {
        options: {
          src: (frame) => {
            const now = performance.now();
            crop = followCrop({
              target: { x: this.cursor.nx * frame.width, y: this.cursor.ny * frame.height },
              prev: crop,
              dtMs: now - last,
              zoom: follow,
              frame,
            });
            last = now;
            return crop;
          },
        },
        sourceSize: (frame) => followCropSize(frame, follow),
      };
    }
    if (region) return { options: { src: () => region }, sourceSize: () => region };
    return { options: {}, sourceSize: (frame) => frame };
  }

  /**
   * Several sources in one picture: every source is a tile, laid out once all have delivered a
   * frame ('virtual' for screens only, else an equal-cell 'grid') and capped as a whole by the
   * quality preset. A tile that ends is blanked (the compositor draws "Source ended"), reported with
   * `tileLost`, and the recording goes on; only when every tile has ended does it stop.
   */
  private async createMultiCompositor(
    streams: MediaStream[],
    multi: readonly EngineMultiSource[],
    command: EnginePrepareCommand,
    camera: CompositorCamera | undefined,
  ): Promise<{ crop: CroppedStream; tiles: Rect[] }> {
    const plan: { layout?: MosaicLayout } = {};
    const crop = await createCompositor({
      tiles: streams.map((stream, index) => ({
        stream,
        // A window can change size while it is recorded: its frame is fitted into the tile.
        fit: true,
        dst: () => (plan.layout as MosaicLayout).rects[index] as Rect,
      })),
      outSize: (sizes) => {
        plan.layout = multiSourceLayout(
          sizes.map((size, index) => {
            const source = multi[index] as EngineMultiSource;
            return {
              kind: source.kind,
              size,
              position: source.rect ? { x: source.rect.x, y: source.rect.y } : null,
            };
          }),
          command.options.quality,
        );
        return { width: plan.layout.width, height: plan.layout.height };
      },
      fps: command.options.fps,
      driver: 'timer',
      onTileLost: (index) => this.onTileLost(index),
      camera,
    });
    return { crop, tiles: (plan.layout as MosaicLayout).rects };
  }

  private onTileLost(index: number): void {
    if (this.lostTiles.has(index)) return;
    this.lostTiles.add(index);
    this.deps.send({ type: 'tileLost', index });
    if (this.lostTiles.size >= this.tileCount) this.deps.send({ type: 'sourceLost' });
  }

  /** Watches for the picture and the audio sources going away. Returns the unwatcher. */
  private watchSources(prepared: Prepared): () => void {
    // A multi-source recording watches its tiles in the compositor instead (see onTileLost).
    const video = prepared.tiles ? undefined : prepared.displayStreams[0]?.getVideoTracks()[0];
    const onVideoEnded = (): void => this.deps.send({ type: 'sourceLost' });
    video?.addEventListener('ended', onVideoEnded);
    // An unplugged camera only takes the overlay away; the recording itself goes on.
    const cameraTrack = prepared.cameraStream?.getVideoTracks()[0];
    const onCameraEnded = (): void => {
      this.cameraLost = true;
      this.camera = { ...this.camera, visible: false };
    };
    cameraTrack?.addEventListener('ended', onCameraEnded);

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
      cameraTrack?.removeEventListener('ended', onCameraEnded);
      offEnded?.();
      navigator.mediaDevices.removeEventListener('devicechange', onDeviceChange);
    };
  }

  // --- live panels -------------------------------------------------------------------------

  /** Counts a stream's users; `key` (a source id) lets a later panel of the same source share it. */
  private holdStream(key: string | undefined, stream: MediaStream): MediaStream {
    this.streamRefs.set(stream, (this.streamRefs.get(stream) ?? 0) + 1);
    if (key !== undefined) this.sourceStreams.set(key, stream);
    return stream;
  }

  /** A stream of the source that is already captured here and still live, counted as one more user. */
  private shareStream(key: string): MediaStream | undefined {
    const stream = this.sourceStreams.get(key);
    if (!stream || stream.getVideoTracks()[0]?.readyState !== 'live') return undefined;
    return this.holdStream(key, stream);
  }

  /** One user less; the last one stops the stream. */
  private releaseStreamRef(stream: MediaStream): void {
    const left = (this.streamRefs.get(stream) ?? 1) - 1;
    if (left > 0) {
      this.streamRefs.set(stream, left);
      return;
    }
    this.streamRefs.delete(stream);
    for (const [key, held] of this.sourceStreams) {
      if (held === stream) this.sourceStreams.delete(key);
    }
    stopStream(stream);
  }

  /** The stream of a panel's source: shared with a user of the same source, or acquired (no audio). */
  private async panelStream(command: EngineAddPanelCommand, fresh = false): Promise<MediaStream> {
    const { synthetic } = command;
    if (__FRAMECAPT_E2E__ && synthetic) {
      const { createSyntheticDisplayStream, PANEL_PALETTE } =
        await import('../capture/synthetic-stream');
      return this.holdStream(
        undefined,
        createSyntheticDisplayStream(synthetic.width, synthetic.height, PANEL_PALETTE),
      );
    }
    if (!fresh) {
      const shared = this.shareStream(command.sourceId);
      if (shared) return shared;
    }
    const stream = await acquireDisplayStream({
      sourceId: command.sourceId,
      systemAudio: false,
      maxFrameRate: this.fps,
      // A region is cut from the unscaled frame; a whole screen or window fills a third at most.
      maxSize: command.region ? undefined : PANEL_MAX_SIZE,
    });
    return this.holdStream(command.sourceId, stream);
  }

  private async addPanel(command: EngineAddPanelCommand): Promise<void> {
    const { requestId, slot } = command;
    const dynamic = this.prepared?.dynamic;
    const fail = (code: string, message: string): void =>
      this.deps.send({ type: 'panelFailed', requestId, code, message: message.slice(0, 400) });
    if (!dynamic || !this.active) return fail('NOT_RECORDING', 'There is no recording to add to.');
    if (this.slotSources.has(slot)) return fail('BUSY', 'That panel is already in use.');
    const { region, displaySize } = command;
    const tile: DynamicTileOptions = {
      fit: true,
      ...(region &&
        displaySize && { src: (frame: Size) => scaleRegion(region, displaySize, frame) }),
    };
    let stream: MediaStream | undefined;
    try {
      stream = await this.panelStream(command);
      await dynamic.attachTile(slot, stream, tile);
    } catch (error) {
      if (stream) this.releaseStreamRef(stream);
      const { code, message } = failure(error);
      return fail(code, message);
    }
    const info = dynamic.slots().find((candidate) => candidate.slot === slot);
    if (this.prepared?.dynamic !== dynamic || !info || info.lost) {
      // The recording ended meanwhile, or the source ended while it was being added.
      dynamic.detachTile(slot);
      this.releaseStreamRef(stream);
      return fail('source-gone', 'That source is no longer available.');
    }
    this.slotSources.set(slot, {
      kind: command.kind,
      stream,
      tile,
      acquireFresh: () => this.panelStream(command, true),
    });
    this.deps.send({ type: 'panelAdded', requestId, slot });
  }

  private removePanel(slot: number): void {
    const source = this.slotSources.get(slot);
    this.prepared?.dynamic?.detachTile(slot);
    this.slotSources.delete(slot);
    this.hiddenWanted.delete(slot);
    if (source) this.releaseStreamRef(source.stream);
  }

  /** A panel's source ended: it leaves the picture and main is told; the recording goes on. */
  private onPanelTileLost(slot: number): void {
    // The recording itself ending is reported by watchSources.
    if (slot === 0 || !this.slotSources.has(slot)) return;
    this.removePanel(slot);
    this.deps.send({ type: 'panelLost', slot });
  }

  private setPanelHidden(slot: number, hidden: boolean, placeholder: PanelPlaceholder): void {
    const dynamic = this.prepared?.dynamic;
    if (!dynamic) return;
    this.hiddenWanted.set(slot, hidden);
    if (hidden) return dynamic.setTileHidden(slot, true, placeholder);
    // A window that was minimized can stay frozen when it comes back: the card stays until the
    // picture is known to move (or was re-acquired).
    if (this.slotSources.get(slot)?.kind === 'window') {
      if (!this.reviving.has(slot)) void this.showWindowTile(slot, placeholder);
      return;
    }
    dynamic.setTileHidden(slot, false, placeholder);
  }

  private async showWindowTile(slot: number, placeholder: PanelPlaceholder): Promise<void> {
    const prepared = this.prepared;
    const dynamic = prepared?.dynamic;
    if (!prepared || !dynamic) return;
    this.reviving.add(slot);
    try {
      if (!(await dynamic.waitForFrame(slot, FRAME_WAIT_MS))) await this.reacquire(slot);
    } catch {
      // A failed re-acquire leaves the old picture in place: it is shown as it is.
    } finally {
      this.reviving.delete(slot);
      if (this.prepared === prepared && this.hiddenWanted.get(slot) === false) {
        dynamic.setTileHidden(slot, false, placeholder);
      }
    }
  }

  /** Swaps a slot's frozen stream for a fresh one of the same source. False when it could not (or must not). */
  private async reacquire(slot: number): Promise<boolean> {
    const prepared = this.prepared;
    const dynamic = prepared?.dynamic;
    const source = this.slotSources.get(slot);
    if (!prepared || !dynamic || !source) return false;
    // The recording's own system audio rides on its stream: it cannot be swapped.
    if (slot === 0 && prepared.audio.system) return false;
    const fresh = await source.acquireFresh();
    try {
      await dynamic.attachTile(slot, fresh, source.tile);
    } catch (error) {
      this.releaseStreamRef(fresh);
      throw error;
    }
    if (this.prepared !== prepared || this.slotSources.get(slot) !== source) {
      this.releaseStreamRef(fresh);
      return false;
    }
    const old = source.stream;
    source.stream = fresh;
    if (slot === 0) {
      prepared.displayStreams[0] = fresh;
      prepared.unwatch();
      prepared.unwatch = this.watchSources(prepared);
    }
    this.releaseStreamRef(old);
    return true;
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
          prepared.bitrateFactor,
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
      stopStream(prepared.cameraStream);
      prepared.displayStreams.forEach((stream) => stopStream(stream));
    }
    // Every stream a slot or a share holds (panels included).
    this.streamRefs.forEach((_refs, stream) => stopStream(stream));
    this.streamRefs.clear();
    this.sourceStreams.clear();
    this.slotSources.clear();
    this.hiddenWanted.clear();
    this.reviving.clear();
  }
}
