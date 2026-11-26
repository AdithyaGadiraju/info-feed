/**
 * Best-effort article body extraction for link items with no body (ADR 0002).
 * A failed fetch/parse must never block or fail an ingest run, so every error
 * path here resolves to null instead of throwing.
 */
import { lookup as dnsLookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { parseHTML } from 'linkedom';
import { Readability } from '@mozilla/readability';

const USER_AGENT = 'info-feed/1.0 (personal news digest)';
// Bounds memory per fetch. Bigger pages are truncated to this prefix, not rejected:
// we keep only MAX_BODY_CHARS of text, and article content starts near the top.
export const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
// Below this a Readability/fallback extraction is more likely noise (nav/boilerplate) than content.
const MIN_EXTRACTED_CHARS = 200;

export const MAX_BODY_CHARS = 2000;

function warn(url: string, reason: string): void {
  let host = url;
  try {
    host = new URL(url).host;
  } catch {
    // url itself was unparsable; fall through with the raw string
  }
  console.warn(`fetchBody: ${host} — ${reason}`);
}

function collapseWhitespace(text: string): string {
  return text
    .replace(/[ \t\f\v]+/g, ' ')
    .replace(/\n\s*\n+/g, '\n')
    .replace(/ *\n */g, '\n')
    .trim();
}

function capAtWordBoundary(text: string, max: number): string {
  if (text.length <= max) return text;
  const slice = text.slice(0, max);
  const lastSpace = slice.lastIndexOf(' ');
  // Only back off to the word boundary if it doesn't throw away most of the cap.
  const cut = lastSpace > max * 0.5 ? lastSpace : max;
  return slice.slice(0, cut).trim();
}

/**
 * Reads at most MAX_RESPONSE_BYTES of the body. An oversized page is truncated,
 * not rejected: we keep only MAX_BODY_CHARS of text, article content is normally
 * near the top, and linkedom parses a truncated HTML prefix fine.
 */
async function readBoundedText(response: Response): Promise<string> {
  // No early reject on a large content-length: an oversized page still has a
  // usable prefix, and the stream cap below bounds memory either way.
  if (!response.body) return (await response.text()).slice(0, MAX_RESPONSE_BYTES);

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    const room = MAX_RESPONSE_BYTES - total;
    if (value.byteLength > room) {
      chunks.push(value.subarray(0, room));
      total += room;
      // Stop downloading the rest; a cancel failure doesn't matter, we have our prefix.
      await reader.cancel().catch(() => {});
      break;
    }
    chunks.push(value);
    total += value.byteLength;
  }
  // Non-fatal decoding turns a multi-byte char split at the cut into U+FFFD
  // instead of throwing.
  return new TextDecoder('utf-8').decode(concatChunks(chunks, total));
}

