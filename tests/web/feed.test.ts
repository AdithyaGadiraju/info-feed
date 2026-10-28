import 'dotenv/config';
import { afterAll, describe, expect, it } from 'vitest';
import { NextRequest } from 'next/server';
// Relative imports throughout: vitest.config.ts registers no `@/` alias.
import { middleware } from '../../middleware';
import { GET } from '../../app/api/feed/route';
import { PUT as putDone } from '../../app/api/story/[id]/done/route';
import { closeDb, db } from '../../lib/db/client';
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

  it('authenticates a non-ASCII password base64-encoded as UTF-8, the way a browser does it', async () => {
    // `atob` alone decodes to Latin-1 bytes: "pässwörd" would come back as
    // "pÃ¤sswÃ¶rd" and never match. FEED_USER/FEED_PASS are swapped out for the
    // duration of this test so it exercises the real comparison path.
    const prevUser = process.env.FEED_USER;
    const prevPass = process.env.FEED_PASS;
    process.env.FEED_USER = 'someone';
    process.env.FEED_PASS = 'pässwörd';
    try {
      const res = await middleware(request('/api/feed', { authorization: basic('someone', 'pässwörd') }));
      expect(res.status).toBe(200);
      expect(res.headers.get('x-middleware-next')).toBe('1');
    } finally {
      process.env.FEED_USER = prevUser;
      process.env.FEED_PASS = prevPass;
    }
  });
});

describe('GET /api/feed parameter validation', () => {
  it('rejects an unknown lane before it can reach the database', async () => {
    const res = await GET(request('/api/feed?lanes=ai,wrestling'));
    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toMatchObject({ error: expect.stringContaining('wrestling') });
  });

  it('rejects a malformed cursor with a 400 rather than blowing up on the timestamptz cast', async () => {
    for (const cursor of [
      'not-base64!!',
      btoa('{'),
      btoa('{"updatedAt":"nope","id":1}'),
      btoa('{"id":"x"}'),
      // `Date.parse` accepts both of these, but `::timestamptz` in Postgres does
      // not — this is exactly the gap that let a crafted cursor reach the
      // database and blow up into a 500 instead of a 400.
      btoa(JSON.stringify({ updatedAt: '5', id: 1 })),
      btoa(JSON.stringify({ updatedAt: '2020', id: 1 })),
    ]) {
      const res = await GET(request(`/api/feed?cursor=${encodeURIComponent(cursor)}`));
      expect(res.status, `cursor=${cursor}`).toBe(400);
    }
  });

  it.skipIf(!hasDb)('accepts a well-formed cursor in the format lib/db/queries.ts actually produces', async () => {
    const first = await getFeedPage({ minScore: 1, limit: 1 });
    if (!first.nextCursor) {
      // Empty stories table (or a single row): nothing to build a real cursor from.
      return;
    }
    const cursor = btoa(JSON.stringify(first.nextCursor));
    const res = await GET(request(`/api/feed?cursor=${encodeURIComponent(cursor)}&minScore=1&limit=1`));
    expect(res.status).toBe(200);
  });

  it('rejects a non-numeric storyId', async () => {
    const res = await GET(request('/api/feed?storyId=abc'));
    expect(res.status).toBe(400);
  });

  it('rejects a day that is not YYYY-MM-DD, or a window that ends before it starts', async () => {
    for (const qs of ['from=yesterday', 'to=2026-02-30', 'from=2026-10-29T00:00:00Z', 'from=2026-10-29&to=2026-10-01']) {
      const res = await GET(request(`/api/feed?${qs}`));
      expect(res.status, qs).toBe(400);
    }
  });

  it.skipIf(!hasDb)('accepts an empty day, a one-day window and a search together', async () => {
    const res = await GET(request('/api/feed?from=&to=2026-10-29&q=godot%20%25&done=1&minScore=1'));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { stories: unknown[] };
    expect(Array.isArray(body.stories)).toBe(true);
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

function putRequest(id: string, body: unknown): [NextRequest, { params: Promise<{ id: string }> }] {
  const init = body === undefined ? { method: 'PUT' } : { method: 'PUT', body: JSON.stringify(body) };
  return [
    new NextRequest(new URL(`/api/story/${id}/done`, 'http://localhost:3000'), init),
    { params: Promise.resolve({ id }) },
  ];
}

describe('PUT /api/story/:id/done validation', () => {
  it('rejects an id that is not a positive integer before touching the database', async () => {
    for (const id of ['abc', '-1', '0', '1.5', '']) {
      const res = await putDone(...putRequest(id, { done: true }));
      expect(res.status, `id=${id}`).toBe(400);
    }
  });

  it('rejects a body that is not {"done": boolean}', async () => {
    expect((await putDone(...putRequest('1', undefined))).status).toBe(400);
    expect((await putDone(...putRequest('1', { done: 'yes' }))).status).toBe(400);
    expect((await putDone(...putRequest('1', {}))).status).toBe(400);
    expect((await putDone(...putRequest('1', 'done'))).status).toBe(400);
  });
});

describe.skipIf(!hasDb)('marking a story done moves it between the two sides of the feed', () => {
  const TITLE = '__test_feed__ done story';
  let storyId = 0;

  async function cleanup() {
    await db()`DELETE FROM stories WHERE title = ${TITLE}`;
  }

  async function ids(qs: string): Promise<number[]> {
    const res = await GET(request(`/api/feed?${qs}`));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { stories: Array<{ id: number }> };
    return body.stories.map((s) => s.id);
  }

  it('starts on the to-read side, leaves it when done, and comes back on undo', async () => {
    await cleanup();
    const [row] = await db()`
      INSERT INTO stories (lane, title, summary_short, score)
      VALUES ('ai', ${TITLE}, 'to be read', 5) RETURNING id::int AS id`;
    storyId = Number(row.id);
    try {
      // Freshly written, so it sorts first on either side at score 5.
      expect(await ids('lanes=ai&minScore=5&limit=5')).toContain(storyId);
      expect(await ids('lanes=ai&minScore=5&limit=5&done=1')).not.toContain(storyId);

      const done = await putDone(...putRequest(String(storyId), { done: true }));
      expect(done.status).toBe(200);
      const doneBody = (await done.json()) as { id: number; doneAt: string | null };
      expect(doneBody.id).toBe(storyId);
      expect(doneBody.doneAt).toBeTruthy();

      expect(await ids('lanes=ai&minScore=5&limit=5')).not.toContain(storyId);
      expect(await ids('lanes=ai&minScore=5&limit=5&done=1')).toContain(storyId);

      // Marking it done again is a no-op that keeps the first timestamp.
      const again = await putDone(...putRequest(String(storyId), { done: true }));
      expect(((await again.json()) as { doneAt: string }).doneAt).toBe(doneBody.doneAt);

      const undo = await putDone(...putRequest(String(storyId), { done: false }));
      expect(undo.status).toBe(200);
      expect(((await undo.json()) as { doneAt: string | null }).doneAt).toBeNull();
      expect(await ids('lanes=ai&minScore=5&limit=5')).toContain(storyId);
    } finally {
      await cleanup();
    }
  });

  it('404s on a story that does not exist', async () => {
    const res = await putDone(...putRequest('2147483647', { done: true }));
    expect(res.status).toBe(404);
  });
});
