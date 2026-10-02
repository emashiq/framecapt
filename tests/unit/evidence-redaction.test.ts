import { describe, expect, it } from 'vitest';
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
