import type { CamelotKey, MusicalKey } from '@/domain/types';
import { musicalKeyToCamelot } from '@/harmonic/camelot';
import { compareKeys, type HarmonicResult } from '@/harmonic/compatibility';
import {
  classify,
  DEFAULT_SCORING,
  DEFAULT_TOLERANCE,
  isWithinDeckRange,
  isWithinPreferred,
  type CompatibilityClass,
  type PitchTolerance,
  type ScoringConfig,
} from './deck';
import {
  pitchClassFromNumber,
  pitchClassNumber,
  pitchShiftSemitones,
  playbackBpm,
  requiredPitchPercent,
  signedSemitoneDistance,
  wrapPitchClass,
} from './calculations';

/**
 * Vinyl playback compatibility. Spec v1.1 §9, §10, §23, §30.
 *
 * The question is not "is this record's key compatible", it is "once I have
 * pitched this record to match what is playing, is the key it will then be in
 * compatible". Those are different questions, and on vinyl the second is the
 * only one that matters.
 *
 * Camelot relationships are retained as one layer of the model (§30), but they
 * are evaluated on the EFFECTIVE keys after pitching, and then adjusted by the
 * residual detuning between the two records.
 */

/** What is currently playing, in playback terms. */
export interface PlaybackTarget {
  /** BPM as actually heard. */
  bpm?: number | undefined;
  /**
   * Effective tonal centre as a continuous pitch class, if known.
   * Live detection already gives playback properties, so no conversion needed.
   */
  effectivePitchClass?: number | undefined;
  tonality?: MusicalKey['tonality'] | undefined;
  keyConfidence?: number | undefined;
}

export interface PitchMatchInput {
  target: PlaybackTarget;
  nativeBpm?: number | undefined;
  nativeKey?: MusicalKey | undefined;
  tolerance?: PitchTolerance;
  config?: ScoringConfig;
}

export interface PitchMatch {
  /** Can the deck reach the target tempo at all? Spec v1.1 §8. */
  reachable: boolean;
  /**
   * False when a tempo was missing on either side. `requiredPitchPercent` is
   * then meaningless and must NOT be shown: "+0.0%" would read as "no pitch
   * needed" when the truth is that we cannot know.
   */
  tempoKnown: boolean;
  requiredPitchPercent: number;
  withinPreferred: boolean;

  playbackBpm?: number | undefined;
  pitchShiftSemitones: number;

  /** Continuous effective pitch class after pitching. Never snapped. §4 */
  effectivePitchClass?: number | undefined;
  effectiveKey?: MusicalKey | undefined;
  effectiveCamelot?: CamelotKey | undefined;

  /** Residual detuning between the two effective centres. Spec v1.1 §6. */
  harmonicDeviationCents: number;
  /** Harmonic score computed on effective keys, 0..1. */
  effectiveHarmonicScore: number;
  /** Camelot relationship between the effective keys, for display. */
  relation: HarmonicResult;

  /** Multiplier for how far the record has to be pitched. Spec v1.1 §24. */
  pitchPenalty: number;
  /** Combined 0..1 score. */
  score: number;
  classification: CompatibilityClass;
}

const UNREACHABLE: Omit<PitchMatch, 'requiredPitchPercent'> = {
  reachable: false,
  tempoKnown: true,
  withinPreferred: false,
  pitchShiftSemitones: Number.NaN,
  harmonicDeviationCents: 0,
  effectiveHarmonicScore: 0,
  relation: { score: 0, relation: 'incompatible', label: 'Out of range', safe: false },
  pitchPenalty: 0,
  score: 0,
  classification: 'OUT_OF_RANGE',
};

/**
 * Work out what it takes to mix a candidate record into what is playing.
 */
