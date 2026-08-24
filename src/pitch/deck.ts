import type { PlaybackMode } from './calculations';

/**
 * Deck profile and pitch-tolerance configuration. Spec v1.1 §7, §12, §25.
 *
 * The spec is explicit that ±8% must not be assumed globally — a 1210 is ±8,
 * a CDJ is ±16 or wider, and a digital deck may have key lock. Everything that
 * depends on the deck lives here so nothing hardcodes vinyl behaviour.
 */

export interface DeckProfile {
  id: string;
  name: string;
  pitchRangeMin: number;
  pitchRangeMax: number;
  keyLockAvailable: boolean;
  /** Preferred working range when the deck offers several. */
  defaultPitchRange?: number;
  mode: PlaybackMode;
}

export const TECHNICS_VINYL: DeckProfile = {
  id: 'technics-vinyl',
  name: 'Technics-style vinyl',
  pitchRangeMin: -8,
  pitchRangeMax: 8,
  keyLockAvailable: false,
  defaultPitchRange: 8,
  mode: 'VINYL',
};

export const DECK_PROFILES: DeckProfile[] = [
  TECHNICS_VINYL,
  {
    id: 'wide-vinyl',
    name: 'Wide-range vinyl (±16%)',
    pitchRangeMin: -16,
    pitchRangeMax: 16,
    keyLockAvailable: false,
    defaultPitchRange: 16,
    mode: 'VINYL',
  },
  {
    id: 'digital-keylock',
    name: 'Digital deck with key lock',
    pitchRangeMin: -16,
    pitchRangeMax: 16,
    keyLockAvailable: true,
    defaultPitchRange: 10,
    mode: 'KEY_LOCK',
  },
];

export function findDeckProfile(id: string | undefined): DeckProfile {
  return DECK_PROFILES.find((profile) => profile.id === id) ?? TECHNICS_VINYL;
}

/**
 * How far the user is happy to pitch a record, versus what the deck permits.
 * Spec v1.1 §25: inside `preferredMaxPitchPercent` is normal, beyond it is
 * penalised, beyond the deck range is unavailable.
 */
export interface PitchTolerance {
  /** Comfortable working range, e.g. 4 for ±4%. */
  preferredMaxPitchPercent: number;
  deck: DeckProfile;
}

export const DEFAULT_TOLERANCE: PitchTolerance = {
  preferredMaxPitchPercent: 4,
  deck: TECHNICS_VINYL,
};

export function isWithinDeckRange(pitchPercent: number, deck: DeckProfile): boolean {
  return pitchPercent >= deck.pitchRangeMin && pitchPercent <= deck.pitchRangeMax;
}

export function isWithinPreferred(pitchPercent: number, tolerance: PitchTolerance): boolean {
  return Math.abs(pitchPercent) <= tolerance.preferredMaxPitchPercent;
}

// ---------------------------------------------------------------------------
// Compatibility classification
// ---------------------------------------------------------------------------

/** Spec v1.1 §12. */
export type CompatibilityClass =
  | 'EXCELLENT'
  | 'GOOD'
  | 'TEMPO_ONLY'
  | 'RISKY'
  | 'OUT_OF_RANGE';

/**
 * Central scoring configuration. Spec v1.1 §12 forbids hardcoding these
 * thresholds into UI components, so every consumer reads them from here.
 */
export interface ScoringConfig {
  /** Harmonic score at or above this, with reachable tempo, is EXCELLENT. */
  excellentHarmonic: number;
  /** Harmonic score at or above this is GOOD. */
  goodHarmonic: number;
  /** Below this the tonal relationship is treated as unusable. */
  minimumHarmonic: number;
  /**
   * Cents of residual detuning between two effective centres that counts as
   * clean. Beyond roughly this the two records beat against each other.
   */
  cleanDeviationCents: number;
  /** Deviation beyond which harmonic compatibility is written off. */
  maxDeviationCents: number;
  /** Score multiplier applied per percent of pitch beyond the preferred range. */
  pitchPenaltyPerPercent: number;
  /** Floor for the pitch penalty, so a reachable track is never zeroed. */
  minPitchPenalty: number;
}

export const DEFAULT_SCORING: ScoringConfig = {
  excellentHarmonic: 0.85,
  goodHarmonic: 0.6,
  minimumHarmonic: 0.3,
  // A quarter-tone (50 cents) is the point where two records audibly fight.
  cleanDeviationCents: 18,
  maxDeviationCents: 50,
  pitchPenaltyPerPercent: 0.045,
  minPitchPenalty: 0.55,
};

export function classify(input: {
  reachable: boolean;
  harmonicScore: number;
  config?: ScoringConfig;
}): CompatibilityClass {
  const config = input.config ?? DEFAULT_SCORING;

  if (!input.reachable) return 'OUT_OF_RANGE';
  if (input.harmonicScore >= config.excellentHarmonic) return 'EXCELLENT';
  if (input.harmonicScore >= config.goodHarmonic) return 'GOOD';
  if (input.harmonicScore >= config.minimumHarmonic) return 'RISKY';
  return 'TEMPO_ONLY';
}

/** Human-readable label for a classification. */
export const COMPATIBILITY_LABELS: Record<CompatibilityClass, string> = {
  EXCELLENT: 'Excellent',
  GOOD: 'Good',
  TEMPO_ONLY: 'Tempo only',
  RISKY: 'Risky',
  OUT_OF_RANGE: 'Out of range',
};
