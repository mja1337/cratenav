import type { CamelotKey } from '@/domain/types';
import type { BagTrack } from '@/bags/coverage';
import {
  compareBpm,
  compareKeys,
  type BpmResult,
  type HarmonicResult,
} from '@/harmonic/compatibility';
import { matchAtPitch, type PitchMatch, type PlaybackTarget } from '@/pitch/matching';
import { DEFAULT_TOLERANCE, type PitchTolerance, type ScoringConfig } from '@/pitch/deck';
import { nativeBpmOf, nativeKeyOf } from '@/pitch/native';

/**
 * Next-track recommendation. Spec §17, §39.
 *
 * V1 combines the four factors spec §17 asks for — BPM compatibility, Camelot
 * compatibility, availability in the chosen scope, and play status — but the
 * weights are a table rather than inline arithmetic, so energy, rating,
 * transition history and recency can be added later without touching callers.
 *
 * Scope is the caller's business: it passes the candidate pool. The engine
 * never reaches for the whole collection on its own, because recommending a
 * record sitting at home is worse than recommending nothing (spec §17).
 */

/** Where candidates were drawn from, carried through for display. */
export type RecommendationScope = 'active-bag' | 'bag' | 'collection' | 'shortlist';

export interface Weights {
  key: number;
  bpm: number;
  /** Applied as a multiplier, not an addend: a played track is deprioritised. */
  playedPenalty: number;
  favouriteBonus: number;
  ratingBonus: number;
}

export const DEFAULT_WEIGHTS: Weights = {
  key: 0.5,
  bpm: 0.5,
  playedPenalty: 0.35,
  favouriteBonus: 0.06,
  ratingBonus: 0.04,
};

export interface CurrentTrack {
  bpm?: number | undefined;
  camelot?: CamelotKey | undefined;
  /** 0..1. Low key confidence reduces how much harmony counts. Spec §15. */
  keyConfidence?: number | undefined;
  /**
   * Continuous effective tonal centre, for playback mode. Live detection
   * already reports playback properties, so this is what it measures. When
   * planning from a library track use `asPlaybackTarget` to derive it.
   */
  effectivePitchClass?: number | undefined;
  tonality?: 'major' | 'minor' | undefined;
}

/**
 * Which compatibility model to use. Spec v1.1 §9.
 *
 *   native    compare stored BPM and key as-is. For library browsing, rough
 *             preparation and sticker information.
 *   playback  work out the pitch each record needs to reach the target tempo,
 *             then compare the keys it will ACTUALLY be in. The correct model
 *             for set planning, B2B and live use.
 */
export type CompatibilityMode = 'native' | 'playback';

export interface RecommendOptions {
  scope?: RecommendationScope;
  mode?: CompatibilityMode;
  /** Deck range and preferred pitch, for playback mode. */
  tolerance?: PitchTolerance;
  config?: ScoringConfig;
  /** Drop played tracks entirely rather than merely ranking them lower. */
  excludePlayed?: boolean;
  /** Never suggest these — the current record, or things already in the set. */
  excludeTrackIds?: readonly string[];
  limit?: number;
  weights?: Partial<Weights>;
  /** Include candidates with no usable BPM or key. Off by default. */
  includeUnknown?: boolean;
}

export interface Recommendation {
  entry: BagTrack;
  /** 0..1 combined score. */
  score: number;
  /** Whole-number percentage, as spec §17 displays it. */
  matchPercent: number;
  key: HarmonicResult;
  bpm: BpmResult;
  /** Short human-readable justifications, most important first. */
  reasons: string[];
  /** Present in playback mode: the pitch this record needs. Spec v1.1 §11. */
  pitch?: PitchMatch | undefined;
}

/**
 * Rank candidates against what is currently playing.
 *
 * Returns an empty list rather than padding with poor suggestions: during a
 * set, three good options beat ten where seven are wrong.
 */
