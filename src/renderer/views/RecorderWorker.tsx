import { useEffect } from 'react';
import { CaptureError } from '../capture/errors';
import { grabFullResolutionFrame } from '../capture/frame';
import { acquireDisplayStream, releaseStream } from '../capture/stream';
import type { GrabFramesEvent } from '../../shared/shot-ipc';

interface GrabbedFrame {
  sourceId: string;
  width: number;
  height: number;
  png: ArrayBuffer;
}

/** One source: acquire the stream, grab one full-resolution PNG, release the tracks at once. */
async function grabSource(
  source: GrabFramesEvent['sources'][number],
  synthetic: boolean,
): Promise<GrabbedFrame> {
  if (__FRAMELET_E2E__ && synthetic && source.syntheticSize) {
    const { drawSyntheticFrame } = await import('../capture/synthetic-frame');
    const { width, height } = source.syntheticSize;
    return {
      sourceId: source.sourceId,
      width,
      height,
      png: await drawSyntheticFrame(source.sourceId, width, height),
    };
  }
  const stream = await acquireDisplayStream({
    sourceId: source.sourceId,
    systemAudio: false,
    maxFrameRate: 5,
  });
  try {
    const frame = await grabFullResolutionFrame(stream);
    return {
      sourceId: source.sourceId,
      width: frame.width,
      height: frame.height,
      png: await frame.blob.arrayBuffer(),
    };
  } finally {
    releaseStream(stream);
  }
}

async function handleGrab(request: GrabFramesEvent): Promise<void> {
  try {
    const frames: GrabbedFrame[] = [];
    // Sequential on purpose: a capture grant is one-shot per webContents.
    for (const source of request.sources) {
      frames.push(await grabSource(source, request.synthetic === true));
    }
    await window.framelet.invoke('worker:frameResult', { requestId: request.requestId, frames });
  } catch (error) {
    const code = error instanceof CaptureError ? error.code : 'unknown';
    const message = error instanceof Error ? error.message : String(error);
    await window.framelet.invoke('worker:frameError', {
      requestId: request.requestId,
      code,
      message: message.slice(0, 500),
    });
  }
}

/**
 * The hidden capture worker (role 'recorder'). It has no UI: main sends `worker:grabFrames`, this
 * answers with frames or an error. Requests are handled one at a time. Phase 05 adds recording to
 * this same window.
 */
export function RecorderWorker() {
  useEffect(() => {
    let queue: Promise<void> = Promise.resolve();
    const off = window.framelet.on('worker:grabFrames', (request) => {
      queue = queue.then(() => handleGrab(request)).catch(() => undefined);
    });
    void window.framelet.invoke('worker:ready');
    return off;
  }, []);
  return null;
}
