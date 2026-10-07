import fs from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { renameWithRetry } from '../../src/main/recording/session-fs';

const errno = (code: string): NodeJS.ErrnoException => Object.assign(new Error(code), { code });

afterEach(() => {
  vi.restoreAllMocks();
});

describe('renameWithRetry', () => {
  it('retries the transient Windows lock errors until the rename works', async () => {
    const rename = vi
      .spyOn(fs.promises, 'rename')
      .mockRejectedValueOnce(errno('EPERM'))
      .mockRejectedValueOnce(errno('EBUSY'))
      .mockResolvedValueOnce(undefined);
    await renameWithRetry('a', 'b');
    expect(rename).toHaveBeenCalledTimes(3);
  });

  it('does not retry other errors', async () => {
    const rename = vi.spyOn(fs.promises, 'rename').mockRejectedValue(errno('ENOENT'));
    await expect(renameWithRetry('a', 'b')).rejects.toMatchObject({ code: 'ENOENT' });
    expect(rename).toHaveBeenCalledTimes(1);
  });

  it('gives up on a lock that does not clear and throws the error', async () => {
    const rename = vi.spyOn(fs.promises, 'rename').mockRejectedValue(errno('EPERM'));
    await expect(renameWithRetry('a', 'b')).rejects.toMatchObject({ code: 'EPERM' });
    expect(rename).toHaveBeenCalledTimes(6);
  });
});
