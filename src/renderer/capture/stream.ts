import { CaptureError, mapMediaError } from './errors';
import { registerStream, stopStream } from './resource-registry';

export interface AcquireDisplayOptions {
  /** desktopCapturer source id, as listed by capture:listSources. */
  sourceId: string;
  /** Request Windows loopback audio. Throws `system-audio-unavailable` if no audio track arrives. */
  systemAudio: boolean;
  maxFrameRate: number;
}

/**
 * Asks main for a one-shot grant, then calls getDisplayMedia: main's display-media handler hands
 * out exactly the granted source. There is no picker, so "cancelled" can only come from an
 * aborted request. Must be called from a user gesture (Chromium requires transient activation).
 * On any failure nothing stays open.
 */
export async function acquireDisplayStream(options: AcquireDisplayOptions): Promise<MediaStream> {
  const grant = await window.framelet.invoke('capture:grant', {
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
      video: { frameRate: { ideal: options.maxFrameRate, max: options.maxFrameRate } },
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

/** Acquires a microphone stream (no echo processing: this is a recorder, not a call). */
export async function acquireMicrophoneStream(deviceId?: string): Promise<MediaStream> {
  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        ...(deviceId ? { deviceId: { exact: deviceId } } : {}),
        echoCancellation: false,
        noiseSuppression: false,
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
