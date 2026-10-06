import fs from 'node:fs';
import path from 'node:path';
import { app, nativeImage, session, shell } from 'electron';
import { BulkExportService } from './history/bulk-export';
import { CompressService, postSaveAction } from './history/compress-service';
import { ExportService } from './history/export-service';
import { registerHistoryHandlers, mp4SaveDialog, pickCopiesFolder } from './history/handlers';
import { rescanLibrary } from './history/rescan';
import { createAfterCapture, createSaveCaptureDirect } from './shots/after-capture';
import { rememberExported } from './shots/exported-paths';
import type { AppSettings } from './settings';
import { probeWritable } from './settings/output-dirs';
import type { TrayInfo } from './tray-info';
import { HistoryService } from './history/service';
import { detectMp4Capability, MP4_UNAVAILABLE_MESSAGE, type Mp4Capability } from './media/export';
import { JobRunner } from './media/job-runner';
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
import { ProjectStore } from './projects/store';
import { ShotSessionStore, SWEEP_MAX_AGE_MS } from './shots/session-store';
import { registerWorkerHandlers } from './worker';
import { installDisplayMediaGrants } from './capture/display-media';
import { registerDiagnosticsHandlers } from './capture/diagnostics';
import type { CaptureProvider } from './capture/types';
import type { IpcEventPayload } from '../shared/ipc-contract';
import { sendEvent } from './events';
import type { UpdateService } from './updates';
import { getOriginConfig, setMainCloseInterceptor, webContentsWithRoles } from './windows';
import { IpcError } from './ipc-core';
import { handle } from './ipc';
import { log } from './logger';

/** Build-time constant of vite.main.config.ts: the literal `false` in every normal build. */
declare const __FRAMECAPT_E2E__: boolean;

/**
 * E2E builds only: a file (FRAMECAPT_E2E_FREE_BYTES_FILE) holds the "free disk space" the service
 * sees, so tests can run the low-disk paths without filling a disk. Removed from normal builds.
 */
