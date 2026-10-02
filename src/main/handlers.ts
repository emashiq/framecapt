import path from 'node:path';
import { app, session } from 'electron';
import { CaptureFlow } from './capture-flow';
import { isMockCaptureEnabled } from './capture';
import { registerShotHandlers } from './shot-handlers';
import { ShotSessionStore, SWEEP_MAX_AGE_MS } from './shots/session-store';
import { registerWorkerHandlers } from './worker';
import { installCaptureAuthorization } from './capture/authorization';
import { registerDiagnosticsHandlers } from './capture/diagnostics';
import type { CaptureProvider } from './capture/types';
import { getOriginConfig } from './windows';
import { handle } from './ipc';
import { log } from './logger';

/** Registers every IPC channel. Feature modules own their channels (capture/, diagnostics). */
export function registerHandlers(provider: CaptureProvider): void {
  handle('app:getInfo', { roles: ['main'] }, () => ({
    version: app.getVersion(),
    electron: process.versions.electron ?? '',
    chrome: process.versions.chrome ?? '',
    node: process.versions.node,
    platform: process.platform,
    arch: process.arch,
    isPackaged: app.isPackaged,
  }));

  handle(
    'app:reportError',
    { roles: ['main', 'overlay', 'toolbar', 'recorder'] },
    (report, ctx) => {
      const parts = [`Renderer error (${ctx.role}, ${report.source}): ${report.message}`];
      if (report.stack) parts.push(report.stack);
      if (report.componentStack) parts.push(`Component stack:${report.componentStack}`);
      log.error(parts.join('\n'));
    },
  );

  handle('capture:listDisplays', { roles: ['main'] }, () => provider.listDisplays());
  handle('capture:listSources', { roles: ['main'] }, (request) =>
    provider.listSources({
      types: request.types,
      ...(request.thumbnailWidth !== undefined && { thumbnailWidth: request.thumbnailWidth }),
    }),
  );
  installCaptureAuthorization(session.defaultSession, provider, getOriginConfig);
  registerDiagnosticsHandlers();

  const store = new ShotSessionStore(path.join(app.getPath('userData'), 'shots'));
  const flow = new CaptureFlow({ provider, store, synthetic: isMockCaptureEnabled() });
  registerWorkerHandlers();
  registerShotHandlers(flow, store);
  // Originals of abandoned sessions are removed after a week (a `keep` marker exempts one).
  void store.sweep(SWEEP_MAX_AGE_MS).then((result) => {
    log.info(
      `Shot sweep: scanned ${result.scanned}, removed ${result.removed}, kept ${result.kept}`,
    );
  });
}
