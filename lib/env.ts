/**
 * Central env access. Loads `.env` once, for the CLI entrypoints (digest, worker,
 * scripts, tests). Next.js loads `.env` itself, so `dotenv` is a harmless no-op there.
 */
import { config as loadDotenv } from 'dotenv';
import { FEED_TIME_ZONE } from './feed/time';

loadDotenv({ quiet: true });

export type LlmTransport = 'cli' | 'api';

function str(name: string, fallback?: string): string {
  const v = process.env[name]?.trim();
  if (v) return v;
  if (fallback !== undefined) return fallback;
  throw new Error(`Missing required env var ${name}. Copy .env.example to .env and fill it in.`);
}

function opt(name: string): string | undefined {
  const v = process.env[name]?.trim();
  return v ? v : undefined;
}

function num(name: string, fallback: number): number {
  const v = process.env[name]?.trim();
  if (!v) return fallback;
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

export const env = {
  get databaseUrl(): string {
    return str('DATABASE_URL');
  },
  /** The worker's cron schedule zone only. Feed days (queries, filters, today) always use FEED_TIME_ZONE and ignore TZ. */
  get tz(): string {
    return str('TZ', FEED_TIME_ZONE);
  },
  get feedUser(): string | undefined {
    return opt('FEED_USER');
  },
  get feedPass(): string | undefined {
    return opt('FEED_PASS');
  },
  get llmTransport(): LlmTransport {
    return str('LLM_TRANSPORT', 'cli') === 'api' ? 'api' : 'cli';
  },
  /** Exact model id. Never append a date suffix (ADR 0003). */
  get llmModel(): string {
    return str('LLM_MODEL', 'claude-sonnet-5');
  },
  get anthropicApiKey(): string | undefined {
    return opt('ANTHROPIC_API_KEY');
  },
  /**
   * Hard ceiling on what one model call may spend, passed to the CLI as
   * `--max-budget-usd`. A runaway response is the only way a single call can cost
   * real money: 60 items each needing a 300-word detail summary is a legitimate
   * 24k-token answer, and nothing else bounds it. The worst call in the first real
   * run was US$0.21, so this leaves ample headroom and only trips on a genuine
   * runaway.
   */
  get llmMaxCallUsd(): number {
    return num('LLM_MAX_CALL_USD', 1);
  },
  /**
   * How many model calls may be in flight at once, enrichment and fact-checks
   * together. Every lane's enrichment overlaps in `npm run digest` and each digest
   * story gets its own fact-check call, so without a cap a full run would start
   * around fifty `claude` processes at the same moment.
   */
  get llmConcurrency(): number {
    return Math.max(1, Math.floor(num('LLM_CONCURRENCY', 8)));
  },
  /** Fact-check digest stories (score 4+) with web search. `off` disables it. */
  get verifyStories(): boolean {
    return str('VERIFY_STORIES', 'on').toLowerCase() !== 'off';
  },
  get enrichIntervalMin(): number {
    return num('ENRICH_INTERVAL_MIN', 60);
  },
  get rettiwtApiKey(): string | undefined {
    return opt('RETTIWT_API_KEY');
  },
  /** Optional. Raises GitHub's search limit from 10 to 30 requests a minute. */
  get githubToken(): string | undefined {
    return opt('GITHUB_TOKEN');
  },
};