function e2eDiskFs(): { fs: SessionFs; diskCheckEveryMs: number } | undefined {
  const file = __FRAMECAPT_E2E__ ? process.env.FRAMECAPT_E2E_FREE_BYTES_FILE : undefined;
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
 * E2E builds only (FRAMECAPT_E2E_FFMPEG_DELAY_MS): the remux starts that many ms late (and can be
 * aborted meanwhile), to exercise the quit cap and interrupted finalization. Removed from normal
 * builds.
 */
function withE2eRemuxDelay(tools: MediaTools): MediaTools {
  const delay = __FRAMECAPT_E2E__ ? Number(process.env.FRAMECAPT_E2E_FFMPEG_DELAY_MS) : 0;
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

function emitToMain<
  E extends 'export:progress' | 'export:done' | 'export:failed' | 'history:bulkProgress',
>(event: E, payload: IpcEventPayload<E>): void {
  for (const contents of webContentsWithRoles(['main'])) sendEvent(contents, event, payload);
}

/** A free `<name>.mp4` next to the recording (no dialog). */
async function freeMp4Path(source: { path: string }): Promise<string> {
  const dir = path.dirname(source.path);
  const base = path.basename(source.path, path.extname(source.path));
  for (let attempt = 1; attempt < 1000; attempt += 1) {
    const name = attempt === 1 ? `${base}.mp4` : `${base} (${attempt}).mp4`;
    const candidate = path.join(dir, name);
    if (!fs.existsSync(candidate)) return candidate;
  }
  throw new Error('No free MP4 name.');
}

/** What the desktop layer (tray, shortcuts) drives: the same objects the IPC handlers use. */
export interface AppServices {
  flow: CaptureFlow;
  recorder: RecorderController;
  exports: ExportService;
  history: HistoryService;
  sessions: SessionService;
  store: ShotSessionStore;
  /** A capture, recording or export is in progress. */
  isBusy(): boolean;
}

/** Registers every IPC channel. Feature modules own their channels (capture/, diagnostics). */
export function registerHandlers(
  provider: CaptureProvider,
  settings: AppSettings,
  trayInfo: () => TrayInfo,
  updates: UpdateService,
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
    updates: updates.getStatus(),
  }));

  handle(
    'app:reportError',
    { roles: ['main', 'overlay', 'toolbar', 'recorder', 'countdown', 'camera'] },
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
  installDisplayMediaGrants(session.defaultSession, provider, getOriginConfig);
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
  const historyDir = path.join(app.getPath('userData'), 'history');
  const projects = new ProjectStore(path.join(app.getPath('userData'), 'projects'));
  const history = new HistoryService({
    dir: historyDir,
    projects,
    tools,
    trashItem: (file) => shell.trashItem(file),
    onChange: () => {
      for (const contents of webContentsWithRoles(['main']))
        sendEvent(contents, 'history:changed', {});
    },
  });
  // Capability is asked once, at startup, and cached (the answer cannot change while running).
  // E2E builds only (FRAMECAPT_E2E_NO_H264=1): behave like a build without an H.264 encoder.
  const detected: Promise<Mp4Capability> =
    __FRAMECAPT_E2E__ && process.env.FRAMECAPT_E2E_NO_H264 === '1'
      ? Promise.resolve({ available: false, reason: MP4_UNAVAILABLE_MESSAGE })
      : detectMp4Capability(tools);
  const mp4Capability: Promise<Mp4Capability> = detected.then((capability) => {
    log.info(`MP4 export ${capability.available ? 'available (libx264 + aac)' : 'unavailable'}`);
    return capability;
  });
  // One ffmpeg job at a time: the user's MP4 exports and the compressed-storage jobs share a queue.
  const runner = new JobRunner();
  const exports = new ExportService({
    history,
    tools,
    capability: () => mp4Capability,
    pickDestination: (source) => mp4SaveDialog(source, outputDir()),
    autoDestination: freeMp4Path,
    runner,
    emit: {
      progress: (event) => emitToMain('export:progress', event),
      done: (event) => emitToMain('export:done', event),
      failed: (event) => emitToMain('export:failed', event),
    },
  });
  const compress = new CompressService({
    history,
    tools,
    capability: () => mp4Capability,
    storage: () => settings.store.get().recording.storage,
    destination: freeMp4Path,
    trashItem: (file) => shell.trashItem(file),
    runner,
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
  const captureSaving = {
    settings: () => settings.store.get(),
    screenshotsDir: () => settings.dirs().screenshotsDir,
    history,
  };
  const saveDirect = createSaveCaptureDirect(captureSaving);
  const recorder: RecorderController = new RecorderController({
    provider,
    saveScreenshot: saveDirect,
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
          "FrameCapt can't save recordings to the chosen folder. Choose another one in Settings → Storage.",
        );
      }
    },
    onSaved: (historyId) => {
      if (!historyId) return;
      // One MP4, never two: compressed storage wins over "Export MP4 automatically".
      const action = postSaveAction(settings.store.get().recording);
      if (action === 'compress') void compress.startIfEnabled(historyId);
      else if (action === 'export') void exports.startAuto(historyId);
    },
    persistCameraStyle: (patch) => void settings.store.update({ recording: patch }),
    // E2E builds only: a slow engine start, to test a stop that arrives while starting.
    ...(__FRAMECAPT_E2E__ &&
      Number(process.env.FRAMECAPT_E2E_ENGINE_START_DELAY_MS) > 0 && {
        engineStartDelayMs: Number(process.env.FRAMECAPT_E2E_ENGINE_START_DELAY_MS),
      }),
    // E2E builds only: a short cap to test quitting while finalizing takes too long.
    ...(__FRAMECAPT_E2E__ &&
      Number(process.env.FRAMECAPT_E2E_QUIT_CAP_MS) > 0 && {
        quitCapMs: Number(process.env.FRAMECAPT_E2E_QUIT_CAP_MS),
      }),
  });
  const flow = new CaptureFlow({
    provider,
    store,
    synthetic,
    // A screenshot may start while a recording runs (saved directly), not while one is set up or saved.
    isBlocked: () => recorder.busy && !recorder.isLive,
    isRecording: () => recorder.isLive,
    saveDirect,
    toast: (event) => recorder.toastToolbar(event),
    afterCapture: createAfterCapture(captureSaving),
  });
  // The recording ended (or was stopped) while a screenshot selection was open: drop the selection.
  recorder.onChange(() => {
    if (flow.duringRecording && !recorder.isLive) flow.cancel();
  });
  registerWorkerHandlers();
  registerShotHandlers(
    flow,
    store,
    recorder,
    history,
    {
      get: () => settings.store.get(),
      screenshotsDir: () => settings.dirs().screenshotsDir,
    },
    { store: projects, appVersion: app.getVersion() },
  );
  const bulk = new BulkExportService({
    history,
    pickFolder: () => pickCopiesFolder(settings.dirs().screenshotsDir),
    writable: probeWritable,
    onSaved: rememberExported,
    onProgress: (done, total) => emitToMain('history:bulkProgress', { done, total }),
  });
  const rescan = (): Promise<number> =>
    rescanLibrary({
      dirs: [settings.dirs().screenshotsDir, settings.dirs().recordingsDir],
      history,
      tools,
      thumbnail: async (file, width) => {
        const image = nativeImage.createFromPath(file);
        return image.isEmpty() ? undefined : image.resize({ width }).toPNG();
      },
    });
  registerHistoryHandlers(history, exports, bulk, () => mp4Capability, outputDir, rescan);
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
  // A fresh start (no history.json: first run, a reinstall, lost app data): earlier recordings,
  // then any capture files already sitting in the output folders. Once; later it is a button.
  void history.ready
    .then(async () => {
      const firstRun = history.isFirstRun;
      const backfilled = await history.backfillFromCompleted(recordingsDir);
      if (backfilled > 0) log.info(`History: added ${backfilled} earlier recordings`);
      if (!firstRun) return;
      const found = await rescan();
      if (found > 0) log.info(`History: found ${found} existing captures`);
    })
    .catch((error: unknown) => log.error('History backfill failed', error));
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
  return {
    flow,
    recorder,
    exports,
    history,
    sessions,
    store,
    isBusy: () => recorder.busy || flow.state.active || exports.active,
  };
}
