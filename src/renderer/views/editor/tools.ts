import {
  ArrowUpRight,
  Crop,
  EyeOff,
  MousePointer2,
  Square,
  Type,
  type LucideIcon,
} from 'lucide-react';

export type ToolId = 'select' | 'crop' | 'arrow' | 'rect' | 'text' | 'redact';

export interface ToolDef {
  id: ToolId;
  label: string;
  /** Single-letter shortcut, shown in the tooltip. */
  key: string;
  icon: LucideIcon;
  hint: string;
}

export const REDACT_TIP = 'Redactions always cover everything beneath';

export const TOOLS: readonly ToolDef[] = [
  { id: 'select', label: 'Select', key: 'V', icon: MousePointer2, hint: 'Select and move' },
  { id: 'crop', label: 'Crop', key: 'C', icon: Crop, hint: 'Drag to crop' },
  { id: 'arrow', label: 'Arrow', key: 'A', icon: ArrowUpRight, hint: 'Drag to draw an arrow' },
  { id: 'rect', label: 'Rectangle', key: 'R', icon: Square, hint: 'Drag to draw a rectangle' },
  { id: 'text', label: 'Text', key: 'T', icon: Type, hint: 'Click to add text' },
  { id: 'redact', label: 'Redact', key: 'X', icon: EyeOff, hint: REDACT_TIP },
];

export function toolForKey(key: string): ToolId | null {
  const upper = key.toUpperCase();
  return TOOLS.find((tool) => tool.key === upper)?.id ?? null;
}
