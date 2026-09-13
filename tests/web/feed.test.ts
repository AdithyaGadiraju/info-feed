import 'dotenv/config';
import { afterAll, describe, expect, it } from 'vitest';
import { NextRequest } from 'next/server';
// Relative imports throughout: vitest.config.ts registers no `@/` alias.
import { middleware } from '../../middleware';
import { GET } from '../../app/api/feed/route';
import { closeDb } from '../../lib/db/client';
import { getFeedPage } from '../../lib/db/queries';

const USER = process.env.FEED_USER;
const PASS = process.env.FEED_PASS;
const hasCreds = Boolean(USER && PASS);
const hasDb = Boolean(process.env.DATABASE_URL);

function basic(user: string, pass: string): string {
  return `Basic ${Buffer.from(`${user}:${pass}`, 'utf8').toString('base64')}`;
}

function request(path: string, headers: Record<string, string> = {}): NextRequest {
  return new NextRequest(new URL(path, 'http://localhost:3000'), { headers });
}

afterAll(async () => {
  await closeDb();
});

describe('middleware basic auth', () => {
  it('401s with a WWW-Authenticate challenge when no header is sent', async () => {
    const res = await middleware(request('/'));
    expect(res.status).toBe(401);
    expect(res.headers.get('www-authenticate')).toMatch(/^Basic realm="info-feed"/);
  });

  it('401s on a malformed Authorization header', async () => {
    const res = await middleware(request('/', { authorization: 'Bearer abc' }));
    expect(res.status).toBe(401);

    const notBase64 = await middleware(request('/', { authorization: 'Basic ***' }));
    expect(notBase64.status).toBe(401);

    const noColon = await middleware(
      request('/', { authorization: `Basic ${Buffer.from('nocolon').toString('base64')}` }),
    );
    expect(noColon.status).toBe(401);
  });

  it.skipIf(!hasCreds)('401s on a wrong password', async () => {
    const res = await middleware(request('/', { authorization: basic(USER!, `${PASS!}x`) }));
    expect(res.status).toBe(401);
    expect(res.headers.get('www-authenticate')).toBeTruthy();
  });

  it.skipIf(!hasCreds)('401s on a wrong user', async () => {
    const res = await middleware(request('/', { authorization: basic(`${USER!}x`, PASS!) }));
    expect(res.status).toBe(401);
  });

  it.skipIf(!hasCreds)('passes the correct FEED_USER / FEED_PASS through', async () => {
    const res = await middleware(request('/api/feed', { authorization: basic(USER!, PASS!) }));
    expect(res.status).toBe(200);
    expect(res.headers.get('www-authenticate')).toBeNull();
    // NextResponse.next() marks the request as handed on to the route.
    expect(res.headers.get('x-middleware-next')).toBe('1');
  });
});

describe('GET /api/feed parameter validation', () => {
  it('rejects an unknown lane before it can reach the database', async () => {
    const res = await GET(request('/api/feed?lanes=ai,wrestling'));
    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toMatchObject({ error: expect.stringContaining('wrestling') });
  });

  it('rejects a malformed cursor with a 400 rather than blowing up on the timestamptz cast', async () => {
    for (const cursor of ['not-base64!!', btoa('{'), btoa('{"updatedAt":"nope","id":1}'), btoa('{"id":"x"}')]) {
      const res = await GET(request(`/api/feed?cursor=${encodeURIComponent(cursor)}`));
      expect(res.status, `cursor=${cursor}`).toBe(400);
    }
  });

  it('rejects a non-numeric storyId', async () => {
    const res = await GET(request('/api/feed?storyId=abc'));
    expect(res.status).toBe(400);
  });

  it.skipIf(!hasDb)('clamps minScore and limit into range instead of trusting them', async () => {
    const high = await GET(request('/api/feed?minScore=99&limit=99999'));
    expect(high.status).toBe(200);
    const body = (await high.json()) as { stories: unknown[] };
    // minScore clamps to 5, limit to 100, so a sane page comes back rather than an error.
    expect(Array.isArray(body.stories)).toBe(true);
    expect(body.stories.length).toBeLessThanOrEqual(100);

    const low = await GET(request('/api/feed?minScore=-4&limit=0'));
    expect(low.status).toBe(200);
    const lowBody = (await low.json()) as { stories: unknown[] };
    expect(lowBody.stories.length).toBeLessThanOrEqual(1);

    const junk = await GET(request('/api/feed?minScore=abc&limit=abc'));
    expect(junk.status).toBe(200);
  });
});

describe.skipIf(!hasDb)('keyset pagination against the live database', () => {
  it('never repeats a story id across two single-row pages', async () => {
    const first = await getFeedPage({ minScore: 1, limit: 1 });
    if (first.stories.length === 0) {
      // Sibling agents may not have populated stories yet; an empty table is not a failure.
      expect(first.nextCursor).toBeNull();
      return;
    }
    if (!first.nextCursor) return;

    const second = await getFeedPage({ minScore: 1, limit: 1, cursor: first.nextCursor });
    const ids = [...first.stories, ...second.stories].map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});
