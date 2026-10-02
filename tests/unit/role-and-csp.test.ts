import { describe, expect, it } from 'vitest';
import { roleFromHash } from '../../src/renderer/role';
import { devCsp, PROD_CSP, PROD_CSP_META } from '../../src/shared/csp';

describe('roleFromHash', () => {
  it('maps known role hashes', () => {
    expect(roleFromHash('#/overlay')).toBe('overlay');
    expect(roleFromHash('#/toolbar')).toBe('toolbar');
    expect(roleFromHash('#/recorder')).toBe('recorder');
    expect(roleFromHash('#/countdown')).toBe('countdown');
    expect(roleFromHash('#/overlay?display=2')).toBe('overlay');
  });

  it('falls back to main for empty or unknown hashes', () => {
    expect(roleFromHash('')).toBe('main');
    expect(roleFromHash('#/')).toBe('main');
    expect(roleFromHash('#/main')).toBe('main');
    expect(roleFromHash('#/nope')).toBe('main');
    expect(roleFromHash('#overlayish')).toBe('main');
  });
});

describe('CSP', () => {
  it('production policy has no unsafe script sources and denies by default', () => {
    expect(PROD_CSP).toContain("default-src 'none'");
    expect(PROD_CSP).toContain("script-src 'self';");
    expect(PROD_CSP).not.toMatch(/script-src[^;]*unsafe/);
    expect(PROD_CSP).toContain("frame-ancestors 'none'");
  });

  it('allows the main-owned recording protocol for media only', () => {
    expect(PROD_CSP).toContain("media-src 'self' blob: mediastream: framelet-media:");
    expect(PROD_CSP).not.toMatch(/(script|connect|img)-src[^;]*framelet-media/);
    expect(devCsp('http://localhost:5173')).toContain('framelet-media:');
  });

  it('meta variant omits frame-ancestors only', () => {
    expect(PROD_CSP_META).not.toContain('frame-ancestors');
    expect(PROD_CSP_META).toContain("script-src 'self'");
  });

  it('dev policy only widens for the dev server origin', () => {
    const policy = devCsp('http://localhost:5173');
    expect(policy).toContain('ws://localhost:5173');
    expect(policy).toMatch(/script-src 'self' 'unsafe-inline' http:\/\/localhost:5173/);
    expect(policy).not.toContain('*');
  });
});
