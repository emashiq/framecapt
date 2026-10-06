/**
 * Content Security Policies. Pure strings so both the Vite config (build-time <meta> injection)
 * and the main process (response headers) share one source of truth.
 */
export const PROD_CSP = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob: framecapt-media:",
  "media-src 'self' blob: mediastream: framecapt-media:",
  "font-src 'self'",
  "connect-src 'self'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
  "object-src 'none'",
].join('; ');

/**
 * Development-only policy: additionally allows the Vite dev server origin, its HMR websocket and
 * the inline react-refresh preamble. Never used for packaged builds.
 */
export function devCsp(devServerUrl: string): string {
  const url = new URL(devServerUrl);
  const wsOrigin = `${url.protocol === 'https:' ? 'wss:' : 'ws:'}//${url.host}`;
  return PROD_CSP.replace("script-src 'self'", `script-src 'self' 'unsafe-inline' ${url.origin}`)
    .replace("connect-src 'self'", `connect-src 'self' ${url.origin} ${wsOrigin}`)
    .replace("style-src 'self'", `style-src 'self' ${url.origin}`)
    .replace("font-src 'self'", `font-src 'self' ${url.origin}`);
}

/**
 * The production policy for a <meta http-equiv> tag. `frame-ancestors` is ignored (and warned
 * about) in meta delivery, so it is left out there.
 */
export const PROD_CSP_META = PROD_CSP.split('; ')
  .filter((directive) => !directive.startsWith('frame-ancestors'))
  .join('; ');
