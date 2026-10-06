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
  { id: 'window:1002:0', name: 'Mock browser - Documentation', kind: 'window' },
  {
    id: 'window:1003:0',
    name: 'Mock editor - a rather long file name that must be truncated.ts',
    kind: 'window',
  },
  { id: 'window:1004:0', name: 'Mock terminal', kind: 'window' },
  // The synthetic worker fails this one, like a minimized window (see synthetic-frame.ts).
  { id: 'window:1005:0', name: 'Mock minimized window', kind: 'window' },
];

/**
 * Deterministic fake for automated UI tests ONLY. It is only reachable from an E2E build
 * (see capture/index.ts) and must never ship in a normal build: scripts/check-no-mocks.mjs
 * fails if this class name appears in the production bundle.
 */
export class MockCaptureProvider implements CaptureProvider {
  /** FRAMECAPT_E2E_MOCK_DISPLAYS=1 limits the mock to the first display (single-monitor flow). */
  private readonly single = process.env.FRAMECAPT_E2E_MOCK_DISPLAYS === '1';

  listDisplays(): DisplayInfo[] {
    return structuredClone(this.single ? DISPLAYS.slice(0, 1) : DISPLAYS);
  }

  listSources(options: ListSourcesOptions): Promise<SourceInfo[]> {
    const withThumbs = (options.thumbnailWidth ?? 0) > 0;
    return Promise.resolve(
      SOURCES.filter(
        (source) =>
          options.types.includes(source.kind) && !(this.single && source.id === 'screen:2:0'),
      ).map((source) => (withThumbs ? { ...source, thumbnail: PIXEL } : { ...source })),
    );
  }
}
