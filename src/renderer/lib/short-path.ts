/** "…\FrameCapt\file.png": the last two path segments, for a toast. */
export function shortPath(file: string): string {
  const parts = file.split(/[\\/]/).filter(Boolean);
  return parts.length > 2 ? `…\\${parts.slice(-2).join('\\')}` : file;
}