export function matchAtPitch(input: PitchMatchInput): PitchMatch {
  const tolerance = input.tolerance ?? DEFAULT_TOLERANCE;
  const config = input.config ?? DEFAULT_SCORING;
  const { deck } = tolerance;

  // Without both tempos there is no pitch to calculate, so fall back to a
  // tempo-free comparison rather than pretending.
  if (input.nativeBpm === undefined || input.target.bpm === undefined) {
    return matchWithoutTempo(input, config);
  }

  const required = requiredPitchPercent(input.nativeBpm, input.target.bpm);

  if (!Number.isFinite(required) || !isWithinDeckRange(required, deck)) {
    return { ...UNREACHABLE, requiredPitchPercent: required };
  }

  const played = playbackBpm(input.nativeBpm, required);
  // Key lock decouples tempo from pitch entirely. Spec v1.1 §22.
  const semitones = deck.mode === 'KEY_LOCK' ? 0 : pitchShiftSemitones(required);

  const pitchPenalty = computePitchPenalty(required, tolerance, config);
  const withinPreferred = isWithinPreferred(required, tolerance);

  // --- harmonic side -------------------------------------------------------
  const haveKeys =
    input.nativeKey !== undefined && input.target.effectivePitchClass !== undefined;

  if (!haveKeys) {
    // Tempo is reachable but we cannot judge harmony. Honest, not pessimistic.
    return {
      reachable: true,
      tempoKnown: true,
      requiredPitchPercent: required,
      withinPreferred,
      playbackBpm: played,
      pitchShiftSemitones: semitones,
      effectivePitchClass: undefined,
      harmonicDeviationCents: 0,
      effectiveHarmonicScore: 0,
      relation: { score: 0, relation: 'incompatible', label: 'Key unknown', safe: false },
      pitchPenalty,
      score: pitchPenalty * 0.5,
      classification: 'TEMPO_ONLY',
    };
  }

  const nativeNumber = pitchClassNumber(input.nativeKey!.pitchClass);
  const effective = wrapPitchClass(nativeNumber + semitones);

  const effectivePitchClassName = pitchClassFromNumber(effective);
  const effectiveKey: MusicalKey = {
    pitchClass: effectivePitchClassName,
    // Speed change moves pitch, never mode.
    tonality: input.nativeKey!.tonality,
  };
  const effectiveCamelot = musicalKeyToCamelot(effectiveKey) ?? undefined;

  const targetCentre = input.target.effectivePitchClass!;
  const targetKey: MusicalKey = {
    pitchClass: pitchClassFromNumber(targetCentre),
    tonality: input.target.tonality ?? input.nativeKey!.tonality,
  };
  const targetCamelot = musicalKeyToCamelot(targetKey) ?? undefined;

  // The relationship is judged on the keys the two records will actually be
  // in, not on their sleeve values.
  const relation = compareKeys(targetCamelot, effectiveCamelot);

  // Residual detuning: the interval that actually exists versus the whole-
  // semitone interval we are calling it. Two records both pitched the same way
  // are still in tune with each other, which is why this uses the interval
  // rather than each record's own deviation.
  const actualInterval = signedSemitoneDistance(targetCentre, effective);
  const labelledInterval = signedSemitoneDistance(
    pitchClassNumber(targetKey.pitchClass),
    pitchClassNumber(effectivePitchClassName),
  );
  const residual = Math.min(50, Math.abs(actualInterval - labelledInterval) * 100);

  const detuneFactor = computeDetuneFactor(residual, config);
  let harmonicScore = relation.score * detuneFactor;

  // A shaky key reading should not dominate the decision. Spec §15.
  const confidence = input.target.keyConfidence;
  if (confidence !== undefined) {
    const trust = Math.max(0.2, Math.min(1, confidence));
    // Blend towards neutral rather than towards zero.
    harmonicScore = harmonicScore * trust + 0.5 * (1 - trust);
  }

  const score = harmonicScore * pitchPenalty;

  return {
    reachable: true,
    tempoKnown: true,
    requiredPitchPercent: required,
    withinPreferred,
    playbackBpm: played,
    pitchShiftSemitones: semitones,
    effectivePitchClass: effective,
    effectiveKey,
    effectiveCamelot,
    harmonicDeviationCents: Math.round(residual),
    effectiveHarmonicScore: harmonicScore,
    relation,
    pitchPenalty,
    score,
    classification: classify({ reachable: true, harmonicScore, config }),
  };
}

/** No tempo on one side: judge key alone, at nominal speed. */
function matchWithoutTempo(input: PitchMatchInput, config: ScoringConfig): PitchMatch {
  const haveKeys =
    input.nativeKey !== undefined && input.target.effectivePitchClass !== undefined;

  if (!haveKeys) {
    return {
      reachable: true,
      tempoKnown: false,
      requiredPitchPercent: 0,
      withinPreferred: true,
      pitchShiftSemitones: 0,
      harmonicDeviationCents: 0,
      effectiveHarmonicScore: 0,
      relation: { score: 0, relation: 'incompatible', label: 'Nothing known', safe: false },
      pitchPenalty: 1,
      score: 0,
      classification: 'TEMPO_ONLY',
    };
  }

  const nativeCamelot = musicalKeyToCamelot(input.nativeKey!) ?? undefined;
  const targetKey: MusicalKey = {
    pitchClass: pitchClassFromNumber(input.target.effectivePitchClass!),
    tonality: input.target.tonality ?? input.nativeKey!.tonality,
  };
  const relation = compareKeys(musicalKeyToCamelot(targetKey) ?? undefined, nativeCamelot);

  return {
    reachable: true,
    tempoKnown: false,
    requiredPitchPercent: 0,
    withinPreferred: true,
    pitchShiftSemitones: 0,
    effectivePitchClass: pitchClassNumber(input.nativeKey!.pitchClass),
    effectiveKey: input.nativeKey,
    effectiveCamelot: nativeCamelot,
    harmonicDeviationCents: 0,
    effectiveHarmonicScore: relation.score,
    relation,
    pitchPenalty: 1,
    score: relation.score,
    classification: classify({ reachable: true, harmonicScore: relation.score, config }),
  };
}

/**
 * Penalty for how hard the record has to be pitched. Spec v1.1 §24, §25.
 *
 * Inside the preferred range there is no penalty. Beyond it the penalty grows
 * linearly but is floored, because a large pitch is a compromise rather than a
 * disqualification — only the deck range disqualifies.
 */
export function computePitchPenalty(
  pitchPercent: number,
  tolerance: PitchTolerance = DEFAULT_TOLERANCE,
  config: ScoringConfig = DEFAULT_SCORING,
): number {
  const magnitude = Math.abs(pitchPercent);
  if (magnitude <= tolerance.preferredMaxPitchPercent) return 1;

  const excess = magnitude - tolerance.preferredMaxPitchPercent;
  return Math.max(config.minPitchPenalty, 1 - excess * config.pitchPenaltyPerPercent);
}

/**
 * How much residual detuning degrades a harmonic match.
 *
 * Under `cleanDeviationCents` the two records are effectively in tune with each
 * other. Beyond `maxDeviationCents` they beat audibly, and the key labels stop
 * meaning much.
 */
export function computeDetuneFactor(
  deviationCents: number,
  config: ScoringConfig = DEFAULT_SCORING,
): number {
  const magnitude = Math.abs(deviationCents);
  if (magnitude <= config.cleanDeviationCents) return 1;
  if (magnitude >= config.maxDeviationCents) return 0.35;

  const span = config.maxDeviationCents - config.cleanDeviationCents;
  const progress = (magnitude - config.cleanDeviationCents) / span;
  return 1 - progress * 0.65;
}
