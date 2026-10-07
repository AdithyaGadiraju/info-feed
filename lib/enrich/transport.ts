/**
 * One `complete()` behind two very different back ends (ADR 0003).
 *
 * v1 runs on `cli`: the local `claude` binary, authenticated by Gadi's Claude
 * subscription, so enrichment costs rate-limit window rather than dollars. The
 * `api` path exists so the worker can move off this Mac later without the rest of
 * lib/enrich changing.
 *
 * Two callers share it: enrichment (no tools, the enrichment schema) and the
 * fact-check in lib/verify (web search on, its own schema). The defaults are
 * enrichment's, so that call is unchanged by the options below.
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

/**
 * A stuck child would hold the worker's tick forever. Measured: a 6-item chunk
 * spends ~50s producing ~5k output tokens, because every story scored 3+ carries a
 * 150-300 word detail. The ceiling has to clear a full chunk's generation, not a
 * trivial call, or the timeout fires on healthy work.
 */
const CLI_TIMEOUT_MS = 300_000;

const WEB_TOOLS = 'WebSearch,WebFetch';

/**
 * Distinguishable because a timeout is not a transient fault: the same input will
 * generate the same amount of text next time. Retrying it burns the whole ceiling
 * again for a certain second failure, so `enrichChunk` stops on this one.
 */
export class CliTimeoutError extends Error {
  constructor(ms: number) {
    super(`claude CLI timed out after ${ms}ms`);
    this.name = 'CliTimeoutError';
  }
}

export interface CompletionOptions {
  /** JSON Schema the answer must match. Defaults to the enrichment schema. */
  schema?: object;
  /** Let the model search and read the web before it answers. */
  webSearch?: boolean;
  effort?: 'low' | 'medium' | 'high';
  /** CLI only: how long the child may run before it is killed. */
  timeoutMs?: number;
}

let inFlight = 0;
const waiting: Array<() => void> = [];

/**
 * Caps concurrent model calls at `LLM_CONCURRENCY`, first come first served. A
 * finishing call hands its slot straight to the next waiter instead of freeing it,
 * so a call arriving in the same tick cannot take the slot and push the count over.
 */
async function withSlot<T>(work: () => Promise<T>): Promise<T> {
  if (inFlight >= env.llmConcurrency) {
    await new Promise<void>((resolve) => waiting.push(resolve));
  } else {
    inFlight += 1;
  }
  try {
    return await work();
  } finally {
    const next = waiting.shift();
    if (next) next();
    else inFlight -= 1;
  }
}

