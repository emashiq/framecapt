import type { TextFont, TextItem } from '../../../shared/video-edit';

/** The parts of drawing text that need no canvas: fonts and line breaking. */

export const FONT_STACKS: Record<TextFont, string> = {
  inter: "'Inter Variable', Inter, 'Segoe UI', sans-serif",
  arial: "Arial, Helvetica, 'Liberation Sans', sans-serif",
  georgia: "Georgia, 'Times New Roman', serif",
  courier: "'Courier New', Consolas, 'Liberation Mono', monospace",
  impact: "Impact, 'Arial Black', sans-serif",
};
export const FONT_LABELS: Record<TextFont, string> = {
  inter: 'Inter (the app font)',
  arial: 'Arial',
  georgia: 'Georgia',
  courier: 'Courier New',
  impact: 'Impact',
};

/** The CSS font of an item, in source pixels. */
export function fontOf(item: Pick<TextItem, 'font' | 'size' | 'weight' | 'italic'>): string {
  return `${item.italic ? 'italic ' : ''}${item.weight} ${item.size}px ${FONT_STACKS[item.font]}`;
}

/** What line breaking needs of a canvas context. */
export interface Measure {
  measureText(text: string): { width: number };
}

/** Lines that fit `maxWidth`: breaks at the new lines of the text, then at spaces (or inside a long word). */
export function wrapLines(ctx: Measure, text: string, maxWidth: number): string[] {
  const lines: string[] = [];
  for (const paragraph of text.split(/\r?\n/)) {
    let line = '';
    for (const word of paragraph.split(' ')) {
      const candidate = line === '' ? word : `${line} ${word}`;
      if (ctx.measureText(candidate).width <= maxWidth || line === '') {
        line = candidate;
        continue;
      }
      lines.push(line);
      line = word;
    }
    // A single word wider than the box is broken between characters.
    while (ctx.measureText(line).width > maxWidth && line.length > 1) {
      let cut = line.length - 1;
      while (cut > 1 && ctx.measureText(line.slice(0, cut)).width > maxWidth) cut -= 1;
      lines.push(line.slice(0, cut));
      line = line.slice(cut);
    }
    lines.push(line);
  }
  return lines;
}
