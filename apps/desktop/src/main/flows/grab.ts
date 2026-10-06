import { grabScreensExact } from '../capture/exact-capture';
import type { CaptureProvider, DisplayInfo } from '../capture/types';
import { log } from '../logger';
import { requestFrames } from '../worker';

/**
 * A pixel-exact image of one display for a step. The desktopCapturer image first (exact edges, no
 * pointer); the capture worker's frame when its size is not exactly the display's, and always in
 * the mock E2E build (synthetic frames, nothing real is captured there).
 */
export function createDisplayGrabber(provider: CaptureProvider, synthetic: boolean) {
  return async (
    display: DisplayInfo,
  ): Promise<{ width: number; height: number; png: Uint8Array }> => {
    if (!synthetic) {
      const grab = await grabScreensExact([display]).catch((error: unknown) => {
        log.warn(`Exact step grab failed (${String(error)}); using a video frame`);
        return undefined;
      });
      const exact = grab?.frames.get(display.id);
      if (exact) return { width: exact.width, height: exact.height, png: exact.image.toPNG() };
    }
    const sources = await provider.listSources({ types: ['screen'], thumbnailWidth: 0 });
    const source = sources.find((candidate) => candidate.displayId === display.id);
    if (!source) throw new Error('The screen is no longer available.');
    const [frame] = await requestFrames(
      [
        {
          sourceId: source.id,
          displayId: display.id,
          ...(synthetic && { syntheticSize: { ...display.physicalSize } }),
        },
      ],
      { synthetic },
    );
    if (!frame) throw new Error('The capture returned no image.');
    return { width: frame.width, height: frame.height, png: frame.png };
  };
}
