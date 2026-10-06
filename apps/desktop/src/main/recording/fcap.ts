import fs from 'node:fs';
import { z } from 'zod';
import {
  FCAP_PAYLOAD_OFFSET,
  LayoutSourceSchema,
  MAX_MULTI_SOURCES,
} from '../../shared/recording-layout';

/**
 * `.fcap`: FrameCapt's own container for multi-source recordings (screens and windows recorded
 * together into one picture). A small header that describes the picture, then an ordinary WebM.
 * Only FrameCapt reads it: other players cannot (by design), and FrameCapt extracts from it.
 *
 *   bytes 0..4    "FCAP" and 0x00
 *   byte  5       format version (1)
 *   bytes 6..7    reserved, zero
 *   bytes 8..11   u32 little-endian length of the JSON header
 *   bytes 12..    JSON header (UTF-8)
 *   ...           zero padding up to payloadOffset (4096)
 *   payloadOffset the WebM payload, payloadLength bytes
 *
 * Window titles are never stored: sources carry generic names ("Screen 1", "Window 2").
 * The format is specified in docs/recording-persistence.md.
 */
export { FCAP_PAYLOAD_OFFSET };
export const FCAP_VERSION = 1;
export const FCAP_PAYLOAD_TYPE = 'video/webm';
/** The JSON header is at most this long (a valid file's is far shorter: it fits before the payload). */
export const FCAP_MAX_JSON_BYTES = 64 * 1024;
const PREFIX_BYTES = 12;
const MAGIC = Buffer.from([0x46, 0x43, 0x41, 0x50, 0x00]); // "FCAP\0"
const COPY_BUFFER_BYTES = 1024 * 1024;

export const FcapHeaderSchema = z
  .strictObject({
    version: z.literal(FCAP_VERSION),
    /** Size of the recorded picture in pixels. */
    width: z.number().int().min(2).max(16384),
    height: z.number().int().min(2).max(16384),
    durationMs: z.number().int().min(0).max(86_400_000),
    hasAudio: z.boolean(),
    createdAt: z.number().min(0),
    sources: z.array(LayoutSourceSchema).min(1).max(MAX_MULTI_SOURCES),
    payloadOffset: z.literal(FCAP_PAYLOAD_OFFSET),
    payloadLength: z.number().int().min(1),
    payloadType: z.literal(FCAP_PAYLOAD_TYPE),
  })
  .refine(
    (header) =>
      header.sources.every(
        ({ rect }) => rect.x + rect.width <= header.width && rect.y + rect.height <= header.height,
      ),
    { message: 'A source lies outside the picture.', path: ['sources'] },
  );
export type FcapHeader = z.infer<typeof FcapHeaderSchema>;

/** What the writer is given; the payload's position and length are filled in. */
export type FcapMeta = Omit<
  FcapHeader,
  'version' | 'payloadOffset' | 'payloadLength' | 'payloadType'
>;

export type FcapErrorCode = 'NOT_FCAP' | 'UNSUPPORTED_VERSION' | 'CORRUPT' | 'TRUNCATED';

export class FcapError extends Error {
  constructor(
    readonly code: FcapErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'FcapError';
  }
}

/**
 * The 4096-byte block in front of the payload: prefix, JSON, zero padding. `payloadLength` is the
 * WebM's size in bytes.
 */
export function buildFcapHeaderBlock(meta: FcapMeta, payloadLength: number): Buffer {
  const header: FcapHeader = FcapHeaderSchema.parse({
    ...meta,
    version: FCAP_VERSION,
    payloadOffset: FCAP_PAYLOAD_OFFSET,
    payloadLength,
    payloadType: FCAP_PAYLOAD_TYPE,
  });
  const json = Buffer.from(JSON.stringify(header), 'utf8');
  if (PREFIX_BYTES + json.length > FCAP_PAYLOAD_OFFSET) {
    throw new FcapError('CORRUPT', 'The header does not fit before the payload.');
  }
  const block = Buffer.alloc(FCAP_PAYLOAD_OFFSET);
  MAGIC.copy(block, 0);
  block[5] = FCAP_VERSION;
  block.writeUInt32LE(json.length, 8);
  json.copy(block, PREFIX_BYTES);
  return block;
}

/**
 * Checks the start of a file (at least its first 4096 bytes, or all of a shorter one) against the
 * format and the file's size, and returns the header.
 */
