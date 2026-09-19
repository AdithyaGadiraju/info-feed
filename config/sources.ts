/**
 * Seed configuration for every source (ADR 0002). This file is curation, not code:
 * Gadi edits the feed and subreddit lists as the feed gets tuned. Expect churn here
 * for the first couple of weeks and none in the source modules.
 */
import { LANES } from '../lib/db/types';
import type { SourcesConfig } from '../lib/sources/types';

export const sourcesConfig: SourcesConfig = {
  lanes: LANES,
  // Digest posting order. ai first because it is the lane Gadi reads first.
  laneOrder: ['ai', 'ai_dev', 'markets', 'betting', 'gamedev', 'games'],

  feeds: [
    // ai (AI News): labs, models, research, the industry.
    { lane: 'ai', name: 'OpenAI', url: 'https://openai.com/news/rss.xml' },
    // Anthropic publishes no first-party RSS feed; every documented path 404s as of
    // 2026-09-13. Anthropic news reaches the ai lane via Hacker News and r/LocalLLaMA
    // instead. See the Deviations section of ADR 0002. (The engineering blog is in
    // ai_dev via a community bridge, and the Claude Code changelog has a real feed.)
    { lane: 'ai', name: 'Google DeepMind', url: 'https://deepmind.google/blog/rss.xml' },
    { lane: 'ai', name: 'Hugging Face', url: 'https://huggingface.co/blog/feed.xml' },
    // -- benchmarks and leaderboards, verified live on 2026-09-19. Arena (lmarena)
    // publishes no feed and posts results on X, so r/singularity and HN carry them.
    { lane: 'ai', name: 'Epoch AI', url: 'https://epochai.substack.com/feed' },
    { lane: 'ai', name: 'Simon Willison (evals)', url: 'https://simonwillison.net/tags/evals.atom' },
    // ai_dev (AI Dev): building with agentic tools. Three kinds of source, verified
    // live on 2026-09-14: tool changelogs (what shipped), the people who coin and
    // spread the techniques (context -> harness -> loop -> goal engineering all
    // started on these blogs), and the gamedev/3D side where AI tooling lands.
    // -- tool changelogs
    { lane: 'ai_dev', name: 'Claude Code changelog', url: 'https://code.claude.com/docs/en/changelog/rss.xml' },
    // Third-party RSSHub bridge; anthropic.com has no feed. Items carry no pubDate,
    // so they surface with fetch time and dedupe on link. Drop it if the bridge dies.
    { lane: 'ai_dev', name: 'Anthropic Engineering', url: 'https://rsshub.bestblogs.dev/anthropic/engineering' },
    { lane: 'ai_dev', name: 'Codex changelog', url: 'https://developers.openai.com/codex/changelog/rss.xml' },
    { lane: 'ai_dev', name: 'Cursor changelog', url: 'https://cursor.com/changelog/rss.xml' },
    { lane: 'ai_dev', name: 'GitHub Changelog (Copilot)', url: 'https://github.blog/changelog/label/copilot/feed/' },
    // -- techniques and discourse
    { lane: 'ai_dev', name: 'Simon Willison (AI-assisted programming)', url: 'https://simonwillison.net/tags/ai-assisted-programming.atom' },
    { lane: 'ai_dev', name: 'Addy Osmani', url: 'https://addyosmani.com/rss.xml' },
    { lane: 'ai_dev', name: 'Geoffrey Huntley', url: 'https://ghuntley.com/rss/' },
    { lane: 'ai_dev', name: 'martinfowler.com', url: 'https://martinfowler.com/feed.atom' },
    { lane: 'ai_dev', name: 'Kent Beck', url: 'https://newsletter.kentbeck.com/feed' },
    { lane: 'ai_dev', name: 'Latent Space', url: 'https://www.latent.space/feed' },
    { lane: 'ai_dev', name: 'The Pragmatic Engineer', url: 'https://newsletter.pragmaticengineer.com/feed' },
    { lane: 'ai_dev', name: 'Every: Chain of Thought', url: 'https://every.to/chain-of-thought/feed' },
    { lane: 'ai_dev', name: 'Lobsters (ai)', url: 'https://lobste.rs/t/ai.rss' },
    // -- AI tooling for game dev, 3D and animation. The vendors themselves (Runway,
    // Luma, Kling, Wonder Dynamics, Meshy, Move.ai, Cascadeur) publish no feeds, so
    // the trade press and r/aigamedev carry that news.
    { lane: 'ai_dev', name: 'CG Channel', url: 'https://www.cgchannel.com/feed/' },
    { lane: 'ai_dev', name: 'AI and Games', url: 'https://www.aiandgames.com/feed' },
    { lane: 'ai_dev', name: 'fxguide', url: 'https://www.fxguide.com/feed/' },
    // gamedev
    // -- engine first-party blogs, verified live on 2026-09-18. The prompt scores
    // patch and QOL releases as noise, so these can stay unfiltered. O3DE has no
    // feed and CRYENGINE's stopped in 2024; GameFromScratch covers both.
    { lane: 'gamedev', name: 'Godot', url: 'https://godotengine.org/rss.xml' },
    { lane: 'gamedev', name: 'Unreal Engine', url: 'https://www.unrealengine.com/en-US/rss' },
    { lane: 'gamedev', name: 'Unity', url: 'https://blog.unity.com/feed' },
    { lane: 'gamedev', name: 'Bevy', url: 'https://bevyengine.org/atom.xml' },
    { lane: 'gamedev', name: 'Defold', url: 'https://defold.com/feed.xml' },
    { lane: 'gamedev', name: 'Stride', url: 'https://www.stride3d.net/feed.xml' },
    { lane: 'gamedev', name: 'Flax Engine', url: 'https://flaxengine.com/feed/' },
    { lane: 'gamedev', name: 'GameMaker', url: 'https://gamemaker.io/en/blog/rss' },
    // -- engine news across the field, and where new engines first show up.
    { lane: 'gamedev', name: 'GameFromScratch', url: 'https://gamefromscratch.com/feed/' },
    { lane: 'gamedev', name: 'Blender', url: 'https://www.blender.org/feed/' },
    { lane: 'gamedev', name: '80.lv', url: 'https://80.lv/feed/' },
    { lane: 'gamedev', name: 'Game Developer', url: 'https://www.gamedeveloper.com/rss.xml' },
    // games
    { lane: 'games', name: 'Eurogamer', url: 'https://www.eurogamer.net/feed' },
    { lane: 'games', name: 'Rock Paper Shotgun', url: 'https://www.rockpapershotgun.com/feed' },
    { lane: 'games', name: 'IGN', url: 'https://feeds.ign.com/ign/games-all' },
    // markets
    { lane: 'markets', name: 'CoinDesk', url: 'https://www.coindesk.com/arc/outboundfeeds/rss/' },
    { lane: 'markets', name: 'CNBC Markets', url: 'https://search.cnbc.com/rs/search/combinedcms/view.xml?partnerId=wrss01&id=20910258' },
    // betting. All four ADR 0002 seeds (Pinnacle, Unabated, MMA Junkie, Bloody Elbow)
    // were dead on 2026-09-13 and are replaced with live equivalents covering the same
    // two halves of the lane: MMA/fight news, and the betting industry itself. The
    // model-building side of the lane comes from r/algobetting and the HN betting query.
    { lane: 'betting', name: 'Sherdog', url: 'https://www.sherdog.com/rss/news.xml' },
    { lane: 'betting', name: 'Yahoo MMA', url: 'https://sports.yahoo.com/mma/rss.xml' },
    { lane: 'betting', name: 'Legal Sports Report', url: 'https://www.legalsportsreport.com/feed/' },
    { lane: 'betting', name: 'Sports Handle', url: 'https://sportshandle.com/feed/' },
  ],

  subreddits: [
    { lane: 'ai', sub: 'MachineLearning' },
    { lane: 'ai', sub: 'LocalLLaMA' },
    { lane: 'ai', sub: 'artificial' },
    { lane: 'ai', sub: 'singularity' },
    { lane: 'ai_dev', sub: 'ClaudeCode' },
    { lane: 'ai_dev', sub: 'codex' },
    { lane: 'ai_dev', sub: 'cursor' },
    { lane: 'ai_dev', sub: 'ChatGPTCoding' },
    { lane: 'ai_dev', sub: 'aigamedev' },
    { lane: 'gamedev', sub: 'gamedev' },
    { lane: 'gamedev', sub: 'godot' },
    { lane: 'gamedev', sub: 'gameenginedevs' },
    { lane: 'gamedev', sub: 'unrealengine' },
    { lane: 'gamedev', sub: 'blender' },
    { lane: 'games', sub: 'Games' },
    { lane: 'games', sub: 'pcgaming' },
    { lane: 'markets', sub: 'CryptoCurrency' },
    { lane: 'markets', sub: 'stocks' },
    { lane: 'betting', sub: 'sportsbook' },
    { lane: 'betting', sub: 'algobetting' },
    { lane: 'betting', sub: 'MMA' },
    { lane: 'betting', sub: 'MMAbetting' },
  ],

  hnQueries: [
    { lane: 'ai', query: 'LLM OR "language model" OR Anthropic OR OpenAI' },
    { lane: 'ai_dev', query: '"Claude Code" OR Codex OR Cursor OR Copilot OR "coding agent" OR "agentic coding" OR MCP' },
    { lane: 'gamedev', query: 'Godot OR "game engine" OR Blender OR "Unreal Engine" OR Unity OR Bevy OR O3DE OR Defold' },
    { lane: 'games', query: 'video game release' },
    { lane: 'markets', query: 'bitcoin OR ethereum OR crypto market' },
    { lane: 'betting', query: 'sports betting OR prediction market OR betting model' },
  ],

  // Routes HN front-page stories into a lane. First match wins; anything unmatched
  // is dropped rather than guessed at, so the front page cannot flood one lane.
  hnFrontPageLaneKeywords: [
    // ai_dev sits before ai on purpose: its keywords are the specific ones, and
    // "claude" / "openai" in the ai rule would otherwise swallow every tooling story.
    { lane: 'ai_dev', keywords: ['claude code', 'codex', 'cursor', 'copilot', 'coding agent', 'agentic', 'mcp', 'vibe cod', 'context engineering', 'loop engineering', 'goal engineering', 'harness engineering', 'spec-driven'] },
    { lane: 'ai', keywords: ['llm', 'gpt', 'claude', 'openai', 'anthropic', 'deepmind', 'neural', 'machine learning', 'transformer', 'diffusion', 'ai ', 'lmarena', 'arena.ai', 'swe-bench', 'arc-agi', 'terminal-bench', "humanity's last exam"] },
    { lane: 'gamedev', keywords: ['godot', 'unreal', 'unity', 'bevy', 'o3de', 'defold', 'blender', 'game engine', 'shader', 'rendering', 'gamedev'] },
    { lane: 'games', keywords: ['video game', 'steam', 'nintendo', 'playstation', 'xbox', 'speedrun'] },
    { lane: 'markets', keywords: ['bitcoin', 'ethereum', 'crypto', 'stock market', 'fed ', 'inflation', 'nasdaq'] },
    { lane: 'betting', keywords: ['betting', 'sportsbook', 'prediction market', 'odds', 'kelly criterion', 'ufc', 'mma'] },
  ],

  // v1 watchlist is crypto only. Stocks are deliberately empty (GOAL.md).
  crypto: [
    { symbol: 'BTC', coingeckoId: 'bitcoin' },
    { symbol: 'ETH', coingeckoId: 'ethereum' },
    { symbol: 'SOL', coingeckoId: 'solana' },
  ],
  stocks: [],
  priceMovePct: 5,

  thresholds: {
    // Reddit's public JSON API returns 403 to unauthenticated clients, so the source
    // reads the .rss endpoint instead, which carries no vote counts. `redditTopN`
    // replaces the upvote threshold: "hot" is already ranked by engagement, so taking
    // the top N of each subreddit is the same cost control by a different measure.
    redditTopN: 10,
    redditMinUpvotes: 50,
    hnMinPoints: 50,
    twitterMinLikes: 100,
  },

  // Empty until a throwaway account exists and RETTIWT_API_KEY is set (TODO T3).
  twitterLists: [],
  twitterQueries: [],

  sourceTimeoutMs: 20_000,
  bodyTimeoutMs: 8_000,
};

export default sourcesConfig;
