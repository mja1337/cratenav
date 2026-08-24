import type {
  AnalysisCandidate,
  AnalysisState,
  CamelotKey,
  MusicalKey,
  TrackAnalysis,
} from '@/domain/types';
import type { ProviderMatch } from './provider';
import { newId, nowIso } from '@/utils/ids';

export const ENRICHMENT_THRESHOLDS = {
  verify: 0.55,
  ready: 0.82,
  bpmConflictDelta: 1.5,
} as const;

export interface EnrichmentResolution {
  state: AnalysisState;
  candidates: AnalysisCandidate[];
  conflicts: { bpm: boolean; key: boolean };
  selected?: ProviderMatch;
  reason: string;
}

function sameMusicalKey(a: MusicalKey | undefined, b: MusicalKey | undefined): boolean | undefined {
  if (!a || !b) return undefined;
  return a.pitchClass === b.pitchClass && a.tonality === b.tonality;
}

function sameCamelot(a: CamelotKey | undefined, b: CamelotKey | undefined): boolean | undefined {
  if (!a || !b) return undefined;
  return a.number === b.number && a.letter === b.letter;
}

function conflictBetween(
  a: AnalysisCandidate,
  b: AnalysisCandidate,
): { bpm: boolean; key: boolean } {
  const bpm =
    a.canonicalBpm !== undefined &&
    b.canonicalBpm !== undefined &&
    Math.abs(a.canonicalBpm - b.canonicalBpm) > ENRICHMENT_THRESHOLDS.bpmConflictDelta;
  const musicalAgreement = sameMusicalKey(a.canonicalKey, b.canonicalKey);
  const camelotAgreement = sameCamelot(a.camelotKey, b.camelotKey);
  return { bpm, key: musicalAgreement === false || camelotAgreement === false };
}

function hasUsableValue(candidate: AnalysisCandidate): boolean {
  return candidate.canonicalBpm !== undefined || Boolean(candidate.canonicalKey || candidate.camelotKey);
}

function persistedCandidate(match: ProviderMatch): AnalysisCandidate {
  return {
    ...match.candidate,
    providerId: match.providerId,
    providerName: match.providerName,
    externalId: match.externalId,
    externalUrl: match.externalUrl,
    matchedArtist: match.identity.artist,
    matchedTitle: match.identity.title,
    matchedVersion: match.identity.version,
    matchedDuration: match.identity.duration,
    matchRationale: match.rationale,
    verificationRequired: match.verificationRequired,
    matchScore: match.score,
  };
}

function sameCandidate(a: AnalysisCandidate, b: AnalysisCandidate): boolean {
  const sameProvider = (a.providerId ?? a.source) === (b.providerId ?? b.source);
  if (!sameProvider) return false;
  if (a.externalId && b.externalId) return a.externalId === b.externalId;
  const sameKey =
    a.canonicalKey?.pitchClass === b.canonicalKey?.pitchClass &&
    a.canonicalKey?.tonality === b.canonicalKey?.tonality &&
    a.camelotKey?.number === b.camelotKey?.number &&
    a.camelotKey?.letter === b.camelotKey?.letter;
  return a.canonicalBpm === b.canonicalBpm && sameKey;
}

/** Retain independent evidence while replacing a refreshed claim for the same recording. */
export function mergeCandidates(
  existing: readonly AnalysisCandidate[],
  incoming: readonly AnalysisCandidate[],
): AnalysisCandidate[] {
  const merged = [...existing];
  for (const candidate of incoming) {
    const index = merged.findIndex((current) => sameCandidate(current, candidate));
    if (index >= 0) merged[index] = candidate;
    else merged.push(candidate);
  }
  return merged.sort((a, b) => (b.matchScore ?? 0) - (a.matchScore ?? 0));
}

