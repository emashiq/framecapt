import { z } from 'zod';

/**
 * Live panels: while a recording runs the user can add a region, a window or a screen as an extra
 * picture in the SAME video. Slot 0 is the recording itself, slots 1..3 are the panels.
 */
export const MAX_PANELS = 3;

export const PanelKindSchema = z.enum(['region', 'window', 'screen']);
export type PanelKind = z.infer<typeof PanelKindSchema>;

/** What a hidden panel's rectangle shows instead of the source (the source's picture is never drawn). */
export const PanelPlaceholderSchema = z.enum(['meeting-hidden', 'meeting-ended', 'share-paused']);
export type PanelPlaceholder = z.infer<typeof PanelPlaceholderSchema>;

export const PLACEHOLDER_TEXT: Record<PanelPlaceholder, string> = {
  'meeting-hidden': 'Meeting window hidden',
  'meeting-ended': 'Meeting ended',
  'share-paused': 'Screen share paused',
};

/** The card of a panel whose source ended (the screen was unplugged, the window closed). */
export const SOURCE_ENDED_TEXT = 'Source ended';

/** "Panel 2" for slot 1: the recording itself is "Panel 1". */
export function panelLabel(slot: number): string {
  return `Panel ${slot + 1}`;
}

/** The lowest free panel slot (1..MAX_PANELS), or undefined at the cap. */
export function freePanelSlot(used: Iterable<number>): number | undefined {
  const taken = new Set(used);
  for (let slot = 1; slot <= MAX_PANELS; slot += 1) if (!taken.has(slot)) return slot;
  return undefined;
}

/**
 * The text of the neutral card a tile draws instead of its video, or null when it draws the video.
 * A source that ended wins over a hidden one; a hidden tile never draws its (stale) frame.
 */
export function tileCardText(tile: {
  lost: boolean;
  hidden: boolean;
  placeholder: PanelPlaceholder | null;
}): string | null {
  if (tile.lost) return SOURCE_ENDED_TEXT;
  if (tile.hidden) return PLACEHOLDER_TEXT[tile.placeholder ?? 'meeting-hidden'];
  return null;
}

/** A panel as the toolbar and the recordings list show it. */
export const PanelSlotSchema = z.strictObject({
  slot: z.number().int().min(1).max(MAX_PANELS),
  kind: PanelKindSchema,
  label: z.string().max(40),
  hidden: z.boolean(),
  placeholder: PanelPlaceholderSchema.nullable(),
});
export type PanelSlot = z.infer<typeof PanelSlotSchema>;
