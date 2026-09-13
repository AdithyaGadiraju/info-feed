import { NextResponse, type NextRequest } from 'next/server';

/**
 * HTTP basic auth for the whole app (ADR 0004 deliberately rejected real auth:
 * one user, and TLS at the reverse proxy is the entire threat model).
 *
 * Edge runtime: Web APIs only, no `node:` imports.
 */

const REALM = 'info-feed';

function unauthorized(): NextResponse {
  return new NextResponse('Unauthorized', {
    status: 401,
    headers: {
      'WWW-Authenticate': `Basic realm="${REALM}", charset="UTF-8"`,
      // A 401 must never be cached by the proxy in front of us.
      'Cache-Control': 'no-store',
    },
  });
}

async function sha256(s: string): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s)));
}

/**
 * Compares digests rather than the strings themselves. That makes the loop a
 * fixed 32 bytes with no early exit, so neither the length of the secret nor the
 * position of the first wrong character shows up in the response time.
 */
async function matches(given: string, expected: string): Promise<boolean> {
  const [a, b] = await Promise.all([sha256(given), sha256(expected)]);
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a[i] ^ b[i];
  return diff === 0;
}

export async function middleware(req: NextRequest): Promise<NextResponse> {
  const user = process.env.FEED_USER;
  const pass = process.env.FEED_PASS;
  // Fail closed: an unconfigured lock on a shared box is an open door.
  if (!user || !pass) return unauthorized();

  const header = req.headers.get('authorization');
  if (!header || !header.toLowerCase().startsWith('basic ')) return unauthorized();

  let decoded: string;
  try {
    decoded = atob(header.slice('basic '.length).trim());
  } catch {
    return unauthorized();
  }

  const sep = decoded.indexOf(':');
  if (sep < 0) return unauthorized();

  // Both halves are always compared; `&&` would short-circuit and turn a correct
  // username into a measurably slower reject than a wrong one.
  const [okUser, okPass] = await Promise.all([
    matches(decoded.slice(0, sep), user),
    matches(decoded.slice(sep + 1), pass),
  ]);
  if (!okUser || !okPass) return unauthorized();

  return NextResponse.next();
}

export const config = {
  // Everything is behind the lock, including /api. Only Next's own immutable
  // build assets are exempt, and they carry no feed content.
  matcher: ['/((?!_next/static|_next/image).*)'],
};
