/**
 * Watches docs sites for new pages. A model-specific prompting guide or a new
 * best-practices page is some of the most useful material for the ai_dev lane, and
 * none of it is announced in a feed. This source returns the full listing of every
 * watched site on each run; the runner (`snapshot`) keeps only URLs it has not seen
 * before, so a new page becomes an item on the run after it is published.
 */
import type { DocsWatchSpec, RawItem, Source, SourceCtx } from './types';

const USER_AGENT = 'info-feed/1.0 (personal news digest)';

export interface DocsPage {
  url: string;
  title: string;
  description?: string;
}

/**
 * `- [Title](https://host/path.md): optional description`, the llms.txt convention.
 * The `.md` suffix is the raw-markdown twin of the page; the item links the page.
 */
export function parseLlmsTxt(text: string): DocsPage[] {
  const pages: DocsPage[] = [];
  const line = /^\s*-\s*\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)(?::\s*(.+))?\s*$/gm;
  for (const m of text.matchAll(line)) {
    const description = m[3]?.trim();
    pages.push({
      url: m[2].replace(/\.md$/, ''),
      title: m[1].trim(),
      ...(description ? { description } : {}),
    });
  }
  return pages;
}

/**
 * The path after its first segment, so the vendor and version survive:
 * "/blog/run-long-horizon-tasks-with-codex" -> "Run long horizon tasks with codex",
 * "/models/meshy/v7.1/image-to-3d" -> "Meshy v7.1 image to 3d".
 */
function titleFromSlug(url: string): string {
  const segments = new URL(url).pathname.split('/').filter(Boolean);
  const kept = segments.length > 1 ? segments.slice(1) : segments;
  const slug = safeDecodeUri(kept.join(' ') || url).replace(/[-_]+/g, ' ').trim();
  return slug.charAt(0).toUpperCase() + slug.slice(1);
}

/** A sitemap gives URLs only, so the title comes from the slug; the body fetch supplies the text. */
export function parseSitemap(xml: string): DocsPage[] {
  const pages: DocsPage[] = [];
  for (const m of xml.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/g)) {
    const url = m[1].replace(/&amp;/g, '&');
    try {
      pages.push({ url, title: titleFromSlug(url) });
    } catch {
      // Not a URL; skip it.
    }
  }
  return pages;
}

/** A stray `%` (`/blog/100%-off`) makes decodeURIComponent throw; keep such text as it is. */
function safeDecodeUri(text: string): string {
  try {
    return decodeURIComponent(text);
  } catch {
    return text;
  }
}

/** An out-of-range reference (`&#99999999;`) makes fromCodePoint throw; keep it as written. */
function fromCodePointOr(code: number, raw: string): string {
  return code <= 0x10ffff ? String.fromCodePoint(code) : raw;
}

function decodeEntities(text: string): string {
  return text
    .replace(/&#(\d+);/g, (raw, n) => fromCodePointOr(Number(n), raw))
    .replace(/&#x([0-9a-f]+);/gi, (raw, n) => fromCodePointOr(parseInt(n, 16), raw))
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&');
}

/**
 * Same-site `<a href>` links on an index page, resolved against `baseUrl`, titled by
 * their link text (or the slug when a link wraps only an image). Query and hash are
 * dropped so a card's image link and title link collapse into one page.
 */
export function parseHtmlLinks(html: string, baseUrl: string): DocsPage[] {
  const base = new URL(baseUrl);
  const byUrl = new Map<string, DocsPage>();
  for (const m of html.matchAll(/<a\b[^>]*?\shref\s*=\s*["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi)) {
    let url: URL;
    try {
      url = new URL(decodeEntities(m[1]), base);
    } catch {
      continue;
    }
    if (url.host !== base.host || !/^https?:$/.test(url.protocol)) continue;
    url.search = '';
    url.hash = '';
    const href = url.toString();
    const text = decodeEntities(m[2].replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim();
    const existing = byUrl.get(href);
    if (!existing) byUrl.set(href, { url: href, title: text || titleFromSlug(href) });
    else if (text && existing.title === titleFromSlug(href)) existing.title = text;
  }
  return [...byUrl.values()];
}

export function matchesPrefix(url: string, prefixes: string[]): boolean {
  try {
    const path = new URL(url).pathname;
    return prefixes.some((p) => path.startsWith(p));
  } catch {
    return false;
  }
}

async function fetchWatch(spec: DocsWatchSpec, ctx: SourceCtx, now: Date): Promise<RawItem[]> {
  const res = await fetch(spec.url, {
    headers: { 'User-Agent': USER_AGENT },
    signal: AbortSignal.timeout(ctx.config.sourceTimeoutMs),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const text = await res.text();
  const pages =
    spec.format === 'llms'
      ? parseLlmsTxt(text)
      : spec.format === 'html'
        ? parseHtmlLinks(text, res.url || spec.url)
        : parseSitemap(text);
  const exclude = spec.excludePrefixes ?? [];

  const seen = new Set<string>();
  const items: RawItem[] = [];
  for (const page of pages) {
    if (!matchesPrefix(page.url, spec.prefixes) || seen.has(page.url)) continue;
    if (exclude.length > 0 && matchesPrefix(page.url, exclude)) continue;
    seen.add(page.url);
    items.push({
      source: 'docs',
      externalId: page.url,
      laneHint: spec.lane,
      url: page.url,
      title: page.title,
      body: page.description,
      author: spec.name,
      // Listings carry no usable date, so a page is dated when it is first seen.
      publishedAt: now,
    });
  }
  return items;
}

export const docs: Source = {
  name: 'docs',
  snapshot: true,
  async fetch(ctx: SourceCtx): Promise<RawItem[]> {
    const watches = ctx.lanes ? ctx.config.docs.filter((d) => ctx.lanes!.includes(d.lane)) : ctx.config.docs;
    const now = new Date();
    const results = await Promise.all(
      watches.map(async (spec) => {
        try {
          return await fetchWatch(spec, ctx, now);
        } catch (err) {
          // One site down must not hide the others (ADR 0002).
          console.warn(`[docs] ${spec.name} (${spec.url}) failed: ${(err as Error).message}`);
          return [] as RawItem[];
        }
      }),
    );
    return results.flat();
  },
};

export default docs;
