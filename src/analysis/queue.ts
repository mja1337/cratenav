import type { AnalysisState } from '@/domain/types';
import type { BagTrack } from '@/bags/coverage';

/**
 * Analysis queue prioritisation. Spec §32.
 *
 * Answers "what should I analyse next?" rather than just listing everything
 * unanalysed. The ordering is deliberate: a record you are taking out tonight
 * is worth more than one staying at home, and a release with four unresolved
 * tracks is worth more per trip to the decks than one with a single gap.
 */

export type QueueFilter = 'all' | 'bpm-missing' | 'key-missing' | 'both-missing' | 'conflict';

export type QueueSort = 'priority' | 'oldest' | 'newest' | 'artist';

export interface QueueItem {
  entry: BagTrack;
  state: AnalysisState;
  missingBpm: boolean;
  missingKey: boolean;
  /** Higher is more worth doing next. */
  priority: number;
  /** Why it is ranked where it is, shown in the UI. */
  reasons: string[];
  /** How many tracks on the same release still need work. */
  siblingGaps: number;
}

export interface BuildQueueOptions {
  /** Track ids in the active bag, which outrank everything else. */
  activeBagTrackIds?: ReadonlySet<string>;
  filter?: QueueFilter;
  sort?: QueueSort;
  limit?: number;
}

/** Weights kept together so the ranking is legible and tunable. */
export const QUEUE_WEIGHTS = {
  inActiveBag: 100,
  perSiblingGap: 8,
  maxSiblingBonus: 40,
  perRatingPoint: 4,
  conflict: 30,
  favourite: 15,
};

/**
 * Build the prioritised queue.
 *
 * READY tracks are excluded: there is nothing to do. CONFLICT is included and
 * boosted, because disagreeing sources are actively misleading rather than
 * merely absent.
 */
export function buildQueue(
  entries: readonly BagTrack[],
  options: BuildQueueOptions = {},
): QueueItem[] {
  const activeBag = options.activeBagTrackIds ?? new Set<string>();
  const filter = options.filter ?? 'all';
  const sort = options.sort ?? 'priority';

  // Count outstanding work per release first, so each item knows whether
  // fetching that record off the shelf would clear several gaps at once.
  const gapsByRelease = new Map<string, number>();
  for (const entry of entries) {
    if (isResolved(entry)) continue;
    gapsByRelease.set(entry.release.id, (gapsByRelease.get(entry.release.id) ?? 0) + 1);
  }

  const items: QueueItem[] = [];

  for (const entry of entries) {
    if (isResolved(entry)) continue;

    const missingBpm = entry.analysis?.canonicalBpm === undefined;
    const missingKey = entry.analysis?.camelotKey === undefined;
    const state = entry.analysis?.state ?? 'ANALYSE';

    if (!matchesFilter(filter, { missingBpm, missingKey, state })) continue;

    const siblingGaps = (gapsByRelease.get(entry.release.id) ?? 1) - 1;
    const reasons: string[] = [];
    let priority = 0;

    if (activeBag.has(entry.track.id)) {
      priority += QUEUE_WEIGHTS.inActiveBag;
      reasons.push('in your active bag');
    }
    if (state === 'CONFLICT') {
      priority += QUEUE_WEIGHTS.conflict;
      reasons.push('sources disagree');
    }
    if (siblingGaps > 0) {
      priority += Math.min(QUEUE_WEIGHTS.maxSiblingBonus, siblingGaps * QUEUE_WEIGHTS.perSiblingGap);
      reasons.push(`${siblingGaps + 1} tracks on this record need work`);
    }
    if (entry.playState === 'favourite') {
      priority += QUEUE_WEIGHTS.favourite;
      reasons.push('favourite tonight');
    }

    items.push({ entry, state, missingBpm, missingKey, priority, reasons, siblingGaps });
  }

  return sortQueue(items, sort).slice(0, options.limit ?? items.length);
}

function isResolved(entry: BagTrack): boolean {
  // Both values present and nobody is disputing them.
  return (
    entry.analysis?.canonicalBpm !== undefined &&
    entry.analysis?.camelotKey !== undefined &&
    entry.analysis?.state !== 'CONFLICT'
  );
}

function matchesFilter(
  filter: QueueFilter,
  item: { missingBpm: boolean; missingKey: boolean; state: AnalysisState },
): boolean {
  switch (filter) {
    case 'bpm-missing':
      return item.missingBpm;
    case 'key-missing':
      return item.missingKey;
    case 'both-missing':
      return item.missingBpm && item.missingKey;
    case 'conflict':
      return item.state === 'CONFLICT';
    default:
      return true;
  }
}

function sortQueue(items: QueueItem[], sort: QueueSort): QueueItem[] {
  const byYear = (item: QueueItem) => item.entry.release.year ?? 0;

  switch (sort) {
    case 'oldest':
      return items.sort(
        (a, b) => (byYear(a) || 9999) - (byYear(b) || 9999) || b.priority - a.priority,
      );
    case 'newest':
      return items.sort((a, b) => byYear(b) - byYear(a) || b.priority - a.priority);
    case 'artist':
      return items.sort(
        (a, b) =>
          a.entry.release.artistSort.localeCompare(b.entry.release.artistSort) ||
          a.entry.track.sequence - b.entry.track.sequence,
      );
    default:
      return items.sort(
        (a, b) =>
          b.priority - a.priority ||
          // Keep a release's tracks together so you only pull it out once.
          a.entry.release.artistSort.localeCompare(b.entry.release.artistSort) ||
          a.entry.track.sequence - b.entry.track.sequence,
      );
  }
}

/** Headline counts for the queue screen. */
export function queueSummary(entries: readonly BagTrack[]): {
  total: number;
  ready: number;
  needsBpm: number;
  needsKey: number;
  needsBoth: number;
  conflict: number;
} {
  let ready = 0;
  let needsBpm = 0;
  let needsKey = 0;
  let needsBoth = 0;
  let conflict = 0;

  for (const entry of entries) {
    const missingBpm = entry.analysis?.canonicalBpm === undefined;
    const missingKey = entry.analysis?.camelotKey === undefined;

    if (entry.analysis?.state === 'CONFLICT') conflict += 1;
    if (isResolved(entry)) {
      ready += 1;
      continue;
    }
    if (missingBpm) needsBpm += 1;
    if (missingKey) needsKey += 1;
    if (missingBpm && missingKey) needsBoth += 1;
  }

  return { total: entries.length, ready, needsBpm, needsKey, needsBoth, conflict };
}
