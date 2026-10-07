import { acquireMicrophoneStream, releaseStream } from '../../capture/stream';

/** A running microphone recording for a voice-over. */
export interface VoiceRecorder {
  /** Stops and returns the recorded WebM/Opus bytes (null when nothing was recorded). */
  stop(): Promise<ArrayBuffer | null>;
  /** Stops and throws the recording away. */
  cancel(): void;
}

const MIME = 'audio/webm;codecs=opus';

/**
 * Starts recording the microphone. A chosen device that is gone falls back to the default one;
 * rejects (with the capture error) when the microphone cannot be opened at all.
 */
export async function startVoiceRecorder(deviceId?: string): Promise<VoiceRecorder> {
  let stream: MediaStream;
  try {
    stream = await acquireMicrophoneStream(deviceId, { processing: true });
  } catch (error) {
    if (!deviceId) throw error;
    stream = await acquireMicrophoneStream(undefined, { processing: true });
  }
  const chunks: Blob[] = [];
  let recorder: MediaRecorder;
  try {
    recorder = new MediaRecorder(
      stream,
      MediaRecorder.isTypeSupported(MIME) ? { mimeType: MIME } : undefined,
    );
  } catch (error) {
    releaseStream(stream);
    throw error;
  }
  recorder.ondataavailable = (event) => {
    if (event.data.size > 0) chunks.push(event.data);
  };
  const stopped = new Promise<void>((resolve) => {
    recorder.onstop = () => resolve();
    recorder.onerror = () => resolve();
  });
  recorder.start(1000);

  const finish = async (): Promise<Blob | null> => {
    if (recorder.state !== 'inactive') recorder.stop();
    await stopped;
    releaseStream(stream);
    return chunks.length > 0 ? new Blob(chunks, { type: recorder.mimeType || MIME }) : null;
  };
  return {
    stop: async () => (await finish())?.arrayBuffer() ?? null,
    cancel: () => void finish(),
  };
}
