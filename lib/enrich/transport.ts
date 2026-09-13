/**
 * One `complete()` behind two very different back ends (ADR 0003).
 *
 * v1 runs on `cli`: the local `claude` binary, authenticated by Gadi's Claude
 * subscription, so enrichment costs rate-limit window rather than dollars. The
 * `api` path exists so the worker can move off this Mac later without the rest of
 * lib/enrich changing.
 */
import { spawn } from 'node:child_process';
import Anthropic from '@anthropic-ai/sdk';
import { env } from '../env';
import { ENRICH_JSON_SCHEMA } from './schema';

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  cacheCreationTokens: number;
  cacheReadTokens: number;
}

export interface CompletionResult {
  text: string;
  usage: TokenUsage;
  /** What the call cost, or would have cost on the API. Absent if unknown. */
  costUsd?: number;
}

export const EMPTY_USAGE: TokenUsage = {
  inputTokens: 0,
  outputTokens: 0,
  cacheCreationTokens: 0,
  cacheReadTokens: 0,
};

export function addUsage(a: TokenUsage, b: TokenUsage): TokenUsage {
  return {
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    cacheCreationTokens: a.cacheCreationTokens + b.cacheCreationTokens,
    cacheReadTokens: a.cacheReadTokens + b.cacheReadTokens,
  };
}

export function sumUsage(list: TokenUsage[]): TokenUsage {
  return list.reduce(addUsage, EMPTY_USAGE);
}

export function formatUsage(u: TokenUsage, costUsd?: number): string {
  const cost = costUsd === undefined ? '' : ` | $${costUsd.toFixed(4)}`;
  return `tokens in ${u.inputTokens} (cache write ${u.cacheCreationTokens}, cache read ${u.cacheReadTokens}) out ${u.outputTokens}${cost}`;
}

/** A stuck child would hold the worker's tick forever; 180s is far past a real call. */
const CLI_TIMEOUT_MS = 180_000;

export function complete(system: string, user: string): Promise<CompletionResult> {
  return env.llmTransport === 'api' ? completeViaApi(system, user) : completeViaCli(system, user);
}

// ---- cli ----

interface CliEnvelope {
  result?: unknown;
  is_error?: boolean;
  total_cost_usd?: number;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    cache_creation_input_tokens?: number;
    cache_read_input_tokens?: number;
  };
}

function n(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0;
}

/**
 * `--restricted` is not cosmetic: dropping the command-running tools from the
 * session took the per-call overhead from ~25k to ~14.2k input tokens in Gadi's
 * measurement. `--allowedTools ""` and `--strict-mcp-config` finish the job of
 * making this a plain one-shot completion rather than an agent.
 *
 * The user prompt goes in on stdin because 60 items with 2000-char bodies is well
 * past the OS argv limit; as an argv argument this fails with E2BIG at ~40 items.
 */
export function completeViaCli(system: string, user: string): Promise<CompletionResult> {
  const args = [
    '-p',
    '--output-format',
    'json',
    '--model',
    env.llmModel,
    '--allowedTools',
    '',
    '--strict-mcp-config',
    '--permission-mode',
    'dontAsk',
    '--restricted',
    '--max-budget-usd',
    String(env.llmMaxCallUsd),
    '--system-prompt',
    system,
  ];

  return new Promise<CompletionResult>((resolve, reject) => {
    const child = spawn('claude', args, { stdio: ['pipe', 'pipe', 'pipe'] });

    let stdout = '';
    let stderr = '';
    let settled = false;

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill('SIGKILL');
      reject(new Error(`claude CLI timed out after ${CLI_TIMEOUT_MS}ms`));
    }, CLI_TIMEOUT_MS);

    const finish = (err: Error | null, value?: CompletionResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (err) reject(err);
      else resolve(value as CompletionResult);
    };

    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (c: string) => {
      stdout += c;
    });
    child.stderr.on('data', (c: string) => {
      stderr += c;
    });

    child.on('error', (err) => finish(new Error(`could not spawn claude: ${err.message}`)));

    child.on('close', (code) => {
      if (code !== 0) {
        finish(new Error(`claude CLI exited ${code}: ${stderr.trim().slice(0, 500)}`));
        return;
      }
      let env_: CliEnvelope;
      try {
        env_ = JSON.parse(stdout) as CliEnvelope;
      } catch {
        finish(new Error(`claude CLI did not print JSON: ${stdout.trim().slice(0, 300)}`));
        return;
      }
      if (env_.is_error) {
        finish(new Error(`claude CLI reported an error: ${String(env_.result).slice(0, 500)}`));
        return;
      }
      if (typeof env_.result !== 'string') {
        finish(new Error('claude CLI response had no .result string'));
        return;
      }
      finish(null, {
        // .result is the model's text; the JSON answer is inside it and needs a
        // second parse, which is extractJsonObject's job.
        text: env_.result,
        usage: {
          inputTokens: n(env_.usage?.input_tokens),
          outputTokens: n(env_.usage?.output_tokens),
          cacheCreationTokens: n(env_.usage?.cache_creation_input_tokens),
          cacheReadTokens: n(env_.usage?.cache_read_input_tokens),
        },
        costUsd: typeof env_.total_cost_usd === 'number' ? env_.total_cost_usd : undefined,
      });
    });

    child.stdin.on('error', (err: Error) => finish(new Error(`claude stdin: ${err.message}`)));
    child.stdin.end(user, 'utf8');
  });
}

// ---- api ----

/** US$ per million tokens, for the models ADR 0003 allows in LLM_MODEL. */
const PRICES: Record<string, { input: number; output: number }> = {
  'claude-sonnet-5': { input: 2, output: 10 },
  'claude-haiku-4-5': { input: 1, output: 5 },
  'claude-opus-5': { input: 5, output: 25 },
};

function apiCost(model: string, u: TokenUsage): number | undefined {
  const p = PRICES[model];
  if (!p) return undefined;
  // Cache writes bill at 1.25x input, cache reads at 0.1x.
  const input = u.inputTokens + u.cacheCreationTokens * 1.25 + u.cacheReadTokens * 0.1;
  return (input * p.input + u.outputTokens * p.output) / 1_000_000;
}

let client: Anthropic | null = null;

export async function completeViaApi(system: string, user: string): Promise<CompletionResult> {
  if (!env.anthropicApiKey) {
    throw new Error('LLM_TRANSPORT=api needs ANTHROPIC_API_KEY');
  }
  client ??= new Anthropic({ apiKey: env.anthropicApiKey });

  const response = await client.messages.create({
    model: env.llmModel,
    max_tokens: 16000,
    // Adaptive thinking at low effort: this is judgement work, but bounded
    // judgement, and effort is the dial ADR 0003 names for keeping it cheap.
    thinking: { type: 'adaptive' },
    output_config: {
      effort: 'low',
      format: { type: 'json_schema', schema: ENRICH_JSON_SCHEMA as unknown as Record<string, unknown> },
    },
    // The one breakpoint goes on the system prompt, which is the only part of the
    // request that is byte-identical between runs (lib/enrich/prompt.ts).
    system: [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }],
    messages: [{ role: 'user', content: user }],
  });

  const text = response.content
    .filter((b): b is Anthropic.TextBlock => b.type === 'text')
    .map((b) => b.text)
    .join('');

  const usage: TokenUsage = {
    inputTokens: n(response.usage.input_tokens),
    outputTokens: n(response.usage.output_tokens),
    cacheCreationTokens: n(response.usage.cache_creation_input_tokens),
    cacheReadTokens: n(response.usage.cache_read_input_tokens),
  };

  return { text, usage, costUsd: apiCost(env.llmModel, usage) };
}
