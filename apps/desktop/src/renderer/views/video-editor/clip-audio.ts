import { fadeAlpha } from '../../../shared/video-edit';
import type { ClipSpec } from './clip-spec';

/** Playback further off than this from where it should be is corrected by seeking. */
const DRIFT_SECONDS = 0.25;

/**
 * The preview of the audio clips: one <audio> element per clip, started, stopped and seeked in step
 * with the video (the player calls `sync` as it plays and whenever it jumps or the user seeks). The
 * browser cannot play louder than 100 %: a clip's volume is capped there in the preview; the export
 * uses the real value.
 */
export class ClipAudio {
  private readonly elements = new Map<string, HTMLAudioElement>();
  private clips: ClipSpec[] = [];

  /** A new list of clips: elements are made for new ones and dropped for the ones that are gone. */
  update(clips: ClipSpec[]): void {
    this.clips = clips;
    const wanted = new Set(clips.map((clip) => clip.id));
    for (const [id, element] of this.elements) {
      if (!wanted.has(id)) {
        element.pause();
        element.removeAttribute('src');
        this.elements.delete(id);
      }
    }
    for (const clip of clips) {
      const existing = this.elements.get(clip.id);
      if (existing && existing.dataset['url'] === clip.url) continue;
      existing?.pause();
      const element = new Audio(clip.url);
      element.preload = 'auto';
      element.dataset['url'] = clip.url;
      this.elements.set(clip.id, element);
    }
  }

  /**
   * Puts every clip where it should be at source time `timeMs`: playing when the video plays and the
   * time is inside the clip, silent otherwise. `seek` forces a jump (the user moved the playhead).
   */
  sync(timeMs: number, playing: boolean, seek: boolean): void {
    for (const clip of this.clips) {
      const element = this.elements.get(clip.id);
      if (!element) continue;
      const active = timeMs >= clip.startMs && timeMs < clip.endMs;
      if (!active) {
        if (!element.paused) element.pause();
        continue;
      }
      const wanted = (timeMs - clip.startMs + clip.inMs) / 1000;
      element.volume = Math.max(0, Math.min(1, Math.min(clip.volume, 1) * fadeAlpha(clip, timeMs)));
      if (seek || Math.abs(element.currentTime - wanted) > DRIFT_SECONDS) {
        element.currentTime = wanted;
      }
      if (playing && element.paused) void element.play().catch(() => undefined);
      else if (!playing && !element.paused) element.pause();
    }
  }

  pauseAll(): void {
    for (const element of this.elements.values()) element.pause();
  }

  dispose(): void {
    this.update([]);
  }
}
