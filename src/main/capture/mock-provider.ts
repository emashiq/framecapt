import type { SourceInfo } from '../../shared/capture-schemas';
import type { CaptureProvider, DisplayInfo, ListSourcesOptions } from './types';

/** 1x1 PNG, enough for UI tests to render a thumbnail. */
const PIXEL =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

const DISPLAYS: DisplayInfo[] = [
  {
    id: '1001',
    label: 'Mock display A',
    bounds: { x: 0, y: 0, width: 2560, height: 1440 },
    scaleFactor: 1,
    rotation: 0,
    physicalSize: { width: 2560, height: 1440 },
    isPrimary: true,
  },
  {
    id: '1002',
    label: 'Mock display B (left of primary)',
    bounds: { x: -2293, y: 0, width: 2293, height: 960 },
    scaleFactor: 1.5,
    rotation: 0,
    physicalSize: { width: 3440, height: 1440 },
    isPrimary: false,
  },
];

const SOURCES: SourceInfo[] = [
  { id: 'screen:1:0', name: 'Screen 1', kind: 'screen', displayId: '1001' },
  { id: 'screen:2:0', name: 'Screen 2', kind: 'screen', displayId: '1002' },
  { id: 'window:1001:0', name: 'Mock window', kind: 'window' },
];

/**
 * Deterministic fake for automated UI tests ONLY. It is only reachable from an E2E build
 * (see capture/index.ts) and must never ship in a normal build: scripts/check-no-mocks.mjs
 * fails if this class name appears in the production bundle.
 */
export class MockCaptureProvider implements CaptureProvider {
  listDisplays(): DisplayInfo[] {
    return structuredClone(DISPLAYS);
  }

  listSources(options: ListSourcesOptions): Promise<SourceInfo[]> {
    const withThumbs = (options.thumbnailWidth ?? 0) > 0;
    return Promise.resolve(
      SOURCES.filter((source) => options.types.includes(source.kind)).map((source) =>
        withThumbs ? { ...source, thumbnail: PIXEL } : { ...source },
      ),
    );
  }
}
