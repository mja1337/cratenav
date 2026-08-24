import type { TrackAnalysis } from '@/domain/types';

/** Analysis evidence that exists but still needs a human decision. */
export function hasUnconfirmedAnalysis(analysis: TrackAnalysis | undefined): boolean {
  if (!analysis) return false;
  if (analysis.canonicalBpm !== undefined && !analysis.verifiedBpm) return true;
  if ((analysis.canonicalKey || analysis.camelotKey) && !analysis.verifiedKey) return true;

  return analysis.candidates.some((candidate) =>
    (candidate.canonicalBpm !== undefined && !analysis.verifiedBpm) ||
    ((candidate.canonicalKey !== undefined || candidate.camelotKey !== undefined) &&
      !analysis.verifiedKey),
  );
}
