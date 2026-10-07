import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  folderNameProblem,
  folderPathProblem,
  isInsideFolder,
  joinFolder,
  LibraryFolderSchema,
  LIBRARY_MAX_DEPTH,
  parentFolder,
} from '../../src/shared/library';
import {
  distinctRoots,
  locateDir,
  replaceDirPrefix,
  resolveFolder,
} from '../../src/main/library/paths';

describe('folder path grammar', () => {
  it('accepts ordinary names, unicode and spaces inside a name', () => {
    for (const folder of [
      'Clients',
      'Clients/Acme/Bugs',
      'Kunden/Müller GmbH',
      '日本語/スクリーン',
      'Q3 2026 (draft)',
      'a-b_c.d',
    ]) {
      expect(folderPathProblem(folder), folder).toBeNull();
    }
  });

  it('refuses reserved Windows names, also with an extension and in any case', () => {
    for (const name of ['CON', 'prn', 'Aux', 'NUL', 'COM1', 'com9', 'LPT1', 'lpt9', 'con.txt']) {
      expect(folderNameProblem(name), name).not.toBeNull();
    }
    expect(folderNameProblem('COM0')).toBeNull();
    expect(folderNameProblem('console')).toBeNull();
  });

  it('refuses traversal, absolute and drive paths, backslashes and empty levels', () => {
    for (const folder of [
      '..',
      '.',
      '../x',
      'a/../b',
      'a/./b',
      '/abs',
      'a//b',
      'a/',
      'C:/x',
      'C:',
      '\\\\server\\share',
      'a\\b',
      '',
    ]) {
      expect(folderPathProblem(folder), JSON.stringify(folder)).not.toBeNull();
    }
  });

  it('refuses forbidden characters, control characters, trailing dots and spaces, hidden names', () => {
    for (const name of [
      'a<b',
      'a>b',
      'a:b',
      'a"b',
      'a|b',
      'a?b',
      'a*b',
      'a\u0000b',
      'a\tb',
      'a\u001fb',
    ]) {
      expect(folderNameProblem(name), JSON.stringify(name)).not.toBeNull();
    }
    for (const name of ['name.', 'name ', ' name', '.hidden', '...']) {
      expect(folderNameProblem(name), JSON.stringify(name)).not.toBeNull();
    }
  });

  it('limits a name to 80 characters and a path to 8 levels', () => {
    expect(folderNameProblem('a'.repeat(80))).toBeNull();
    expect(folderNameProblem('a'.repeat(81))).not.toBeNull();
    const deep = Array.from({ length: LIBRARY_MAX_DEPTH }, (_, i) => `l${i}`).join('/');
    expect(folderPathProblem(deep)).toBeNull();
    expect(folderPathProblem(`${deep}/x`)).not.toBeNull();
  });

  it('keeps step-guide folder names for guides', () => {
    expect(folderNameProblem('FrameCapt Steps 2026-10-07 at 14.05.09')).not.toBeNull();
    expect(folderNameProblem('FrameCapt Steps notes')).toBeNull();
  });

  it('the schema applies the same rules', () => {
    expect(LibraryFolderSchema.safeParse('Clients/Acme').success).toBe(true);
    expect(LibraryFolderSchema.safeParse('../etc').success).toBe(false);
    expect(LibraryFolderSchema.safeParse(5).success).toBe(false);
  });

  it('path helpers', () => {
    expect(parentFolder('a/b/c')).toBe('a/b');
    expect(parentFolder('a')).toBeNull();
    expect(joinFolder(null, 'a')).toBe('a');
    expect(joinFolder('a', 'b')).toBe('a/b');
    expect(isInsideFolder('A/b', 'a')).toBe(true);
    expect(isInsideFolder('ab', 'a')).toBe(false);
  });
});

describe('containment under the capture folders', () => {
  const root = path.resolve('C:\\Capture\\Pictures');

  it('resolves a folder under the root', () => {
    expect(resolveFolder(root, 'Clients/Acme')).toBe(path.join(root, 'Clients', 'Acme'));
    expect(resolveFolder(root, null)).toBe(root);
  });

  it('throws for anything that would leave the root, even if the grammar were bypassed', () => {
    for (const folder of ['..', '../x', 'a/../../x', 'C:\\Windows', '/etc', 'a/..']) {
      expect(() => resolveFolder(root, folder), folder).toThrow();
    }
  });

  it('locates a directory in a root, in either root, and outside', () => {
    const roots = {
      screenshotsDir: path.resolve('C:\\Capture\\Pictures'),
      recordingsDir: path.resolve('C:\\Capture\\Videos'),
    };
    expect(locateDir(roots, path.join(roots.screenshotsDir, 'A', 'B'))).toMatchObject({
      root: { kind: 'screenshots' },
      folder: 'A/B',
    });
    expect(locateDir(roots, roots.recordingsDir)).toMatchObject({
      root: { kind: 'recordings' },
      folder: null,
    });
    expect(locateDir(roots, path.resolve('C:\\Capture\\Videos2'))).toBeNull();
    expect(locateDir(roots, path.resolve('D:\\Elsewhere'))).toBeNull();
    // Deeper than the grammar allows: treated as outside, never as an invalid folder name.
    expect(locateDir(roots, path.join(roots.screenshotsDir, ...'abcdefghi'.split('')))).toBeNull();
  });

  it('is case-insensitive like the file system and merges identical roots', () => {
    const same = {
      screenshotsDir: path.resolve('C:\\Cap'),
      recordingsDir: path.resolve('c:\\cap'),
    };
    expect(distinctRoots(same)).toHaveLength(1);
    expect(locateDir(same, path.resolve('C:\\CAP\\x'))?.folder).toBe('x');
  });

  it('replaces a directory prefix only for files inside it', () => {
    const from = path.resolve('C:\\R\\A');
    const to = path.resolve('C:\\R\\B');
    expect(replaceDirPrefix(path.join(from, 'x', 'f.png'), from, to)).toBe(
      path.join(to, 'x', 'f.png'),
    );
    expect(replaceDirPrefix(path.resolve('C:\\R\\AA\\f.png'), from, to)).toBeNull();
    expect(replaceDirPrefix(from, from, to)).toBeNull();
  });
});
