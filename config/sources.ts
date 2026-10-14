/**
 * Seed configuration for every source (ADR 0002). This file is curation, not code:
 * Gadi edits the feed and subreddit lists as the feed gets tuned. Expect churn here
 * for the first couple of weeks and none in the source modules.
 */
import { ACTIVE_LANES } from '../lib/db/types';
import type { SourcesConfig } from '../lib/sources/types';

/** Title gate for broad creative-AI feeds: keep only posts about game-usable assets. */
const ASSET_TOPICS = /\b3d\b|trellis|hunyuan|pixal3d|mesh|texture|pbr|sprite|pixel art|audio|music|sfx|sound effect|rigg|splat|world model/i;

/** Title gate for general AI-news channels: keep only game-asset and world topics. */
const GAME_AI_TOPICS = /\b3d\b|mesh|texture|sprite|pixel art|audio|music|sfx|sound|rigg|splat|world model|\bgames?\b|blender|unity|unreal|godot|roblox|mocap|motion capture|\bnpc|marble|genie|4d\b/i;

/** Title gate for the image-model subreddits: game-usable assets only. */
const ASSET_POSTS = /\b3d\b|\bmesh|hunyuan|trellis|tripo|\bpbr\b|texture (gen|map)|seamless|sprite|pixel ?art|tileset|isometric|\brig(ging|ged)?\b|mocap|motion capture|splat|world model|\bsfx\b|sound effect|foley|\bgames?\b|game asset|turnaround|character sheet/i;

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
    // ai_gamedev (AI Gamedev): AI tools and models for making games. Grouped with
    // ai and ai_dev, so the model files each story by content.
    // -- AI agents in game engines. The 3D trade press (CG Channel, fxguide) was dropped
    // on 2026-10-14: almost none of it was about AI. The Godot items suit a Godot 4
    // C# workflow; both repos ship release notes worth reading.
    { lane: 'ai_gamedev', name: 'GodotPrompter releases', url: 'https://github.com/jame581/GodotPrompter/releases.atom' },
    { lane: 'ai_gamedev', name: 'Godot AI (MCP) releases', url: 'https://github.com/hi-godot/godot-ai/releases.atom' },
    { lane: 'ai_gamedev', name: 'Ziva (Godot AI)', url: 'https://ziva.sh/feed.xml' },
    { lane: 'ai_gamedev', name: 'Kyle Kukshtel', url: 'https://kylekukshtel.com/feed.rss' },
    // -- AI game development, researched and verified live on 2026-10-14. Engine
    // vendors' own AI announcements first: official and accurate, so worth a
    // title filter on otherwise noisy feeds. The Unity blog also feeds gamedev
    // below; a post in both keeps the first lane listed, so its AI posts land here.
    { lane: 'ai_gamedev', name: 'Unity blog (AI)', url: 'https://blog.unity.com/feed', include: /\b(AI|assistant|agent|MCP|Claude|Codex|Copilot|Cursor|Gemini|CLI|Muse|Sentis)\b/i },
    { lane: 'ai_gamedev', name: 'Roblox announcements (AI)', url: 'https://devforum.roblox.com/c/updates/announcements/36.rss', include: /assistant|\bMCP\b|\bAI\b|generat|agent|LLM|procedural models/i },
    { lane: 'ai_gamedev', name: 'Unreal announcements (AI)', url: 'https://forums.unrealengine.com/c/general/announcements/49.rss', include: /\bMCP\b|\bAI\b|agent|assistant|LLM/i },
    { lane: 'ai_gamedev', name: 'Godot forum plugins (AI)', url: 'https://forum.godotengine.org/c/resources/plugins/21.rss', include: /\bMCP\b|\bAI\b|claude|codex|agent|LLM/i },
    { lane: 'ai_gamedev', name: 'Godot forum tools (AI)', url: 'https://forum.godotengine.org/c/showcase/tools/16.rss', include: /\bMCP\b|\bAI\b|claude|codex|agent|LLM/i },
    // -- analysts and practitioners writing about AI game development
    { lane: 'ai_gamedev', name: 'Naavik (AI gaming)', url: 'https://naavik.co/category/ai-gaming/feed/' },
    { lane: 'ai_gamedev', name: 'AI Gamechangers', url: 'https://aigamechangers.substack.com/feed' },
    { lane: 'ai_gamedev', name: 'GamesIndustry.biz (AI)', url: 'https://www.gamesindustry.biz/feed', include: /\bAI\b|generative|LLM|machine learning|Claude|Codex|agentic/i },
    { lane: 'ai_gamedev', name: 'Games Alchemy', url: 'https://gamesalchemy.substack.com/feed', include: /\bAI\b/i },
    { lane: 'ai_gamedev', name: 'Game Dev Dairy', url: 'https://gamedevdairy.substack.com/feed', include: /\bAI\b|vibe|Claude|agent|LLM/i },
    // -- asset generation: 3D, textures, sprites, motion, audio. Most vendors have
    // no feed; the docs watches below cover the ones with a usable sitemap.
    { lane: 'ai_gamedev', name: 'ComfyUI blog (assets)', url: 'https://blog.comfy.org/feed', include: ASSET_TOPICS, exclude: /challenge/i },
    { lane: 'ai_gamedev', name: 'pixaroma (YouTube)', url: 'https://www.youtube.com/feeds/videos.xml?channel_id=UCmMbwA-s3GZDKVzGZ-kPwaQ', include: ASSET_TOPICS },
    { lane: 'ai_gamedev', name: 'ElevenLabs (audio models)', url: 'https://elevenlabs.io/blog/rss.xml', include: /^introducing (eleven v\d|music|sound)|sound effects?|\bsfx\b|music v\d|\bgames?\b/i },
    { lane: 'ai_gamedev', name: 'Stability AI (audio, 3D)', url: 'https://stability.ai/news-updates?format=rss', include: /stable audio|3d|game/i },
    // arXiv papers on assets a game can ship: PBR, textures, rigging, sprites, low-poly.
    { lane: 'ai_gamedev', name: 'arXiv (game asset generation)', url: 'https://export.arxiv.org/api/query?search_query=(cat:cs.CV%20OR%20cat:cs.GR)%20AND%20(ti:%22PBR%22%20OR%20ti:%22texture%20generation%22%20OR%20ti:%22auto-rigging%22%20OR%20ti:%22pixel%20art%22%20OR%20ti:sprite%20OR%20ti:%22game%20asset%22%20OR%20ti:%22low-poly%22%20OR%20ti:retopology)&sortBy=submittedDate&sortOrder=descending&max_results=25' },
    // arXiv titles on 3D, motion and world generation, ~3 a day, about 95% on topic.
    // No overlap with the query above. "world model", "game", "rigging" and
    // "skinning" are left out: arXiv stems them into robotics and skin-lesion papers.
    { lane: 'ai_gamedev', name: 'arXiv (3D, motion, world gen)', url: 'https://export.arxiv.org/api/query?search_query=(cat:cs.CV%20OR%20cat:cs.GR)%20AND%20(ti:%22text-to-3D%22%20OR%20ti:%22image-to-3D%22%20OR%20ti:%223D%20generation%22%20OR%20ti:%223D%20asset%22%20OR%20ti:%22mesh%20generation%22%20OR%20ti:%223D%20generative%22%20OR%20ti:%22text-to-motion%22%20OR%20ti:%22motion%20generation%22%20OR%20ti:%22skinning%20weights%22%20OR%20ti:%22scene%20generation%22%20OR%20ti:%22world%20generation%22%20OR%20ti:%223D%20texture%22%20OR%20ti:%22stylized%203D%22%20OR%20ti:%22game%20world%22)&sortBy=submittedDate&sortOrder=descending&max_results=50' },
    // -- YouTube, verified live on 2026-10-14 (a channel feed holds its newest 15).
    // 3D, splat and Blender tool news.
    { lane: 'ai_gamedev', name: 'Radiance Fields (YouTube)', url: 'https://www.youtube.com/feeds/videos.xml?channel_id=UCvxZ0tCKgCrrgfGu_175NIA' },
    // New free and open 3D tools, ~13 a month.
    { lane: 'ai_gamedev', name: 'askNK (YouTube)', url: 'https://www.youtube.com/feeds/videos.xml?channel_id=UCHx1jeKRMi_wDAwvvhaIDYA' },
    // Blender add-on roundups.
    { lane: 'ai_gamedev', name: 'InspirationTuts (YouTube)', url: 'https://www.youtube.com/feeds/videos.xml?channel_id=UCDdv3C21EFv7MxBMu70OExw', include: /\bAI\b|add-?ons?|generat|released|open.?source|free .*(tool|software)/i },
    // Local AI world generation, 4D, ComfyUI with Blender; about one a month.
    { lane: 'ai_gamedev', name: 'Mickmumpitz (YouTube)', url: 'https://www.youtube.com/feeds/videos.xml?channel_id=UCKBURc62w9crMI1BhzHRnvw' },
    // General creative-AI news channels, gated to game topics.
    { lane: 'ai_gamedev', name: 'Theoretically Media (YouTube)', url: 'https://www.youtube.com/feeds/videos.xml?channel_id=UC9Ryt3XOGYBoAJVsBHNGDzA', include: GAME_AI_TOPICS },
    { lane: 'ai_gamedev', name: 'AI Search (YouTube)', url: 'https://www.youtube.com/feeds/videos.xml?channel_id=UCIgnGlGkVRhd4qNFcEwLL4A', include: GAME_AI_TOPICS },
    // Vendors whose launches show up on YouTube first. Hashtag titles are shorts.
    { lane: 'ai_gamedev', name: 'Hyper3D Rodin (YouTube)', url: 'https://www.youtube.com/feeds/videos.xml?channel_id=UCkvcj7B61MXxmlx79cZNN5g' },
    { lane: 'ai_gamedev', name: 'Tripo (YouTube)', url: 'https://www.youtube.com/feeds/videos.xml?channel_id=UCUxEy0OUAdRja1OOdTNL6oQ', exclude: /\bprint|#\w/i },
    { lane: 'ai_gamedev', name: 'Meshy (YouTube)', url: 'https://www.youtube.com/feeds/videos.xml?channel_id=UCz9e8s9x8QbyyYTGftoXn2g', exclude: /#\w/ },
    { lane: 'ai_gamedev', name: 'Cascadeur (YouTube)', url: 'https://www.youtube.com/feeds/videos.xml?channel_id=UCwF6yYbIFJmB5ynAkzq9Psg', exclude: /#\w/ },
    { lane: 'ai_gamedev', name: 'Convai (YouTube)', url: 'https://www.youtube.com/feeds/videos.xml?channel_id=UCcYtXgiavJYMKSirsk6VNsw' },
    { lane: 'ai_gamedev', name: 'World Labs (YouTube)', url: 'https://www.youtube.com/feeds/videos.xml?channel_id=UChrAtfl7o4zpvkQMY6StcJg' },
    { lane: 'ai_gamedev', name: 'Rokoko (YouTube)', url: 'https://www.youtube.com/feeds/videos.xml?channel_id=UC4lC3oAfOCzU2ZCaKZj3Iww' },
    // -- newsletters and communities
    // 3DGS and spatial-AI tools weekly, about 85% on topic.
    { lane: 'ai_gamedev', name: 'XR AI Spotlight', url: 'https://xraispotlight.substack.com/feed' },
    { lane: 'ai_gamedev', name: 'PocketGamer.biz (AI)', url: 'https://www.pocketgamer.biz/rss/', include: /\bAI\b|generative|\bLLM|agentic|\bagents?\b/i },
    // 25 posts a day; the gate keeps AI plugins.
    { lane: 'ai_gamedev', name: 'Roblox DevForum resources (AI)', url: 'https://devforum.roblox.com/c/resources/community-resources.rss', include: /\bAI\b|\bMCP\b|\bLLM|claude|codex|gpt|gemini|generat/i },
    // Where niche tools launch: AI sprite generators, GDevelop, Tiled, Krita and Aseprite MCPs.
    { lane: 'ai_gamedev', name: 'itch.io tools (ai)', url: 'https://itch.io/tools/newest/tag-ai.xml' },
    { lane: 'ai_gamedev', name: 'itch.io tools (mcp)', url: 'https://itch.io/tools/newest/tag-mcp.xml' },
    // -- GitHub releases of engine MCP servers and open asset tools. Each repo was
    // checked to publish releases; a ".0$" gate keeps minor versions of busy ones.
    { lane: 'ai_gamedev', name: 'unity-mcp releases', url: 'https://github.com/CoplayDev/unity-mcp/releases.atom' },
    { lane: 'ai_gamedev', name: 'Unity-MCP (IvanMurzak) releases', url: 'https://github.com/IvanMurzak/Unity-MCP/releases.atom', include: /\.0$/ },
    { lane: 'ai_gamedev', name: 'Unreal_mcp releases', url: 'https://github.com/ChiR24/Unreal_mcp/releases.atom' },
    { lane: 'ai_gamedev', name: 'robloxstudio-mcp releases', url: 'https://github.com/Chrrxs/robloxstudio-mcp/releases.atom', include: /\.0$/ },
    { lane: 'ai_gamedev', name: 'godot-mcp-pro releases', url: 'https://github.com/youichi-uda/godot-mcp-pro/releases.atom' },
    // blender-mcp publishes no releases; feature commits stand in for them.
    { lane: 'ai_gamedev', name: 'blender-mcp features', url: 'https://github.com/ahujasid/blender-mcp/commits/main.atom', include: /^feat/i },
    // Local image-to-3D desktop app.
    { lane: 'ai_gamedev', name: 'Modly releases', url: 'https://github.com/lightningpixel/modly/releases.atom' },
    { lane: 'ai_gamedev', name: 'img2threejs releases', url: 'https://github.com/img2threejs/img2threejs/releases.atom' },
    { lane: 'ai_gamedev', name: 'SuperSplat releases', url: 'https://github.com/playcanvas/supersplat/releases.atom', include: /\.0$/ },
    { lane: 'ai_gamedev', name: 'Spark (3DGS) releases', url: 'https://github.com/sparkjsdev/spark/releases.atom' },
    { lane: 'ai_gamedev', name: 'KIRI 3DGS Blender releases', url: 'https://github.com/Kiri-Innovation/3dgs-render-blender-addon/releases.atom' },
    { lane: 'ai_gamedev', name: 'Text-To-VRMA releases', url: 'https://github.com/Kirakun0328/text-to-vrma/releases.atom' },
    // Rare but big voice-model drops.
    { lane: 'ai_gamedev', name: 'Fish Speech releases', url: 'https://github.com/fishaudio/fish-speech/releases.atom' },
    // -- vendors with a feed, verified live on 2026-10-14 with the app's user agent.
    // Mirelo: video-to-SFX, foley and audio-to-MIDI releases, ~4 a month, all on topic.
    { lane: 'ai_gamedev', name: 'Mirelo', url: 'https://mirelo.ai/feed.xml' },
    // Model launches (V8, Edit, Thinking Mode), ~6 a month; the weekly alpha changelog is skipped.
    { lane: 'ai_gamedev', name: 'Midjourney updates', url: 'https://updates.midjourney.com/rss/', exclude: /^alpha changelog/i },
    // Game-character voice and TTS models, ~2 a month after the filter.
    { lane: 'ai_gamedev', name: 'Inworld (voice)', url: 'https://inworld.ai/blog/rss.xml', include: /\bTTS\b|voice model|speech|introducing|\bgames?\b|character/i },
    // SuperSplat and gaussian splats in a game engine, ~2 a month after the filter.
    { lane: 'ai_gamedev', name: 'PlayCanvas (splats)', url: 'https://blog.playcanvas.com/rss.xml', include: /splat|gaussian|\bAI\b|vibe|3D scan|digital twin/i },
    // Headshot AI head generation, AccuRIG, video mocap, ~4 a month after the filter.
    { lane: 'ai_gamedev', name: 'Reallusion (AI)', url: 'https://magazine.reallusion.com/feed/', include: /\bAI\b|generat|headshot|accurig|mocap|motion capture|video to/i },
    // About 50 posts a month; the filter keeps game-dev roundups, ACE and 3D asset AI.
    { lane: 'ai_gamedev', name: 'NVIDIA Developer (games/3D)', url: 'https://developer.nvidia.com/blog/feed', include: /game|gaussian|splat|\bACE\b|audio2face|neural render|RTX Kit|edify|3D (asset|generat|scene|content|model)|text-to-3d|world model/i },
    // Omniverse, Cosmos and ACE. "game develop" leaves out the weekly GeForce NOW posts.
    { lane: 'ai_gamedev', name: 'NVIDIA blog (Omniverse/ACE)', url: 'https://blogs.nvidia.com/feed/', include: /omniverse|\bACE\b|gaussian|world model|3D generat|RTX AI|game develop|edify|cosmos/i },
    // Neither repo publishes releases, so these read commits and keep the release ones.
    { lane: 'ai_gamedev', name: 'Roblox Cube releases', url: 'https://github.com/Roblox/cube/commits/main.atom', include: /release/i },
    { lane: 'ai_gamedev', name: 'TRELLIS.2 releases', url: 'https://github.com/microsoft/TRELLIS.2/commits/main.atom', include: /release/i },
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
    { lane: 'ai_gamedev', name: 'fal.ai 3D and audio models', url: 'https://fal.ai/sitemap.xml', format: 'sitemap', prefixes: ['/models/meshy/', '/models/fal-ai/meshy', '/models/tripo3d/', '/models/hitem3d/', '/models/fal-ai/hyper3d/', '/models/fal-ai/hunyuan3d', '/models/fal-ai/hunyuan-3d', '/models/fal-ai/hunyuan-motion', '/models/fal-ai/hunyuan_world', '/models/fal-ai/trellis', '/models/fal-ai/stable-audio', '/models/mirelo-ai/', '/models/sonilo/', '/models/elevenlabs/'] },
    { lane: 'ai_gamedev', name: 'Meshy launches', url: 'https://www.meshy.ai/llms.txt', format: 'llms', prefixes: ['/blog/meshy-'] },
    { lane: 'ai_gamedev', name: 'Scenario', url: 'https://www.scenario.com/sitemap.xml', format: 'sitemap', prefixes: ['/blog/', '/explorations/'] },
    { lane: 'ai_gamedev', name: 'World Labs', url: 'https://www.worldlabs.ai/sitemap.xml', format: 'sitemap', prefixes: ['/blog/', '/labs/learn/'] },
    { lane: 'ai_gamedev', name: 'Uthana', url: 'https://uthana.com/sitemap.xml', format: 'sitemap', prefixes: ['/blog/'] },
    { lane: 'ai_gamedev', name: 'Bezi', url: 'https://www.bezi.com/sitemap.xml', format: 'sitemap', prefixes: ['/blog/'] },
    // Vendors with no feed, verified live on 2026-10-14. Each url is the child
    // sitemap that holds the posts, because the watcher does not follow an index.
    // Tripo, Luma, Recraft, Suno, Cascadeur, Move.ai and Adobe have no usable
    // listing (403, HTML only or stale); fal.ai and Layer carry their models.
    // Rodin's blog is mostly SEO, so only the news slugs are kept.
    { lane: 'ai_gamedev', name: 'Hyper3D Rodin', url: 'https://hyper3d.ai/landing-sitemap-blog-en.xml', format: 'sitemap', prefixes: ['/blog/hyper3d-', '/blog/rodin', '/blog/deemos-'] },
    // Layer's catalog adds a page when a vendor ships a model, ~3-5 a month. It
    // overlaps fal.ai; the enrichment pass collapses the same model into one story.
    { lane: 'ai_gamedev', name: 'Layer (blog, 3D and audio models)', url: 'https://layer.ai/sitemap-0.xml', format: 'sitemap', prefixes: ['/blog/', '/models/tripo3d-', '/models/hyper3d-', '/models/hitem3d-', '/models/meshy-', '/models/microsoft-trellis', '/models/tencent-hunyuan3d', '/models/bytedance-seed3d', '/models/meta-sam-3-3d', '/models/uthana-', '/models/fal-patina', '/models/image2pixel', '/models/mirelo-', '/models/sonilo-', '/models/stable-audio', '/models/cassetteai-', '/models/elevenlabs-sound', '/models/elevenlabs-music', '/models/lyria-', '/models/minimax-music', '/models/mureka-', '/models/ace-step', '/models/seed-audio', '/models/tencent-hunyuan-video-foley', '/models/kling-video-to-audio'] },
    { lane: 'ai_gamedev', name: 'Black Forest Labs', url: 'https://bfl.ai/sitemap.xml', format: 'sitemap', prefixes: ['/blog/', '/models/', '/research/'] },
    // /sitemap.xml is 403; this child is 200.
    { lane: 'ai_gamedev', name: 'Ideogram', url: 'https://ideogram.ai/sitemap-0.xml', format: 'sitemap', prefixes: ['/blog/', '/models/'] },
    // Includes the audio models: pika-sfx, pika-music, pika-speech.
    { lane: 'ai_gamedev', name: 'Pika', url: 'https://pika.art/sitemap.xml', format: 'sitemap', prefixes: ['/blog/'] },
    // World models (GWM Worlds 2, Solaris).
    { lane: 'ai_gamedev', name: 'Runway research', url: 'https://runway.com/sitemap.xml', format: 'sitemap', prefixes: ['/research/', '/news/research/', '/news/developers/'] },
    { lane: 'ai_gamedev', name: 'MetaHuman', url: 'https://www.metahuman.com/sitemap.xml', format: 'sitemap', prefixes: ['/news/'] },
    // Gaussian splats and world models, ~5 a month.
    { lane: 'ai_gamedev', name: 'Niantic Spatial', url: 'https://www.nianticspatial.com/sitemap.xml', format: 'sitemap', prefixes: ['/blog/'] },
    // Seed3D, Seed Audio, Seedream.
    { lane: 'ai_gamedev', name: 'ByteDance Seed', url: 'https://seed.bytedance.com/sitemap.xml', format: 'sitemap', prefixes: ['/blog/'] },
    { lane: 'ai_gamedev', name: 'Hume (voice)', url: 'https://www.hume.ai/sitemap.xml', format: 'sitemap', prefixes: ['/blog/'] },
    // Mocap, including AI video mocap; some SEO guides get through.
    { lane: 'ai_gamedev', name: 'Rokoko', url: 'https://www.rokoko.com/sitemap.xml', format: 'sitemap', prefixes: ['/insights/'] },
    // AI NPCs for Unity and Unreal; mostly tutorials.
    { lane: 'ai_gamedev', name: 'Convai', url: 'https://convai.com/sitemap.xml', format: 'sitemap', prefixes: ['/blog/'] },
    { lane: 'ai_gamedev', name: 'Spline changelog', url: 'https://updates.spline.design/sitemap.xml', format: 'sitemap', prefixes: ['/changelog/'] },
    // A new docs or tool page is a new generator (sprites, 3D, audio, MCP). The blog is indie spotlights.
    { lane: 'ai_gamedev', name: 'Ludo.ai docs', url: 'https://ludo.ai/sitemap-0.xml', format: 'sitemap', prefixes: ['/docs/', '/developers/', '/tools/'] },
    { lane: 'ai_gamedev', name: 'Krea models', url: 'https://www.krea.ai/sitemap.xml', format: 'sitemap', prefixes: ['/models/'] },
    // leonardo.ai is 403 everywhere; a new model guide in its API docs is the signal.
    { lane: 'ai_gamedev', name: 'Leonardo.ai docs', url: 'https://docs.leonardo.ai/llms.txt', format: 'llms', prefixes: ['/docs/'] },
    // One page per pixel-art sprite and animation tool.
    { lane: 'ai_gamedev', name: 'PixelLab tools', url: 'https://www.pixellab.ai/llms.txt', format: 'llms', prefixes: ['/docs/tools/', '/docs/guides/'] },
    { lane: 'ai_gamedev', name: 'Unity AI docs', url: 'https://docs.unity.com/ai/llms.txt', format: 'llms', prefixes: ['/en-us/ai/'] },
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
    // ai_gamedev. Every one is solo with a gate: in a shared listing of 100 the big
    // subreddits crowd these out before the gate runs. Each solo is one more request
    // at Reddit's 30s spacing, so the low-yield ones (threejs, computergraphics,
    // proceduralgeneration) were left out. Gates measured on hot, 2026-10-14.
    // r/aigamedev posts ~60 a day, mostly showcases; the gate keeps tool, model and
    // workflow posts.
    { lane: 'ai_gamedev', sub: 'aigamedev', solo: true, include: /\b(tools?|plugin|add-?on|mcp|generator|model|3d|mesh|sprites?|pixel ?art|textures?|rigg?ing|animation|sfx|sound|music|voice|tts|splats?|world model|meshy|tripo|rodin|hunyuan|trellis|pixellab|retro ?diffusion|scenario|ludo|suno|elevenlabs|open.?source|released?|launch)|claude|codex|cursor|agents?\.md|workflow|pipeline|godot|unity|unreal|blender|prompt|skill/i },
    { lane: 'ai_gamedev', sub: 'StableDiffusion', solo: true, include: ASSET_POSTS },
    { lane: 'ai_gamedev', sub: 'comfyui', solo: true, include: ASSET_POSTS },
    // About 65% of what passes is a tool or plugin.
    { lane: 'ai_gamedev', sub: 'gaussiansplatting', solo: true, include: /\b(releas|open.?sourc|launch|introduc|announc|plugin|add-?on|blender|unity|unreal|godot|three\.?js|playcanvas|supersplat|spark|games?|tool|v\d|update|now (supports|available)|built|i made|generat|world model|marble|ai\b)/i },
    { lane: 'ai_gamedev', sub: 'robloxgamedev', solo: true, include: /\bAI\b|\bmcp\b|\bllm|claude|codex|gpt|gemini|assistant/i },
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
    { lane: 'ai_gamedev', query: 'godot claude', allWords: true },
    { lane: 'ai_gamedev', query: 'godot mcp', allWords: true },
    { lane: 'ai_gamedev', query: 'unreal mcp', allWords: true },
    { lane: 'ai_gamedev', query: 'blender mcp', allWords: true },
    { lane: 'ai_gamedev', query: 'unity mcp', allWords: true },
    { lane: 'ai_gamedev', query: 'godot llm', allWords: true },
    { lane: 'ai_gamedev', query: 'game development ai', allWords: true },
    { lane: 'ai_gamedev', query: 'Hunyuan3D', allWords: true },
    { lane: 'ai_gamedev', query: 'TRELLIS.2', allWords: true },
    { lane: 'ai_gamedev', query: 'gaussian splatting', allWords: true },
    // HN carries little for this lane, so it passes at 4 points (hnMinPointsByLane).
    // About half of each query's hits in 90 days were on topic at that bar.
    { lane: 'ai_gamedev', query: '3D generation', allWords: true },
    { lane: 'ai_gamedev', query: 'AI 3D model', allWords: true },
    // Show HN titles: "Blender for AI Agents", "Auto-Rig Web", pixel-art sprite
    // generators, splat browser games. About 40% on topic.
    ...['blender', 'pixel art', 'sprite', 'rigging', '3D model', 'game assets', 'gaussian', 'roblox', 'procedural'].map((query) => ({
      lane: 'ai_gamedev' as const,
      query,
      allWords: true,
      showHn: true,
    })),
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
    // ai_gamedev and ai_dev sit before ai on purpose: their keywords are the
    // specific ones, and "claude" / "openai" in the ai rule would otherwise swallow
    // every tooling story. ai_gamedev goes first so "blender mcp" beats "mcp".
    { lane: 'ai_gamedev', keywords: ['text-to-3d', 'image-to-3d', 'text to 3d', 'image to 3d', '3d generation', '3d model generat', 'hunyuan3d', 'trellis', 'gaussian splat', 'blender mcp', 'godot mcp', 'unity mcp', 'unreal mcp', 'world model', 'text-to-motion', 'pixel art ai', 'ai sprite', 'ai npc', 'ai game', 'game asset'] },
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
    // queries stopped returning noise (sampled 2026-10-14). ai_gamedev tool launches
    // rarely clear 10, and that lane wants volume; the model does the filtering.
    hnMinPointsByLane: { ai_dev: 15, ai_gamedev: 4 },
    twitterMinLikes: 100,
  },

  // Hugging Face Hub (lib/sources/huggingface.ts): models created in the last 30
  // days with at least `minLikes`, from the trending listing, and Daily Papers from
  // the last four days that pass a title gate. Thresholds verified live on
  // 2026-10-14 against the last year of each listing: the releases that mattered
  // (TRELLIS.2, Pixal3D, HY-Motion, Stable Audio 3) all passed hundreds of likes.
  huggingface: {
    models: [
      // Quiet month: nothing new above 25 (best was Mira-Scene at 14), but
      // ABot-Recon (26) and Pixal3D (375) would have passed in their first weeks.
      { lane: 'ai_gamedev', name: 'image-to-3d', pipelineTag: 'image-to-3d', minLikes: 25 },
      // HY-Motion (text-to-motion) is filed under this tag, as is BlenderLLM.
      { lane: 'ai_gamedev', name: 'text-to-3d', pipelineTag: 'text-to-3d', minLikes: 25 },
      // Busy with YuE2 LoRAs at 1-20 likes; 50 keeps the base releases (YuE2-3B 1148).
      { lane: 'ai_gamedev', name: 'text-to-audio', pipelineTag: 'text-to-audio', minLikes: 50 },
      // Game voice. Six models in 30 days reached 40+, so the bar is higher here:
      // 100 kept Fish Audio Drama 3 (272) and ema-lightning (409).
      { lane: 'ai_gamedev', name: 'text-to-speech', pipelineTag: 'text-to-speech', minLikes: 100 },
    ],
    papers: [
      // Title only: abstracts mention 3D or audio in passing. The exclude drops the
      // robotics world-model papers that dominate "3D" and "motion" titles. At 20
      // upvotes, 2026-10-06 to 10-14 kept Tetris3D, OuroWorld, WorldSonus,
      // Recursive Game Creator, SWE-Game and Kandinsky 6.0 Video (joint audio).
      {
        lane: 'ai_gamedev',
        name: 'Daily Papers (game assets)',
        include: /\b3d\b|\b4d\b|mesh|texture|\bpbr\b|material|rigg|motion|animat|avatar|character|sprite|pixel art|gaussian splat|3dgs|\bgames?\b|audio|sound|music|\bsfx\b|foley|scene generation|world generation|interactive world|world model|asset/i,
        exclude: /robot|manipulat|embodied|humanoid|\bvla\b|world[- ]action|\bwam\b|driving|navigation|medical|\bct\b|\bmri\b|surgical|tactile|\bgui\b/i,
        minUpvotes: 20,
      },
    ],
  },

  // GitHub repositories created in the last 30 days, by stars (lib/sources/github.ts).
  // At most 10: that is the unauthenticated search budget per minute. Each bar was
  // set from a live search on 2026-10-14; the comment is what it would keep today.
  github: [
    // Roqer, an agent for Roblox Studio (138). The rest are under 15.
    { lane: 'ai_gamedev', name: 'Blender MCP', query: 'blender mcp', minStars: 20 },
    // blender-ai-addon, chat-to-model in Blender (212).
    { lane: 'ai_gamedev', name: 'Blender AI add-ons', query: 'topic:blender-addon ai', minStars: 20 },
    // Godot-MCP (24).
    { lane: 'ai_gamedev', name: 'Godot MCP', query: 'godot mcp', minStars: 15 },
    // Nothing yet; the best was a Unity profiling agent at 12.
    { lane: 'ai_gamedev', name: 'Unity MCP', query: 'unity mcp', minStars: 15 },
    // Nothing yet; the best was 7.
    { lane: 'ai_gamedev', name: 'Unreal MCP', query: 'unreal mcp', minStars: 15 },
    // PixelArtistry Watertight Meshes (71), a Roblox asset cost tracker (69), Slate
    // previs (44), CarveAnything (26). Tripo SEO repos sit at 14-15, under the bar.
    { lane: 'ai_gamedev', name: 'Image to 3D', query: 'image-to-3d', minStars: 25 },
    // Watertight Meshes again, Pixal3D Multiview (21), and two off-topic image tools.
    { lane: 'ai_gamedev', name: 'ComfyUI 3D', query: 'comfyui 3d', minStars: 20 },
    // TostAI Sprite Sheet Studio (76).
    { lane: 'ai_gamedev', name: 'AI sprite sheets', query: 'sprite sheet ai', minStars: 15 },
    // agent-audio, a sound generation MCP for coding agents (42).
    { lane: 'ai_gamedev', name: 'AI sound effects', query: 'sound effects ai', minStars: 20 },
    // PAMI-Code (81). HY-Motion front ends are at 2-3.
    { lane: 'ai_gamedev', name: 'Text to motion', query: 'text-to-motion', minStars: 20 },
  ],

  // Empty until a throwaway account exists and RETTIWT_API_KEY is set (TODO T3).
  twitterLists: [],
  twitterQueries: [],

  sourceTimeoutMs: 20_000,
  bodyTimeoutMs: 8_000,
};

export default sourcesConfig;
