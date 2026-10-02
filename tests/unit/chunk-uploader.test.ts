import { describe, expect, it } from 'vitest';
import {
  ChunkUploader,
  type AppendFn,
  type AppendResult,
  type UploadFailure,
} from '../../src/renderer/recorder/chunk-uploader';

const wait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
const blob = (size: number, fill = 1): Blob => new Blob([new Uint8Array(size).fill(fill)]);
const OK: AppendResult = { ok: true, data: { duplicate: false, lastSeq: 0 } };

interface Call {
  seq: number;
  size: number;
  sessionId: string;
}

/** An append that records calls, tracks concurrency and takes `latency(seq)` ms to answer. */
function fakeAppend(latency: (seq: number) => number = () => 0) {
  const calls: Call[] = [];
  let inFlight = 0;
  let maxInFlight = 0;
  const append: AppendFn = async (request) => {
    inFlight += 1;
    maxInFlight = Math.max(maxInFlight, inFlight);
    calls.push({ seq: request.seq, size: request.bytes.byteLength, sessionId: request.sessionId });
    await wait(latency(request.seq));
    inFlight -= 1;
    return { ok: true, data: { duplicate: false, lastSeq: request.seq } };
  };
  return { append, calls, maxInFlight: () => maxInFlight };
}

/** An append whose answers are released by the test, one at a time. */
function heldAppend() {
  const calls: Call[] = [];
  const releases: ((result?: AppendResult) => void)[] = [];
  const append: AppendFn = (request) =>
    new Promise<AppendResult>((resolve) => {
      calls.push({
        seq: request.seq,
        size: request.bytes.byteLength,
        sessionId: request.sessionId,
      });
      releases.push((result = OK) => resolve(result));
    });
  return {
    append,
    calls,
    release: (index = 0, result?: AppendResult) => releases[index]?.(result),
  };
}

describe('ChunkUploader: ordering and acknowledgements', () => {
  it('numbers chunks from 0 and sends them strictly in order, one at a time', async () => {
    const fake = fakeAppend((seq) => (seq % 2 === 0 ? 12 : 1)); // later chunks answer faster
    const failures: UploadFailure[] = [];
    const uploader = new ChunkUploader({
      sessionId: 'sess',
      append: fake.append,
      onFatal: (failure) => failures.push(failure),
    });
    for (let i = 0; i < 8; i += 1) uploader.push(blob(10 + i, i));
    await uploader.flush();
    expect(fake.calls.map((call) => call.seq)).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
    expect(fake.calls.map((call) => call.size)).toEqual([10, 11, 12, 13, 14, 15, 16, 17]);
    expect(fake.calls.every((call) => call.sessionId === 'sess')).toBe(true);
    expect(fake.maxInFlight()).toBe(1);
    expect(uploader.lastSeq).toBe(7);
    expect(uploader.ackedSeq).toBe(7);
    expect(uploader.pending).toEqual({ chunks: 0, bytes: 0 });
    expect(failures).toEqual([]);
  });

  it('does not send the next chunk before the previous one is acknowledged', async () => {
    const held = heldAppend();
    const uploader = new ChunkUploader({
      sessionId: 's',
      append: held.append,
      onFatal: () => undefined,
    });
    uploader.push(blob(5));
    uploader.push(blob(6));
    uploader.push(blob(7));
    await wait(15);
    expect(held.calls.map((call) => call.seq)).toEqual([0]);
    expect(uploader.ackedSeq).toBe(-1);
    held.release(0);
    await wait(15);
    expect(held.calls.map((call) => call.seq)).toEqual([0, 1]);
    held.release(1);
    await wait(15);
    held.release(2);
    await uploader.flush();
    expect(held.calls.map((call) => call.seq)).toEqual([0, 1, 2]);
    expect(uploader.ackedSeq).toBe(2);
  });

  it('flush on an idle uploader resolves at once, and waits for pending acks otherwise', async () => {
    const held = heldAppend();
    const uploader = new ChunkUploader({
      sessionId: 's',
      append: held.append,
      onFatal: () => undefined,
    });
    await uploader.flush();
    uploader.push(blob(4));
    let flushed = false;
    void uploader.flush().then(() => {
      flushed = true;
    });
    await wait(15);
    expect(flushed).toBe(false);
    held.release(0);
    await wait(15);
    expect(flushed).toBe(true);
  });

  it('ignores empty blobs (they carry nothing and would waste a sequence number)', async () => {
    const fake = fakeAppend();
    const uploader = new ChunkUploader({
      sessionId: 's',
      append: fake.append,
      onFatal: () => undefined,
    });
    uploader.push(new Blob([]));
    uploader.push(blob(3));
    await uploader.flush();
    expect(fake.calls.map((call) => call.seq)).toEqual([0]);
    expect(uploader.chunkCount).toBe(1);
  });

  it('accepts a duplicate acknowledgement as success', async () => {
    const uploader = new ChunkUploader({
      sessionId: 's',
      append: () => Promise.resolve({ ok: true, data: { duplicate: true, lastSeq: 0 } }),
      onFatal: () => {
        throw new Error('should not fail');
      },
    });
    uploader.push(blob(2));
    await uploader.flush();
    expect(uploader.ackedSeq).toBe(0);
  });
});

