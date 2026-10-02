import { ElectronCaptureProvider } from './electron-provider';
import type { CaptureProvider } from './types';

/**
 * Build-time constant, defined by vite.main.config.ts: true only when the bundle is built with
 * FRAMELET_E2E_BUILD=1. In every normal build it is the literal `false`, so the branch below and
 * the dynamically imported mock module are removed from the bundle.
 */
declare const __FRAMELET_E2E__: boolean;

/** True only in an E2E build started with FRAMELET_E2E_MOCK_CAPTURE=1 (never in a normal build). */
export function isMockCaptureEnabled(): boolean {
  return __FRAMELET_E2E__ && process.env.FRAMELET_E2E_MOCK_CAPTURE === '1';
}

export async function createCaptureProvider(): Promise<CaptureProvider> {
  // The literal build-time constant is repeated here so the bundler can drop the dynamic import.
  if (__FRAMELET_E2E__ && isMockCaptureEnabled()) {
    const { MockCaptureProvider } = await import('./mock-provider');
    return new MockCaptureProvider();
  }
  return new ElectronCaptureProvider();
}
