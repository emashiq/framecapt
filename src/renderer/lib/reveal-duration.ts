/**
 * MediaRecorder WebM has no duration header, so <video> reports Infinity until it has seen the
 * end. Seeking far past the end makes it find the real duration; it then goes back to the start.
 * Finished files are remuxed with a proper duration and seek index, so this only matters for an
 * unindexed raw copy (a failed remux).
 */
export function revealDuration(video: HTMLVideoElement): void {
  if (Number.isFinite(video.duration)) return;
  const restore = (): void => {
    video.removeEventListener('timeupdate', restore);
    video.currentTime = 0;
  };
  video.addEventListener('timeupdate', restore);
  video.currentTime = 1e101;
}
