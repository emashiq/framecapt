const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** "just now", "2 min ago", "3 h ago", "yesterday", "4 days ago", then a plain date. */
export function formatRelative(timestamp: number, now: number = Date.now()): string {
  const age = Math.max(0, now - timestamp);
  if (age < 45_000) return 'just now';
  if (age < HOUR) return `${Math.max(1, Math.round(age / MINUTE))} min ago`;
  if (age < DAY) return `${Math.round(age / HOUR)} h ago`;
  const days = Math.floor(age / DAY);
  if (days === 1) return 'yesterday';
  if (days < 7) return `${days} days ago`;
  return new Date(timestamp).toLocaleDateString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  });
}

/** The exact local date and time, for tooltips and the details view. */
export function formatExact(timestamp: number): string {
  return new Date(timestamp).toLocaleString(undefined, {
    dateStyle: 'medium',
    timeStyle: 'medium',
  });
}
