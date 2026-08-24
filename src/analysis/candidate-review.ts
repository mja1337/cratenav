import type { AnalysisCandidate, TrackAnalysis } from '@/domain/types';
import { musicalKeyToCamelot } from '@/harmonic/camelot';

/**
 * Human adjudication of one source's claim. Spec §10.
 *
 * A DJ approves or rejects a specific candidate and says why, and the comment
 * is kept against that source rather than as a free-floating note: "GetSongBPM
 * has the 12" at 174" only means something attached to the source it judges.
 *
 * Kept as a pure patch builder because it encodes the provenance rules that are
 * easy to get wrong — source vs canonical BPM, per-dimension verification, and
 * undoing an approval — and those deserve tests rather than a click-through.
 */

export interface CandidateReview {
  status: 'approved' | 'rejected';
  comment?: string;
  /** Injected so a test does not depend on the clock. */
  now: string;
}

/** Confidence in a dimension can never exceed confidence in the identity. */
function dimensionConfidence(
  candidate: AnalysisCandidate,
  dimension: number | undefined,
): number {
  const identity = candidate.matchScore ?? candidate.confidence;
  return Math.min(dimension ?? candidate.confidence, identity);
}

export function camelotFor(candidate: AnalysisCandidate) {
  return candidate.camelotKey ??
    (candidate.canonicalKey ? musicalKeyToCamelot(candidate.canonicalKey) ?? undefined : undefined);
}

/**
 * True when the analysis currently carries THIS candidate's claim.
 *
 * Rejecting a source that was previously approved has to withdraw the value it
 * supplied. Leaving it in place produced an analysis that read "verified 174
 * BPM, source AcousticBrainz" directly beside that same source marked rejected.
 */
function suppliedBpm(analysis: TrackAnalysis, candidate: AnalysisCandidate): boolean {
  return (
    candidate.canonicalBpm !== undefined &&
    analysis.canonicalBpm === candidate.canonicalBpm &&
    analysis.bpmSource === candidate.source
  );
}

function suppliedKey(analysis: TrackAnalysis, candidate: AnalysisCandidate): boolean {
  const camelot = camelotFor(candidate);
  if (!camelot) return false;
  return (
    analysis.keySource === candidate.source &&
    analysis.camelotKey?.number === camelot.number &&
    analysis.camelotKey?.letter === camelot.letter
  );
}

export function reviewCandidatePatch(
  analysis: TrackAnalysis,
  candidate: AnalysisCandidate,
  review: CandidateReview,
): Partial<TrackAnalysis> {
  const comment = review.comment?.trim() || undefined;
  const candidates = analysis.candidates.map((item) =>
    item === candidate
      ? { ...item, reviewStatus: review.status, reviewComment: comment, reviewedAt: review.now }
      : item,
  );

  const patch: Partial<TrackAnalysis> = { candidates };
  const camelot = camelotFor(candidate);

  if (review.status === 'rejected') {
    // Withdraw only what this candidate put there; a hand-entered or
    // microphone-measured value on the other dimension is untouched.
    if (suppliedBpm(analysis, candidate)) {
      Object.assign(patch, {
        canonicalBpm: undefined,
        sourceBpm: undefined,
        nativeBpm: undefined,
        bpmSource: undefined,
        bpmConfidence: undefined,
        normalisationReason: undefined,
        verifiedBpm: false,
      });
    }
    if (suppliedKey(analysis, candidate)) {
      Object.assign(patch, {
        canonicalKey: undefined,
        sourceKey: undefined,
        camelotKey: undefined,
        nativeKey: undefined,
        nativeCamelot: undefined,
        nativePitchClass: undefined,
        nativeMode: undefined,
        keySource: undefined,
        keyConfidence: undefined,
        verifiedKey: false,
      });
    }
    return patch;
  }

  patch.analysisMethod = `External candidate approved by user${comment ? `: ${comment}` : ''}`;

  // Each dimension is verified separately: approving a source that only knows
  // the tempo must not mark its absent key as confirmed.
  if (candidate.canonicalBpm !== undefined) {
    Object.assign(patch, {
      sourceBpm: candidate.sourceBpm ?? candidate.canonicalBpm,
      canonicalBpm: candidate.canonicalBpm,
      nativeBpm: candidate.nativeBpm ?? candidate.canonicalBpm,
      bpmSource: candidate.source,
      bpmConfidence: dimensionConfidence(candidate, candidate.bpmConfidence),
      normalisationReason: candidate.normalisationReason,
      verifiedBpm: true,
    });
  }

  if (candidate.canonicalKey || camelot) {
    Object.assign(patch, {
      sourceKey: candidate.sourceKey,
      canonicalKey: candidate.canonicalKey,
      camelotKey: camelot,
      nativeKey: candidate.nativeKey ?? candidate.canonicalKey,
      nativeCamelot: candidate.nativeCamelot ?? camelot,
      nativePitchClass: candidate.nativePitchClass,
      nativeMode: candidate.nativeMode ?? candidate.canonicalKey?.tonality,
      keySource: candidate.source,
      keyConfidence: dimensionConfidence(candidate, candidate.keyConfidence),
      verifiedKey: true,
    });
  }

  return patch;
}
