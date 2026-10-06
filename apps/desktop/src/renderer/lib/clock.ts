/** "1:05.3": minutes, seconds and tenths (hours from one hour on); what the extract time fields show. */
export function formatClock(ms: number): string {
  const total = Math.max(0, Math.round(ms / 100));
  const tenths = total % 10;
  const seconds = Math.floor(total / 10) % 60;
  const minutes = Math.floor(total / 600) % 60;
  const hours = Math.floor(total / 36000);
  const two = (value: number): string => String(value).padStart(2, '0');
  const tail = `${two(seconds)}.${tenths}`;
  return hours > 0 ? `${hours}:${two(minutes)}:${tail}` : `${minutes}:${tail}`;
}

/**
 * Reads what a person types into a time field: "12", "12.5", "1:05", "1:05.3", "1:02:03". Returns
 * milliseconds, or null when it is not a time.
 */
export function parseClock(text: string): number | null {
  const match = /^\s*(?:(?:(\d+):)?(\d{1,2}):)?(\d+)(?:\.(\d{1,3}))?\s*$/.exec(text);
  if (!match) return null;
  const [, hours = '0', minutes = '0', seconds = '0', fraction = ''] = match;
  const minutePart = Number(minutes);
  // "1:75" is not a time; "75" seconds is fine (it is the only part given).
  if (match[2] !== undefined && Number(seconds) >= 60) return null;
  if (match[1] !== undefined && minutePart >= 60) return null;
  const millis = fraction === '' ? 0 : Number(fraction.padEnd(3, '0'));
  return ((Number(hours) * 60 + minutePart) * 60 + Number(seconds)) * 1000 + millis;
}
