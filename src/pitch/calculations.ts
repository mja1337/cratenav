import type { CamelotKey, MusicalKey, PitchClass } from '@/domain/types';
import { musicalKeyToCamelot } from '@/harmonic/camelot';

/**
 * Vinyl pitch mathematics. Spec v1.1 §2, §3.
 *
 * On a turntable without key lock, changing the platter speed changes tempo AND
 * musical pitch together — they are the same physical fact. So the stored key of
 * a record is only its key at nominal speed, and a record played at +4% is
 * genuinely two thirds of a semitone sharp.
 *
 * Everything here is pure and offline (spec v1.1 §33), and deliberately keeps
 * pitch as a continuous float rather than snapping to discrete keys (§4).
 */

/** Semitones per octave; a doubling of frequency. */
const SEMITONES_PER_OCTAVE = 12;

/** Canonical pitch-class numbering, C = 0. Spec v1.1 §4 uses A minor = 9. */
const PITCH_CLASS_NUMBERS: Record<PitchClass, number> = {
  C: 0, 'C#': 1, D: 2, 'D#': 3, E: 4, F: 5,
  'F#': 6, G: 7, 'G#': 8, A: 9, 'A#': 10, B: 11,
};

const NUMBER_TO_PITCH_CLASS: PitchClass[] = [
  'C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B',
];

export function pitchClassNumber(pitchClass: PitchClass): number {
  return PITCH_CLASS_NUMBERS[pitchClass];
}

export function pitchClassFromNumber(value: number): PitchClass {
  // Wrap into 0..11 first; negative and out-of-range input is normal after
  // applying a downward pitch shift.
  const wrapped = ((Math.round(value) % 12) + 12) % 12;
  return NUMBER_TO_PITCH_CLASS[wrapped]!;
}

// ---------------------------------------------------------------------------
// Tempo
// ---------------------------------------------------------------------------

/** Effective BPM after a pitch adjustment. Spec v1.1 §2. */
export function playbackBpm(nativeBpm: number, pitchPercent: number): number {
  return nativeBpm * (1 + pitchPercent / 100);
}

/**
 * Pitch percentage needed to take a record from its native tempo to a target.
 * Spec v1.1 §8.
 */
export function requiredPitchPercent(nativeBpm: number, targetBpm: number): number {
  if (!nativeBpm) return Number.NaN;
  return (targetBpm / nativeBpm - 1) * 100;
}

// ---------------------------------------------------------------------------
// Musical pitch
// ---------------------------------------------------------------------------

/**
 * Musical displacement caused by a speed change, in semitones.
 *
 * This is logarithmic, not linear: +6% is about a semitone, but +12% is not two.
 * Spec v1.1 §2.
 */
export function pitchShiftSemitones(pitchPercent: number): number {
  return SEMITONES_PER_OCTAVE * Math.log2(1 + pitchPercent / 100);
}

/** Same displacement expressed in cents. Spec v1.1 §2. */
export function pitchShiftCents(pitchPercent: number): number {
  return pitchShiftSemitones(pitchPercent) * 100;
}

/** Derive the shift from the two tempos instead of the pitch control reading. */
export function pitchShiftFromBpm(nativeBpm: number, playedBpm: number): number {
  if (!nativeBpm || !playedBpm) return Number.NaN;
  return SEMITONES_PER_OCTAVE * Math.log2(playedBpm / nativeBpm);
}

/** The inverse: what pitch percentage produces a given semitone shift. */
export function pitchPercentForSemitones(semitones: number): number {
  return (2 ** (semitones / SEMITONES_PER_OCTAVE) - 1) * 100;
}

// ---------------------------------------------------------------------------
// Playback mode
// ---------------------------------------------------------------------------

/**
 * Whether tempo changes drag musical pitch with them.
 * Spec v1.1 §22: vinyl does, key lock does not.
 */
export type PlaybackMode = 'VINYL' | 'KEY_LOCK';

export interface PlaybackState {
  trackId?: string;
  nativeBpm: number;
  nativeKey?: MusicalKey | undefined;
  nativeCamelot?: CamelotKey | undefined;

  pitchPercent: number;
  mode: PlaybackMode;

