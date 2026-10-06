/** A PNG-looking buffer: real magic and IHDR size (all `readImageSize` and the format check read), then filler. */
export function pngBytes(width: number, height: number, filler = 'x'): Buffer {
  const head = Buffer.alloc(24);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(head, 0);
  head.writeUInt32BE(13, 8);
  head.write('IHDR', 12, 'ascii');
  head.writeUInt32BE(width, 16);
  head.writeUInt32BE(height, 20);
  return Buffer.concat([head, Buffer.from(filler.repeat(32))]);
}

export const SAMPLE_DOC = { schema: 2, annotations: [{ type: 'arrow', id: 'a' }], crop: null };
