import type { AnnotationPatch } from './model/commands';
import type { StyleDefaults } from './model/create';
import {
  DEFAULT_SPOTLIGHT_DIM,
  HIGHLIGHT_OPACITY,
  type Annotation,
  type AnnotationType,
  type StampId,
} from './model/types';

/** The values the properties panel shows, for a selected annotation or for the current tool. */
export interface PropValues {
  color: string;
  strokeWidth: number;
  fill: string | null;
  fillOpacity: number;
  opacity: number;
  radius: number;
  shadow: { blur: number; offset: number } | null;
  fontSize: number;
  fontWeight: number;
  family: StyleDefaults['family'];
  italic: boolean;
  align: StyleDefaults['align'];
  textBackground: string | null;
  outlineColor: string | null;
  outlineWidth: number;
  arrowStyle: StyleDefaults['arrowStyle'];
  startHead: StyleDefaults['startHead'];
  endHead: StyleDefaults['endHead'];
  dash: StyleDefaults['dash'];
  blurMode: StyleDefaults['blurMode'];
  blurAmount: number;
  stepNumber: number;
  markSize: number;
  stamp: StampId;
  spotlightShape: StyleDefaults['spotlightShape'];
  spotlightDim: number;
  magnifierZoom: number;
  textColor: string;
}
export type PropField = keyof PropValues;

/** Which controls make sense for an element type. */
export interface PropSupport {
  color: boolean;
  colorLabel: string;
  stroke: boolean;
  fill: boolean;
  radius: boolean;
  opacity: boolean;
  shadow: boolean;
  text: boolean;
  textColor: boolean;
  arrow: boolean;
  dash: boolean;
  blur: boolean;
  spotlight: boolean;
  magnifier: boolean;
  step: boolean;
  stamp: boolean;
}

const NONE: PropSupport = {
  color: false,
  colorLabel: 'Color',
  stroke: false,
  fill: false,
  radius: false,
  opacity: false,
  shadow: false,
  text: false,
  textColor: false,
  arrow: false,
  dash: false,
  blur: false,
  spotlight: false,
  magnifier: false,
  step: false,
  stamp: false,
};

const SUPPORT: Record<AnnotationType, PropSupport> = {
  arrow: { ...NONE, color: true, stroke: true, opacity: true, shadow: true, arrow: true },
  line: { ...NONE, color: true, stroke: true, opacity: true, shadow: true, dash: true },
  rect: {
    ...NONE,
    color: true,
    stroke: true,
    fill: true,
    radius: true,
    opacity: true,
    shadow: true,
  },
  ellipse: { ...NONE, color: true, stroke: true, fill: true, opacity: true, shadow: true },
  highlight: { ...NONE, color: true, opacity: true },
  pen: { ...NONE, color: true, stroke: true, opacity: true, shadow: true },
  blur: { ...NONE, blur: true },
  step: { ...NONE, color: true, opacity: true, shadow: true, step: true },
  callout: {
    ...NONE,
    color: true,
    colorLabel: 'Bubble color',
    radius: true,
    opacity: true,
    shadow: true,
    text: true,
    textColor: true,
  },
  text: { ...NONE, color: true, colorLabel: 'Text color', opacity: true, shadow: true, text: true },
  spotlight: { ...NONE, spotlight: true },
  magnifier: { ...NONE, color: true, stroke: true, opacity: true, shadow: true, magnifier: true },
  stamp: { ...NONE, color: true, opacity: true, shadow: true, stamp: true },
  ruler: { ...NONE, color: true, stroke: true, opacity: true, shadow: true },
  redact: NONE,
};

export function supportFor(type: AnnotationType | null): PropSupport {
  return type ? SUPPORT[type] : NONE;
}

