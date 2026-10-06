/**
 * "FrameCapt 2026-10-02 at 14.05.09.png": the names the app gives its captures (see
 * `defaultShotFileName` and `defaultRecordingFileName`), with " (2)" for a collision or
 * " (recovered)". The one place that reads such a name back.
 */
const NAME_PATTERN =
  /^FrameCapt (\d{4})-(\d{2})-(\d{2}) at (\d{2})\.(\d{2})\.(\d{2})(?: \((?:\d+|recovered)\))*\.[a-z0-9]+$/i;

export function isCaptureFileName(name: string): boolean {
  return NAME_PATTERN.test(name);
}

/** Local time from a name the app made; null for any other name. */
export function createdAtFromName(name: string): number | null {
  const match = NAME_PATTERN.exec(name);
  if (!match) return null;
  const [year, month, day, hour, minute, second] = match.slice(1, 7).map(Number) as [
    number,
    number,
    number,
    number,
    number,
    number,
  ];
  const date = new Date(year, month - 1, day, hour, minute, second);
  return Number.isNaN(date.getTime()) ? null : date.getTime();
}
