/**
 * Live-network tests per ADR 0002 (source tests hit real endpoints; no mocks).
 */
import { describe, expect, it } from 'vitest';
import { fetchBody, fetchBodies, MAX_BODY_CHARS } from '../lib/fetchBody.js';

// Wikipedia articles are stable, semantically marked-up, and extraction-friendly —
// far less likely to rot than a random blog post.
const GOOD_URL = 'https://en.wikipedia.org/wiki/Alan_Turing';
const UNREACHABLE_URL = 'https://this-host-does-not-exist.invalid/x';
const JSON_URL = 'https://jsonplaceholder.typicode.com/todos/1';

describe('fetchBody', () => {
  it('extracts readable text from a stable article URL', async () => {
    const body = await fetchBody(GOOD_URL);
    expect(body).not.toBeNull();
    expect((body as string).length).toBeGreaterThan(200);
  });

  it('returns null for an unreachable host without throwing', async () => {
    await expect(fetchBody(UNREACHABLE_URL)).resolves.toBeNull();
  });

  it('returns null for a non-HTML content type', async () => {
    const body = await fetchBody(JSON_URL);
    expect(body).toBeNull();
  });

  it('never exceeds MAX_BODY_CHARS', async () => {
    const body = await fetchBody(GOOD_URL);
    expect(body).not.toBeNull();
    expect((body as string).length).toBeLessThanOrEqual(MAX_BODY_CHARS);
  });

  it('fetchBodies resolves with a key for every input and at least one success', async () => {
    const urls = [GOOD_URL, UNREACHABLE_URL, JSON_URL];
    const results = await fetchBodies(urls);

    expect(results.size).toBe(urls.length);
    for (const url of urls) {
      expect(results.has(url)).toBe(true);
    }
    expect([...results.values()].some((body) => body !== null)).toBe(true);
  });
});