export function parseFcapHeader(start: Uint8Array, fileSize: number): FcapHeader {
  const bytes = Buffer.from(start.buffer, start.byteOffset, start.byteLength);
  if (bytes.length < PREFIX_BYTES || !bytes.subarray(0, MAGIC.length).equals(MAGIC)) {
    throw new FcapError('NOT_FCAP', 'This is not a FrameCapt multi-source recording.');
  }
  if (bytes[5] !== FCAP_VERSION) {
    throw new FcapError(
      'UNSUPPORTED_VERSION',
      'This recording was made by a newer version of FrameCapt.',
    );
  }
  if (bytes[6] !== 0 || bytes[7] !== 0) {
    throw new FcapError('CORRUPT', 'The recording header is damaged.');
  }
  const jsonLength = bytes.readUInt32LE(8);
  if (
    jsonLength === 0 ||
    jsonLength > FCAP_MAX_JSON_BYTES ||
    PREFIX_BYTES + jsonLength > FCAP_PAYLOAD_OFFSET
  ) {
    throw new FcapError('CORRUPT', 'The recording header is damaged.');
  }
  if (bytes.length < PREFIX_BYTES + jsonLength) {
    throw new FcapError('TRUNCATED', 'The recording file is incomplete.');
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(bytes.toString('utf8', PREFIX_BYTES, PREFIX_BYTES + jsonLength));
  } catch {
    throw new FcapError('CORRUPT', 'The recording header is damaged.');
  }
  const result = FcapHeaderSchema.safeParse(parsed);
  if (!result.success) throw new FcapError('CORRUPT', 'The recording header is damaged.');
  const header = result.data;
  if (header.payloadOffset + header.payloadLength > fileSize) {
    throw new FcapError('TRUNCATED', 'The recording file is incomplete.');
  }
  return header;
}

/** Reads and validates the header of a `.fcap` file. */
export async function readFcapHeader(file: string): Promise<FcapHeader> {
  const handle = await fs.promises.open(file, 'r');
  try {
    const { size } = await handle.stat();
    const buffer = Buffer.alloc(Math.min(size, FCAP_PAYLOAD_OFFSET));
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    return parseFcapHeader(buffer.subarray(0, bytesRead), size);
  } finally {
    await handle.close();
  }
}

async function writeAll(handle: fs.promises.FileHandle, bytes: Uint8Array): Promise<void> {
  let offset = 0;
  while (offset < bytes.length) {
    const { bytesWritten } = await handle.write(bytes, offset, bytes.length - offset);
    if (bytesWritten <= 0) throw new Error('A write made no progress.');
    offset += bytesWritten;
  }
}

/**
 * Writes a `.fcap` at `destPath` (which must not exist): the header block, then the whole WebM at
 * `payloadPath`, read in 1 MB pieces. Flushed to disk before it returns. A failure removes the file
 * it was writing. The caller names `destPath` as a partial file and renames it when this succeeds.
 */
export async function writeFcap(
  payloadPath: string,
  destPath: string,
  meta: FcapMeta,
  signal?: AbortSignal,
): Promise<FcapHeader> {
  const source = await fs.promises.open(payloadPath, 'r');
  let dest: fs.promises.FileHandle | undefined;
  // Only a file this call created is ever removed (an existing one makes the open fail).
  let created = false;
  try {
    const { size } = await source.stat();
    if (size === 0) throw new FcapError('CORRUPT', 'There is no video to store.');
    const block = buildFcapHeaderBlock(meta, size);
    dest = await fs.promises.open(destPath, 'wx');
    created = true;
    await writeAll(dest, block);
    const buffer = Buffer.alloc(COPY_BUFFER_BYTES);
    let copied = 0;
    while (copied < size) {
      if (signal?.aborted) throw new FcapError('TRUNCATED', 'Writing the recording was cancelled.');
      const { bytesRead } = await source.read(buffer, 0, buffer.length, copied);
      if (bytesRead === 0) throw new FcapError('TRUNCATED', 'The video ended unexpectedly.');
      await writeAll(dest, buffer.subarray(0, bytesRead));
      copied += bytesRead;
    }
    await dest.sync();
    return parseFcapHeader(block, FCAP_PAYLOAD_OFFSET + size);
  } catch (error) {
    await dest?.close().catch(() => undefined);
    dest = undefined;
    if (created) await fs.promises.rm(destPath, { force: true }).catch(() => undefined);
    throw error;
  } finally {
    await source.close().catch(() => undefined);
    await dest?.close().catch(() => undefined);
  }
}

// --- cache --------------------------------------------------------------------------------------

interface CacheEntry {
  mtimeMs: number;
  size: number;
  header: FcapHeader;
}
const cache = new Map<string, CacheEntry>();
const CACHE_LIMIT = 64;

/**
 * The header of a `.fcap`, cached by path, modification time and size (the media protocol asks for
 * it on every range request). A changed file is read again; an invalid file is never cached.
 */
export async function readFcapHeaderCached(file: string): Promise<FcapHeader> {
  const stat = await fs.promises.stat(file);
  const hit = cache.get(file);
  if (hit && hit.mtimeMs === stat.mtimeMs && hit.size === stat.size) return hit.header;
  const header = await readFcapHeader(file);
  cache.delete(file);
  cache.set(file, { mtimeMs: stat.mtimeMs, size: stat.size, header });
  if (cache.size > CACHE_LIMIT) cache.delete(cache.keys().next().value as string);
  return header;
}

export function clearFcapHeaderCache(): void {
  cache.clear();
}

export function isFcapPath(file: string): boolean {
  return file.toLowerCase().endsWith('.fcap');
}
