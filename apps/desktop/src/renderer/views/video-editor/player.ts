import { DEFAULT_FPS, type Segment } from '../../../shared/video-edit';
import { playbackStep, playStart, stepTime } from './playback';

export interface PlayerConfig {
  segments: readonly Segment[];
  fps: number | undefined;
  durationMs: number;
}

export interface PlayerSnapshot {
  /** Source time, milliseconds. */
  timeMs: number;
  playing: boolean;
}

/**
 * Drives the preview <video>. The video plays the whole recording; this skips the cut pieces and
 * stops at the end of the trim (see playback.ts). The time lives here, outside React, so a playing
 * video does not re-render the editor sixty times a second: the playhead, the time read-outs and
 * the overlay subscribe to it themselves.
 */
export class Player {
  private video: HTMLVideoElement | null = null;
  private raf = 0;
  private readonly listeners = new Set<() => void>();
  private snapshot: PlayerSnapshot = { timeMs: 0, playing: false };
  private readonly cleanups: (() => void)[] = [];

  private config: PlayerConfig = { segments: [], fps: undefined, durationMs: 0 };

  /** What the player needs of the project: kept pieces, frame rate and length. Set whenever it changes. */
  configure(config: PlayerConfig): void {
    this.config = config;
  }

  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => void this.listeners.delete(listener);
  };
  readonly getSnapshot = (): PlayerSnapshot => this.snapshot;

  /** One video frame in milliseconds (the source rate, 30 fps when unknown). */
  get frameMs(): number {
    return 1000 / (this.config.fps ?? DEFAULT_FPS);
  }

  private set(change: Partial<PlayerSnapshot>): void {
    const next = { ...this.snapshot, ...change };
    if (next.timeMs === this.snapshot.timeMs && next.playing === this.snapshot.playing) return;
    this.snapshot = next;
    for (const listener of this.listeners) listener();
  }

  attach(video: HTMLVideoElement): void {
    this.detach();
    this.video = video;
    const on = (type: string, handler: () => void): void => {
      video.addEventListener(type, handler);
      this.cleanups.push(() => video.removeEventListener(type, handler));
    };
    on('seeked', () => this.syncFromVideo());
    on('loadedmetadata', () => this.syncFromVideo());
    on('pause', () => this.afterPause());
    on('ended', () => this.afterPause());
    on('play', () => {
      this.set({ playing: true });
      cancelAnimationFrame(this.raf);
      this.raf = requestAnimationFrame(this.loop);
    });
  }

  detach(): void {
    cancelAnimationFrame(this.raf);
    for (const cleanup of this.cleanups.splice(0)) cleanup();
    this.video = null;
  }

  private syncFromVideo(): void {
    if (this.video) this.set({ timeMs: Math.round(this.video.currentTime * 1000) });
  }

  private afterPause(): void {
    cancelAnimationFrame(this.raf);
    this.set({ playing: false });
    this.syncFromVideo();
  }

  private readonly loop = (): void => {
    const video = this.video;
    if (!video || video.paused) return;
    const ms = video.currentTime * 1000;
    const step = playbackStep(this.config.segments, ms);
    if (step.kind === 'jump') {
      video.currentTime = step.toMs / 1000;
      this.set({ timeMs: step.toMs });
    } else if (step.kind === 'stop') {
      video.pause();
      this.seek(step.atMs);
      return;
    } else {
      this.set({ timeMs: Math.round(ms) });
    }
    this.raf = requestAnimationFrame(this.loop);
  };

  /** Moves the playhead (and the video) to a source time. */
  seek(ms: number): void {
    const clamped = Math.max(0, Math.min(this.config.durationMs, Math.round(ms)));
    if (this.video) this.video.currentTime = clamped / 1000;
    this.set({ timeMs: clamped });
  }

  play(): void {
    const video = this.video;
    if (!video) return;
    const start = playStart(this.config.segments, this.snapshot.timeMs);
    if (start !== this.snapshot.timeMs) this.seek(start);
    void video.play().catch(() => undefined);
  }

  pause(): void {
    this.video?.pause();
  }

  toggle(): void {
    if (this.snapshot.playing) this.pause();
    else this.play();
  }

  /** A step of `deltaMs` (a frame, a second) that skips cuts and stays inside the trim. */
  step(deltaMs: number): void {
    this.pause();
    this.seek(stepTime(this.config.segments, this.snapshot.timeMs, deltaMs));
  }

  /** The preview's own volume: the project's volume up to 100 % (the browser cannot boost), or muted. */
  applyAudio(volume: number, muted: boolean): void {
    if (!this.video) return;
    this.video.volume = Math.max(0, Math.min(1, volume));
    this.video.muted = muted;
  }
}
