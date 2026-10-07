import { describe, expect, it } from 'vitest';
import {
  ancestorsOf,
  buildTree,
  selectionMatches,
  visibleRows,
  type FolderSelection,
} from '../../src/renderer/library/tree';
import type { LibraryFolderInfo } from '../../src/shared/library';

const info = (path: string, count = 0): LibraryFolderInfo => ({
  path,
  inScreenshots: true,
  inRecordings: false,
  count,
});

describe('library tree (renderer)', () => {
  const folders = [
    info('Clients', 1),
    info('Clients/Acme', 2),
    info('Clients/Acme/Bugs', 3),
    info('Clients/beta', 0),
    info('Archive', 4),
  ];

  it('builds nested nodes sorted by name with subtree totals', () => {
    const roots = buildTree(folders);
    expect(roots.map((r) => r.name)).toEqual(['Archive', 'Clients']);
    const clients = roots[1];
    expect(clients?.children.map((c) => c.name)).toEqual(['Acme', 'beta']);
    expect(clients?.total).toBe(6);
    expect(clients?.children[0]?.children[0]).toMatchObject({ depth: 3, total: 3 });
  });

  it('lists only the rows of expanded folders', () => {
    const roots = buildTree(folders);
    expect(visibleRows(roots, new Set()).map((r) => r.path)).toEqual(['Archive', 'Clients']);
    expect(visibleRows(roots, new Set(['Clients'])).map((r) => r.path)).toEqual([
      'Archive',
      'Clients',
      'Clients/Acme',
      'Clients/beta',
    ]);
  });

  it('names the ancestors of a folder', () => {
    expect(ancestorsOf('a/b/c')).toEqual(['a/b', 'a']);
    expect(ancestorsOf('a')).toEqual([]);
  });

  it('filters items by selection, with and without subfolders', () => {
    const base = { type: 'screenshot', createdAt: 0 } as const;
    const inAcme = { ...base, folder: 'Clients/Acme' };
    const inBugs = { ...base, folder: 'Clients/Acme/Bugs' };
    const atRoot = { ...base };
    const elsewhere = { ...base, outside: true };
    const acme: FolderSelection = { kind: 'folder', path: 'clients/acme' };
    expect(selectionMatches(inBugs, acme, true)).toBe(true);
    expect(selectionMatches(inBugs, acme, false)).toBe(false);
    expect(selectionMatches(inAcme, acme, false)).toBe(true);
    expect(selectionMatches(atRoot, acme, true)).toBe(false);
    expect(selectionMatches(elsewhere, { kind: 'other' }, true)).toBe(true);
    expect(selectionMatches(atRoot, { kind: 'other' }, true)).toBe(false);
    expect(selectionMatches(elsewhere, { kind: 'all' }, true)).toBe(true);
  });

  it('filters by kind and by the last week', () => {
    const day = 86_400_000;
    const now = 100 * day;
    const fresh = { type: 'recording', createdAt: now - 2 * day } as const;
    const old = { type: 'screenshot', createdAt: now - 30 * day } as const;
    expect(selectionMatches(fresh, { kind: 'recent' }, true, now)).toBe(true);
    expect(selectionMatches(old, { kind: 'recent' }, true, now)).toBe(false);
    expect(selectionMatches(fresh, { kind: 'type', type: 'recording' }, true, now)).toBe(true);
    expect(selectionMatches(old, { kind: 'type', type: 'recording' }, true, now)).toBe(false);
  });
});
