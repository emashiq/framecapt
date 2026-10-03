import { CaptureError, mapMediaError } from './errors';
import { registerStream, stopStream } from './resource-registry';

export interface AcquireDisplayOptions {
  /** desktopCapturer source id, as listed by capture:listSources. */
  sourceId: string;
  /** Request Windows loopback audio. Throws `system-audio-unavailable` if no audio track arrives. */
  systemAudio: boolean;
  maxFrameRate: number;
  /**
   * Ask the capturer to deliver frames no larger than this (aspect kept): a recording that is
   * scaled down to 1080p anyway then never moves full-size desktop frames around. Leave it out
   * when the full-resolution picture is needed (a region of the screen).
   */
  maxSize?: { width: number; height: number } | undefined;
}

/**
 * Asks main for a one-shot grant, then calls getDisplayMedia: main's display-media handler hands
 * out exactly the granted source. There is no picker, so "cancelled" can only come from an
 * aborted request. Must be called from a user gesture (Chromium requires transient activation).
 * On any failure nothing stays open.
 */
export async function acquireDisplayStream(options: AcquireDisplayOptions): Promise<MediaStream> {
  const grant = await window.framecapt.invoke('capture:grant', {
    sourceId: options.sourceId,
    systemAudio: options.systemAudio,
  });
  if (!grant.ok) {
    if (grant.error.code === 'NOT_FOUND') {
      throw new CaptureError('source-gone', grant.error.message, 'GrantNotFound');
    }
    throw new CaptureError('denied', grant.error.message, grant.error.code);
  }

  let stream: MediaStream;
  try {
    stream = await navigator.mediaDevices.getDisplayMedia({
      video: {
        frameRate: { ideal: options.maxFrameRate, max: options.maxFrameRate },
        ...(options.maxSize && {
          width: { max: options.maxSize.width },
          height: { max: options.maxSize.height },
        }),
      },
      audio: options.systemAudio,
    });
  } catch (error) {
    throw mapMediaError(error);
  }
  registerStream(stream);

  if (options.systemAudio && stream.getAudioTracks().length === 0) {
    stopStream(stream);
    throw new CaptureError(
      'system-audio-unavailable',
      'Windows did not provide a system audio track. Recording without system audio was not started.',
    );
  }
  return stream;
}

/**
 * Acquires a microphone stream. Diagnostics use the raw signal; the recorder passes
 * `processing: true` (echo cancellation and noise suppression on, like a call).
 */
export async function acquireMicrophoneStream(
  deviceId?: string,
  options: { processing?: boolean } = {},
): Promise<MediaStream> {
  const processing = options.processing === true;
  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        ...(deviceId ? { deviceId: { exact: deviceId } } : {}),
        echoCancellation: processing,
        noiseSuppression: processing,
        autoGainControl: false,
      },
    });
    return registerStream(stream);
  } catch (error) {
    throw mapMediaError(error);
  }
}

/** Stops every track of the stream. Safe to call more than once. */
export function releaseStream(stream: MediaStream | undefined): void {
  stopStream(stream);
}