/** The values to show: the style defaults, overridden by what the (single) selection has. */
export function propsOf(annotation: Annotation | null, style: StyleDefaults): PropValues {
  const base: PropValues = {
    color: style.color,
    strokeWidth: style.strokeWidth,
    fill: style.fill,
    fillOpacity: style.fillOpacity,
    opacity: style.opacity,
    radius: style.radius,
    shadow: style.shadow,
    fontSize: style.fontSize,
    fontWeight: style.fontWeight,
    family: style.family,
    italic: style.italic,
    align: style.align,
    textBackground: style.textBackground,
    outlineColor: style.outlineColor,
    outlineWidth: style.outlineWidth,
    arrowStyle: style.arrowStyle,
    startHead: style.startHead,
    endHead: style.endHead,
    dash: style.dash,
    blurMode: style.blurMode,
    blurAmount: style.blurAmount,
    stepNumber: style.stepNumber,
    markSize: Math.max(24, Math.round(style.fontSize * 1.5)),
    stamp: style.stamp,
    spotlightShape: style.spotlightShape,
    spotlightDim: style.spotlightDim,
    magnifierZoom: style.magnifierZoom,
    textColor: style.calloutTextColor,
  };
  if (!annotation) return base;
  const a = annotation;
  const next = { ...base };
  if ('color' in a) next.color = a.color;
  if ('width' in a) next.strokeWidth = a.width;
  if ('opacity' in a) next.opacity = a.opacity ?? (a.type === 'highlight' ? HIGHLIGHT_OPACITY : 1);
  else next.opacity = 1;
  next.shadow = 'shadow' in a && a.shadow ? a.shadow : null;
  if (a.type === 'rect' || a.type === 'ellipse') {
    next.fill = a.fill ?? null;
    next.fillOpacity = a.fillOpacity ?? 1;
  }
  if (a.type === 'rect') next.radius = a.radius ?? 0;
  if (a.type === 'callout') {
    next.radius = a.radius ?? 10;
    next.textColor = a.textColor;
  }
  if (a.type === 'text' || a.type === 'callout') {
    next.fontSize = a.fontSize;
    next.fontWeight = a.fontWeight;
  }
  if (a.type === 'text') {
    next.family = a.family ?? 'sans';
    next.italic = a.italic ?? false;
    next.align = a.align ?? 'left';
    next.textBackground = a.background ?? null;
    next.outlineColor = a.outlineColor ?? null;
    next.outlineWidth = a.outlineWidth ?? 0;
  }
  if (a.type === 'arrow') {
    next.arrowStyle = a.style ?? 'straight';
    next.startHead = a.startHead ?? 'none';
    next.endHead = a.endHead ?? 'triangle';
  }
  if (a.type === 'line') next.dash = a.dash ?? 'solid';
  if (a.type === 'blur') {
    next.blurMode = a.mode;
    next.blurAmount = a.amount;
  }
  if (a.type === 'step') {
    next.stepNumber = a.number;
    next.markSize = a.size;
  }
  if (a.type === 'stamp') {
    next.stamp = a.stamp;
    next.markSize = a.size;
  }
  if (a.type === 'spotlight') {
    next.spotlightShape = a.shape;
    next.spotlightDim = a.dim ?? DEFAULT_SPOTLIGHT_DIM;
  }
  if (a.type === 'magnifier') next.magnifierZoom = a.zoom;
  return next;
}

/** How a panel field maps onto the style defaults and onto an annotation patch. */
const MAP: Record<PropField, { style?: keyof StyleDefaults; patch?: keyof AnnotationPatch }> = {
  color: { style: 'color', patch: 'color' },
  strokeWidth: { style: 'strokeWidth', patch: 'width' },
  fill: { style: 'fill', patch: 'fill' },
  fillOpacity: { style: 'fillOpacity', patch: 'fillOpacity' },
  opacity: { style: 'opacity', patch: 'opacity' },
  radius: { style: 'radius', patch: 'radius' },
  shadow: { style: 'shadow', patch: 'shadow' },
  fontSize: { style: 'fontSize', patch: 'fontSize' },
  fontWeight: { style: 'fontWeight', patch: 'fontWeight' },
  family: { style: 'family', patch: 'family' },
  italic: { style: 'italic', patch: 'italic' },
  align: { style: 'align', patch: 'align' },
  textBackground: { style: 'textBackground', patch: 'background' },
  outlineColor: { style: 'outlineColor', patch: 'outlineColor' },
  outlineWidth: { style: 'outlineWidth', patch: 'outlineWidth' },
  arrowStyle: { style: 'arrowStyle', patch: 'style' },
  startHead: { style: 'startHead', patch: 'startHead' },
  endHead: { style: 'endHead', patch: 'endHead' },
  dash: { style: 'dash', patch: 'dash' },
  blurMode: { style: 'blurMode', patch: 'mode' },
  blurAmount: { style: 'blurAmount', patch: 'amount' },
  stepNumber: { patch: 'number' },
  markSize: { patch: 'size' },
  stamp: { style: 'stamp', patch: 'stamp' },
  spotlightShape: { style: 'spotlightShape', patch: 'shape' },
  spotlightDim: { style: 'spotlightDim', patch: 'dim' },
  magnifierZoom: { style: 'magnifierZoom', patch: 'zoom' },
  textColor: { style: 'calloutTextColor', patch: 'textColor' },
};

/**
 * The effect of changing one panel field: the new style defaults (so the next element is made
 * the same way) and the patch for the selected elements. `kind` is the element type the panel is
 * showing, which decides where a color goes (a highlighter and a bubble keep their own).
 */
export function applyProp<F extends PropField>(
  field: F,
  value: PropValues[F],
  style: StyleDefaults,
  kind: AnnotationType | null,
): { style: StyleDefaults; patch: AnnotationPatch } {
  const map = MAP[field];
  const next = { ...style } as Record<string, unknown>;
  let styleKey = map.style;
  if (field === 'color' && kind === 'highlight') styleKey = 'highlightColor';
  if (field === 'color' && kind === 'callout') styleKey = 'calloutColor';
  if (styleKey) next[styleKey] = value;
  const patch: Record<string, unknown> = {};
  if (map.patch) patch[map.patch] = value;
  // A new fill needs an opacity too (an existing shape without one would be fully opaque).
  if (field === 'fill' && value !== null) patch.fillOpacity = style.fillOpacity;
  return { style: next as unknown as StyleDefaults, patch: patch as AnnotationPatch };
}

/** The annotation type a tool makes (what the panel shows for it), or null for non-drawing tools. */
export function typeForTool(tool: string): AnnotationType | null {
  switch (tool) {
    case 'rect':
    case 'ellipse':
    case 'line':
    case 'arrow':
    case 'pen':
    case 'text':
    case 'callout':
    case 'highlight':
    case 'blur':
    case 'spotlight':
    case 'magnifier':
    case 'ruler':
    case 'redact':
      return tool;
    case 'step':
    case 'stamp':
      return tool;
    default:
      return null;
  }
}
