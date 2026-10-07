import { useAnnouncement } from '../lib/announce';

/** One polite live region for status messages (saved, recording stopped, settings reset). */
export function LiveRegion() {
  const { text, n } = useAnnouncement();
  return (
    <div
      role="status"
      aria-live="polite"
      aria-atomic="true"
      className="sr-only"
      data-testid="live-region"
    >
      {/* The counter makes an identical message announce again. */}
      <span key={n}>{text}</span>
    </div>
  );
}
