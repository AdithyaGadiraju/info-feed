/**
 * Devpost source tests (ADR 0002). The gates are pinned against a fixture through
 * the pure `mapHackathons`, paging against a mocked `fetch`, and one live search
 * checks the real API still answers in the shape the mapper expects.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import devpost, { mapHackathons, parsePrize, searchUrl, type DevpostHackathon } from '../../lib/sources/devpost';
import type { DevpostSpec, SourceCtx } from '../../lib/sources/types';
import { sourcesConfig } from '../../config/sources';

const gaming: DevpostSpec = { lane: 'events', name: 'Devpost (Gaming)', themes: ['Gaming'], minPrize: 1000, onlineOnly: true };
const NOW = new Date('2026-11-17T02:00:00Z');

function hackathon(id: number, over: Partial<DevpostHackathon> = {}): DevpostHackathon {
  return {
    id,
    title: `Hackathon ${id}`,
    url: `https://hackathon-${id}.devpost.com/`,
    displayed_location: { location: 'Online' },
    open_state: 'open',
    submission_period_dates: 'Nov 11 - Dec 08, 2026',
    prize_amount: '$<span data-currency-value>35,000</span>',
    prizes_counts: { cash: 5, other: 0 },
    registrations_count: 1462,
    organization_name: 'reddit',
    themes: [{ name: 'Beginner Friendly' }, { name: 'Gaming' }],
    invite_only: false,
    ...over,
  };
}

function ctxWith(specs: DevpostSpec[], lanes?: SourceCtx['lanes']): SourceCtx {
  return { since: new Date(Date.now() - 6 * 3600_000), config: { ...sourcesConfig, devpost: specs }, lanes };
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('searchUrl', () => {
  it('asks for open and upcoming hackathons of the theme, never ended ones', () => {
    const url = new URL(searchUrl(gaming));
    expect(url.origin + url.pathname).toBe('https://devpost.com/api/hackathons');
    expect(url.searchParams.getAll('themes[]')).toEqual(['Gaming']);
    expect(url.searchParams.getAll('status[]')).toEqual(['upcoming', 'open']);
    expect(url.searchParams.has('page')).toBe(false);
  });

  it('adds the search text and the page', () => {
    const url = new URL(searchUrl({ ...gaming, themes: undefined, search: 'game jam' }, 2));
    expect(url.searchParams.get('search')).toBe('game jam');
    expect(url.searchParams.get('page')).toBe('2');
    expect(url.searchParams.has('themes[]')).toBe(false);
  });
});

describe('parsePrize', () => {
  it('reads the amount out of the HTML the API returns', () => {
    expect(parsePrize('$<span data-currency-value>35,000</span>')).toEqual({ text: '$35,000', value: 35000 });
    expect(parsePrize('£<span data-currency-value>0</span>')).toEqual({ text: '£0', value: 0 });
    expect(parsePrize(undefined)).toEqual({ text: '', value: 0 });
  });
});

describe('mapHackathons', () => {
  it('keeps hackathons at or above the prize bar', () => {
    const items = mapHackathons(
      [
        hackathon(1),
        hackathon(2, { prize_amount: '$<span data-currency-value>1,000</span>' }),
        hackathon(3, { prize_amount: '$<span data-currency-value>150</span>' }),
        hackathon(4, { prize_amount: '$<span data-currency-value>0</span>' }),
      ],
      gaming,
      NOW,
    );
    expect(items.map((i) => i.externalId)).toEqual(['1', '2']);
  });

  it('drops in-person and invite-only hackathons for an online-only spec', () => {
    const list = [
      hackathon(1, { displayed_location: { location: 'Brighton' } }),
      hackathon(2, { invite_only: true }),
      hackathon(3),
    ];
    expect(mapHackathons(list, gaming, NOW).map((i) => i.externalId)).toEqual(['3']);
    expect(mapHackathons(list, { ...gaming, onlineOnly: false }, NOW).map((i) => i.externalId)).toEqual(['1', '3']);
  });

  it('fills every RawItem field, with the dates, place and prize in the body', () => {
    const [item] = mapHackathons([hackathon(31644, { title: 'Reddit’s Game of the Day Hackathon' })], gaming, NOW);
    expect(item).toMatchObject({
      source: 'devpost',
      externalId: '31644',
      laneHint: 'events',
      url: 'https://hackathon-31644.devpost.com/',
      title: 'Reddit’s Game of the Day Hackathon (hackathon by reddit)',
      // The spec name: the runner tracks a snapshot per author.
      author: 'Devpost (Gaming)',
      engagement: { likes: 1462 },
      publishedAt: NOW,
    });
    expect(item.body).toContain('Where: Online.');
    expect(item.body).toContain('Submission period: Nov 11 - Dec 08, 2026.');
    expect(item.body).toContain('Prizes: $35,000 in total (5 cash prizes).');
    expect(item.body).toContain('Themes: Beginner Friendly, Gaming.');
  });
});

describe('devpost.fetch', () => {
  it('is a snapshot source that does not seed its first listing as seen', () => {
    expect(devpost.snapshot).toBe(true);
    expect(devpost.seedFirstListing).toBe(false);
  });

  it('reads further pages until the listing is complete', async () => {
    const pageOne = Array.from({ length: 9 }, (_, i) => hackathon(i + 1));
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(json({ hackathons: pageOne, meta: { total_count: 11, per_page: 9 } }))
      .mockResolvedValueOnce(json({ hackathons: [hackathon(10), hackathon(11)], meta: { total_count: 11, per_page: 9 } }));
    vi.stubGlobal('fetch', fetchMock);

    const items = await devpost.fetch(ctxWith([gaming]));
    expect(items).toHaveLength(11);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(String(fetchMock.mock.calls[1][0])).toContain('page=2');
  });

  it('keeps a hackathon once when two searches return it, and survives a failed search', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(json({}, 500))
      .mockResolvedValueOnce(json({ hackathons: [hackathon(1)], meta: { total_count: 1, per_page: 9 } }))
      .mockResolvedValueOnce(json({ hackathons: [hackathon(1), hackathon(2)], meta: { total_count: 2, per_page: 9 } }));
    vi.stubGlobal('fetch', fetchMock);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const items = await devpost.fetch(
      ctxWith([{ ...gaming, name: 'broken' }, gaming, { ...gaming, name: 'second', search: 'game' }]),
    );
    expect(items.map((i) => i.externalId)).toEqual(['1', '2']);
    expect(warn).toHaveBeenCalledOnce();
    warn.mockRestore();
  });

  it('runs no search for a lane that has none', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    expect(await devpost.fetch(ctxWith([gaming], ['ai']))).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('live: the configured search answers in the expected shape', async () => {
    const items = await devpost.fetch(ctxWith(sourcesConfig.devpost));
    // An empty listing is possible in a quiet month; a wrong shape is not.
    for (const item of items) {
      expect(item.source).toBe('devpost');
      expect(item.laneHint).toBe('events');
      expect(item.url).toMatch(/^https:\/\//);
      expect(item.body).toContain('Hackathon listed on Devpost');
    }
  });
});