describe('ChunkUploader: bounded queue', () => {
  it('stops with QUEUE_OVERFLOW when more than the allowed chunks are pending, and keeps the accepted ones', async () => {
    const held = heldAppend();
    const failures: UploadFailure[] = [];
    const uploader = new ChunkUploader({
      sessionId: 's',
      append: held.append,
      maxChunks: 3,
      onFatal: (failure) => failures.push(failure),
    });
    for (let i = 0; i < 3; i += 1) uploader.push(blob(10));
    expect(failures).toEqual([]);
    expect(uploader.pending.chunks).toBe(3);
    uploader.push(blob(10)); // the fourth does not fit
    expect(failures).toHaveLength(1);
    expect(failures[0]?.code).toBe('QUEUE_OVERFLOW');
    expect(uploader.pending.chunks).toBe(3); // never grows past the bound
    expect(uploader.lastSeq).toBe(2);
    uploader.push(blob(10)); // after the overflow nothing is accepted and nothing is reported twice
    expect(uploader.lastSeq).toBe(2);
    expect(failures).toHaveLength(1);

    // The three accepted chunks are still delivered, in order.
    await wait(10);
    held.release(0);
    await wait(10);
    held.release(1);
    await wait(10);
    held.release(2);
    await uploader.flush();
    expect(held.calls.map((call) => call.seq)).toEqual([0, 1, 2]);
    expect(uploader.ackedSeq).toBe(2);
  });

  it('stops with QUEUE_OVERFLOW when the pending bytes exceed the limit', () => {
    const held = heldAppend();
    const failures: UploadFailure[] = [];
    const uploader = new ChunkUploader({
      sessionId: 's',
      append: held.append,
      maxBytes: 100,
      onFatal: (failure) => failures.push(failure),
    });
    uploader.push(blob(60));
    uploader.push(blob(40)); // exactly 100: fits
    expect(failures).toEqual([]);
    uploader.push(blob(1));
    expect(failures.map((failure) => failure.code)).toEqual(['QUEUE_OVERFLOW']);
    expect(uploader.pending.bytes).toBe(100);
  });

  it('frees space as acknowledgements arrive', async () => {
    const fake = fakeAppend(() => 2);
    const failures: UploadFailure[] = [];
    const uploader = new ChunkUploader({
      sessionId: 's',
      append: fake.append,
      maxChunks: 2,
      onFatal: (failure) => failures.push(failure),
    });
    for (let i = 0; i < 10; i += 1) {
      uploader.push(blob(8));
      await wait(10); // slower than the sink would be: the queue never fills
    }
    await uploader.flush();
    expect(failures).toEqual([]);
    expect(fake.calls).toHaveLength(10);
  });

  it('uses the shared defaults of 16 chunks', () => {
    const held = heldAppend();
    const failures: UploadFailure[] = [];
    const uploader = new ChunkUploader({
      sessionId: 's',
      append: held.append,
      onFatal: (failure) => failures.push(failure),
    });
    for (let i = 0; i < 16; i += 1) uploader.push(blob(1));
    expect(failures).toEqual([]);
    uploader.push(blob(1));
    expect(failures[0]?.code).toBe('QUEUE_OVERFLOW');
  });
});

describe('ChunkUploader: failures', () => {
  it('a rejected write stops everything: reported once, nothing more is sent', async () => {
    const calls: number[] = [];
    const failures: UploadFailure[] = [];
    const uploader = new ChunkUploader({
      sessionId: 's',
      append: (request) => {
        calls.push(request.seq);
        return Promise.resolve(
          request.seq === 1 ? { ok: false, error: { code: 'DISK_FULL', message: 'full' } } : OK,
        );
      },
      onFatal: (failure) => failures.push(failure),
    });
    for (let i = 0; i < 5; i += 1) uploader.push(blob(4));
    await uploader.flush();
    expect(calls).toEqual([0, 1]);
    expect(failures).toEqual([{ code: 'DISK_FULL', message: 'full' }]);
    expect(uploader.failed?.code).toBe('DISK_FULL');
    expect(uploader.ackedSeq).toBe(0);
    uploader.push(blob(4));
    await uploader.flush();
    expect(calls).toEqual([0, 1]);
    expect(failures).toHaveLength(1);
  });

  it('a throwing invoke is reported as UPLOAD_FAILED', async () => {
    const failures: UploadFailure[] = [];
    const uploader = new ChunkUploader({
      sessionId: 's',
      append: () => Promise.reject(new Error('channel closed')),
      onFatal: (failure) => failures.push(failure),
    });
    uploader.push(blob(4));
    await uploader.flush();
    expect(failures).toEqual([{ code: 'UPLOAD_FAILED', message: 'channel closed' }]);
  });

  it('a sequence error from main is fatal as well', async () => {
    const failures: UploadFailure[] = [];
    const uploader = new ChunkUploader({
      sessionId: 's',
      append: () => Promise.resolve({ ok: false, error: { code: 'SEQ_GAP', message: 'gap' } }),
      onFatal: (failure) => failures.push(failure),
    });
    uploader.push(blob(4));
    await uploader.flush();
    expect(failures[0]?.code).toBe('SEQ_GAP');
  });
});
