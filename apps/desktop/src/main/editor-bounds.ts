/**
 * The Editor window's remembered size and position (a small JSON file next to the settings). Pure:
 * windows.ts reads and writes the file; this only decides what a stored value is worth.
 */
export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface EditorBounds extends Rect {
  maximized: boolean;
}

export const EDITOR_DEFAULT_SIZE = { width: 1280, height: 820 } as const;
export const EDITOR_MIN_SIZE = { width: 900, height: 600 } as const;

const finite = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value);

/** Parses the stored JSON; anything that is not a sane rectangle gives null (the default size is used). */
export function parseEditorBounds(raw: string): EditorBounds | null {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof value !== 'object' || value === null) return null;
  const { x, y, width, height, maximized } = value as Record<string, unknown>;
  if (!finite(x) || !finite(y) || !finite(width) || !finite(height)) return null;
  if (width < EDITOR_MIN_SIZE.width || height < EDITOR_MIN_SIZE.height) return null;
  if (width > 20_000 || height > 20_000 || Math.abs(x) > 100_000 || Math.abs(y) > 100_000) {
    return null;
  }
  return { x, y, width, height, maximized: maximized === true };
}

/** True when at least `margin` px of the title bar area of `bounds` lies inside one of the work areas. */
export function isReachable(bounds: Rect, workAreas: readonly Rect[], margin = 80): boolean {
  return workAreas.some(
    (area) =>
      bounds.x + bounds.width - margin > area.x &&
      bounds.x + margin < area.x + area.width &&
      bounds.y >= area.y - 8 &&
      bounds.y + margin < area.y + area.height,
  );
}
