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
      'capture:grant',
      'capture:listDisplays',
      'capture:listSources',
      'capture:startScreenshot',
      'diagnostics:revealFolder',
      'diagnostics:saveRecording',
      'editor:resolveClose',
      'editor:setDirty',
      'overlay:cancel',
      'overlay:confirm',
      'overlay:getInit',
      'overlay:pickDisplay',
      'overlay:ready',
      'overlay:selectionStarted',
      'shell:showItemInFolder',
      'shot:copy',
      'shot:discard',
      'shot:export',
      'shot:get',
      'worker:frameError',
      'worker:frameResult',
      'worker:ready',
    ]);
    expect([...IPC_EVENTS].sort()).toEqual([
      'app:confirmClose',
      'app:themeChanged',
      'capture:flowEnded',
      'overlay:clearSelection',
      'shot:ready',
      'worker:grabFrames',
    ]);
  });

  it('keeps each channel family to its window role', () => {
    for (const channel of IPC_CHANNELS) {
      const roles = [...ipcContract[channel].roles];
      if (channel.startsWith('worker:')) expect(roles).toEqual(['recorder']);
      if (channel.startsWith('overlay:')) expect(roles).toEqual(['overlay']);
      if (
        channel.startsWith('shot:') ||
        channel.startsWith('editor:') ||
        channel === 'shell:showItemInFolder'
      ) {
        expect(roles).toEqual(['main']);
      }
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
      };
      expect(AppInfoSchema.safeParse(info).success).toBe(true);
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
