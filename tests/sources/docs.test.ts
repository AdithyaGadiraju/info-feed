import { describe, expect, it } from 'vitest';
import { docs, matchesPrefix, parseLlmsTxt, parseSitemap } from '../../lib/sources/docs';
import { sourcesConfig } from '../../config/sources';

describe('parseLlmsTxt', () => {
  it('reads titled links, drops the .md twin suffix and keeps descriptions', () => {
    const text = [
      '# Claude Docs',
      '',
      '- [Prompting Claude Opus 5.5](https://platform.claude.com/docs/en/build-with-claude/prompt-engineering/prompting-claude-opus-5-5.md)',
      '- [Skills](https://code.claude.com/docs/en/skills.md): Package reusable instructions.',
      'Not a link line',
    ].join('\n');
    expect(parseLlmsTxt(text)).toEqual([
      {
        url: 'https://platform.claude.com/docs/en/build-with-claude/prompt-engineering/prompting-claude-opus-5-5',
        title: 'Prompting Claude Opus 5.5',
      },
      { url: 'https://code.claude.com/docs/en/skills', title: 'Skills', description: 'Package reusable instructions.' },
    ]);
  });
});

describe('parseSitemap', () => {
  it('reads <loc> URLs and titles them from the slug', () => {
    const xml = `<urlset><url><loc>https://developers.openai.com/blog/run-long-horizon-tasks-with-codex</loc><lastmod>2026-10-01</lastmod></url>
      <url><loc> https://cursor.com/blog/improved-token-efficiency/ </loc></url>
      <url><loc>https://fal.ai/models/meshy/v7.1/image-to-3d</loc></url></urlset>`;
    expect(parseSitemap(xml)).toEqual([
      { url: 'https://developers.openai.com/blog/run-long-horizon-tasks-with-codex', title: 'Run long horizon tasks with codex' },
      { url: 'https://cursor.com/blog/improved-token-efficiency/', title: 'Improved token efficiency' },
      { url: 'https://fal.ai/models/meshy/v7.1/image-to-3d', title: 'Meshy v7.1 image to 3d' },
    ]);
  });
});

describe('matchesPrefix', () => {
  it('matches on the URL path only', () => {
    expect(matchesPrefix('https://cursor.com/blog/x', ['/blog/'])).toBe(true);
    expect(matchesPrefix('https://cursor.com/ja/blog/x', ['/blog/'])).toBe(false);
    expect(matchesPrefix('not a url', ['/blog/'])).toBe(false);
  });
});

// Live, like the other source tests: every configured watch should still list pages.
describe('docs source (live)', () => {
  it('lists pages under each configured prefix', async () => {
    const items = await docs.fetch({ since: new Date(0), config: sourcesConfig });
    for (const watch of sourcesConfig.docs) {
      const mine = items.filter((i) => i.author === watch.name);
      expect(mine.length, watch.name).toBeGreaterThan(0);
      for (const i of mine) expect(matchesPrefix(i.url, watch.prefixes)).toBe(true);
    }
    expect(items.some((i) => i.url.endsWith('/prompting-claude-opus-5-5'))).toBe(true);
  }, 60_000);
});
