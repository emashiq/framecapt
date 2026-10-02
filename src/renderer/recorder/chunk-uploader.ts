import { MAX_PENDING_BYTES, MAX_PENDING_CHUNKS } from '../../shared/recorder-ipc';

export interface UploadFailure {
  /** QUEUE_OVERFLOW, or the code main answered with (WRITE_FAILED, DISK_FULL, SEQ_GAP, ...). */
  code: string;
  message: string;
}

export type AppendResult =
  | { ok: true; data: { duplicate: boolean; lastSeq: number } }
  | { ok: false; error: { code: string; message: string } };

export type AppendFn = (request: {
  sessionId: string;
  seq: number;
  bytes: ArrayBuffer;
}) => Promise<AppendResult>;

export interface ChunkUploaderOptions {
  sessionId: string;
  append: AppendFn;
  maxChunks?: number;
  maxBytes?: number;
  /** Called once, when the uploader can take no more data (overflow or a failed write). */
  onFatal: (failure: UploadFailure) => void;
}

interface Queued {
  seq: number;
  blob: Blob;
}

/**
 * Sends MediaRecorder chunks to main, strictly one at a time and in order: a chunk's bytes are
 * read, sent, and only after main acknowledged the write does the next one go. Sequence numbers
 * start at 0 and are assigned when a chunk is pushed. The queue is bounded (16 chunks or 64 MB by
 * default): a chunk that would exceed it is not accepted, the uploader fails with QUEUE_OVERFLOW
 * and the recorder must stop. Chunks are never dropped silently and never buffered without bound.
 * Chunks accepted before an overflow are still sent; after a write failure nothing more is sent.
 */
export class ChunkUploader {
  private readonly queue: Queued[] = [];
  private readonly maxChunks: number;
  private readonly maxBytes: number;
  private nextSeq = 0;
  private acked = -1;
  private pendingBytes = 0;
  private totalBytes = 0;
  private draining = false;
  private failure: UploadFailure | null = null;
  /** Nothing is sent any more (a failed write); queued chunks are abandoned. */
  private halted = false;
  private idleWaiters: (() => void)[] = [];

  constructor(private readonly options: ChunkUploaderOptions) {
    this.maxChunks = options.maxChunks ?? MAX_PENDING_CHUNKS;
    this.maxBytes = options.maxBytes ?? MAX_PENDING_BYTES;
  }

  /** Sequence number of the last chunk accepted, -1 when none. */
  get lastSeq(): number {
    return this.nextSeq - 1;
  }

  /** Sequence number of the last chunk main acknowledged, -1 when none. */
  get ackedSeq(): number {
    return this.acked;
  }

  get pending(): { chunks: number; bytes: number } {
    return { chunks: this.queue.length, bytes: this.pendingBytes };
  }

  get chunkCount(): number {
    return this.nextSeq;
  }

  get bytesAccepted(): number {
    return this.totalBytes;
  }

  get failed(): UploadFailure | null {
    return this.failure;
  }

  /** Accepts a chunk, or fails the uploader when it would not fit the queue. */
  push(blob: Blob): void {
    if (this.failure || blob.size === 0) return;
    if (this.queue.length + 1 > this.maxChunks || this.pendingBytes + blob.size > this.maxBytes) {
      this.fail({
        code: 'QUEUE_OVERFLOW',
        message: 'Saving the recording to disk is too slow, so the recording was stopped.',
      });
      return;
    }
    this.queue.push({ seq: this.nextSeq, blob });
    this.nextSeq += 1;
    this.pendingBytes += blob.size;
    this.totalBytes += blob.size;
    void this.drain();
  }

  /** Resolves when everything accepted has been acknowledged, or the uploader gave up. */
  flush(): Promise<void> {
    if (!this.draining && (this.queue.length === 0 || this.halted)) return Promise.resolve();
    return new Promise<void>((resolve) => this.idleWaiters.push(resolve));
  }

  private fail(failure: UploadFailure, halt = false): void {
    if (halt) this.halted = true;
    if (this.failure) return;
    this.failure = failure;
    this.options.onFatal(failure);
  }

  private async drain(): Promise<void> {
    if (this.draining) return;
    this.draining = true;
    try {
      while (this.queue.length > 0 && !this.halted) {
        const item = this.queue[0];
        if (!item) break;
        const bytes = await item.blob.arrayBuffer();
        const result = await this.options.append({
          sessionId: this.options.sessionId,
          seq: item.seq,
          bytes,
        });
        if (!result.ok) {
          this.fail({ code: result.error.code, message: result.error.message }, true);
          break;
        }
        this.queue.shift();
        this.pendingBytes -= item.blob.size;
        this.acked = item.seq;
      }
    } catch (error) {
      this.fail(
        { code: 'UPLOAD_FAILED', message: error instanceof Error ? error.message : String(error) },
        true,
      );
    } finally {
      this.draining = false;
      if (this.halted) {
        this.queue.length = 0;
        this.pendingBytes = 0;
      }
      if (this.queue.length === 0 || this.halted) {
        const waiters = this.idleWaiters;
        this.idleWaiters = [];
        for (const resolve of waiters) resolve();
      } else {
        void this.drain();
      }
    }
  }
}
