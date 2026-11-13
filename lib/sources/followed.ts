/**
 * Followed X accounts (config `twitterUsers`): one lookup shared by the ingest
 * pre-filter (skip the likes threshold) and enrichment (prompt note + score floor).
 */
import type { TwitterUserSpec } from './types';

/** The followed account behind a twitter item, or null. Handles match case-insensitively. */
export function followedAccount(
  item: { source: string; author?: string | null },
  users: readonly TwitterUserSpec[],
): TwitterUserSpec | null {
  if (item.source !== 'twitter' || !item.author) return null;
  const handle = item.author.replace(/^@/, '').toLowerCase();
  return users.find((u) => u.userName.toLowerCase() === handle) ?? null;
}
