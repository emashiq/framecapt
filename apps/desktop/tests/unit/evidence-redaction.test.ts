import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { redactedJson, redactPaths, redactTitles } from '../native/evidence';

describe('evidence redaction', () => {
  const home = 'C:\\Users\\jane';

  it('replaces the home directory in every slash style and case', () => {
    expect(redactPaths('C:\\Users\\jane\\AppData\\x', home)).toBe('~\\AppData\\x');
    expect(redactPaths('c:/users/JANE/Pictures', home)).toBe('~/Pictures');
    const json = redactedJson({ file: 'C:\\Users\\jane\\Pictures\\a.png' }, home);
    expect(json).toContain('~\\\\Pictures\\\\a.png');
    expect(json).not.toContain('jane');
  });

  it('replaces window titles but keeps screen labels and ids', () => {
    const redacted = redactTitles({
      sources: [
        { kind: 'screen', id: 'screen:1:0', label: 'screen: Screen 1' },
        {
          kind: 'window',
          id: 'window:5:0',
          label: 'window: Secret plans.docx - Word',
          name: 'Secret',
        },
      ],
      title: 'Secret project',
    });
    expect(JSON.stringify(redacted)).not.toMatch(/Secret/);
    expect(redacted).toMatchObject({
      sources: [
        { label: 'screen: Screen 1' },
        { id: 'window:5:0', label: 'window: [title redacted]', name: '[title redacted]' },
      ],
      title: '[title redacted]',
    });
  });
});

describe('evidence directory gating (FRAMECAPT_WRITE_EVIDENCE)', () => {
  afterEach(() => vi.unstubAllEnvs());

  async function dirFor(flag: string | undefined) {
    vi.resetModules();
    if (flag === undefined) vi.stubEnv('FRAMECAPT_WRITE_EVIDENCE', '');
    else vi.stubEnv('FRAMECAPT_WRITE_EVIDENCE', flag);
    const mod = await import('../native/evidence');
    return mod.evidenceDirFor(path.resolve('repo'), 'phase10');
  }

  it('is a scratch directory outside the repository by default', async () => {
    for (const flag of [undefined, '0', 'true']) {
      const dir = await dirFor(flag);
      expect(dir).toBe(path.join(os.tmpdir(), 'framecapt-evidence-scratch', 'phase10'));
      expect(dir.startsWith(path.resolve('repo'))).toBe(false);
    }
  });

  it('is docs/evidence/<phase> only when FRAMECAPT_WRITE_EVIDENCE=1', async () => {
    expect(await dirFor('1')).toBe(
      path.join(path.resolve('repo', '..', '..'), 'docs', 'evidence', 'phase10'),
    );
  });
});
