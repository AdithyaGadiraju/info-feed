/**
 * Central env access. Loads `.env` once, for the CLI entrypoints (digest, worker,
 * scripts, tests). Next.js loads `.env` itself, so `dotenv` is a harmless no-op there.
 */
import { config as loadDotenv } from 'dotenv';

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
  get tz(): string {
    return str('TZ', 'Australia/Sydney');
  },
  get discordWebhook(): string | undefined {
    return opt('DISCORD_WEBHOOK_URL');
  },
  /** Optional per-lane mirror. The main webhook always receives the lane as well. */
  discordLaneWebhook(lane: string): string | undefined {
    return opt(`DISCORD_WEBHOOK_URL_${lane.toUpperCase()}`);
  },
  get feedBaseUrl(): string {
    return str('FEED_BASE_URL', 'http://localhost:3005').replace(/\/+$/, '');
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
  get enrichIntervalMin(): number {
    return num('ENRICH_INTERVAL_MIN', 60);
  },
  get rettiwtApiKey(): string | undefined {
    return opt('RETTIWT_API_KEY');
  },
};
