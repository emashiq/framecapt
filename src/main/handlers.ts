import fs from 'node:fs';
import path from 'node:path';
import { app, session } from 'electron';
import { createMediaTools, FfmpegError, resolveFfmpeg, type MediaTools } from './media/ffmpeg';
import { installMediaProtocol, MediaRegistry } from './recording/media-protocol';
import { RecoveryService } from './recording/recovery';
import { registerRecoveryHandlers } from './recording/recovery-handlers';
import { nodeSessionFs, type SessionFs } from './recording/session-fs';
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
import { sendEvent } from './events';
import { getOriginConfig, setMainCloseInterceptor, webContentsWithRoles } from './windows';
import { handle } from './ipc';
import { log } from './logger';

/** Build-time constant of vite.main.config.ts: the literal `false` in every normal build. */
declare const __FRAMELET_E2E__: boolean;

/**
 * E2E builds only: a file (FRAMELET_E2E_FREE_BYTES_FILE) holds the "free disk space" the service
 * sees, so tests can run the low-disk paths without filling a disk. Removed from normal builds.
 */
function e2eDiskFs(): { fs: SessionFs; diskCheckEveryMs: number } | undefined {
  const file = __FRAMELET_E2E__ ? process.env.FRAMELET_E2E_FREE_BYTES_FILE : undefined;
  if (!file) return undefined;
  return {
    fs: {
      ...nodeSessionFs,
      statfs: async () => ({ bavail: Number(await fs.promises.readFile(file, 'utf8')), bsize: 1 }),
    },
    diskCheckEveryMs: 500,
  };
}

/**
 * E2E builds only (FRAMELET_E2E_FFMPEG_DELAY_MS): the remux starts that many ms late (and can be
 * aborted meanwhile), to exercise the quit cap and interrupted finalization. Removed from normal
 * builds.
 */
function withE2eRemuxDelay(tools: MediaTools): MediaTools {
  const delay = __FRAMELET_E2E__ ? Number(process.env.FRAMELET_E2E_FFMPEG_DELAY_MS) : 0;
  if (!delay) return tools;
  return {
    ...tools,
    run: async (args, options = {}) => {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(resolve, delay);
        options.signal?.addEventListener('abort', () => {
          clearTimeout(timer);
          reject(new FfmpegError('FFMPEG_ABORTED', 'The media tool was cancelled.'));
        });
      });
      return tools.run(args, options);
    },
  };
}

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
  const recordingsDir = path.join(app.getPath('userData'), 'recordings');
  const outputDir = (): string => path.join(app.getPath('videos'), 'Framelet');
  const tools = withE2eRemuxDelay(
    createMediaTools(() =>
      resolveFfmpeg({
        isPackaged: app.isPackaged,
        resourcesPath: process.resourcesPath,
        appPath: app.getAppPath(),
      }),
    ),
  );
  const sessions = new SessionService(recordingsDir, {
    ...e2eDiskFs(),
    appVersion: app.getVersion(),
    onDiskLow: (sessionId) => recorder.onDiskLow(sessionId),
  });
  const recovery = new RecoveryService({
    rootDir: recordingsDir,
    fs: nodeSessionFs,
    tools,
    outputDir,
    isActive: (sessionId) => sessions.has(sessionId),
    appVersion: app.getVersion(),
  });
  const media = new MediaRegistry();
  installMediaProtocol(media);
  const recorder: RecorderController = new RecorderController({
    provider,
    sessions,
    media,
    synthetic,
    isScreenshotBusy: () => flow.state.active,
    outputDir,
    tools,
    // E2E builds only: a short cap to test quitting while finalizing takes too long.
    ...(__FRAMELET_E2E__ &&
      Number(process.env.FRAMELET_E2E_QUIT_CAP_MS) > 0 && {
        quitCapMs: Number(process.env.FRAMELET_E2E_QUIT_CAP_MS),
      }),
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
  registerRecoveryHandlers(recovery, recorder, media);
  // Closing the main window during a recording only minimizes it; quitting finishes the recording.
  setMainCloseInterceptor(() => recorder.isRecording && !recorder.isQuitting);
  app.on('before-quit', (event) => recorder.handleBeforeQuit(event, () => app.quit()));
  app.on('will-quit', () => void sessions.closeAll());
  // ffmpeg finishes every recording: say in the log whether it is usable, then clean up and
  // count what earlier runs left behind (interrupted finalizations are resumed once).
  void tools.version().then(
    (version) => log.info(`ffmpeg ok ${version}`),
    (error: unknown) =>
      log.error('ffmpeg is not usable (run "npm run fetch:ffmpeg" in development)', error),
  );
  void recovery
    .startup()
    .catch((error: unknown) => log.error('Recovery scan failed', error))
    .then(() => {
      for (const contents of webContentsWithRoles(['main'])) {
        sendEvent(contents, 'recovery:changed', {});
      }
    });
  // Originals of abandoned sessions are removed after a week (a `keep` marker exempts one).
  void store.sweep(SWEEP_MAX_AGE_MS).then((result) => {
    log.info(
      `Shot sweep: scanned ${result.scanned}, removed ${result.removed}, kept ${result.kept}`,
    );
  });
}
