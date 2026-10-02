import fs from 'node:fs';
import path from 'node:path';
import { app, session, shell } from 'electron';
import { ExportService } from './history/export-service';
import { registerHistoryHandlers, mp4SaveDialog } from './history/handlers';
import { createAfterCapture } from './shots/after-capture';
import type { AppSettings } from './settings';
import { probeWritable } from './settings/output-dirs';
import type { TrayInfo } from './tray-info';
import { HistoryService } from './history/service';
import { detectMp4Capability, MP4_UNAVAILABLE_MESSAGE, type Mp4Capability } from './media/export';
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
import type { IpcEventPayload } from '../shared/ipc-contract';
import { sendEvent } from './events';
import { getOriginConfig, setMainCloseInterceptor, webContentsWithRoles } from './windows';
import { IpcError } from './ipc-core';
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

function emitToMain<E extends 'export:progress' | 'export:done' | 'export:failed'>(
  event: E,
  payload: IpcEventPayload<E>,
): void {
  for (const contents of webContentsWithRoles(['main'])) sendEvent(contents, event, payload);
}

/** What the desktop layer (tray, shortcuts) drives: the same objects the IPC handlers use. */
export interface AppServices {
  flow: CaptureFlow;
  recorder: RecorderController;
  exports: ExportService;
  history: HistoryService;
  sessions: SessionService;
  store: ShotSessionStore;
}

/** Registers every IPC channel. Feature modules own their channels (capture/, diagnostics). */
export function registerHandlers(
  provider: CaptureProvider,
  settings: AppSettings,
  trayInfo: () => TrayInfo,
): AppServices {
  handle('app:getInfo', { roles: ['main'] }, () => ({
    version: app.getVersion(),
    electron: process.versions.electron ?? '',
    chrome: process.versions.chrome ?? '',
    node: process.versions.node,
    platform: process.platform,
    arch: process.arch,
    isPackaged: app.isPackaged,
    tray: trayInfo(),
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
  const outputDir = (): string => settings.dirs().recordingsDir;
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
  const history = new HistoryService({
    dir: path.join(app.getPath('userData'), 'history'),
    tools,
    trashItem: (file) => shell.trashItem(file),
    onChange: () => {
      for (const contents of webContentsWithRoles(['main']))
        sendEvent(contents, 'history:changed', {});
    },
  });
  // Capability is asked once, at startup, and cached (the answer cannot change while running).
  // E2E builds only (FRAMELET_E2E_NO_H264=1): behave like a build without an H.264 encoder.
  const detected: Promise<Mp4Capability> =
    __FRAMELET_E2E__ && process.env.FRAMELET_E2E_NO_H264 === '1'
      ? Promise.resolve({ available: false, reason: MP4_UNAVAILABLE_MESSAGE })
      : detectMp4Capability(tools);
  const mp4Capability: Promise<Mp4Capability> = detected.then((capability) => {
    log.info(`MP4 export ${capability.available ? 'available (libx264 + aac)' : 'unavailable'}`);
    return capability;
  });
  const exports = new ExportService({
    history,
    tools,
    capability: () => mp4Capability,
    pickDestination: (source) => mp4SaveDialog(source, outputDir()),
    autoDestination: async (source) => {
      const dir = path.dirname(source.path);
      const base = path.basename(source.path, path.extname(source.path));
      for (let attempt = 1; attempt < 1000; attempt += 1) {
        const name = attempt === 1 ? `${base}.mp4` : `${base} (${attempt}).mp4`;
        const candidate = path.join(dir, name);
        if (!fs.existsSync(candidate)) return candidate;
      }
      throw new Error('No free MP4 name.');
    },
    emit: {
      progress: (event) => emitToMain('export:progress', event),
      done: (event) => emitToMain('export:done', event),
      failed: (event) => emitToMain('export:failed', event),
    },
  });
  const recovery = new RecoveryService({
    rootDir: recordingsDir,
    fs: nodeSessionFs,
    tools,
    outputDir,
    isActive: (sessionId) => sessions.has(sessionId),
    appVersion: app.getVersion(),
    history,
  });
  const media = new MediaRegistry();
  installMediaProtocol(media, history);
  const recorder: RecorderController = new RecorderController({
    provider,
    sessions,
    media,
    synthetic,
    isScreenshotBusy: () => flow.state.active,
    outputDir,
    tools,
    history,
    ensureOutputDir: async () => {
      if (!(await probeWritable(outputDir()))) {
        throw new IpcError(
          'OUTPUT_DIR_UNWRITABLE',
          "Framelet can't save recordings to the chosen folder. Choose another one in Settings → Storage.",
        );
      }
    },
    onSaved: (historyId) => {
      if (historyId && settings.store.get().recording.autoExportMp4) {
        void exports.startAuto(historyId);
      }
    },
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
    afterCapture: createAfterCapture({
      settings: () => settings.store.get(),
      screenshotsDir: () => settings.dirs().screenshotsDir,
      history,
    }),
  });
  registerWorkerHandlers();
  registerShotHandlers(flow, store, recorder, history, {
    get: () => settings.store.get(),
    screenshotsDir: () => settings.dirs().screenshotsDir,
  });
  registerHistoryHandlers(history, exports, () => mp4Capability, outputDir);
  registerRecorderHandlers(recorder, sessions, media);
  registerRecoveryHandlers(recovery, recorder, media);
  // Closing the main window during a recording only minimizes it; quitting finishes the recording.
  setMainCloseInterceptor(() => recorder.isRecording && !recorder.isQuitting);
  app.on('before-quit', (event) => recorder.handleBeforeQuit(event, () => app.quit()));
  app.on('will-quit', () => void sessions.closeAll());
  // An export in progress is cancelled (its partial file removed) before the app exits.
  app.on('before-quit', (event) => {
    if (!exports.active) return;
    event.preventDefault();
    const quit = (): void => app.quit();
    void Promise.race([
      exports.cancelAll(),
      new Promise((resolve) => setTimeout(resolve, 5000)),
    ]).then(quit, quit);
  });
  // ffmpeg finishes every recording: say in the log whether it is usable, then clean up and
  // count what earlier runs left behind (interrupted finalizations are resumed once).
  void tools.version().then(
    (version) => log.info(`ffmpeg ok ${version}`),
    (error: unknown) =>
      log.error('ffmpeg is not usable (run "npm run fetch:ffmpeg" in development)', error),
  );
  void history.backfillFromCompleted(recordingsDir).then(
    (added) => added > 0 && log.info(`History: added ${added} earlier recordings`),
    (error: unknown) => log.error('History backfill failed', error),
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
  return { flow, recorder, exports, history, sessions, store };
}