function corroboratedConfidence(
  selected: AnalysisCandidate,
  selectedProviderId: string | undefined,
  candidates: readonly AnalysisCandidate[],
  dimension: 'bpm' | 'key',
  identityScore: number | undefined,
): number {
  const signal = dimension === 'bpm'
    ? selected.bpmConfidence ?? selected.confidence
    : selected.keyConfidence ?? selected.confidence;
  const base = Math.min(signal, identityScore ?? signal);
  const agreeingProviders = new Set<string>();
  for (const candidate of candidates) {
    if ((candidate.matchScore ?? 0) < ENRICHMENT_THRESHOLDS.verify) continue;
    const providerId = candidate.providerId ?? candidate.source;
    if (providerId === selectedProviderId) continue;
    const agrees = dimension === 'bpm'
      ? selected.canonicalBpm !== undefined && candidate.canonicalBpm !== undefined &&
        Math.abs(selected.canonicalBpm - candidate.canonicalBpm) <= ENRICHMENT_THRESHOLDS.bpmConflictDelta
      : (sameMusicalKey(selected.canonicalKey, candidate.canonicalKey) === true ||
        sameCamelot(selected.camelotKey, candidate.camelotKey) === true);
    if (agrees) agreeingProviders.add(providerId);
  }
  return Math.min(1, base + Math.min(0.15, agreeingProviders.size * 0.05));
}

function canAutoReady(match: ProviderMatch): boolean {
  if (match.verificationRequired) return false;
  const { evidence } = match;
  const pressingEvidence =
    evidence.isrcMatch === true ||
    evidence.recordingMatch === true ||
    evidence.releaseMatch === true ||
    evidence.catalogueMatch === true ||
    (evidence.durationDelta !== undefined && evidence.durationDelta <= 10);
  return (
    match.score >= ENRICHMENT_THRESHOLDS.ready &&
    evidence.artistExact &&
    evidence.titleExact &&
    evidence.versionExact &&
    pressingEvidence
  );
}

/** Re-evaluate stored candidates so later user verification cannot hide another conflict. */
export function candidateConflicts(
  candidates: readonly AnalysisCandidate[],
): { bpm: boolean; key: boolean } {
  const credible = candidates.filter(
    (candidate) => (candidate.matchScore ?? 0) >= ENRICHMENT_THRESHOLDS.verify,
  );
  const conflicts = { bpm: false, key: false };
  for (let i = 0; i < credible.length; i += 1) {
    for (let j = i + 1; j < credible.length; j += 1) {
      const pair = conflictBetween(credible[i]!, credible[j]!);
      conflicts.bpm ||= pair.bpm;
      conflicts.key ||= pair.key;
    }
  }
  return conflicts;
}

/**
 * Resolve provider matches without silently trusting a provider's own ranking.
 * Every usable claim is retained; only the central thresholds decide whether a
 * leading result is READY, VERIFY, ANALYSE or CONFLICT.
 */
export function resolveMatches(matches: readonly ProviderMatch[]): EnrichmentResolution {
  const ranked = [...matches]
    .filter((match) => hasUsableValue(match.candidate))
    .sort((a, b) => b.score - a.score);
  const candidates = ranked.map(persistedCandidate);
  const credible = ranked.filter((match) => match.score >= ENRICHMENT_THRESHOLDS.verify);
  const conflicts = candidateConflicts(candidates);
  if (conflicts.bpm || conflicts.key) {
    const sources = [...new Set(credible.map((match) => match.candidate.source))];
    return {
      state: 'CONFLICT',
      candidates,
      conflicts,
      reason: `${sources.join(' and ')} disagree.`,
    };
  }

  const first = ranked[0];
  if (!first || first.score < ENRICHMENT_THRESHOLDS.verify) {
    return {
      state: 'ANALYSE',
      candidates,
      conflicts,
      reason: ranked.length
        ? 'No candidate has enough identity evidence to use.'
        : 'No provider returned usable BPM or key data.',
    };
  }

  if (canAutoReady(first)) {
    return {
      state: 'READY',
      candidates,
      conflicts,
      selected: first,
      reason: `High-confidence match: ${first.rationale}.`,
    };
  }

  return {
    state: 'VERIFY',
    candidates,
    conflicts,
    selected: first,
    reason: `Likely match, but pressing or version evidence is incomplete: ${first.rationale}.`,
  };
}

