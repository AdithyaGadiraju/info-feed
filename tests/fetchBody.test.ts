/**
 * Live-network tests per ADR 0002 (source tests hit real endpoints; no mocks).
 * Page-shape cases (oversized, tagless) are served over real HTTP from a local
 * server, since no stable public page pins those shapes down.
 */
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  fetchBody,
  fetchBodies,
  isBlockedAddress,
  MAX_BODY_CHARS,
  MAX_REDIRECTS,
  MAX_RESPONSE_BYTES,
  type LookupAll,
} from '../lib/fetchBody';

// The page-shape server listens on 127.0.0.1, which the SSRF guard refuses.
const LOCAL = { allowPrivateHosts: true };

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

const LEAD = 'The newest entry sits at the top of the page, where a truncated read still finds it. ';
const ARTICLE = `<article><h1>Changelog</h1><p>${LEAD.repeat(10)}</p></article>`;

// Headroom past the ceiling so the read has to stop early.
function oversizedPage(): Buffer {
  const head = `<!DOCTYPE html><html><head><title>Big</title></head><body>${ARTICLE}`;
  const filler = '<p>older entry older entry older entry</p>'.repeat(
    Math.ceil((MAX_RESPONSE_BYTES * 1.5) / 40),
  );
  return Buffer.from(head + filler + '</body></html>');
}

// Multi-byte text laid out so the ceiling cuts through the middle of a 2-byte char.
function splitCharPage(): Buffer {
  const build = (pad: string) =>
    Buffer.from(
      `<html><body>${pad}${ARTICLE}<p>${'héllo wörld '.repeat(MAX_RESPONSE_BYTES / 10)}</p></body></html>`,
    );
  const page = build('');
  // A byte of the form 10xxxxxx at the cut is a UTF-8 continuation byte.
  return (page[MAX_RESPONSE_BYTES] & 0xc0) === 0x80 ? page : build(' ');
}

// Minified markup with the optional <head>/<body> tags left out, like pdp1173.com.
const TAGLESS_PAGE = `<!DOCTYPE html><html lang=en><meta charset=UTF-8><title>Tagless</title><style>.x{color:red}</style><main><p>${LEAD.repeat(10)}</p></main><script>var x = 1;</script>`;

// A docs page whose table of contents precedes many short entries, like
// code.claude.com's changelog. Without stripping, Readability picks the common
// parent and its text opens with the TOC's run of version labels.
const TOC_PAGE = `<html><body><div id="content"><div><ul class="toc">${Array.from(
  { length: 60 },
  (_, i) => `<li><a href="#v${i}">2.1.${300 - i}</a></li>`,
).join('')}</ul></div><div>${Array.from(
  { length: 60 },
  (_, i) =>
    `<div><div>2.1.${300 - i}</div><div><ul><li>${
      i === 0 ? LEAD : 'Fixed an older bug, with enough words to count as a paragraph of content.'
    }</li><li>Added a feature, described in a sentence that has commas, and more words.</li></ul></div></div>`,
).join('')}</div></div></body></html>`;

