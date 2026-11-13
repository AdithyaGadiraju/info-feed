/**
 * Score floors for followed X accounts (config `twitterUsers`). The prompt asks
 * the model to respect the floor; this is the deterministic backstop, applied to a
 * validated result before it is written. Pure: no network, no database.
 *
 * - A kept story scored 3+ below the floor is raised to the floor. It already has
 *   a detail summary (score >= 3), so the detail invariant still holds.
 * - A new story scored 1-2 means the model judged the post noise. When every item
 *   behind it is from a followed account, its items are dropped instead, which is
 *   the "scan it to make sure it is of use" step. A mixed story is left alone.
 * - An update that rescored an open story to 3+ below the floor is raised. An
 *   update with no new score is extra coverage and is left alone.
 */
import type { EnrichResult, Item, Score } from '../db/types';
import { followedAccount } from '../sources/followed';
import type { TwitterUserSpec } from '../sources/types';

export interface FloorReport {
  raised: number;
  droppedAsNoise: number;
}

export function applyScoreFloors(
  result: EnrichResult,
  items: Item[],
  followed: readonly TwitterUserSpec[],
): { result: EnrichResult; report: FloorReport } {
  const report: FloorReport = { raised: 0, droppedAsNoise: 0 };
  if (followed.length === 0) return { result, report };

  const floorById = new Map<number, Score>();
  for (const item of items) {
    const f = followedAccount(item, followed);
    if (f) floorById.set(item.id, f.minScore);
  }
  if (floorById.size === 0) return { result, report };

  const floorOf = (ids: number[]): Score | null => {
    let floor: Score | null = null;
    for (const id of ids) {
      const f = floorById.get(id);
      if (f !== undefined && (floor === null || f > floor)) floor = f;
    }
    return floor;
  };

  const dropped = [...result.dropped];
  const assignments: EnrichResult['assignments'] = [];

  for (const a of result.assignments) {
    const floor = floorOf(a.itemIds);
    if (floor === null) {
      assignments.push(a);
      continue;
    }
    if ('newStory' in a) {
      const score = a.newStory.score;
      if (score >= 3 && score < floor) {
        report.raised += 1;
        assignments.push({ ...a, newStory: { ...a.newStory, score: floor } });
      } else if (score <= 2 && a.itemIds.every((id) => floorById.has(id))) {
        report.droppedAsNoise += a.itemIds.length;
        dropped.push(...a.itemIds);
      } else {
        assignments.push(a);
      }
      continue;
    }
    if (a.updatedScore !== undefined && a.updatedScore >= 3 && a.updatedScore < floor) {
      report.raised += 1;
      assignments.push({ ...a, updatedScore: floor });
    } else {
      assignments.push(a);
    }
  }

  return { result: { assignments, dropped }, report };
}
