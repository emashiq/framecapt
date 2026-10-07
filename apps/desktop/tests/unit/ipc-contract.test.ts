import { describe, expect, it } from 'vitest';
import {
  AppInfoSchema,
  ERROR_REPORT_LIMITS,
  IPC_CHANNELS,
  IPC_EVENTS,
  ipcContract,
  isIpcChannel,
  isIpcEvent,
} from '../../src/shared/ipc-contract';
import { ROLES } from '../../src/shared/types';

describe('ipc contract', () => {
  it('lists the registered channels', () => {
    expect([...IPC_CHANNELS].sort()).toEqual([
      'app:getInfo',
      'app:reportError',
      'app:requestQuit',
      'app:resolveQuit',
      'camera:getStyle',
      'camera:setStyle',
      'capture:grant',
      'capture:listDisplays',
      'capture:listSources',
      'capture:startScreenshot',
      'diagnostics:revealFolder',
      'diagnostics:saveRecording',
      'editor:getState',
      'editor:historyImage',
      'editor:open',
      'editor:pickImage',
      'editor:ready',
      'editor:resolveClose',
      'editor:setState',
      'editor:show',
      'export:cancel',
      'export:capabilities',
      'export:mp4',
      'flow:export',
      'flow:get',
      'flow:openStepInEditor',
      'flow:readStep',
      'flow:update',
      'history:cancelBulk',
      'history:clearMissing',
      'history:consumeNotice',
      'history:copyImage',
      'history:copyPath',
      'history:deleteFile',
      'history:deleteProject',
      'history:exportMany',
      'history:extractFcap',
      'history:list',
      'history:open',
      'history:relink',
      'history:remove',
      'history:rescan',
      'history:reveal',
      'history:saveCopy',
      'history:startDrag',
      'history:undoRemove',
      'overlay:cancel',
      'overlay:confirm',
      'overlay:getInit',
      'overlay:pickDisplay',
      'overlay:ready',
      'overlay:selectionStarted',
      'recorder:cancel',
      'recorder:copyPath',
      'recorder:engineEvent',
      'recorder:getState',
      'recorder:pause',
      'recorder:reset',
      'recorder:resolveChoice',
      'recorder:resume',
      'recorder:screenshot',
      'recorder:showInFolder',
      'recorder:start',
      'recorder:stop',
      'recorder:toggleCamera',
      'recorder:toggleMute',
      'recovery:discard',
      'recovery:list',
      'recovery:recover',
      'recovery:reveal',
      'session:appendChunk',
      'session:finish',
      'settings:chooseOutputDir',
      'settings:consumeNotice',
      'settings:get',
      'settings:openOutputDir',
      'settings:reset',
      'settings:update',
      'settings:useDefaultOutputDir',
      'shell:showItemInFolder',
      'shortcuts:setPaused',
      'shortcuts:status',
      'shortcuts:validate',
      'shot:copy',
      'shot:discard',
      'shot:export',
      'shot:get',
      'shot:importImage',
      'shot:openFromHistory',
      'shot:openImage',
      'shot:quickSave',
      'shot:saveOver',
      'steps:cancel',
      'steps:captureStep',
      'steps:done',
      'steps:getState',
      'steps:pause',
      'steps:resume',
      'steps:setAuto',
      'steps:start',
      'toolbar:resize',
      'video:addImage',
      'video:export',
      'video:open',
      'video:pickAudio',
      'video:save',
      'worker:frameError',
      'worker:frameResult',
      'worker:ready',
    ]);
    expect([...IPC_EVENTS].sort()).toEqual([
      'app:confirmQuit',
      'app:navigate',
      'app:startRequest',
      'app:themeChanged',
      'app:toast',
      'capture:flowEnded',
      'editor:confirmClose',
      'editor:openTab',
      'editor:stateChanged',
      'export:done',
      'export:failed',
      'export:progress',
      'history:bulkProgress',
      'history:changed',
      'overlay:clearSelection',
      'recorder:engineCommand',
      'recorder:levels',
      'recorder:state',
      'recorder:toast',
      'recovery:changed',
      'settings:changed',
      'shortcuts:changed',
      'steps:finished',
      'steps:state',
      'video:exportDone',
      'video:exportFailed',
      'video:exportProgress',
      'worker:grabFrames',
    ]);
  });

  it('keeps each channel family to its window role', () => {
    for (const channel of IPC_CHANNELS) {
      const roles = [...ipcContract[channel].roles];
      if (channel.startsWith('worker:')) expect(roles).toEqual(['recorder']);
      if (channel.startsWith('overlay:')) expect(roles).toEqual(['overlay']);
      // Recovery is driven by the main window only (ids, never paths).
      if (channel.startsWith('recovery:')) expect(roles).toEqual(['main']);
      // The recorder window's chunk and engine channels belong to it alone.
      if (channel.startsWith('session:') || channel === 'recorder:engineEvent') {
        expect(roles).toEqual(['recorder']);
      }
      // Step guides: the Flow view is the main window's (it asks the Editor window to open a step,
      // which then loads it); the pill (toolbar role) only steers the capture.
      if (channel.startsWith('flow:')) {
        expect(roles).toEqual(channel === 'flow:openStepInEditor' ? ['editor'] : ['main']);
      }
      if (channel.startsWith('steps:')) {
        expect(roles.every((role) => role === 'main' || role === 'toolbar')).toBe(true);
        expect(roles).toContain('main');
      }
      // History, export, screenshots and the editor take ids from the main and Editor windows only
      // (never paths); the video editor's channels are the Editor window's alone.
      if (channel.startsWith('video:')) expect(roles).toEqual(['editor']);
      if (
        channel.startsWith('history:') ||
        channel.startsWith('export:') ||
        channel.startsWith('shot:') ||
        channel.startsWith('editor:') ||
        channel === 'shell:showItemInFolder'
      ) {
        expect(roles.every((role) => role === 'main' || role === 'editor')).toBe(true);
      }
      // The rest of History is the main window's; the editors read the list (the image picker)
      // and reveal or undo a quick save.
      if (channel.startsWith('history:') && channel !== 'history:list') {
        expect(roles).toEqual(
          channel === 'history:reveal' || channel === 'history:deleteFile'
            ? ['main', 'editor']
            : ['main'],
        );
      }
      // Settings, shortcuts and quitting are the main window's; the Editor window only reads the
      // settings and shortcut states and changes a setting (a one-time notice); the toolbar only sizes itself.
      if (
        channel.startsWith('settings:') ||
        channel.startsWith('shortcuts:') ||
        channel === 'app:requestQuit' ||
        channel === 'app:resolveQuit'
      ) {
        const editorToo = ['settings:get', 'settings:update', 'shortcuts:status'].includes(channel);
        expect(roles).toEqual(editorToo ? ['main', 'editor'] : ['main']);
      }
      if (channel === 'toolbar:resize') expect(roles).toEqual(['toolbar']);
    }
  });

  it('only allows known roles on every channel', () => {
    for (const channel of IPC_CHANNELS) {
      for (const role of ipcContract[channel].roles) expect(ROLES).toContain(role);
    }
  });

  it('recognizes channels without matching inherited object keys', () => {
    expect(isIpcChannel('app:getInfo')).toBe(true);
    expect(isIpcChannel('not:a:channel')).toBe(false);
    expect(isIpcChannel('toString')).toBe(false);
    expect(isIpcChannel('__proto__')).toBe(false);
    expect(isIpcChannel(42)).toBe(false);
    expect(isIpcEvent('app:themeChanged')).toBe(true);
    expect(isIpcEvent('app:getInfo')).toBe(false);
  });

  describe('app:getInfo', () => {
    const { request, response } = ipcContract['app:getInfo'];

    it('takes no payload', () => {
      expect(request.safeParse(undefined).success).toBe(true);
      expect(request.safeParse({}).success).toBe(false);
      expect(request.safeParse('x').success).toBe(false);
    });

    it('describes AppInfo', () => {
      const info = {
        version: '0.1.0',
        electron: '44.5.1',
        chrome: '1',
        node: '24',
        platform: 'win32',
        arch: 'x64',
        isPackaged: false,
        tray: { active: true, bounds: { x: 1, y: 2, width: 16, height: 16 } },
        updates: { state: 'unconfigured' },
      };
      expect(AppInfoSchema.safeParse(info).success).toBe(true);
      expect(
        AppInfoSchema.safeParse({ ...info, tray: { active: false, bounds: null } }).success,
      ).toBe(true);
      expect(
        AppInfoSchema.safeParse({ ...info, updates: { state: 'error', message: 'offline' } })
          .success,
      ).toBe(true);
      expect(AppInfoSchema.safeParse({ ...info, updates: { state: 'bogus' } }).success).toBe(false);
      expect(AppInfoSchema.safeParse({ ...info, updates: undefined }).success).toBe(false);
      expect(response.safeParse({ ...info, isPackaged: 'no' }).success).toBe(false);
      expect(response.safeParse({ version: '0.1.0' }).success).toBe(false);
    });
  });

  describe('app:reportError', () => {
    const { request } = ipcContract['app:reportError'];

    it('accepts a valid report', () => {
      expect(
        request.safeParse({
          source: 'window-error',
          message: 'boom',
          stack: 'at x',
          componentStack: 'in A',
        }).success,
      ).toBe(true);
      expect(request.safeParse({ source: 'error-boundary', message: 'boom' }).success).toBe(true);
    });

    it('rejects wrong shapes and unknown sources', () => {
      expect(request.safeParse(undefined).success).toBe(false);
      expect(request.safeParse({ message: 'boom' }).success).toBe(false);
      expect(request.safeParse({ source: 'other', message: 'boom' }).success).toBe(false);
      expect(request.safeParse({ source: 'window-error', message: 42 }).success).toBe(false);
    });

    it('enforces length caps', () => {
      const atCap = 'a'.repeat(ERROR_REPORT_LIMITS.message);
      expect(request.safeParse({ source: 'window-error', message: atCap }).success).toBe(true);
      expect(request.safeParse({ source: 'window-error', message: `${atCap}a` }).success).toBe(
        false,
      );
      expect(
        request.safeParse({
          source: 'window-error',
          message: 'm',
          stack: 'a'.repeat(ERROR_REPORT_LIMITS.stack + 1),
        }).success,
      ).toBe(false);
      expect(
        request.safeParse({
          source: 'window-error',
          message: 'm',
          componentStack: 'a'.repeat(ERROR_REPORT_LIMITS.componentStack + 1),
        }).success,
      ).toBe(false);
    });
  });
});
