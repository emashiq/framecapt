import path from 'node:path';

/** Files this run wrote itself: the only ones `shell:showItemInFolder` accepts. */
const exported = new Set<string>();

export function rememberExported(file: string): void {
  exported.add(path.resolve(file));
}

export function wasExported(file: string): boolean {
  return exported.has(path.resolve(file));
}
