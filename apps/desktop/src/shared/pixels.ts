/**
 * Electron's `NativeImage.toBitmap()` is B, G, R, A per pixel (little-endian 0xAARRGGBB words);
 * canvas `ImageData` wants R, G, B, A. Returns a NEW buffer, so the input can be reused.
 */
export function bgraToRgba(bgra: ArrayBuffer): Uint8ClampedArray<ArrayBuffer> {
  const source = new Uint32Array(bgra);
  const target = new Uint32Array(source.length);
  for (let i = 0; i < source.length; i += 1) {
    const value = source[i] as number;
    target[i] = (value & 0xff00ff00) | ((value & 0xff) << 16) | ((value >>> 16) & 0xff);
  }
  return new Uint8ClampedArray(target.buffer);
}
