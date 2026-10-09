import fs from 'node:fs';
import path from 'node:path';
import {
  app,
  BrowserWindow,
  Menu,
  nativeImage,
  Notification,
  screen,
  session,
  shell,
  webContents,
} from 'electron';
import { BulkExportService } from './history/bulk-export';
import { AutoCopy } from './clipboard/auto-copy';
import { FinalizeService } from './history/finalize-service';
import { ExportService } from './history/export-service';
import { ExtractService } from './history/extract-service';
import { OpenVideoService, registerOpenVideoHandler } from './history/open-video';
import { registerSplitHandler, SplitService, splitAndOpen } from './history/split-service';
import { registerHistoryHandlers, mp4SaveDialog, pickCopiesFolder } from './history/handlers';
import { ProjectFileService, registerProjectFileHandlers } from './history/project-files';
import { rescanLibrary } from './history/rescan';
import { registerLibraryHandlers } from './library/handlers';
import { LibraryService } from './library/service';
import { LibraryStore } from './library/store';
import { createAfterCapture, createSaveCaptureDirect } from './shots/after-capture';
import { rememberExported } from './shots/exported-paths';
import type { AppSettings } from './settings';
import { probeWritable } from './settings/output-dirs';
import type { TrayInfo } from './tray-info';
import { HistoryService } from './history/service';
import { detectEncoders, type EncoderCapability } from './media/convert';
import { detectMp4Capability, MP4_UNAVAILABLE_MESSAGE, type Mp4Capability } from './media/export';
import { JobRunner } from './media/job-runner';
import { createMediaTools, FfmpegError, resolveFfmpeg, type MediaTools } from './media/ffmpeg';
import { installMediaProtocol, MediaRegistry } from './recording/media-protocol';
import { RecoveryService } from './recording/recovery';
import { registerRecoveryHandlers } from './recording/recovery-handlers';
import { nodeSessionFs, type SessionFs } from './recording/session-fs';
import { SessionService } from './recording/session-service';
import { RecorderController } from './recorder/controller';
import { HiddenWindowPool } from './recorder/engine-pool';
import { registerRecorderHandlers } from './recorder/handlers';
import { buildPanelMenuTemplate, buildScreenshotMenuTemplate } from './recorder/toolbar-menus';
import { Cancelled } from './recorder/recording-session';
import { CaptureFlow } from './capture-flow';
import { StepsController } from './flows/controller';
import { pickExportFolder, pickGuideSave } from './flows/dialogs';
import { FlowSessions } from './flows/flow-store';
import { createDisplayGrabber } from './flows/grab';
import { registerFlowHandlers } from './flows/handlers';
import { createStepsPill } from './flows/pill';
import { FlowService } from './flows/service';
import { guideThumbnail } from './flows/thumbnail';
import { isMockCaptureEnabled } from './capture';
import { openEditorTab, registerEditorHandlers } from './editor-host';
import { registerShotHandlers } from './shot-handlers';
import { ProjectStore } from './projects/store';
import { VideoEditService, editedDestination } from './video-projects/service';
import { pickAudioFile, registerVideoHandlers } from './video-projects/handlers';
import { VideoProjectStore } from './video-projects/store';
import { freeFileName } from './shots/free-name';
import { ShotSessionStore, SWEEP_MAX_AGE_MS } from './shots/session-store';
import { registerWorkerHandlers } from './worker';
import { installDisplayMediaGrants } from './capture/display-media';
import { registerDiagnosticsHandlers } from './capture/diagnostics';
import type { CaptureProvider } from './capture/types';
import type { IpcEventPayload } from '../shared/ipc-contract';
import { friendlyError } from '../shared/error-messages';
import type { StartScreenshotRequest } from '../shared/shot-ipc';
import { sendEvent } from './events';
import type { UpdateService } from './updates';
import {
  getMainWindow,
  getOriginConfig,
  setMainCloseInterceptor,
  setMainProtected,
  showMainWindow,
  webContentsWithRoles,
} from './windows';
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
  E extends
    | 'export:progress'
    | 'export:done'
    | 'export:failed'
    | 'history:bulkProgress'
    | 'video:exportProgress'
    | 'video:exportDone'
    | 'video:exportFailed',
