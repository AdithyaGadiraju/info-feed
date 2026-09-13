/**
 * Seed configuration for every source (ADR 0002). This file is curation, not code:
 * Gadi edits the feed and subreddit lists as the feed gets tuned. Expect churn here
 * for the first couple of weeks and none in the source modules.
 */
import { LANES } from '../lib/db/types.js';
import type { SourcesConfig } from '../lib/sources/types.js';

export const sourcesConfig: SourcesConfig = {
  lanes: LANES,
  // Digest posting order. ai first because it is the lane Gadi reads first.
  laneOrder: ['ai', 'markets', 'betting', 'gamedev', 'games'],

  feeds: [
    // ai
    { lane: 'ai', name: 'OpenAI', url: 'https://openai.com/news/rss.xml' },
    { lane: 'ai', name: 'Anthropic', url: 'https://www.anthropic.com/news/rss.xml' },
    { lane: 'ai', name: 'Google DeepMind', url: 'https://deepmind.google/blog/rss.xml' },
    { lane: 'ai', name: 'Hugging Face', url: 'https://huggingface.co/blog/feed.xml' },
    // gamedev
    { lane: 'gamedev', name: 'Godot', url: 'https://godotengine.org/rss.xml' },
    { lane: 'gamedev', name: 'Unreal Engine', url: 'https://www.unrealengine.com/en-US/feed' },
    { lane: 'gamedev', name: 'Unity', url: 'https://blog.unity.com/feed' },
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
    // betting
    { lane: 'betting', name: 'Pinnacle Betting Resources', url: 'https://www.pinnacle.com/en/betting-resources/rss' },
    { lane: 'betting', name: 'Unabated', url: 'https://unabated.com/articles/rss.xml' },
    { lane: 'betting', name: 'MMA Junkie', url: 'https://mmajunkie.usatoday.com/feed' },
    { lane: 'betting', name: 'Bloody Elbow', url: 'https://www.bloodyelbow.com/feed' },
  ],

  subreddits: [
    { lane: 'ai', sub: 'MachineLearning' },
    { lane: 'ai', sub: 'LocalLLaMA' },
    { lane: 'ai', sub: 'artificial' },
    { lane: 'gamedev', sub: 'gamedev' },
    { lane: 'gamedev', sub: 'godot' },
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
    { lane: 'gamedev', query: 'Godot OR "game engine" OR Blender OR "Unreal Engine"' },
    { lane: 'games', query: 'video game release' },
    { lane: 'markets', query: 'bitcoin OR ethereum OR crypto market' },
    { lane: 'betting', query: 'sports betting OR prediction market OR betting model' },
  ],

  // Routes HN front-page stories into a lane. First match wins; anything unmatched
  // is dropped rather than guessed at, so the front page cannot flood one lane.
  hnFrontPageLaneKeywords: [
    { lane: 'ai', keywords: ['llm', 'gpt', 'claude', 'openai', 'anthropic', 'deepmind', 'neural', 'machine learning', 'transformer', 'diffusion', 'ai '] },
    { lane: 'gamedev', keywords: ['godot', 'unreal', 'unity', 'blender', 'game engine', 'shader', 'rendering', 'gamedev'] },
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
