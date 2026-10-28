import { NextResponse, type NextRequest } from 'next/server';
// Relative rather than `@/`: vitest resolves no tsconfig `paths` alias (see app/api/feed/route.ts).
import { setStoryDone } from '../../../../../lib/db/queries';

// `postgres` is a node driver, and a write is never cacheable.
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function badRequest(error: string): NextResponse {
  return NextResponse.json({ error }, { status: 400 });
}

/**
 * The Done button's one write: `PUT /api/story/:id/done` with `{ "done": true }`
 * or `{ "done": false }`. PUT because the body is the whole state and the call is
 * idempotent (`setStoryDone`). Basic auth in middleware.ts covers it like every
 * other route, which is the entire access control (ADR 0004: one reader).
 */
export async function PUT(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const { id: raw } = await params;
  // Reject anything that is not a plain positive integer before touching the db.
  if (!/^\d+$/.test(raw)) return badRequest('id must be a positive integer');
  const id = Number.parseInt(raw, 10);
  if (!Number.isSafeInteger(id) || id <= 0) return badRequest('id must be a positive integer');

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return badRequest('body must be JSON');
  }
  if (typeof body !== 'object' || body === null || typeof (body as { done?: unknown }).done !== 'boolean') {
    return badRequest('body must be {"done": true | false}');
  }
  const { done } = body as { done: boolean };

  let result;
  try {
    result = await setStoryDone(id, done);
  } catch (err) {
    // The real error goes to the server log, never into a response body.
    console.error(`[api/story/${id}/done] setStoryDone:`, err);
    return NextResponse.json({ error: 'internal error' }, { status: 500 });
  }
  if (!result) return NextResponse.json({ error: 'not found' }, { status: 404 });
  return NextResponse.json({ id, doneAt: result.doneAt }, { headers: { 'Cache-Control': 'no-store' } });
}