function concatChunks(chunks: Uint8Array[], total: number): Uint8Array {
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

const HEAD_TAGS = new Set(['META', 'TITLE', 'LINK', 'BASE']);

/**
 * Minified pages often omit the optional <head>/<body> tags. Browsers imply them,
 * but linkedom leaves every element loose under <html> next to an empty <body>,
 * which gives the fallback nothing to read and makes Readability throw
 * ("Cannot read properties of null (reading 'tagName')"). Re-home the strays.
 */
function repairImpliedBody(document: Document): void {
  const root = document.documentElement;
  const { head, body } = document;
  if (!root || !head || !body || body.childNodes.length > 0) return;
  for (const node of Array.from(root.childNodes)) {
    if (node === head || node === body) continue;
    const el = node as Element;
    (el.tagName && HEAD_TAGS.has(el.tagName.toUpperCase()) ? head : body).appendChild(node);
  }
}

// Navigation and tables of contents. Readability doesn't treat a TOC as unlikely
// content, so on docs pages (e.g. a changelog) its top candidate starts with the
// TOC's run of anchor labels and the real text never makes the MAX_BODY_CHARS cut.
const NAVIGATION_SELECTOR = 'nav, [role="navigation"], .toc, #toc, [id^="table-of-contents"]';

function stripNavigation(document: Document): void {
  for (const el of Array.from(document.querySelectorAll(NAVIGATION_SELECTOR))) {
    el.remove();
  }
}

function fallbackTextContent(document: Document): string | null {
  for (const tag of ['script', 'style']) {
    for (const el of Array.from(document.querySelectorAll(tag))) {
      el.remove();
    }
  }
  const text = collapseWhitespace(document.body?.textContent ?? '');
  return text.length >= MIN_EXTRACTED_CHARS ? text : null;
}

// ---- SSRF guard ----
// Item URLs come from third-party feeds, so a link (or a redirect it answers with)
// must not reach the worker's own network: loopback, private ranges, cloud
// metadata (169.254.169.254) and the like. Redirects are followed by hand so each
// hop is checked before it is fetched.

export const MAX_REDIRECTS = 5;

export type LookupAll = (hostname: string) => Promise<Array<{ address: string; family: number }>>;

const defaultLookup: LookupAll = (hostname) => dnsLookup(hostname, { all: true });

export interface FetchBodyOptions {
  /** DNS resolver, injectable for tests. */
  lookup?: LookupAll;
  /** Skips the address check; only for tests that serve pages from 127.0.0.1. */
  allowPrivateHosts?: boolean;
}

function parseIpv4(s: string): number[] | null {
  const parts = s.split('.');
  if (parts.length !== 4) return null;
  const octets = parts.map((p) => (/^\d{1,3}$/.test(p) ? Number(p) : NaN));
  return octets.every((o) => o >= 0 && o <= 255) ? octets : null;
}

function ipv4Blocked([a, b, c]: number[]): boolean {
  return (
    a === 0 || // 0.0.0.0/8 "this network"
    a === 10 || // 10/8 private
    a === 127 || // 127/8 loopback
    (a === 100 && b >= 64 && b <= 127) || // 100.64/10 CGNAT
    (a === 169 && b === 254) || // 169.254/16 link-local, cloud metadata
    (a === 172 && b >= 16 && b <= 31) || // 172.16/12 private
    (a === 192 && b === 168) || // 192.168/16 private
    (a === 192 && b === 0 && (c === 0 || c === 2)) || // 192.0.0/24 IETF, 192.0.2/24 TEST-NET-1
    (a === 198 && (b === 18 || b === 19)) || // 198.18/15 benchmarking
    (a === 198 && b === 51 && c === 100) || // TEST-NET-2
    (a === 203 && b === 0 && c === 113) || // TEST-NET-3
    a >= 224 // 224/4 multicast, 240/4 reserved, broadcast
  );
}

/** Eight 16-bit groups, or null. Accepts `::` and a dotted IPv4 tail. */
function parseIpv6(s: string): number[] | null {
  let text = s.toLowerCase();
  const zone = text.indexOf('%');
  if (zone >= 0) text = text.slice(0, zone);
  const lastColon = text.lastIndexOf(':');
  if (lastColon < 0) return null;
  const tail = text.slice(lastColon + 1);
  if (tail.includes('.')) {
    // ::ffff:127.0.0.1 -> ::ffff:7f00:1
    const v4 = parseIpv4(tail);
    if (!v4) return null;
    const hex = (hi: number, lo: number) => ((hi << 8) | lo).toString(16);
    text = `${text.slice(0, lastColon + 1)}${hex(v4[0], v4[1])}:${hex(v4[2], v4[3])}`;
  }
  const halves = text.split('::');
  if (halves.length > 2) return null;
  const parse = (h: string) =>
    h === '' ? [] : h.split(':').map((g) => (/^[0-9a-f]{1,4}$/.test(g) ? parseInt(g, 16) : NaN));
  const head = parse(halves[0]);
  let groups = head;
  if (halves.length === 2) {
    const rest = parse(halves[1]);
    const fill = 8 - head.length - rest.length;
    if (fill < 1) return null;
    groups = [...head, ...Array<number>(fill).fill(0), ...rest];
  }
  return groups.length === 8 && groups.every((g) => !Number.isNaN(g)) ? groups : null;
}

/**
 * True when an IP address is one a fetch of a public article must never reach.
 * Anything that does not parse as an IP is blocked too, so the check fails closed.
 */
export function isBlockedAddress(ip: string): boolean {
  const host = ip.startsWith('[') && ip.endsWith(']') ? ip.slice(1, -1) : ip;
  const v4 = parseIpv4(host);
  if (v4) return ipv4Blocked(v4);
  const g = parseIpv6(host);
  if (!g) return true;
  const embeddedV4 = [g[6] >> 8, g[6] & 0xff, g[7] >> 8, g[7] & 0xff];
  const zeroTo = (n: number) => g.slice(0, n).every((x) => x === 0);
  if (zeroTo(5) && g[5] === 0xffff) return ipv4Blocked(embeddedV4); // ::ffff:a.b.c.d mapped
  if (zeroTo(6)) return true; // ::, ::1 and the old IPv4-compatible ::a.b.c.d
  if (g[0] === 0x64 && g[1] === 0xff9b && g[2] === 0 && g[3] === 0 && g[4] === 0 && g[5] === 0) {
    return ipv4Blocked(embeddedV4); // 64:ff9b::/96 NAT64
  }
  return (
    (g[0] & 0xffc0) === 0xfe80 || // fe80::/10 link-local
    (g[0] & 0xfe00) === 0xfc00 || // fc00::/7 unique-local
    (g[0] & 0xff00) === 0xff00 || // ff00::/8 multicast
    (g[0] === 0x2001 && g[1] === 0x0db8) || // 2001:db8::/32 documentation
    (g[0] === 0x0100 && g[1] === 0 && g[2] === 0 && g[3] === 0) // 100::/64 discard
  );
}

/** Throws when a URL is not http(s) or its host is, or resolves to, a blocked address. */
async function assertFetchable(target: URL, opts: FetchBodyOptions): Promise<void> {
  if (target.protocol !== 'http:' && target.protocol !== 'https:') {
    throw new Error(`refused scheme ${target.protocol}`);
  }
  if (opts.allowPrivateHosts) return;
  const host = target.hostname.replace(/^\[|\]$/g, '');
  if (isIP(host)) {
    if (isBlockedAddress(host)) throw new Error(`refused private address ${host}`);
    return;
  }
  const addresses = await (opts.lookup ?? defaultLookup)(host);
  if (addresses.length === 0) throw new Error(`no address for ${host}`);
  const bad = addresses.find((a) => isBlockedAddress(a.address));
  if (bad) throw new Error(`refused private address ${bad.address} for ${host}`);
}

/** Fetches with redirects followed by hand, each hop checked by assertFetchable. */
async function guardedFetch(url: string, signal: AbortSignal, opts: FetchBodyOptions): Promise<Response> {
  let target = new URL(url);
  for (let hop = 0; ; hop += 1) {
    await assertFetchable(target, opts);
    const response = await fetch(target, {
      redirect: 'manual',
      signal,
      headers: { 'User-Agent': USER_AGENT },
    });
    const location = response.headers.get('location');
    if (response.status < 300 || response.status >= 400 || location === null) return response;
    await response.body?.cancel().catch(() => {});
    if (hop >= MAX_REDIRECTS) throw new Error(`more than ${MAX_REDIRECTS} redirects`);
    target = new URL(location, target);
  }
}

export async function fetchBody(
  url: string,
  timeoutMs = 8000,
  opts: FetchBodyOptions = {},
): Promise<string | null> {
  try {
    const response = await guardedFetch(url, AbortSignal.timeout(timeoutMs), opts);

    if (!response.ok) {
      warn(url, `HTTP ${response.status}`);
      return null;
    }

    const contentType = response.headers.get('content-type') ?? '';
    if (!/\b(text\/html|application\/xhtml\+xml)\b/i.test(contentType)) {
      warn(url, `non-HTML content-type "${contentType}"`);
      return null;
    }

    const html = await readBoundedText(response);

    // Readability resolves relative hrefs off document.location; linkedom only sets
    // that from the `globals` override, not from a plain string argument.
    const parse = () => {
      const { document } = parseHTML(html, { location: { href: url } });
      repairImpliedBody(document);
      stripNavigation(document);
      return document;
    };

    let extracted: string | null = null;
    let readabilityError: string | null = null;
    try {
      const article = new Readability(parse()).parse();
      if (article?.textContent) extracted = collapseWhitespace(article.textContent);
    } catch (err) {
      readabilityError = (err as Error).message;
    }

    if (!extracted || extracted.length < MIN_EXTRACTED_CHARS) {
      // Readability strips and re-parents nodes as it goes (also on the way to a
      // throw), so the fallback reads a fresh parse, not the rewritten document.
      extracted = fallbackTextContent(parse());
    }

    // A Readability throw is only worth a log line when the fallback couldn't recover.
    if (!extracted && readabilityError) warn(url, `Readability threw: ${readabilityError}`);

    if (!extracted) return null;

    return capAtWordBoundary(extracted, MAX_BODY_CHARS);
  } catch (err) {
    warn(url, (err as Error).message ?? 'unknown error');
    return null;
  }
}

export async function fetchBodies(
  urls: string[],
  opts?: { concurrency?: number; timeoutMs?: number },
): Promise<Map<string, string | null>> {
  const concurrency = opts?.concurrency ?? 5;
  const timeoutMs = opts?.timeoutMs ?? 8000;

  const results = new Map<string, string | null>();
  const unique = Array.from(new Set(urls));

  let next = 0;
  async function worker() {
    for (;;) {
      const index = next++;
      if (index >= unique.length) return;
      const url = unique[index];
      results.set(url, await fetchBody(url, timeoutMs));
    }
  }

  const workers = Array.from({ length: Math.min(concurrency, unique.length) }, () => worker());
  await Promise.all(workers);

  return results;
}
