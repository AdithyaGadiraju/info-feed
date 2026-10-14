/**
 * Seed configuration for every source (ADR 0002). This file is curation, not code:
 * Gadi edits the feed and subreddit lists as the feed gets tuned. Expect churn here
 * for the first couple of weeks and none in the source modules.
 */
import { ACTIVE_LANES } from '../lib/db/types';
import type { SourcesConfig } from '../lib/sources/types';

/** Title gate for broad creative-AI feeds: keep only posts about game-usable assets. */
const ASSET_TOPICS = /\b3d\b|trellis|hunyuan|pixal3d|mesh|texture|pbr|sprite|pixel art|audio|music|sfx|sound effect|rigg|splat|world model/i;

/** Title gate for subreddits where agent technique is a small share of posts. */
const AGENT_TECHNIQUE = /plugin|skill|hook|subagent|mcp|token|claude\.md|agents\.md|workflow|tips?\b|context|i built|cost/i;

export const sourcesConfig: SourcesConfig = {
  // Both are LANES minus PAUSED_LANES (lib/db/types.ts). Pause or resume a lane
  // there, not here.
  lanes: ACTIVE_LANES,
  // Digest posting order. ai first because it is the lane Gadi reads first.
  laneOrder: ACTIVE_LANES,

  feeds: [
    // ai (AI News): labs, models, research, the industry.
    { lane: 'ai', name: 'OpenAI', url: 'https://openai.com/news/rss.xml' },
    { lane: 'ai', name: 'Google DeepMind', url: 'https://deepmind.google/blog/rss.xml' },
    { lane: 'ai', name: 'Hugging Face', url: 'https://huggingface.co/blog/feed.xml' },
    // -- benchmarks and leaderboards, verified live on 2026-09-19. Arena (lmarena)
    // publishes no feed and posts results on X, so r/singularity and HN carry them.
    { lane: 'ai', name: 'Epoch AI', url: 'https://epochai.substack.com/feed' },
    { lane: 'ai', name: 'Simon Willison (evals)', url: 'https://simonwillison.net/tags/evals.atom' },
    // -- news-heavy feeds. Latent Space is mostly AINews, Lobsters' ai tag is ML
    // research (coding-tool posts go under vibecoding), AI and Games is commentary.
    { lane: 'ai', name: 'Latent Space', url: 'https://www.latent.space/feed' },
    { lane: 'ai', name: 'Lobsters (ai)', url: 'https://lobste.rs/t/ai.rss' },
    { lane: 'ai', name: 'AI and Games', url: 'https://www.aiandgames.com/feed' },
    // ai_dev (AI Dev): getting better and faster at building with AI. ai and ai_dev
    // are enriched as one pool (laneGroup in lib/db/types.ts), so the lane here is a
    // hint: the model files each story by content. Picked for the share of posts
    // that are technique, verified live on 2026-10-14. The docs watches below catch
    // official guides, which no feed announces.
    // -- first-party technique and tool changelogs
    { lane: 'ai_dev', name: 'Claude Developer Blog', url: 'https://claude.dev/rss.xml' },
    { lane: 'ai_dev', name: 'Claude Code changelog', url: 'https://code.claude.com/docs/en/changelog/rss.xml' },
    { lane: 'ai_dev', name: 'Codex changelog', url: 'https://developers.openai.com/codex/changelog/rss.xml' },
    { lane: 'ai_dev', name: 'Cursor changelog', url: 'https://cursor.com/changelog/rss.xml' },
    { lane: 'ai_dev', name: 'GitHub Changelog (Copilot)', url: 'https://github.blog/changelog/label/copilot/feed/' },
    { lane: 'ai_dev', name: 'GitHub Blog (AI & ML)', url: 'https://github.blog/ai-and-ml/feed/' },
    // JetBrains tests agent tools and skills for token and quality claims.
    { lane: 'ai_dev', name: 'JetBrains AI', url: 'https://blog.jetbrains.com/ai/feed/' },
    // -- practitioners
    { lane: 'ai_dev', name: 'Simon Willison (coding agents)', url: 'https://simonwillison.net/tags/coding-agents.atom' },
    { lane: 'ai_dev', name: 'Addy Osmani', url: 'https://addyo.substack.com/feed' },
    { lane: 'ai_dev', name: 'Matt Pocock (YouTube)', url: 'https://www.youtube.com/feeds/videos.xml?channel_id=UCswG6FSbgZjbWtdf_hMLaow' },
    // About 70 of AI Hero's posts are one-line glossary stubs titled "... Dictionary".
    { lane: 'ai_dev', name: 'AI Hero', url: 'https://www.aihero.dev/rss.xml', exclude: /dictionary/i },
    { lane: 'ai_dev', name: 'Jesse Vincent', url: 'https://blog.fsck.com/feed/feed.xml' },
    { lane: 'ai_dev', name: 'AI Coding Daily', url: 'https://aicodingdaily.substack.com/feed' },
    { lane: 'ai_dev', name: 'Drew Breunig', url: 'https://www.dbreunig.com/feed.xml' },
    { lane: 'ai_dev', name: 'Tessl', url: 'https://tessl.io/blog/feed' },
    { lane: 'ai_dev', name: 'Builder.io', url: 'https://www.builder.io/blog/feed/xml' },
    { lane: 'ai_dev', name: 'Every: Source Code', url: 'https://every.to/source-code/feed' },
    { lane: 'ai_dev', name: 'Geoffrey Huntley', url: 'https://ghuntley.com/rss/' },
    { lane: 'ai_dev', name: 'martinfowler.com', url: 'https://martinfowler.com/feed.atom' },
    { lane: 'ai_dev', name: 'Kent Beck', url: 'https://newsletter.kentbeck.com/feed' },
    { lane: 'ai_dev', name: 'The Pragmatic Engineer', url: 'https://newsletter.pragmaticengineer.com/feed' },
    { lane: 'ai_dev', name: 'Lobsters (vibecoding)', url: 'https://lobste.rs/t/vibecoding.rss' },
    { lane: 'ai_dev', name: 'dev.to (agenticcoding)', url: 'https://dev.to/feed/tag/agenticcoding' },
    // -- AI agents in game dev. The 3D trade press (CG Channel, fxguide) was dropped
    // on 2026-10-14: almost none of it was about AI. The Godot items suit a Godot 4
    // C# workflow; both repos ship release notes worth reading.
    { lane: 'ai_dev', name: 'GodotPrompter releases', url: 'https://github.com/jame581/GodotPrompter/releases.atom' },
    { lane: 'ai_dev', name: 'Godot AI (MCP) releases', url: 'https://github.com/hi-godot/godot-ai/releases.atom' },
    { lane: 'ai_dev', name: 'Ziva (Godot AI)', url: 'https://ziva.sh/feed.xml' },
    { lane: 'ai_dev', name: 'Kyle Kukshtel', url: 'https://kylekukshtel.com/feed.rss' },
    // -- AI game development, researched and verified live on 2026-10-14. Engine
    // vendors' own AI announcements first: official and accurate, so worth a
    // title filter on otherwise noisy feeds. The Unity blog also feeds gamedev
    // below; a post in both keeps the first lane listed, so its AI posts land here.
    { lane: 'ai_dev', name: 'Unity blog (AI)', url: 'https://blog.unity.com/feed', include: /\b(AI|assistant|agent|MCP|Claude|Codex|Copilot|Cursor|Gemini|CLI|Muse|Sentis)\b/i },
    { lane: 'ai_dev', name: 'Roblox announcements (AI)', url: 'https://devforum.roblox.com/c/updates/announcements/36.rss', include: /assistant|\bMCP\b|\bAI\b|generat|agent|LLM|procedural models/i },
    { lane: 'ai_dev', name: 'Unreal announcements (AI)', url: 'https://forums.unrealengine.com/c/general/announcements/49.rss', include: /\bMCP\b|\bAI\b|agent|assistant|LLM/i },
    { lane: 'ai_dev', name: 'Godot forum plugins (AI)', url: 'https://forum.godotengine.org/c/resources/plugins/21.rss', include: /\bMCP\b|\bAI\b|claude|codex|agent|LLM/i },
    { lane: 'ai_dev', name: 'Godot forum tools (AI)', url: 'https://forum.godotengine.org/c/showcase/tools/16.rss', include: /\bMCP\b|\bAI\b|claude|codex|agent|LLM/i },
    // -- analysts and practitioners writing about AI game development
    { lane: 'ai_dev', name: 'Naavik (AI gaming)', url: 'https://naavik.co/category/ai-gaming/feed/' },
    { lane: 'ai_dev', name: 'AI Gamechangers', url: 'https://aigamechangers.substack.com/feed' },
    { lane: 'ai_dev', name: 'GamesIndustry.biz (AI)', url: 'https://www.gamesindustry.biz/feed', include: /\bAI\b|generative|LLM|machine learning|Claude|Codex|agentic/i },
    { lane: 'ai_dev', name: 'Games Alchemy', url: 'https://gamesalchemy.substack.com/feed', include: /\bAI\b/i },
    { lane: 'ai_dev', name: 'Game Dev Dairy', url: 'https://gamedevdairy.substack.com/feed', include: /\bAI\b|vibe|Claude|agent|LLM/i },
    // -- asset generation: 3D, textures, sprites, motion, audio. Most vendors have
    // no feed; the docs watches below cover the ones with a usable sitemap.
    { lane: 'ai_dev', name: 'ComfyUI blog (assets)', url: 'https://blog.comfy.org/feed', include: ASSET_TOPICS, exclude: /challenge/i },
    { lane: 'ai_dev', name: 'pixaroma (YouTube)', url: 'https://www.youtube.com/feeds/videos.xml?channel_id=UCmMbwA-s3GZDKVzGZ-kPwaQ', include: ASSET_TOPICS },
    { lane: 'ai_dev', name: 'ElevenLabs (audio models)', url: 'https://elevenlabs.io/blog/rss.xml', include: /^introducing (eleven v\d|music|sound)|sound effects?|\bsfx\b|music v\d|\bgames?\b/i },
    { lane: 'ai_dev', name: 'Stability AI (audio, 3D)', url: 'https://stability.ai/news-updates?format=rss', include: /stable audio|3d|game/i },
    // arXiv papers on assets a game can ship: PBR, textures, rigging, sprites, low-poly.
    { lane: 'ai_dev', name: 'arXiv (game asset generation)', url: 'http://export.arxiv.org/api/query?search_query=(cat:cs.CV%20OR%20cat:cs.GR)%20AND%20(ti:%22PBR%22%20OR%20ti:%22texture%20generation%22%20OR%20ti:%22auto-rigging%22%20OR%20ti:%22pixel%20art%22%20OR%20ti:sprite%20OR%20ti:%22game%20asset%22%20OR%20ti:%22low-poly%22%20OR%20ti:retopology)&sortBy=submittedDate&sortOrder=descending&max_results=25' },
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

  // New pages on docs sites, which publish no feed (lib/sources/docs.ts). A new
  // page is the signal: this is how a guide like "Prompting Claude Opus 5.5" reaches
  // the feed. The anthropic.com watch replaces an RSSHub bridge to the engineering
  // blog. Verified live on 2026-10-14.
  docs: [
    { lane: 'ai_dev', name: 'Claude Platform docs', url: 'https://platform.claude.com/llms.txt', format: 'llms', prefixes: ['/docs/en/build-with-claude/', '/docs/en/about-claude/'] },
    { lane: 'ai_dev', name: 'Claude Code docs', url: 'https://code.claude.com/docs/llms.txt', format: 'llms', prefixes: ['/docs/en/'] },
    { lane: 'ai_dev', name: 'Anthropic Engineering', url: 'https://www.anthropic.com/sitemap.xml', format: 'sitemap', prefixes: ['/engineering/'] },
    { lane: 'ai_dev', name: 'OpenAI developer docs', url: 'https://developers.openai.com/sitemap-0.xml', format: 'sitemap', prefixes: ['/blog/', '/cookbook/examples/', '/api/docs/guides/'] },
    // Cursor's blog feed stopped in 2024; its sitemap still lists every post.
    { lane: 'ai_dev', name: 'Cursor blog', url: 'https://cursor.com/sitemap.xml', format: 'sitemap', prefixes: ['/blog/'] },
    // AI game development. fal.ai hosts most 3D and audio models days after release,
    // so a new model page there is the earliest reliable signal across vendors.
    { lane: 'ai_dev', name: 'fal.ai 3D and audio models', url: 'https://fal.ai/sitemap.xml', format: 'sitemap', prefixes: ['/models/meshy/', '/models/fal-ai/meshy', '/models/tripo3d/', '/models/hitem3d/', '/models/fal-ai/hyper3d/', '/models/fal-ai/hunyuan3d', '/models/fal-ai/hunyuan-3d', '/models/fal-ai/hunyuan-motion', '/models/fal-ai/hunyuan_world', '/models/fal-ai/trellis', '/models/fal-ai/stable-audio', '/models/mirelo-ai/', '/models/sonilo/', '/models/elevenlabs/'] },
    { lane: 'ai_dev', name: 'Meshy launches', url: 'https://www.meshy.ai/llms.txt', format: 'llms', prefixes: ['/blog/meshy-'] },
    { lane: 'ai_dev', name: 'Scenario', url: 'https://www.scenario.com/sitemap.xml', format: 'sitemap', prefixes: ['/blog/', '/explorations/'] },
    { lane: 'ai_dev', name: 'World Labs', url: 'https://www.worldlabs.ai/sitemap.xml', format: 'sitemap', prefixes: ['/blog/', '/labs/learn/'] },
    { lane: 'ai_dev', name: 'Uthana', url: 'https://uthana.com/sitemap.xml', format: 'sitemap', prefixes: ['/blog/'] },
    { lane: 'ai_dev', name: 'Bezi', url: 'https://www.bezi.com/sitemap.xml', format: 'sitemap', prefixes: ['/blog/'] },
  ],

  subreddits: [
    { lane: 'ai', sub: 'MachineLearning' },
    { lane: 'ai', sub: 'LocalLLaMA' },
    { lane: 'ai', sub: 'artificial' },
    { lane: 'ai', sub: 'singularity' },
    { lane: 'ai_dev', sub: 'ClaudeCode' },
    // Mostly news and complaints; the gate keeps tool and technique posts.
    { lane: 'ai_dev', sub: 'ClaudeAI', include: AGENT_TECHNIQUE },
    { lane: 'ai_dev', sub: 'codex' },
    { lane: 'ai_dev', sub: 'cursor' },
    { lane: 'ai_dev', sub: 'ChatGPTCoding' },
    // r/aigamedev posts ~60 a day, mostly showcases; the gate keeps workflow posts.
    // Solo: in the lane's combined listing it got 8 of 100 slots, and the gate left none.
    { lane: 'ai_dev', sub: 'aigamedev', solo: true, include: /claude|codex|cursor|mcp|agents?\.md|workflow|pipeline|godot|unity|unreal|blender|prompt|context|skill/i },
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
    // Phrase queries for ai_dev: the old OR-of-terms query surfaced mostly 1-3
    // point Show HNs. Each of these, at 15+ points, was on topic for 60 days.
    { lane: 'ai_dev', query: 'Claude Code', allWords: true },
    { lane: 'ai_dev', query: 'coding agents', allWords: true },
    { lane: 'ai_dev', query: 'AGENTS.md', allWords: true },
    { lane: 'ai_dev', query: 'godot claude', allWords: true },
    { lane: 'ai_dev', query: 'godot mcp', allWords: true },
    { lane: 'ai_dev', query: 'unreal mcp', allWords: true },
    { lane: 'ai_dev', query: 'blender mcp', allWords: true },
    { lane: 'ai_dev', query: 'unity mcp', allWords: true },
    { lane: 'ai_dev', query: 'godot llm', allWords: true },
    { lane: 'ai_dev', query: 'game development ai', allWords: true },
    { lane: 'ai_dev', query: 'Hunyuan3D', allWords: true },
    { lane: 'ai_dev', query: 'TRELLIS.2', allWords: true },
    { lane: 'ai_dev', query: 'gaussian splatting', allWords: true },
    // Show HN titles: where plugins and agent tools launch. Sampled 2026-10-14,
    // about 85% of matches at 10+ points were dev-agent tools. 'mcp' is left out:
    // it pulls in CAD tools and DAWs that merely expose an MCP server.
    ...['coding agent', 'claude code', 'codex', 'plugin', 'skill', 'harness', 'tokens'].map((query) => ({
      lane: 'ai_dev' as const,
      query,
      allWords: true,
      showHn: true,
    })),
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
    // Technique posts draw fewer points than news; 15 was the bar where the ai_dev
    // queries stopped returning noise (sampled 2026-10-14).
    hnMinPointsByLane: { ai_dev: 15 },
    twitterMinLikes: 100,
  },

  // Empty until a throwaway account exists and RETTIWT_API_KEY is set (TODO T3).
  twitterLists: [],
  twitterQueries: [],

  sourceTimeoutMs: 20_000,
  bodyTimeoutMs: 8_000,
};

export default sourcesConfig;