export function recommend(
  current: CurrentTrack,
  candidates: readonly BagTrack[],
  options: RecommendOptions = {},
): Recommendation[] {
  const weights = { ...DEFAULT_WEIGHTS, ...options.weights };
  const excluded = new Set(options.excludeTrackIds ?? []);
  const limit = options.limit ?? 10;

  const results: Recommendation[] = [];

  for (const entry of candidates) {
    if (excluded.has(entry.track.id)) continue;

    const playState = entry.playState ?? 'packed';
    if (playState === 'put-aside') continue;
    if (options.excludePlayed && playState === 'played') continue;

    const candidateBpm = entry.analysis?.canonicalBpm;
    const candidateKey = entry.analysis?.camelotKey;

    const known = candidateBpm !== undefined || candidateKey !== undefined;
    if (!known && !options.includeUnknown) continue;

    // Playback mode scores the key the record will be in once pitched to match,
    // which on vinyl is the only question that matters. Spec v1.1 §9, §10.
    if (options.mode === 'playback') {
      const scored = scoreAtPlayback(current, entry, weights, options);
      if (scored) results.push(scored);
      continue;
    }

    const key = compareKeys(current.camelot, candidateKey);
    const bpm = compareBpm(current.bpm, candidateBpm);

    // Only weight a dimension we actually have information for, then
    // renormalise. Otherwise an unknown key would silently halve every score
    // and make the ranking meaningless.
    let keyWeight = current.camelot && candidateKey ? weights.key : 0;
    const bpmWeight = current.bpm !== undefined && candidateBpm !== undefined ? weights.bpm : 0;

    // Shaky key detection should not drive the decision. Spec §15.
    const confidence = current.keyConfidence;
    if (keyWeight && confidence !== undefined) keyWeight *= Math.max(0.2, Math.min(1, confidence));

    const totalWeight = keyWeight + bpmWeight;
    if (totalWeight === 0) continue;

    let score = (key.score * keyWeight + bpm.score * bpmWeight) / totalWeight;

    // A tempo or key that genuinely clashes is not a candidate at all.
    if (bpmWeight && bpm.score === 0) continue;
    if (keyWeight && key.score === 0) continue;

    const reasons: string[] = [];
    if (keyWeight) reasons.push(key.label);
    if (bpmWeight) reasons.push(bpm.label);

    if (playState === 'played') {
      score *= weights.playedPenalty;
      reasons.push('already played');
    }
    if (playState === 'favourite') {
      score = Math.min(1, score + weights.favouriteBonus);
      reasons.push('favourite tonight');
    }

    const rating = entry.analysis?.energy;
    if (rating !== undefined) {
      score = Math.min(1, score + (rating / 10) * weights.ratingBonus);
    }

    if (!keyWeight) reasons.push('key unknown, ranked on tempo alone');
    if (!bpmWeight) reasons.push('BPM unknown, ranked on key alone');

    results.push({
      entry,
      score,
      matchPercent: Math.round(score * 100),
      key,
      bpm,
      reasons,
    });
  }

  return results
    .sort(
      (a, b) =>
        b.score - a.score ||
        // Stable, meaningful tie-break: prefer the smaller pitch adjustment.
        Math.abs(a.bpm.pitchPercent) - Math.abs(b.bpm.pitchPercent) ||
        a.entry.track.title.localeCompare(b.entry.track.title),
    )
    .slice(0, limit);
}

/**
 * Score one candidate in playback mode. Spec v1.1 §10, §23.
 *
 * Components, per spec v1.1 §23: tempo reachability (a hard gate), the pitch
 * adjustment penalty, the effective harmonic score, bag availability (the
 * caller's candidate pool) and the played penalty.
 */
