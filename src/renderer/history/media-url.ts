/**
 * The main-owned thumbnail and file routes of the `framecapt-media:` protocol (history ids only).
 * `nonce` (lowercase letters and digits) gives a load its own URL; see the protocol's route comment.
 */
const suffix = (nonce?: string): string => (nonce ? `/${nonce}` : '');
export const thumbUrl = (id: string, nonce?: string): string =>
  `framecapt-media://thumb/${id}${suffix(nonce)}`;
export const fileUrl = (id: string, nonce?: string): string =>
  `framecapt-media://file/${id}${suffix(nonce)}`;

/** A fresh nonce (8 characters of a-z0-9). */
export function newNonce(): string {
  return Math.random().toString(36).slice(2, 10).padEnd(8, '0');
}
