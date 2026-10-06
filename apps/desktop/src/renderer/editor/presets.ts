import { DEFAULT_HIGHLIGHT_COLOR, type StyleDefaults } from './model/create';
import type { Beautify, StampId } from './model/types';

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

// --- colors ----------------------------------------------------------------------------------

/** `#rgb` or `#rrggbb` to the canonical `#RRGGBB`, or null when it is not a hex color. */
export function normalizeHex(value: string): string | null {
  const text = value.trim().replace(/^#/, '');
  if (/^[0-9a-f]{3}$/i.test(text)) {
    return `#${text
      .split('')
      .map((c) => c + c)
      .join('')
      .toUpperCase()}`;
  }
  return /^[0-9a-f]{6}$/i.test(text) ? `#${text.toUpperCase()}` : null;
}

export const MAX_RECENT_COLORS = 8;

/** `recent` with `color` moved to the front (case-insensitive, no duplicates, capped). */
export function addRecentColor(recent: readonly string[], color: string): string[] {
  const hex = normalizeHex(color);
  if (!hex) return [...recent];
  return [hex, ...recent.filter((c) => c.toUpperCase() !== hex)].slice(0, MAX_RECENT_COLORS);
}

/** Black or white, whichever reads better on `background` (a hex color). */
export function readableOn(background: string): string {
  const hex = normalizeHex(background) ?? '#000000';
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255) as [
    number,
    number,
    number,
  ];
  return 0.299 * r + 0.587 * g + 0.114 * b > 0.6 ? '#111111' : '#FFFFFF';
}

// --- beautify ----------------------------------------------------------------------------------

export interface BackgroundPreset {
  id: string;
  label: string;
  background: Beautify['background'];
}

export const BACKGROUND_PRESETS: readonly BackgroundPreset[] = [
  {
    id: 'indigo',
    label: 'Indigo',
    background: { kind: 'gradient', from: '#6366F1', to: '#8B5CF6', angle: 135 },
  },
  {
    id: 'sunset',
    label: 'Sunset',
    background: { kind: 'gradient', from: '#F97316', to: '#EC4899', angle: 135 },
  },
  {
    id: 'ocean',
    label: 'Ocean',
    background: { kind: 'gradient', from: '#06B6D4', to: '#3B82F6', angle: 135 },
  },
  {
    id: 'forest',
    label: 'Forest',
    background: { kind: 'gradient', from: '#10B981', to: '#065F46', angle: 135 },
  },
  {
    id: 'slate',
    label: 'Slate',
    background: { kind: 'gradient', from: '#334155', to: '#0F172A', angle: 160 },
  },
  { id: 'white', label: 'White', background: { kind: 'solid', color: '#FFFFFF' } },
  { id: 'paper', label: 'Paper', background: { kind: 'solid', color: '#F1F5F9' } },
  { id: 'ink', label: 'Ink', background: { kind: 'solid', color: '#111827' } },
];

export const DEFAULT_BEAUTIFY: Beautify = {
  background: BACKGROUND_PRESETS[0]?.background ?? { kind: 'solid', color: '#6366F1' },
  padding: 48,
  radius: 12,
  shadowBlur: 32,
  shadowOffset: 12,
  shadowOpacity: 0.35,
};

// --- crop aspect ratios ------------------------------------------------------------------------

export const ASPECT_PRESETS = [
  { id: 'free', label: 'Free', ratio: null },
  { id: '16:9', label: '16:9', ratio: 16 / 9 },
  { id: '4:3', label: '4:3', ratio: 4 / 3 },
  { id: '1:1', label: '1:1', ratio: 1 },
] as const;
export type AspectId = (typeof ASPECT_PRESETS)[number]['id'];

// --- text and stamps ---------------------------------------------------------------------------

export const STAMP_LABELS: Record<StampId, string> = {
  check: 'Check',
  cross: 'Cross',
  star: 'Star',
  heart: 'Heart',
  warning: 'Warning',
  question: 'Question',
  info: 'Info',
};

export const STAMP_COLORS: Record<StampId, string> = {
  check: '#22C55E',
  cross: '#EF4444',
  star: '#F59E0B',
  heart: '#EC4899',
  warning: '#F59E0B',
  question: '#3B82F6',
  info: '#3B82F6',
};

// --- the editor's starting "pen" -----------------------------------------------------------------

/** What new elements are made with before the user changes anything. Sizes scale with the capture. */
export function initialStyle(image: { width: number; height: number }): StyleDefaults {
  return {
    color: DEFAULT_COLOR,
    strokeWidth: strokeWidthFor(1, image),
    fontSize: fontSizeFor(1, image),
    fontWeight: 600,
    fill: null,
    fillOpacity: 0.25,
    opacity: 1,
    radius: 0,
    shadow: null,
    arrowStyle: 'straight',
    startHead: 'none',
    endHead: 'triangle',
    dash: 'solid',
    blurMode: 'blur',
    blurAmount: Math.round(10 * presetScale(image)),
    stepNumber: 1,
    stamp: 'check',
    highlightMode: 'rect',
    highlightColor: DEFAULT_HIGHLIGHT_COLOR,
    spotlightShape: 'rect',
    spotlightDim: 0.6,
    magnifierZoom: 2,
    family: 'sans',
    italic: false,
    align: 'left',
    textBackground: null,
    outlineColor: null,
    outlineWidth: 0,
    calloutColor: '#111827',
    calloutTextColor: '#FFFFFF',
  };
}

/** Marker colors of the highlighter's quick palette. */
export const HIGHLIGHT_COLORS = [
  { value: '#FACC15', label: 'Yellow' },
  { value: '#4ADE80', label: 'Green' },
  { value: '#F472B6', label: 'Pink' },
  { value: '#22D3EE', label: 'Cyan' },
  { value: '#FB923C', label: 'Orange' },
] as const;
