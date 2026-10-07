import type { EditorAction } from '../../../shared/shortcuts';
import {
  ArrowUpRight,
  Circle,
  Crop,
  EyeOff,
  Grid3x3,
  Highlighter,
  ImagePlus,
  ListOrdered,
  MessageSquare,
  Minus,
  MousePointer2,
  Pencil,
  Ruler,
  Search,
  Spotlight,
  Square,
  Stamp,
  Type,
  type LucideIcon,
} from 'lucide-react';

export type ToolId =
  | 'select'
  | 'crop'
  | 'rect'
  | 'ellipse'
  | 'line'
  | 'arrow'
  | 'pen'
  | 'text'
  | 'callout'
  | 'step'
  | 'stamp'
  | 'highlight'
  | 'blur'
  | 'redact'
  | 'spotlight'
  | 'magnifier'
  | 'ruler';

export interface ToolDef {
  id: ToolId;
  label: string;
  /** The editor shortcut that selects it (the key itself is a setting: shared/shortcuts.ts). */
  action: EditorAction;
  icon: LucideIcon;
  hint: string;
}

export const REDACT_TIP = 'Redactions always cover everything beneath';
export const BLUR_TIP = 'Blur and pixelate are visual effects, not secure: use Redact for secrets';

export const TOOLS: readonly ToolDef[] = [
  {
    id: 'select',
    label: 'Select',
    action: 'toolSelect',
    icon: MousePointer2,
    hint: 'Select and move. Shift-click or drag a box to select several',
  },
  { id: 'crop', label: 'Crop', action: 'toolCrop', icon: Crop, hint: 'Drag to crop' },
  {
    id: 'rect',
    label: 'Rectangle',
    action: 'toolRect',
    icon: Square,
    hint: 'Drag to draw a rectangle',
  },
  {
    id: 'ellipse',
    label: 'Ellipse',
    action: 'toolEllipse',
    icon: Circle,
    hint: 'Drag to draw an ellipse (Shift: circle)',
  },
  {
    id: 'line',
    label: 'Line',
    action: 'toolLine',
    icon: Minus,
    hint: 'Drag to draw a line (Shift: 45 degree steps)',
  },
  {
    id: 'arrow',
    label: 'Arrow',
    action: 'toolArrow',
    icon: ArrowUpRight,
    hint: 'Drag to draw an arrow',
  },
  { id: 'pen', label: 'Pen', action: 'toolPen', icon: Pencil, hint: 'Draw freehand' },
  { id: 'text', label: 'Text', action: 'toolText', icon: Type, hint: 'Click to add text' },
  {
    id: 'callout',
    label: 'Callout',
    action: 'toolCallout',
    icon: MessageSquare,
    hint: 'Drag to draw a speech bubble',
  },
  {
    id: 'step',
    label: 'Step number',
    action: 'toolStep',
    icon: ListOrdered,
    hint: 'Click to place the next number',
  },
  {
    id: 'stamp',
    label: 'Stamp',
    action: 'toolStamp',
    icon: Stamp,
    hint: 'Click to place a stamp',
  },
  {
    id: 'highlight',
    label: 'Highlighter',
    action: 'toolHighlight',
    icon: Highlighter,
    hint: 'Drag a box or draw freehand with the highlighter',
  },
  { id: 'blur', label: 'Blur', action: 'toolBlur', icon: Grid3x3, hint: BLUR_TIP },
  { id: 'redact', label: 'Redact', action: 'toolRedact', icon: EyeOff, hint: REDACT_TIP },
  {
    id: 'spotlight',
    label: 'Spotlight',
    action: 'toolSpotlight',
    icon: Spotlight,
    hint: 'Drag to dim everything outside an area',
  },
  {
    id: 'magnifier',
    label: 'Magnifier',
    action: 'toolMagnifier',
    icon: Search,
    hint: 'Drag a circle that enlarges what is under it',
  },
  { id: 'ruler', label: 'Ruler', action: 'toolRuler', icon: Ruler, hint: 'Drag to measure pixels' },
];

/** The toolbar groups, in order (separators between them). */
export const TOOL_GROUPS: readonly { label: string; ids: readonly ToolId[] }[] = [
  { label: 'Pointer', ids: ['select', 'crop'] },
  { label: 'Shapes', ids: ['rect', 'ellipse', 'line', 'arrow', 'pen'] },
  { label: 'Annotate', ids: ['text', 'callout', 'step', 'stamp'] },
  { label: 'Effects', ids: ['highlight', 'blur', 'redact', 'spotlight', 'magnifier', 'ruler'] },
];

/**
 * Insert image is an action, not a drawing tool: it opens a menu (from a file, from History) and
 * places the picture as a layer. Its key is a setting like the tools' keys.
 */
export const INSERT_IMAGE = {
  label: 'Insert image',
  action: 'insertImage',
  icon: ImagePlus,
  hint: 'Add a picture from a file or from History. You can also paste or drop one',
} as const satisfies Omit<ToolDef, 'id'>;

/** The tool an editor action selects, or null for the other actions. */
export function toolForAction(action: EditorAction): ToolId | null {
  return TOOLS.find((tool) => tool.action === action)?.id ?? null;
}
