import { describe, expect, it } from 'vitest';
import {
  hwndFromSourceId,
  isMicInUse,
  micAppsInUse,
  parseConsentStoreKeyName,
  parseRegQueryOutput,
  sourceIdFromHwnd,
} from '../../src/main/platform/window-probe';

describe('hwnd and source id', () => {
  it('converts both ways', () => {
    expect(hwndFromSourceId('window:123:0')).toBe('123');
    expect(sourceIdFromHwnd('123')).toBe('window:123:0');
    expect(hwndFromSourceId(sourceIdFromHwnd('4294967295'))).toBe('4294967295');
  });

  it('rejects ids that are not window sources', () => {
    expect(hwndFromSourceId('screen:0:0')).toBeNull();
    expect(hwndFromSourceId('window:abc:0')).toBeNull();
    expect(hwndFromSourceId('')).toBeNull();
  });
});

describe('parseConsentStoreKeyName', () => {
  it('turns a NonPackaged key into the lowercase exe name', () => {
    expect(parseConsentStoreKeyName('C:#Program Files#Zoom#bin#Zoom.exe')).toBe('zoom.exe');
  });

  it('only lowercases a packaged key', () => {
    expect(parseConsentStoreKeyName('MSTeams_8wekyb3d8bbwe')).toBe('msteams_8wekyb3d8bbwe');
  });
});

describe('isMicInUse', () => {
  it('is in use when started and not stopped', () => {
    expect(isMicInUse(133_000_000_000_000_000n, 0n)).toBe(true);
    expect(isMicInUse(133_000_000_000_000_000n, 133_000_000_000_000_500n)).toBe(false);
    expect(isMicInUse(0n, 0n)).toBe(false);
  });
});

const BASE =
  'HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\CapabilityAccessManager\\ConsentStore\\microphone';

const REG_OUTPUT = [
  '',
  BASE,
  '    Value    REG_SZ    Allow',
  '',
  `${BASE}\\MSTeams_8wekyb3d8bbwe`,
  '    Value    REG_SZ    Allow',
  '    LastUsedTimeStart    REG_QWORD    0x1dcb0a1b2c3d4e5f',
  '    LastUsedTimeStop    REG_QWORD    0x0',
  '',
  `${BASE}\\NonPackaged`,
  '    Value    REG_SZ    Allow',
  '',
  `${BASE}\\NonPackaged\\C:#Program Files#Zoom#bin#Zoom.exe`,
  '    Value    REG_SZ    Allow',
  '    LastUsedTimeStart    REG_QWORD    0x1dcb0a1b2c3d4e5f',
  '    LastUsedTimeStop    REG_QWORD    0x1dcb0a1b2c3d9999',
  '',
  `${BASE}\\NonPackaged\\C:#Tools#Rec.exe`,
  '    LastUsedTimeStart    REG_QWORD    0x1',
  '    LastUsedTimeStop    REG_QWORD    0x0',
  '',
].join('\r\n');

describe('parseRegQueryOutput', () => {
  it('returns the keys that have the QWORD values', () => {
    const entries = parseRegQueryOutput(REG_OUTPUT);
    expect(entries).toHaveLength(3);
    expect(entries[0]).toMatchObject({
      lastUsedTimeStart: 0x1dcb0a1b2c3d4e5fn,
      lastUsedTimeStop: 0n,
    });
    expect(entries[0]?.key.endsWith('\\MSTeams_8wekyb3d8bbwe')).toBe(true);
    expect(entries[1]).toMatchObject({ lastUsedTimeStop: 0x1dcb0a1b2c3d9999n });
  });

  it('gives no entries for empty or unrelated output', () => {
    expect(parseRegQueryOutput('')).toEqual([]);
    expect(
      parseRegQueryOutput('ERROR: The system was unable to find the specified registry key'),
    ).toEqual([]);
  });

  it('lists only the apps still using the microphone', () => {
    expect(micAppsInUse(parseRegQueryOutput(REG_OUTPUT))).toEqual([
      'msteams_8wekyb3d8bbwe',
      'rec.exe',
    ]);
  });
});
