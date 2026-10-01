import { afterEach, describe, expect, it, vi } from 'vitest';
import { writeWithConnectRetry } from '../../lib/enrich/run';

function pgError(code: string): Error {
  return Object.assign(new Error(`write ${code} pooler.example:6543`), { code });
}

describe('writeWithConnectRetry', () => {
  afterEach(() => vi.restoreAllMocks());

  it('retries a write whose connection was never opened', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const write = vi
      .fn<() => Promise<string>>()
      .mockRejectedValueOnce(pgError('CONNECT_TIMEOUT'))
      .mockResolvedValueOnce('written');

    await expect(writeWithConnectRetry('betting', write)).resolves.toBe('written');
    expect(write).toHaveBeenCalledTimes(2);
  });

  it('gives up after three failed connects', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const write = vi.fn<() => Promise<string>>().mockRejectedValue(pgError('CONNECT_TIMEOUT'));

    await expect(writeWithConnectRetry('betting', write)).rejects.toThrow('CONNECT_TIMEOUT');
    expect(write).toHaveBeenCalledTimes(3);
  });

  it('never retries an error that may have landed after the commit', async () => {
    const write = vi.fn<() => Promise<string>>().mockRejectedValue(pgError('CONNECTION_CLOSED'));

    await expect(writeWithConnectRetry('betting', write)).rejects.toThrow('CONNECTION_CLOSED');
    expect(write).toHaveBeenCalledTimes(1);
  });
});