export function complete(
  system: string,
  user: string,
  opts: CompletionOptions = {},
): Promise<CompletionResult> {
  return withSlot(() =>
    env.llmTransport === 'api' ? completeViaApi(system, user, opts) : completeViaCli(system, user, opts),
  );
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
 *
 * `--json-schema` and `--effort` are the CLI's equivalents of the `output_config`
 * the API path sets. Without the schema the model omits `newStory.score` often
 * enough that a large share of calls were paid for twice: once for the rejected
 * response, once for the retry.
 *
 * With `webSearch` the session keeps exactly two tools, both read-only. `--tools`
 * has to name WebFetch because `--restricted` removes it otherwise.
 */
export function completeViaCli(
  system: string,
  user: string,
  opts: CompletionOptions = {},
): Promise<CompletionResult> {
  const timeoutMs = opts.timeoutMs ?? CLI_TIMEOUT_MS;
  const tools = opts.webSearch
    ? ['--tools', WEB_TOOLS, '--allowedTools', WEB_TOOLS]
    : ['--allowedTools', ''];
  const args = [
    '-p',
    '--output-format',
    'json',
    '--json-schema',
    JSON.stringify(opts.schema ?? ENRICH_JSON_SCHEMA),
    '--effort',
    opts.effort ?? 'low',
    '--model',
    env.llmModel,
    ...tools,
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
      reject(new CliTimeoutError(timeoutMs));
    }, timeoutMs);

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

/** Web search is billed per request on top of tokens: US$10 per 1,000 searches. */
const WEB_SEARCH_USD = 0.01;
/** Searches one fact-check may run. Bounds the cost of a call that keeps digging. */
const WEB_SEARCH_MAX_USES = 8;
/** A paused server-tool turn is resumed at most this many times before giving up. */
const MAX_PAUSE_RESUMES = 4;

function apiCost(model: string, u: TokenUsage, webSearches = 0): number | undefined {
  const p = PRICES[model];
  if (!p) return undefined;
  // Cache writes bill at 1.25x input, cache reads at 0.1x.
  const input = u.inputTokens + u.cacheCreationTokens * 1.25 + u.cacheReadTokens * 0.1;
  return (input * p.input + u.outputTokens * p.output) / 1_000_000 + webSearches * WEB_SEARCH_USD;
}

/**
 * The answer is the run of text blocks at the end of the response. With web search
 * on, the model may also write a sentence before a search, and that is not part of
 * the answer.
 */
function finalText(content: Anthropic.ContentBlock[]): string {
  const parts: string[] = [];
  for (let i = content.length - 1; i >= 0; i -= 1) {
    const block = content[i];
    if (block.type === 'text') parts.unshift(block.text);
    else if (parts.length > 0) break;
  }
  return parts.join('');
}

let client: Anthropic | null = null;

export async function completeViaApi(
  system: string,
  user: string,
  opts: CompletionOptions = {},
): Promise<CompletionResult> {
  if (!env.anthropicApiKey) {
    throw new Error('LLM_TRANSPORT=api needs ANTHROPIC_API_KEY');
  }
  client ??= new Anthropic({ apiKey: env.anthropicApiKey });

  const schema = (opts.schema ?? ENRICH_JSON_SCHEMA) as unknown as Record<string, unknown>;
  const messages: Anthropic.MessageParam[] = [{ role: 'user', content: user }];
  let usage = EMPTY_USAGE;
  let webSearches = 0;
  let response: Anthropic.Message;

  for (let resumes = 0; ; resumes += 1) {
    response = await client.messages.create({
      model: env.llmModel,
      max_tokens: 16000,
      // Adaptive thinking at low effort: this is judgement work, but bounded
      // judgement, and effort is the dial ADR 0003 names for keeping it cheap.
      thinking: { type: 'adaptive' },
      output_config: {
        effort: opts.effort ?? 'low',
        // Not constrained on a web-search call. Search answers carry citations, and
        // the API rejects citations next to a constrained format on document input.
        // Whether it does for search is untested, so this takes the request shape
        // that cannot be rejected: the prompt asks for the JSON and the caller's
        // validator checks it.
        ...(opts.webSearch ? {} : { format: { type: 'json_schema' as const, schema } }),
      },
      ...(opts.webSearch
        ? { tools: [{ type: 'web_search_20260209' as const, name: 'web_search' as const, max_uses: WEB_SEARCH_MAX_USES }] }
        : {}),
      // The one breakpoint goes on the system prompt, which is the only part of the
      // request that is byte-identical between runs (lib/enrich/prompt.ts).
      system: [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }],
      messages,
    });

    usage = addUsage(usage, {
      inputTokens: n(response.usage.input_tokens),
      outputTokens: n(response.usage.output_tokens),
      cacheCreationTokens: n(response.usage.cache_creation_input_tokens),
      cacheReadTokens: n(response.usage.cache_read_input_tokens),
    });
    webSearches += n(response.usage.server_tool_use?.web_search_requests);

    // The server stops a long search turn part way; sending the partial turn back
    // unchanged resumes it.
    if (response.stop_reason !== 'pause_turn' || resumes >= MAX_PAUSE_RESUMES) break;
    messages.push({ role: 'assistant', content: response.content });
  }

  return { text: finalText(response.content), usage, costUsd: apiCost(env.llmModel, usage, webSearches) };
}
