import { describe, expect, it, vi } from 'vitest';
import {
  FallbackWindowProbe,
  type FallbackProbeDeps,
} from '../../src/main/platform/fallback-probe';

const BASE =
  'HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\CapabilityAccessManager\\ConsentStore\\microphone';

const REG_OUTPUT = [
  `${BASE}\\NonPackaged\\C:#Program Files#Zoom#bin#Zoom.exe`,
  '    LastUsedTimeStart    REG_QWORD    0x1dcb0a1b2c3d4e5f',
  '    LastUsedTimeStop    REG_QWORD    0x0',
  '',
  `${BASE}\\Old_8wekyb3d8bbwe`,
  '    LastUsedTimeStart    REG_QWORD    0x1dcb0a1b2c3d4e5f',
  '    LastUsedTimeStop    REG_QWORD    0x1dcb0a1b2c3d9999',
].join('\r\n');

function makeProbe(overrides: Partial<FallbackProbeDeps> = {}) {
  const getSources = vi.fn(async () => [
    { id: 'window:1048586:0', name: 'Weekly sync - Zoom' },
    { id: 'window:77:0', name: 'Notes' },
    { id: 'screen:0:0', name: 'Screen 1' },
  ]);
  const execFile = vi.fn(async () => REG_OUTPUT);
  const probe = new FallbackWindowProbe({
    desktopCapturer: { getSources },
    execFile,
    platform: 'win32',
    ...overrides,
  });
  return { probe, getSources, execFile };
}

describe('FallbackWindowProbe', () => {
  it('lists windows from desktopCapturer without thumbnails', async () => {
    const { probe, getSources } = makeProbe();
    const windows = await probe.list();
    expect(getSources).toHaveBeenCalledWith({
      types: ['window'],
      thumbnailSize: { width: 0, height: 0 },
    });
    expect(windows.map((window) => [window.hwnd, window.title])).toEqual([
      ['1048586', 'Weekly sync - Zoom'],
      ['77', 'Notes'],
    ]);
    expect(windows[0]).toMatchObject({
      className: '',
      exe: '',
      pid: 0,
      minimized: false,
      cloaked: false,
      visible: true,
      rect: { x: 0, y: 0, width: 0, height: 0 },
    });
    expect(probe.kind).toBe('fallback');
  });

  it('gets one window and has no foreground window', async () => {
    const { probe } = makeProbe();
    expect((await probe.get('77'))?.title).toBe('Notes');
    expect(await probe.get('5')).toBeNull();
    expect(await probe.foreground()).toBeNull();
  });

  it('reads the microphone with reg.exe, no shell', async () => {
    const { probe, execFile } = makeProbe();
    expect(await probe.micInUse()).toEqual(['zoom.exe']);
    const [file, args, options] = execFile.mock.calls[0] as unknown as [string, string[], object];
    expect(file).toBe('reg.exe');
    expect(args[0]).toBe('query');
    expect(args[1]).toMatch(/^HKCU\\Software\\.*ConsentStore\\microphone$/);
    expect(args[2]).toBe('/s');
    expect(options).toEqual({ shell: false, windowsHide: true, timeout: 3000 });
  });

  it('reports no microphone use off Windows', async () => {
    const { probe, execFile } = makeProbe({ platform: 'linux' });
    expect(await probe.micInUse()).toEqual([]);
    expect(execFile).not.toHaveBeenCalled();
  });
});