  playbackBpm: number;
  pitchShiftSemitones: number;
  pitchShiftCents: number;

  /** Continuous effective pitch class, 0..12 exclusive. Never snapped. §4 */
  effectivePitchClass: number;
  /** Nearest real key, for display only. */
  effectiveKeyApproximation?: MusicalKey | undefined;
  effectiveCamelotApproximation?: CamelotKey | undefined;
  /**
   * How far the effective centre sits from that nearest key, in cents.
   * A record at +4% is audibly between keys, and this is that distance.
   */
  harmonicDeviationCents: number;
}

/**
 * Describe a track played at a given pitch.
 *
 * Calculated on demand rather than persisted (spec v1.1 §6): it is a property
 * of a moment, not of the record.
 */
export function describePlayback(input: {
  trackId?: string;
  nativeBpm: number;
  nativeKey?: MusicalKey | undefined;
  pitchPercent: number;
  mode?: PlaybackMode;
}): PlaybackState {
  const mode = input.mode ?? 'VINYL';
  const played = playbackBpm(input.nativeBpm, input.pitchPercent);

  // With key lock the platter speed changes but the pitch is corrected back,
  // so musically nothing moves. Spec v1.1 §22.
  const semitones = mode === 'KEY_LOCK' ? 0 : pitchShiftSemitones(input.pitchPercent);

  const nativeCamelot = input.nativeKey ? musicalKeyToCamelot(input.nativeKey) ?? undefined : undefined;

  let effectivePitchClass = Number.NaN;
  let effectiveKeyApproximation: MusicalKey | undefined;
  let effectiveCamelotApproximation: CamelotKey | undefined;
  let harmonicDeviationCents = 0;

  if (input.nativeKey) {
    const native = pitchClassNumber(input.nativeKey.pitchClass);
    effectivePitchClass = wrapPitchClass(native + semitones);

    const nearest = pitchClassFromNumber(effectivePitchClass);
    effectiveKeyApproximation = { pitchClass: nearest, tonality: input.nativeKey.tonality };
    effectiveCamelotApproximation = musicalKeyToCamelot(effectiveKeyApproximation) ?? undefined;

    // How far the effective centre sits from the key we are calling it.
    // Signed so that sharp reads positive and flat negative, which is how a
    // DJ thinks about it: "+32 cents sharp of A#".
    const deviation = signedSemitoneDistance(
      pitchClassNumber(nearest),
      effectivePitchClass,
    );
    harmonicDeviationCents = Math.round(deviation * 100);
  }

  return {
    trackId: input.trackId,
    nativeBpm: input.nativeBpm,
    nativeKey: input.nativeKey,
    nativeCamelot,
    pitchPercent: input.pitchPercent,
    mode,
    playbackBpm: played,
    pitchShiftSemitones: semitones,
    pitchShiftCents: semitones * 100,
    effectivePitchClass,
    effectiveKeyApproximation,
    effectiveCamelotApproximation,
    harmonicDeviationCents,
  };
}

// ---------------------------------------------------------------------------
// Pitch-class geometry
// ---------------------------------------------------------------------------

/** Wrap a possibly-negative or oversized pitch class into 0..12. */
export function wrapPitchClass(value: number): number {
  return ((value % 12) + 12) % 12;
}

/**
 * Shortest distance between two pitch classes, in semitones. Spec v1.1 §29.
 *
 * Wraps around the octave: B to C is 1 semitone, not 11. Works on continuous
 * values so a pitched record can be compared without rounding first.
 */
export function semitoneDistance(a: number, b: number): number {
  const raw = Math.abs(wrapPitchClass(a) - wrapPitchClass(b));
  return Math.min(raw, 12 - raw);
}

/**
 * Signed shortest distance, positive when b is above a.
 * Range is (-6, 6].
 */
export function signedSemitoneDistance(a: number, b: number): number {
  let delta = wrapPitchClass(b) - wrapPitchClass(a);
  if (delta > 6) delta -= 12;
  if (delta <= -6) delta += 12;
  return delta;
}

export function centsDistance(a: number, b: number): number {
  return semitoneDistance(a, b) * 100;
}
