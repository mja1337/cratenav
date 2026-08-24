import type { Track, TrackAnalysis } from '@/domain/types';
import { nowIso } from '@/utils/ids';

/**
 * Pure track-reconciliation logic. Spec §24.
 *
 * When Discogs later improves an old white-label entry we want its better
 * titles and durations, but we must not lose the BPM/key work attached to those
 * tracks. Analysis is keyed by track id, so blindly deleting and re-creating
 * tracks would orphan it.
 *
 * Kept free of storage concerns so it can be tested directly — this is the code
 * standing between a metadata refresh and someone's hand-entered analysis.
 */

/**
 * Does this analysis row hold anything worth preserving?
 *
 * Every track gets an analysis row at import time, in state ANALYSE, purely so
 * the provenance fields exist. Those empty placeholders must NOT count as
 * "has analysis": if they did, nothing would ever be removable and a track
 * deleted upstream would linger as a phantom for good.
 */
export function hasMeaningfulAnalysis(analysis: TrackAnalysis | undefined): boolean {
  if (!analysis) return false;
  return (
    analysis.canonicalBpm !== undefined ||
    analysis.sourceBpm !== undefined ||
    analysis.camelotKey !== undefined ||
    analysis.canonicalKey !== undefined ||
    analysis.verifiedBpm ||
    analysis.verifiedKey ||
    analysis.candidates.length > 0 ||
    analysis.energy !== undefined ||
    (analysis.tags?.length ?? 0) > 0 ||
    Boolean(analysis.mixNotes)
  );
}

export interface ReconcilePlan {
  /** Tracks to write: the incoming list, with ids preserved where matched. */
  resolved: Track[];
  /** Existing tracks that vanished upstream and carry nothing worth keeping. */
  removable: Track[];
  /** Existing tracks that vanished upstream but hold real analysis. */
  retained: Track[];
  /** How many incoming tracks kept an existing id. */
  preserved: number;
}

/**
 * Work out how to fold an incoming tracklist into the existing one.
 *
 * Matching is by vinyl position first, then by title. Position is the stronger
 * signal: on a 12" it is stable and near-unique ("A", "AA", "B1"), whereas a
 * title can legitimately repeat across three mixes of the same tune.
 */
export function planReconciliation(
  existing: readonly Track[],
  incoming: readonly Track[],
  analysisFor: (trackId: string) => TrackAnalysis | undefined,
): ReconcilePlan {
  const unmatched = [...existing];
  const normalise = (value: string) => value.trim().toLowerCase();

  const take = (predicate: (track: Track) => boolean): Track | undefined => {
    const index = unmatched.findIndex(predicate);
    return index === -1 ? undefined : unmatched.splice(index, 1)[0];
  };

  let preserved = 0;
  const resolved: Track[] = incoming.map((track) => {
    const match =
      take((candidate) => normalise(candidate.position) === normalise(track.position)) ??
      take((candidate) => normalise(candidate.title) === normalise(track.title));

    if (!match) return track;

    preserved += 1;
    // Keep identity and any recording link; take the fresh catalogue data.
    return {
      ...track,
      id: match.id,
      createdAt: match.createdAt,
      recordingId: match.recordingId ?? track.recordingId,
      version: match.version + 1,
      updatedAt: nowIso(),
    };
  });

  const removable: Track[] = [];
  const retained: Track[] = [];
  for (const track of unmatched) {
    if (hasMeaningfulAnalysis(analysisFor(track.id))) retained.push(track);
    else removable.push(track);
  }

  return { resolved, removable, retained, preserved };
}
