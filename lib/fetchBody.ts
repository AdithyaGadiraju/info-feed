/**
 * Best-effort article body extraction for link items with no body (ADR 0002).
 * A failed fetch/parse must never block or fail an ingest run, so every error
 * path here resolves to null instead of throwing.
 */
import { parseHTML } from 'linkedom';
import { Readability } from '@mozilla/readability';

const USER_AGENT = 'info-feed/1.0 (personal news digest)';
// Guards against a slow/huge response tying up a fetch slot; articles never need this much.
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
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

async function readBoundedText(response: Response): Promise<string | null> {
  const declaredLength = response.headers.get('content-length');
  if (declaredLength && Number(declaredLength) > MAX_RESPONSE_BYTES) return null;

  if (!response.body) return await response.text();

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) {
      total += value.byteLength;
      if (total > MAX_RESPONSE_BYTES) {
        await reader.cancel();
        return null;
      }
      chunks.push(value);
    }
  }
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

function fallbackTextContent(document: Document): string | null {
  for (const tag of ['script', 'style', 'nav']) {
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
    if (html === null) {
      warn(url, 'response exceeded size ceiling');
      return null;
    }

    // Readability resolves relative hrefs off document.location; linkedom only sets
    // that from the `globals` override, not from a plain string argument.
    const { document } = parseHTML(html, { location: { href: url } });

    let extracted: string | null = null;
    try {
      // Readability mutates a clone-worthy DOM; linkedom's document is close enough
      // as long as we pass the source URL so relative hrefs/imgs resolve.
      const article = new Readability(document).parse();
      if (article?.textContent) extracted = collapseWhitespace(article.textContent);
    } catch (err) {
      warn(url, `Readability threw: ${(err as Error).message}`);
    }

    if (!extracted || extracted.length < MIN_EXTRACTED_CHARS) {
      extracted = fallbackTextContent(document);
    }

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
