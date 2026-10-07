import {
  Droplets,
  EyeOff,
  Focus,
  Grid3x3,
  Image as ImageIcon,
  Music,
  Type,
  type LucideIcon,
} from 'lucide-react';
import type { ItemKind } from '../../../shared/video-edit';

/** How each kind of item is named and drawn in the tool bar, timeline and inspector. */
export interface KindStyle {
  label: string;
  /** One line under the tool: what it does. */
  hint: string;
  icon: LucideIcon;
  /** Classes of its bar on the timeline (theme tokens, so both themes work). */
  bar: string;
}

export const KIND_STYLES: Record<ItemKind, KindStyle> = {
  redact: {
    label: 'Redact',
    hint: 'Cover an area with a solid box',
    icon: EyeOff,
    bar: 'border-danger bg-danger-soft text-danger',
  },
  blur: {
    label: 'Blur',
    hint: 'Blur an area',
    icon: Droplets,
    bar: 'border-accent bg-accent-soft text-accent-fg',
  },
  pixelate: {
    label: 'Pixelate',
    hint: 'Turn an area into blocks',
    icon: Grid3x3,
    bar: 'border-warning bg-warning-soft text-warning',
  },
  highlight: {
    label: 'Spotlight',
    hint: 'Dim everything outside an area',
    icon: Focus,
    bar: 'border-success bg-surface-3 text-success',
  },
  text: {
    label: 'Text',
    hint: 'Add text for a while',
    icon: Type,
    bar: 'border-fg-muted bg-surface-3 text-fg',
  },
  image: {
    label: 'Image',
    hint: 'Add a picture or logo for a while',
    icon: ImageIcon,
    bar: 'border-accent bg-surface-3 text-accent-fg',
  },
  audio: {
    label: 'Audio',
    hint: 'Add a sound or music clip',
    icon: Music,
    bar: 'border-success border-dashed bg-surface-3 text-fg',
  },
};
