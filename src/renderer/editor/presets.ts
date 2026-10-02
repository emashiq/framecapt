/** Curated annotation colors. The last swatch toggles white/black. */
export const COLORS = [
  { value: '#EF4444', label: 'Red' },
  { value: '#F59E0B', label: 'Amber' },
  { value: '#22C55E', label: 'Green' },
  { value: '#3B82F6', label: 'Blue' },
  { value: '#8B5CF6', label: 'Violet' },
] as const;

export const WHITE = '#FFFFFF';
export const BLACK = '#111111';
export const DEFAULT_COLOR = COLORS[0].value;

export type SizeStep = 0 | 1 | 2 | 3;

const WIDTHS = [3, 5, 8] as const;
const FONT_SIZES = [18, 26, 36, 52] as const;

/**
 * Presets scale with the capture so that a mark is as visible on a 3440 px wide screen as on a
 * 800 px one. Everything stays in image pixels.
 */
export function presetScale(image: { width: number; height: number }): number {
  return Math.min(3, Math.max(1, Math.max(image.width, image.height) / 1200));
}

export function strokeWidthFor(step: 0 | 1 | 2, image: { width: number; height: number }): number {
  return Math.round(WIDTHS[step] * presetScale(image));
}

export function fontSizeFor(step: SizeStep, image: { width: number; height: number }): number {
  return Math.round(FONT_SIZES[step] * presetScale(image));
}

/** The preset step closest to a stored value, so the options strip reflects a selected shape. */
export function nearestStep(value: number, all: readonly number[]): number {
  let best = 0;
  all.forEach((candidate, index) => {
    if (Math.abs(candidate - value) < Math.abs((all[best] ?? 0) - value)) best = index;
  });
  return best;
}

export const WIDTH_LABELS = ['Small', 'Medium', 'Large'] as const;
export const FONT_LABELS = ['Small', 'Medium', 'Large', 'Extra large'] as const;
