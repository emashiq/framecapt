/**
 * desktopCapturer ids look like `screen:<n>:0` and `window:<hwnd>:<n>`; BrowserWindow
 * `getMediaSourceId()` uses the same `window:<hwnd>:<n>` shape. The trailing number differs
 * between the two APIs (it marks the current process / web contents), so windows are compared by
 * their handle only.
 */
export function windowHandleOf(sourceId: string): string | undefined {
  const match = /^window:(\d+):\d+$/.exec(sourceId);
  return match?.[1];
}

/** True when `sourceId` is a window source belonging to one of our own windows. */
export function isOwnWindowSource(sourceId: string, ownMediaSourceIds: readonly string[]): boolean {
  const handle = windowHandleOf(sourceId);
  if (handle === undefined) return false;
  return ownMediaSourceIds.some((own) => windowHandleOf(own) === handle);
}
