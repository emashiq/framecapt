/**
 * Debug counters for everything the capture library opens: media tracks, audio contexts and
 * timers/frame loops. Every module registers what it creates; the diagnostics view shows the
 * live counts and the native test asserts they return to zero after each test (no leaks).
 */
const tracks = new Set<MediaStreamTrack>();
const contexts = new Set<AudioContext>();
const loops = new Map<number, string>();
let nextLoopId = 1;

export function registerStream(stream: MediaStream): MediaStream {
  for (const track of stream.getTracks()) tracks.add(track);
  return stream;
}

export function registerTrack<T extends MediaStreamTrack>(track: T): T {
  tracks.add(track);
  return track;
}

export function registerAudioContext<T extends AudioContext>(ctx: T): T {
  contexts.add(ctx);
  return ctx;
}

/** Registers a running timer or frame loop; call the returned function when it stops. */
export function registerLoop(name: string): () => void {
  const id = nextLoopId++;
  loops.set(id, name);
  return () => {
    loops.delete(id);
  };
}

export interface ResourceSnapshot {
  liveTracks: number;
  openAudioContexts: number;
  activeLoops: number;
  loopNames: string[];
}

export function getResourceSnapshot(): ResourceSnapshot {
  for (const track of tracks) if (track.readyState === 'ended') tracks.delete(track);
  for (const ctx of contexts) if (ctx.state === 'closed') contexts.delete(ctx);
  return {
    liveTracks: tracks.size,
    openAudioContexts: contexts.size,
    activeLoops: loops.size,
    loopNames: [...loops.values()],
  };
}

export function stopStream(stream: MediaStream | undefined): void {
  stream?.getTracks().forEach((track) => track.stop());
}
