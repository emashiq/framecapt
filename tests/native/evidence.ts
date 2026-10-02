import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * Privacy rules for evidence files: no window titles (they can name documents, people or
 * projects) and no absolute user paths (the Windows user name). Applied to every JSON the native
 * tests write.
 */
export const TITLE_PLACEHOLDER = '[title redacted]';

/** Replaces the home directory (in every slash style, any case) with "~". */
export function redactPaths(text: string, home: string = os.homedir()): string {
  if (!home) return text;
  const variants = new Set([
    home,
    home.replaceAll('\\', '/'),
    home.replaceAll('\\', '\\\\'), // as it appears inside JSON strings
  ]);
  let result = text;
  for (const variant of variants) {
    const escaped = variant.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    result = result.replace(new RegExp(escaped, 'gi'), '~');
  }
  return result;
}

/** Deep copy with window titles replaced. Paths are redacted separately, on the final text. */
export function redactTitles(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redactTitles);
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    const isWindow = record.kind === 'window';
    const out: Record<string, unknown> = {};
    for (const [key, inner] of Object.entries(record)) {
      if (key === 'title' && typeof inner === 'string') out[key] = TITLE_PLACEHOLDER;
      else if (isWindow && (key === 'label' || key === 'name') && typeof inner === 'string') {
        out[key] = key === 'label' ? `window: ${TITLE_PLACEHOLDER}` : TITLE_PLACEHOLDER;
      } else out[key] = redactTitles(inner);
    }
    return out;
  }
  return value;
}

export function redactedJson(value: unknown, home?: string): string {
  return redactPaths(`${JSON.stringify(redactTitles(value), null, 2)}\n`, home);
}

/** Writes a redacted evidence JSON file (creating the directory). */
export function writeEvidenceJson(dir: string, name: string, value: unknown): void {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, name), redactedJson(value));
}
