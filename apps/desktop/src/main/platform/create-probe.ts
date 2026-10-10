import { execFile } from 'node:child_process';
import { desktopCapturer } from 'electron';
import { describeError, log } from '../logger';
import { FallbackWindowProbe } from './fallback-probe';
import type { WindowProbe } from './window-probe';

/** Defined by vite.main.config.ts: the literal `false` in every normal build (the mock is removed). */
declare const __FRAMECAPT_E2E__: boolean;

function execFileText(
  file: string,
  args: string[],
  options: { shell: false; windowsHide: true; timeout: number },
): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(file, args, { ...options, encoding: 'utf8' }, (error, stdout) =>
      error ? reject(error) : resolve(stdout),
    );
  });
}

/**
 * The probe for this process: the Win32 (koffi) one on Windows, the fallback when koffi cannot
 * load or off Windows, and in an E2E build started with FRAMECAPT_E2E_MOCK_PROBE=1 the mock.
 * Async only because the mock is a dynamic import the bundler can drop.
 */
export async function createWindowProbe(): Promise<WindowProbe> {
  if (__FRAMECAPT_E2E__ && process.env.FRAMECAPT_E2E_MOCK_PROBE === '1') {
    const { MockWindowProbe } = await import('./mock-probe');
    const mock = new MockWindowProbe();
    mock.exposeTestHook();
    return mock;
  }
  if (process.platform === 'win32') {
    try {
      const { Win32WindowProbe } = await import('./win32-probe');
      const probe = new Win32WindowProbe();
      log.info('window probe: win32 (koffi)');
      return probe;
    } catch (error) {
      log.warn(`window probe: koffi unavailable, using the fallback (${describeError(error)})`);
    }
  } else {
    log.info('window probe: fallback (not Windows)');
  }
  return new FallbackWindowProbe({
    desktopCapturer,
    execFile: execFileText,
    platform: process.platform,
  });
}
