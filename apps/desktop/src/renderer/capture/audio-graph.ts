import { registerAudioContext } from './resource-registry';

export type AudioSourceName = 'mic' | 'system';

export interface AudioMix {
  /** One mixed track for the recorder. Never connected to the speakers. */
  readonly stream: MediaStream;
  /** Linear gain, 0 mutes. */
  setGain(source: AudioSourceName, gain: number): void;
  /** RMS level of the source after its gain, 0..1. */
  getLevel(source: AudioSourceName): number;
  /** Called when an input track ends (device unplugged, source closed). Returns unsubscribe. */
  onTrackEnded(listener: (source: AudioSourceName) => void): () => void;
  dispose(): void;
}

interface Branch {
  source: MediaStreamAudioSourceNode;
  gain: GainNode;
  analyser: AnalyserNode;
  buffer: Float32Array<ArrayBuffer>;
  track: MediaStreamTrack;
  onEnded: () => void;
}

/**
 * Explicit mix graph: each requested input -> its own GainNode (mute/volume) -> AnalyserNode (for
 * meters) and -> a shared MediaStreamAudioDestinationNode whose stream is recorded. Nothing is
 * connected to `ctx.destination`, so the mix is never played back (no echo/monitoring).
 *
 * The caller owns the input streams; `dispose()` only disconnects nodes and closes the context.
 */
export function createAudioMix(inputs: {
  micStream?: MediaStream | undefined;
  systemStream?: MediaStream | undefined;
}): AudioMix {
  const ctx = registerAudioContext(new AudioContext({ sampleRate: 48000 }));
  const destination = ctx.createMediaStreamDestination();
  const branches = new Map<AudioSourceName, Branch>();
  const listeners = new Set<(source: AudioSourceName) => void>();
  let disposed = false;

  const add = (name: AudioSourceName, stream: MediaStream | undefined): void => {
    const track = stream?.getAudioTracks()[0];
    if (!stream || !track) return;
    const source = ctx.createMediaStreamSource(new MediaStream([track]));
    const gain = ctx.createGain();
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 1024;
    source.connect(gain);
    gain.connect(analyser);
    gain.connect(destination);
    const onEnded = (): void => listeners.forEach((listener) => listener(name));
    track.addEventListener('ended', onEnded);
    branches.set(name, {
      source,
      gain,
      analyser,
      buffer: new Float32Array(new ArrayBuffer(analyser.fftSize * 4)),
      track,
      onEnded,
    });
  };
  add('mic', inputs.micStream);
  add('system', inputs.systemStream);

  // Created in a user gesture normally; make sure it is actually running.
  void ctx.resume();

  return {
    stream: destination.stream,
    setGain(source, gain) {
      const branch = branches.get(source);
      if (branch) branch.gain.gain.value = Math.max(0, Math.min(4, gain));
    },
    getLevel(source) {
      const branch = branches.get(source);
      if (!branch || disposed) return 0;
      branch.analyser.getFloatTimeDomainData(branch.buffer);
      let sum = 0;
      for (const sample of branch.buffer) sum += sample * sample;
      return Math.min(1, Math.sqrt(sum / branch.buffer.length));
    },
    onTrackEnded(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      for (const branch of branches.values()) {
        branch.track.removeEventListener('ended', branch.onEnded);
        branch.source.disconnect();
        branch.gain.disconnect();
        branch.analyser.disconnect();
      }
      branches.clear();
      listeners.clear();
      destination.stream.getTracks().forEach((track) => track.stop());
      destination.disconnect();
      void ctx.close().catch(() => undefined);
    },
  };
}
