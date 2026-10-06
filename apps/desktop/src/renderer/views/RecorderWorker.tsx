import { useEffect } from 'react';
import { CaptureError } from '../capture/errors';
import { grabFullResolutionFrame } from '../capture/frame';
import { getResourceSnapshot } from '../capture/resource-registry';
import { acquireDisplayStream, releaseStream } from '../capture/stream';
import { RecorderEngine } from '../recorder/engine';
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
  if (__FRAMECAPT_E2E__ && synthetic && source.syntheticSize) {
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
    await window.framecapt.invoke('worker:frameResult', { requestId: request.requestId, frames });
  } catch (error) {
    const code = error instanceof CaptureError ? error.code : 'unknown';
    const message = error instanceof Error ? error.message : String(error);
    await window.framecapt.invoke('worker:frameError', {
      requestId: request.requestId,
      code,
      message: message.slice(0, 500),
    });
  }
}

/**
 * The hidden capture worker (role 'recorder'). It has no UI. Main sends `worker:grabFrames` (this
 * answers with frames or an error, one request at a time) and `recorder:engineCommand` (the one
 * and only recorder, see recorder/engine.ts).
 */
export function RecorderWorker() {
  useEffect(() => {
    let queue: Promise<void> = Promise.resolve();
    const offFrames = window.framecapt.on('worker:grabFrames', (request) => {
      queue = queue.then(() => handleGrab(request)).catch(() => undefined);
    });
    const engine = new RecorderEngine({
      send: (event) => void window.framecapt.invoke('recorder:engineEvent', event),
      invoke: window.framecapt.invoke,
    });
    const offCommands = window.framecapt.on('recorder:engineCommand', (command) => {
      void engine.handle(command);
    });
    // Read-only debug counters (live tracks, audio contexts, timers, recorders) for the tests.
    Object.defineProperty(window, '__frameCaptResources', {
      value: getResourceSnapshot,
      configurable: true,
    });
    void window.framecapt.invoke('worker:ready');
    return () => {
      offFrames();
      offCommands();
      engine.releaseAll();
    };
  }, []);
  return null;
}