>(event: E, payload: IpcEventPayload<E>): void {
  for (const contents of webContentsWithRoles(['main'])) sendEvent(contents, event, payload);
}

/** A free `<name><suffix><extension>` next to the recording (no dialog). */
async function freeVideoPath(
  source: { path: string },
  extension: string,
  suffix = '',
): Promise<string> {
  const dir = path.dirname(source.path);
  const base = `${path.basename(source.path, path.extname(source.path))}${suffix}`;
  for (let attempt = 1; attempt < 1000; attempt += 1) {
    const name = attempt === 1 ? `${base}${extension}` : `${base} (${attempt})${extension}`;
    const candidate = path.join(dir, name);
    if (!fs.existsSync(candidate)) return candidate;
  }
  throw new Error(`No free ${extension} name.`);
}

/** What the desktop layer (tray, shortcuts) drives: the same objects the IPC handlers use. */
export interface AppServices {
  flow: CaptureFlow;
  recorder: RecorderController;
  steps: StepsController;
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
    { roles: ['main', 'overlay', 'toolbar', 'recorder', 'countdown', 'camera', 'meeting-prompt'] },
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
  // New recordings (and what is saved beside them) go into the chosen library folder, if any.
  const outputDir = (): string => library.saveDir('recordings');
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
  const videoProjects = new VideoProjectStore(path.join(app.getPath('userData'), 'video-projects'));
  const history = new HistoryService({
    dir: historyDir,
    projects,
    videoProjects,
    tools,
    trashItem: (file) => shell.trashItem(file),
    folderOf: (dir) => library.folderOfDir(dir),
    onChange: () => {
      for (const contents of webContentsWithRoles(['main']))
        sendEvent(contents, 'history:changed', {});
    },
  });
  const libraryStore = new LibraryStore(app.getPath('userData'));
  const library: LibraryService = new LibraryService({
    roots: () => settings.dirs(),
    history: {
      ready: Promise.all([history.ready, libraryStore.load()]).then(() => undefined),
      items: () => history.items(),
      rewritePaths: (changes) => history.rewritePaths(changes),
    },
    store: libraryStore,
    captureFolder: {
      get: () => settings.store.get().general.captureFolder,
      set: (folder) => void settings.store.setCaptureFolder(folder),
    },
    trashItem: (file) => shell.trashItem(file),
    onChange: () => {
      for (const contents of webContentsWithRoles(['main']))
        sendEvent(contents, 'library:changed', {});
    },
  });
  registerLibraryHandlers(library);
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
  // Which encoders the bundled build has (WebM, GIF, H.264): the save-format controls follow it.
  // E2E builds only (FRAMECAPT_E2E_NO_H264=1): no H.264 here either.
  const encoders: Promise<EncoderCapability> = detectEncoders(tools).then((found) =>
    __FRAMECAPT_E2E__ && process.env.FRAMECAPT_E2E_NO_H264 === '1'
      ? { ...found, h264: false }
      : found,
  );
  // One ffmpeg job at a time: the user's MP4 exports and the save-format jobs share a queue.
  const runner = new JobRunner();
  const exports = new ExportService({
    history,
    tools,
    capability: () => mp4Capability,
    pickDestination: (source) => mp4SaveDialog(source, outputDir()),
    autoDestination: (source) => freeVideoPath(source, '.mp4'),
    runner,
    emit: {
      progress: (event) => emitToMain('export:progress', event),
      done: (event) => emitToMain('export:done', event),
      failed: (event) => emitToMain('export:failed', event),
    },
  });
  const extracts = new ExtractService({
    history,
    tools,
    capability: () => mp4Capability,
    runner,
    emit: {
      progress: (event) => emitToMain('export:progress', event),
      done: (event) => emitToMain('export:done', event),
      failed: (event) => emitToMain('export:failed', event),
    },
  });
  const splitter = new SplitService({
    history,
    extracts,
    capability: () => mp4Capability,
  });
  registerSplitHandler(splitter);
  registerOpenVideoHandler(
    new OpenVideoService({
      history,
      tools,
      runner,
      recordingsDir: outputDir,
      encoders: () => encoders,
      openTab: openEditorTab,
    }),
  );
  // The clipboard rule: a confirmation goes to the recording toolbar while recording, else to the
  // main window, else (it is hidden in the tray) to the OS when notifications are on.
  const autoCopy = new AutoCopy({
    settings: () => settings.store.get(),
    notify: (message) => {
      if (recorder.anyLive) {
        recorder.toastToolbar({ level: 'info', message });
      } else if (getMainWindow()?.isVisible()) {
        for (const contents of webContentsWithRoles(['main']))
          sendEvent(contents, 'app:toast', { level: 'info', message });
      } else if (settings.store.get().general.showNotifications && Notification.isSupported()) {
        new Notification({ title: 'FrameCapt', body: message, silent: true }).show();
      }
    },
  });
  const finalize = new FinalizeService({
    history,
    tools,
    encoders: () => encoders,
    settings: () => settings.store.get().recording,
    destination: freeVideoPath,
    trashItem: (file) => shell.trashItem(file),
    runner,
    toast: (event) => {
      if (getMainWindow()?.isVisible()) {
        for (const contents of webContentsWithRoles(['main']))
          sendEvent(contents, 'app:toast', event);
      }
    },
    onReplaced: (change) => void autoCopy.replaced(change),
    emit: {
      progress: (event) => emitToMain('export:progress', event),
      done: (event) => emitToMain('export:done', event),
      failed: (event) => emitToMain('export:failed', event),
    },
  });
  registerVideoHandlers(
    new VideoEditService({
      history,
      store: videoProjects,
      pickAudioFile,
      tools,
      runner,
      destination: (source, extension) => editedDestination(source, extension, freeFileName),
      emit: {
        progress: (event) => emitToMain('video:exportProgress', event),
        done: (event) => {
          emitToMain('video:exportDone', event);
          void autoCopy.file(event.path);
        },
        failed: (event) => emitToMain('video:exportFailed', event),
      },
    }),
  );
  const flowsDir = path.join(app.getPath('userData'), 'flows');
  const flows = new FlowService({
    history,
    tools,
    runner,
    capability: () => mp4Capability,
    screenshotsDir: () => library.saveDir('screenshots'),
    scratchDir: flowsDir,
    thumbnail: guideThumbnail,
    trashItem: (file) => shell.trashItem(file),
    pickFolder: () => pickExportFolder(settings.dirs().screenshotsDir),
    pickSave: (options) => pickGuideSave(settings.dirs().screenshotsDir, options),
    remember: rememberExported,
    emit: {
      progress: (event) => emitToMain('export:progress', event),
      done: (event) => {
        emitToMain('export:done', event);
        // A guide exported as a video or GIF (the only kind this service reports as done).
        void autoCopy.file(event.path);
      },
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
  installMediaProtocol(media, {
    thumbPathOf: (id) => history.thumbPathOf(id),
    filePathOf: (id) => history.filePathOf(id),
    videoAssetPathOf: (id, name) =>
      history.get(id) ? videoProjects.assetPathByName(id, name) : undefined,
    flowStepPathOf: (id, index) => flows.stepPathOf(id, index),
  });
  const captureSaving = {
    settings: () => settings.store.get(),
    screenshotsDir: () => library.saveDir('screenshots'),
    history,
    copyImage: (png: Uint8Array, options?: { quiet?: boolean }) =>
      autoCopy.screenshot(png, options),
  };
  /**
   * A recording was saved: put the file on the clipboard (the settings), then queue the work on
   * the file. "Also save an MP4" queues first, so it reads the recording as recorded (it is skipped
   * when MP4 is already the save format); the save-format job follows and replaces the file.
   */
  async function afterRecordingSaved(historyId: string): Promise<void> {
    const item = history.get(historyId);
    if (item) await autoCopy.file(item.path);
    const recording = settings.store.get().recording;
    if (recording.autoExportMp4 && recording.saveFormat !== 'mp4')
      await exports.startAuto(historyId);
    await finalize.startAfterSave(historyId);
    // Several screens in one file: each screen becomes a video of its own, opened for editing.
    if (item?.format === 'fcap') void splitAndOpen(splitter, history, historyId, openEditorTab);
  }
  const saveDirect = createSaveCaptureDirect(captureSaving);
  const recorder: RecorderController = new RecorderController({
    provider,
    saveScreenshot: saveDirect,
    sessions,
    media,
    engines: new HiddenWindowPool(),
    synthetic,
    // A recording's toolbar lost focus: an open screenshot selection checks whether the user left FrameCapt.
    onToolbarBlur: () => flow.recheckBlur(),
    isScreenshotBusy: () => flow.state.active || steps.active,
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
      void afterRecordingSaved(historyId).catch((error: unknown) =>
        log.warn(`After saving a recording: ${String(error)}`),
      );
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
    // Nor while a step guide is captured: the pointer and the screen belong to it.
    isBlocked: () =>
      (recorder.anyBusy && !recorder.anyLive) || recorder.startupInProgress || steps.active,
    isRecording: () => recorder.anyLive,
    onOverlaysShown: () => recorder.raiseToolbar(),
    saveDirect,
    toast: (event) => recorder.toastToolbar(event),
    afterCapture: createAfterCapture(captureSaving),
    openEditor: openEditorTab,
  });
  // The recording ended (or was stopped) while a screenshot selection was open: drop the selection.
  recorder.onChange(() => {
    if (flow.duringRecording && !recorder.anyLive) flow.cancel();
    // The main window can be shown for the window picker during a recording: keep it out of the video.
    setMainProtected(recorder.anyLive);
  });
  const steps: StepsController = new StepsController({
    now: () => Date.now(),
    monotonic: () => performance.now(),
    cursor: () => screen.getCursorScreenPoint(),
    displays: () => provider.listDisplays(),
    grab: createDisplayGrabber(provider, synthetic),
    sessions: new FlowSessions(flowsDir),
    save: async (input) => {
      const saved = await flows.saveSession(input);
      // The guide is a folder of step images: that folder goes on the clipboard (the recording rule).
      const guide = history.get(saved.historyId);
      if (guide) void autoCopy.file(path.dirname(guide.path));
      // The guide opens in the main window (a window that was hidden in the tray comes back).
      showMainWindow();
      for (const contents of webContentsWithRoles(['main'])) {
        sendEvent(contents, 'steps:finished', { historyId: saved.historyId });
      }
      return saved;
    },
    isBlocked: () => recorder.anyBusy || flow.state.active,
    isOverPill: (point) => pill.isOver(point),
    ui: {
      open: () => pill.open(),
      close: () => pill.close(),
      follow: (displayId) => pill.follow(displayId),
    },
    log,
  });
  const pill = createStepsPill(() => {
    void steps.done().catch((error: unknown) => log.warn(`Steps pill closed: ${String(error)}`));
  });
  steps.onChange((snapshot) => {
    for (const contents of webContentsWithRoles(['main', 'toolbar'])) {
      sendEvent(contents, 'steps:state', snapshot);
    }
  });
  registerFlowHandlers(steps, flows);
  registerWorkerHandlers();
  registerShotHandlers(
    flow,
    store,
    recorder,
    history,
    {
      get: () => settings.store.get(),
      screenshotsDir: () => library.saveDir('screenshots'),
      copyImage: captureSaving.copyImage,
    },
    { store: projects, appVersion: app.getVersion() },
    flows,
  );
  registerEditorHandlers(store, history);
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
      flowThumbnail: (dir, parsed) => flows.thumbnailOf(dir, parsed),
      thumbnail: async (file, width) => {
        const image = nativeImage.createFromPath(file);
        return image.isEmpty() ? undefined : image.resize({ width }).toPNG();
      },
    });
  registerHistoryHandlers(
    history,
    exports,
    extracts,
    bulk,
    () => mp4Capability,
    outputDir,
    rescan,
    finalize,
    () => encoders,
  );
  registerProjectFileHandlers(
    history,
    new ProjectFileService({
      history,
      projects,
      videoProjects,
      screenshotsDir: () => library.saveDir('screenshots'),
      appVersion: app.getVersion(),
    }),
  );
  /** The "Add panel" menu: a region, screen or window joins the picture of a running recording; a panel leaves it. */
  const popPanelMenu = async (
    win: BrowserWindow,
    sessionId: string | undefined,
    anchor: { x: number; y: number },
  ): Promise<void> => {
    const state = recorder.panelState(sessionId);
    if (!state) return;
    const displays = provider.listDisplays();
    const windows = await provider.listSources({ types: ['window'], thumbnailWidth: 0 });
    const report = (error: unknown): void => {
      if (error instanceof Cancelled) return;
      const failure = error as { code?: string; message?: string };
      recorder.toastToolbar(
        { level: 'error', message: friendlyError(failure.code, failure.message) },
        state.sessionId,
      );
    };
    const add = (request: {
      kind: 'region' | 'screen' | 'window';
      sourceId?: string;
      displayId?: string;
    }) => void recorder.addPanel({ ...request, sessionId: state.sessionId }).catch(report);
    const menu = Menu.buildFromTemplate(
      buildPanelMenuTemplate(
        displays,
        windows,
        {
          panels: state.panels.map(({ slot, label }) => ({ slot, label })),
          addDisabled: state.addDisabled,
        },
        {
          region: () => add({ kind: 'region' }),
          screen: (displayId) => add({ kind: 'screen', displayId }),
          window: (sourceId) => add({ kind: 'window', sourceId }),
          remove: (slot) => {
            try {
              recorder.removePanel(state.sessionId, slot);
            } catch (error) {
              report(error);
            }
          },
        },
      ),
    );
    menu.popup({ window: win, x: Math.round(anchor.x), y: Math.round(anchor.y) });
  };
  registerRecorderHandlers(
    recorder,
    sessions,
    media,
    (width) => pill.resize(width),
    async (request, webContentsId) => {
      const contents = webContents.fromId(webContentsId);
      const win = contents && BrowserWindow.fromWebContents(contents);
      if (!win || win.isDestroyed() || !recorder.anyLive) return;
      if (request.menu === 'panel') {
        return popPanelMenu(win, recorder.sessionIdOf(webContentsId), request);
      }
      const displays = provider.listDisplays();
      const windows = await provider.listSources({ types: ['window'], thumbnailWidth: 0 });
      const report = (error: unknown): void => {
        const failure = error as { code?: string; message?: string };
        recorder.toastToolbar({
          level: 'error',
          message: friendlyError(failure.code, failure.message),
        });
      };

      const shot = (shotRequest: StartScreenshotRequest): void =>
        void flow.start(shotRequest).catch(report);
      const menu = Menu.buildFromTemplate(
        buildScreenshotMenuTemplate(displays, windows, {
          recordedArea: () =>
            void recorder.screenshotNow(recorder.sessionIdOf(webContentsId)).catch(() => undefined),
          region: () => shot({ target: 'region' }),
          screen: (displayId) => shot({ target: 'screen', displayId }),
          window: (sourceId) => shot({ target: 'window', sourceId }),
        }),
      );
      menu.popup({ window: win, x: Math.round(request.x), y: Math.round(request.y) });
    },
    async (request, webContentsId) => {
      const contents = webContents.fromId(webContentsId);
      const win = contents && BrowserWindow.fromWebContents(contents);
      if (win && !win.isDestroyed()) await popPanelMenu(win, request.sessionId, request);
    },
  );
  registerRecoveryHandlers(recovery, recorder, media);
  // Closing the main window during a recording only minimizes it; quitting finishes the recording.
  setMainCloseInterceptor(() => (recorder.isRecording && !recorder.isQuitting) || steps.active);
  app.on('before-quit', (event) => recorder.handleBeforeQuit(event, () => app.quit()));
  app.on('will-quit', () => {
    void sessions.closeAll();
    void steps.dispose();
  });
  // Quitting while a guide is being captured saves what was captured (an empty one is dropped).
  app.on('before-quit', (event) => {
    if (!steps.active) return;
    event.preventDefault();
    const quit = (): void => app.quit();
    void steps.done().then(quit, quit);
  });
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
  void new FlowSessions(flowsDir).sweep(SWEEP_MAX_AGE_MS).then((removed) => {
    if (removed > 0) log.info(`Step sweep: removed ${removed} abandoned capture folders`);
  });
  void store.sweep(SWEEP_MAX_AGE_MS).then((result) => {
    log.info(
      `Shot sweep: scanned ${result.scanned}, removed ${result.removed}, kept ${result.kept}`,
    );
  });
  return {
    flow,
    recorder,
    steps,
    exports,
    history,
    sessions,
    store,
    isBusy: () => recorder.anyBusy || flow.state.active || exports.active || steps.active,
  };
}