function scoreAtPlayback(
  current: CurrentTrack,
  entry: BagTrack,
  weights: Weights,
  options: RecommendOptions,
): Recommendation | null {
  const tolerance = options.tolerance ?? DEFAULT_TOLERANCE;

  const target: PlaybackTarget = {
    bpm: current.bpm,
    effectivePitchClass: current.effectivePitchClass,
    tonality: current.tonality,
    keyConfidence: current.keyConfidence,
  };

  const match = matchAtPitch({
    target,
    nativeBpm: nativeBpmOf(entry.analysis),
    nativeKey: nativeKeyOf(entry.analysis),
    tolerance,
    ...(options.config ? { config: options.config } : {}),
  });

  // Cannot reach the tempo on this deck: not a candidate at all. Spec v1.1 §8.
  if (!match.reachable) return null;
  // A genuine clash after pitching is no better than one before it.
  if (match.classification === 'RISKY' && match.effectiveHarmonicScore === 0) return null;

  let score = match.score;
  const playState = entry.playState ?? 'packed';

  const reasons: string[] = [];
  if (match.effectiveCamelot) reasons.push(match.relation.label);
  reasons.push(`${match.requiredPitchPercent >= 0 ? '+' : ''}${match.requiredPitchPercent.toFixed(1)}%`);
  if (!match.withinPreferred) reasons.push('beyond preferred pitch');
  if (Math.abs(match.harmonicDeviationCents) > 0) {
    reasons.push(`${match.harmonicDeviationCents > 0 ? '+' : ''}${match.harmonicDeviationCents} cents`);
  }

  if (playState === 'played') {
    score *= weights.playedPenalty;
    reasons.push('already played');
  }
  if (playState === 'favourite') {
    score = Math.min(1, score + weights.favouriteBonus);
    reasons.push('favourite tonight');
  }

  return {
    entry,
    score,
    matchPercent: Math.round(score * 100),
    key: match.relation,
    // Pitch mode expresses tempo through the required pitch, so the plain BPM
    // comparison is reported for continuity rather than used for ranking.
    bpm: {
      score: 1,
      pitchPercent: Math.round(match.requiredPitchPercent * 10) / 10,
      label: `${match.requiredPitchPercent >= 0 ? '+' : ''}${match.requiredPitchPercent.toFixed(1)}%`,
      viaOctave: false,
    },
    reasons,
    pitch: match,
  };
}

/**
 * Find a track that bridges two others. Spec §20's "Find bridge track".
 *
 * A bridge has to work on both sides, so it is scored as the weaker of its two
 * halves rather than the average — a track that mixes beautifully out of A but
 * badly into B is not a bridge.
 */
export interface BridgeSuggestion {
  entry: BagTrack;
  score: number;
  matchPercent: number;
  fromScore: number;
  toScore: number;
  reasons: string[];
}

export function findBridge(
  from: CurrentTrack,
  to: CurrentTrack,
  candidates: readonly BagTrack[],
  options: RecommendOptions = {},
): BridgeSuggestion[] {
  const limit = options.limit ?? 5;
  const fromRanked = new Map(
    recommend(from, candidates, { ...options, limit: Number.MAX_SAFE_INTEGER }).map((r) => [
      r.entry.track.id,
      r,
    ]),
  );
  const toRanked = new Map(
    recommend(to, candidates, { ...options, limit: Number.MAX_SAFE_INTEGER }).map((r) => [
      r.entry.track.id,
      r,
    ]),
  );

  const suggestions: BridgeSuggestion[] = [];
  for (const [trackId, outbound] of fromRanked) {
    const inbound = toRanked.get(trackId);
    if (!inbound) continue;

    const score = Math.min(outbound.score, inbound.score);
    suggestions.push({
      entry: outbound.entry,
      score,
      matchPercent: Math.round(score * 100),
      fromScore: outbound.score,
      toScore: inbound.score,
      reasons: [`in: ${outbound.reasons[0] ?? ''}`, `out: ${inbound.reasons[0] ?? ''}`].filter(
        (reason) => reason.length > 4,
      ),
    });
  }

  return suggestions.sort((a, b) => b.score - a.score).slice(0, limit);
}
