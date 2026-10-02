import path from 'node:path';
import { app, session } from 'electron';
import { installMediaProtocol, MediaRegistry } from './recording/media-protocol';
import { SessionService } from './recording/session-service';
import { RecorderController } from './recorder/controller';
import { registerRecorderHandlers } from './recorder/handlers';
import { CaptureFlow } from './capture-flow';
import { isMockCaptureEnabled } from './capture';
import { registerShotHandlers } from './shot-handlers';
import { ShotSessionStore, SWEEP_MAX_AGE_MS } from './shots/session-store';
import { registerWorkerHandlers } from './worker';
import { installCaptureAuthorization } from './capture/authorization';
import { registerDiagnosticsHandlers } from './capture/diagnostics';
import type { CaptureProvider } from './capture/types';
import { getOriginConfig, setMainCloseInterceptor } from './windows';
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
  const synthetic = isMockCaptureEnabled();
  const sessions = new SessionService(path.join(app.getPath('userData'), 'recordings'));
  const media = new MediaRegistry();
  installMediaProtocol(media);
  const recorder: RecorderController = new RecorderController({
    provider,
    sessions,
    media,
    synthetic,
    isScreenshotBusy: () => flow.state.active,
    outputDir: () => path.join(app.getPath('videos'), 'Framelet'),
  });
  const flow = new CaptureFlow({
    provider,
    store,
    synthetic,
    isBlocked: () => recorder.busy,
  });
  registerWorkerHandlers();
  registerShotHandlers(flow, store, recorder);
  registerRecorderHandlers(recorder, sessions, media);
  // Closing the main window during a recording only minimizes it; quitting finishes the recording.
  setMainCloseInterceptor(() => recorder.isRecording && !recorder.isQuitting);
  app.on('before-quit', (event) => recorder.handleBeforeQuit(event, () => app.quit()));
  app.on('will-quit', () => void sessions.closeAll());
  // Originals of abandoned sessions are removed after a week (a `keep` marker exempts one).
  void store.sweep(SWEEP_MAX_AGE_MS).then((result) => {
    log.info(
      `Shot sweep: scanned ${result.scanned}, removed ${result.removed}, kept ${result.kept}`,
    );
  });
}
