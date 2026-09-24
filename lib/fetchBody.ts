/**
 * Best-effort article body extraction for link items with no body (ADR 0002).
 * A failed fetch/parse must never block or fail an ingest run, so every error
 * path here resolves to null instead of throwing.
 */
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

export async function fetchBody(url: string, timeoutMs = 8000): Promise<string | null> {
  try {
    const response = await fetch(url, {
      redirect: 'follow',
      signal: AbortSignal.timeout(timeoutMs),
      headers: { 'User-Agent': USER_AGENT },
    });

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
