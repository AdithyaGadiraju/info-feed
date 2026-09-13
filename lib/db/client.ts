import postgres from 'postgres';
import { env } from '../env';

/**
 * One `postgres` client for the whole process.
 *
 * DATABASE_URL must be the Supavisor POOLER string in transaction mode, so
 * prepared statements are disabled (`prepare: false`) — transaction-mode pooling
 * hands each statement a different backend and named prepares do not survive that.
 */
let _sql: postgres.Sql | null = null;

export function db(): postgres.Sql {
  if (_sql) return _sql;
  _sql = postgres(env.databaseUrl, {
    prepare: false,
    max: 5,
    idle_timeout: 20,
    connect_timeout: 15,
    onnotice: () => {},
  });
  return _sql;
}

export async function closeDb(): Promise<void> {
  if (_sql) {
    await _sql.end({ timeout: 5 });
    _sql = null;
  }
}

/** https://supabase.com/dashboard/project/<ref>, derived from the pooler username. */
export function dashboardUrl(): string {
  try {
    const user = decodeURIComponent(new URL(env.databaseUrl).username);
    const ref = user.includes('.') ? user.split('.').pop() : undefined;
    return ref
      ? `https://supabase.com/dashboard/project/${ref}`
      : 'https://supabase.com/dashboard/projects';
  } catch {
    return 'https://supabase.com/dashboard/projects';
  }
}

const PAUSED_CODES = new Set([
  'ENOTFOUND',
  'ECONNREFUSED',
  'ETIMEDOUT',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'CONNECT_TIMEOUT',
  'CONNECTION_CLOSED',
  'CONNECTION_ENDED',
]);

/**
 * A Supabase Free project pauses after 7 days without database activity and the
 * connection then simply fails. Turn that into the one instruction that fixes it
 * rather than a raw socket error (ADR 0001 Consequences).
 */
export function isProjectPausedError(err: unknown): boolean {
  const code = (err as { code?: string } | null)?.code;
  return typeof code === 'string' && PAUSED_CODES.has(code);
}

/**
 * Wrap an entrypoint so a paused project prints the resume instruction and exits
 * non-zero instead of dumping a stack trace.
 */
export async function withDb<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    if (isProjectPausedError(err)) {
      console.error(`Supabase project paused, resume it at ${dashboardUrl()}`);
      process.exitCode = 1;
      throw err;
    }
    throw err;
  }
}