describe('fetchBody page shapes', () => {
  let server: Server;
  let base = '';
  const oversized = oversizedPage();
  const splitChar = splitCharPage();

  beforeAll(async () => {
    server = createServer((req, res) => {
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      switch (req.url) {
        case '/oversized-chunked':
          // Streamed in pieces with no content-length.
          for (let i = 0; i < oversized.length; i += 64 * 1024) {
            res.write(oversized.subarray(i, i + 64 * 1024));
          }
          res.end();
          return;
        case '/oversized-declared':
          res.setHeader('Content-Length', String(oversized.length));
          res.end(oversized);
          return;
        case '/split-char':
          res.end(splitChar);
          return;
        case '/tagless':
          res.end(TAGLESS_PAGE);
          return;
        case '/toc':
          res.end(TOC_PAGE);
          return;
        default:
          res.statusCode = 404;
          res.end();
      }
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('extracts from the prefix of a streamed page over the size ceiling', async () => {
    const warn = vi.spyOn(console, 'warn');
    const body = await fetchBody(`${base}/oversized-chunked`, 8000, LOCAL);
    expect(body).not.toBeNull();
    expect(body).toContain('The newest entry sits at the top');
    expect((body as string).length).toBeLessThanOrEqual(MAX_BODY_CHARS);
    expect(warn).not.toHaveBeenCalled();
  });

  it('reads up to the ceiling when content-length declares more', async () => {
    const body = await fetchBody(`${base}/oversized-declared`, 8000, LOCAL);
    expect(body).toContain('The newest entry sits at the top');
  });

  it('decodes a prefix cut through a multi-byte character', async () => {
    const body = await fetchBody(`${base}/split-char`, 8000, LOCAL);
    expect(body).toContain('The newest entry sits at the top');
  });

  it('extracts from markup that omits <head> and <body>, without warning', async () => {
    const warn = vi.spyOn(console, 'warn');
    const body = await fetchBody(`${base}/tagless`, 8000, LOCAL);
    expect(body).toContain('The newest entry sits at the top');
    expect(body).not.toContain('color:red');
    expect(body).not.toContain('var x');
    expect(warn).not.toHaveBeenCalled();
  });

  it('skips a table of contents that precedes the content', async () => {
    const body = await fetchBody(`${base}/toc`, 8000, LOCAL);
    expect(body).not.toBeNull();
    expect(body).not.toContain('2.1.2992.1.298');
    expect(body).toContain('The newest entry sits at the top');
  });
});

describe('isBlockedAddress', () => {
  it.each([
    '127.0.0.1', '127.255.0.9', '10.1.2.3', '172.16.0.1', '172.31.255.255', '192.168.1.1',
    '169.254.169.254', '100.64.0.1', '100.127.255.255', '0.0.0.0', '0.1.2.3', '224.0.0.1',
    '239.1.1.1', '240.0.0.1', '255.255.255.255', '192.0.2.5', '198.18.0.1',
    '::1', '::', '[::1]', 'fe80::1', 'febf::1', 'fc00::1', 'fd12:3456::1', 'ff02::1',
    '::ffff:127.0.0.1', '::ffff:7f00:1', '::ffff:10.0.0.1', '::ffff:169.254.169.254',
    '0:0:0:0:0:ffff:c0a8:0101', '64:ff9b::10.0.0.1', '::127.0.0.1', 'fe80::1%eth0',
    'not-an-ip', '1.2.3', '1.2.3.256',
  ])('blocks %s', (ip) => {
    expect(isBlockedAddress(ip)).toBe(true);
  });

  it.each([
    '8.8.8.8', '1.1.1.1', '172.15.255.255', '172.32.0.1', '100.63.255.255', '100.128.0.1',
    '169.253.1.1', '192.169.0.1', '11.0.0.1', '223.255.255.255',
    '2606:4700:4700::1111', '2001:4860:4860::8888', '::ffff:8.8.8.8', '64:ff9b::8.8.8.8', 'fec0::1',
  ])('allows public %s', (ip) => {
    expect(isBlockedAddress(ip)).toBe(false);
  });
});

describe('fetchBody SSRF guard (mocked fetch and DNS, no network)', () => {
  const PAGE = `<html><body><article><p>${LEAD.repeat(10)}</p></article></body></html>`;
  const html = () => new Response(PAGE, { status: 200, headers: { 'Content-Type': 'text/html' } });
  const redirect = (to: string) => new Response(null, { status: 302, headers: { Location: to } });
  const lookup: LookupAll = async (host) => [
    { address: host === 'internal.example' ? '10.0.0.5' : '93.184.216.34', family: 4 },
  ];

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  function stubFetch(handler: (url: string) => Response) {
    const fn = vi.fn(async (input: string | URL | Request, _init?: RequestInit) => handler(String(input instanceof Request ? input.url : input)));
    vi.stubGlobal('fetch', fn);
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    return fn;
  }

  it('follows a redirect between public hosts, checking each hop by hand', async () => {
    const fn = stubFetch((u) => (u.startsWith('https://a.example/') ? redirect('https://b.example/post') : html()));
    const body = await fetchBody('https://a.example/x', 8000, { lookup });
    expect(body).toContain('The newest entry sits at the top');
    expect(fn).toHaveBeenCalledTimes(2);
    expect(fn.mock.calls[0][1]).toMatchObject({ redirect: 'manual' });
  });

  it('refuses a redirect to a host that resolves to a private address', async () => {
    const fn = stubFetch((u) => (u.startsWith('https://a.example/') ? redirect('http://internal.example/admin') : html()));
    await expect(fetchBody('https://a.example/x', 8000, { lookup })).resolves.toBeNull();
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('refuses a redirect to a private IP literal and to a non-http scheme', async () => {
    const meta = stubFetch((u) => (u.startsWith('https://a.example/') ? redirect('http://169.254.169.254/latest/meta-data') : html()));
    await expect(fetchBody('https://a.example/x', 8000, { lookup })).resolves.toBeNull();
    expect(meta).toHaveBeenCalledTimes(1);
    vi.unstubAllGlobals();
    const file = stubFetch((u) => (u.startsWith('https://a.example/') ? redirect('file:///etc/passwd') : html()));
    await expect(fetchBody('https://a.example/x', 8000, { lookup })).resolves.toBeNull();
    expect(file).toHaveBeenCalledTimes(1);
  });

  it('refuses a host when any one of its addresses is private', async () => {
    const fn = stubFetch(() => html());
    const mixed: LookupAll = async () => [
      { address: '93.184.216.34', family: 4 },
      { address: '::1', family: 6 },
    ];
    await expect(fetchBody('https://a.example/x', 8000, { lookup: mixed })).resolves.toBeNull();
    await expect(fetchBody('http://[::ffff:127.0.0.1]/x', 8000, { lookup })).resolves.toBeNull();
    expect(fn).not.toHaveBeenCalled();
  });

  it('gives up after MAX_REDIRECTS hops', async () => {
    let n = 0;
    const fn = stubFetch(() => redirect(`https://a.example/${++n}`));
    await expect(fetchBody('https://a.example/0', 8000, { lookup })).resolves.toBeNull();
    expect(fn).toHaveBeenCalledTimes(MAX_REDIRECTS + 1);
  });
});