/**
 * Apply a resolution to one track without allowing automation to overwrite a
 * user-verified BPM or key. Each dimension is guarded independently.
 */
export function applyResolution(
  trackId: string,
  existing: TrackAnalysis | undefined,
  resolution: EnrichmentResolution,
): TrackAnalysis {
  const timestamp = nowIso();
  const base: TrackAnalysis = existing ?? {
    id: newId('ana'),
    trackId,
    createdAt: timestamp,
    updatedAt: timestamp,
    version: 0,
    verifiedBpm: false,
    verifiedKey: false,
    candidates: [],
    state: 'ANALYSE',
  };
  const selected = resolution.selected?.candidate;
  const score = resolution.selected?.score;
  const selectedProviderId = resolution.selected?.providerId;
  const candidates = mergeCandidates(base.candidates, resolution.candidates);
  const conflicts = candidateConflicts(candidates);
  const next: TrackAnalysis = {
    ...base,
    trackId,
    candidates,
    updatedAt: timestamp,
    version: base.version + 1,
    analysisDate: selected ? timestamp : base.analysisDate,
    analysisMethod: selected ? 'external-metadata' : base.analysisMethod,
  };

  if (selected && !conflicts.bpm && !base.verifiedBpm && selected.canonicalBpm !== undefined) {
    next.sourceBpm = selected.sourceBpm ?? selected.canonicalBpm;
    next.canonicalBpm = selected.canonicalBpm;
    next.nativeBpm = selected.nativeBpm ?? selected.canonicalBpm;
    next.bpmSource = selected.source;
    next.bpmConfidence = corroboratedConfidence(
      selected,
      selectedProviderId,
      candidates,
      'bpm',
      score,
    );
    next.normalisationReason = selected.normalisationReason;
  }

  if (selected && !conflicts.key && !base.verifiedKey && (selected.canonicalKey || selected.camelotKey)) {
    next.sourceKey = selected.sourceKey;
    next.canonicalKey = selected.canonicalKey;
    next.camelotKey = selected.camelotKey;
    next.nativeKey = selected.nativeKey ?? selected.canonicalKey;
    next.nativeCamelot = selected.nativeCamelot ?? selected.camelotKey;
    next.nativePitchClass = selected.nativePitchClass;
    next.nativeMode = selected.nativeMode ?? selected.canonicalKey?.tonality;
    next.keySource = selected.source;
    next.keyConfidence = corroboratedConfidence(
      selected,
      selectedProviderId,
      candidates,
      'key',
      score,
    );
  }

  const unresolvedConflict =
    (conflicts.bpm && !next.verifiedBpm) ||
    (conflicts.key && !next.verifiedKey);
  if (unresolvedConflict) next.state = 'CONFLICT';
  else {
    const hasBpm = next.canonicalBpm !== undefined;
    const hasKey = next.camelotKey !== undefined || next.canonicalKey !== undefined;
    const allVerified = (hasBpm ? next.verifiedBpm : true) && (hasKey ? next.verifiedKey : true);
    const selectedBpmIsReady =
      resolution.state === 'READY' && selected?.canonicalBpm !== undefined;
    const selectedKeyIsReady =
      resolution.state === 'READY' && Boolean(selected?.canonicalKey || selected?.camelotKey);
    const everyKnownValueReady =
      (!hasBpm || next.verifiedBpm || selectedBpmIsReady) &&
      (!hasKey || next.verifiedKey || selectedKeyIsReady);
    next.state =
      !hasBpm && !hasKey
        ? 'ANALYSE'
        : allVerified || everyKnownValueReady
          ? 'READY'
          : 'VERIFY';
  }

  return next;
}
