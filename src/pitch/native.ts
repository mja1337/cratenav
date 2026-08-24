import type { CamelotKey, MusicalKey, TrackAnalysis } from '@/domain/types';
import { camelotToMusicalKey, musicalKeyToCamelot } from '@/harmonic/camelot';
import { describePlayback, pitchClassNumber } from './calculations';
import type { PlaybackTarget } from './matching';

/**
 * Native-value accessors. Spec v1.1 §5.
 *
 * The native fields are explicit in the model, but writing them everywhere
 * would let them drift out of step with the canonical values. So they are read
 * through here, falling back to canonical when unset: canonicalBpm already IS
 * the tempo at nominal speed once half/double-time normalisation has run.
 */

export function nativeBpmOf(analysis: TrackAnalysis | undefined): number | undefined {
  return analysis?.nativeBpm ?? analysis?.canonicalBpm;
}

export function nativeKeyOf(analysis: TrackAnalysis | undefined): MusicalKey | undefined {
  if (analysis?.nativeKey) return analysis.nativeKey;
  if (analysis?.canonicalKey) return analysis.canonicalKey;
  // Fall back through Camelot: some writers set only the wheel position, and
  // silently degrading to "no key" would drop the record to TEMPO ONLY.
  return analysis?.camelotKey ? camelotToMusicalKey(analysis.camelotKey) ?? undefined : undefined;
}

export function nativeCamelotOf(analysis: TrackAnalysis | undefined): CamelotKey | undefined {
  if (analysis?.nativeCamelot) return analysis.nativeCamelot;
  const key = nativeKeyOf(analysis);
  if (analysis?.camelotKey) return analysis.camelotKey;
  return key ? musicalKeyToCamelot(key) ?? undefined : undefined;
}

export function nativePitchClassOf(analysis: TrackAnalysis | undefined): number | undefined {
  if (analysis?.nativePitchClass !== undefined) return analysis.nativePitchClass;
  const key = nativeKeyOf(analysis);
  return key ? pitchClassNumber(key.pitchClass) : undefined;
}

/**
 * Treat a library track as a playback target at nominal speed.
 *
 * Used when planning from a track already in the library: its stored key IS its
 * effective key, because pitch is zero until someone moves the slider.
 */
export function asPlaybackTarget(
  analysis: TrackAnalysis | undefined,
  overrides: { pitchPercent?: number } = {},
): PlaybackTarget {
  const key = nativeKeyOf(analysis);
  const bpm = nativeBpmOf(analysis);
  const pitch = overrides.pitchPercent ?? 0;

  if (!pitch) {
    return {
      bpm,
      effectivePitchClass: key ? pitchClassNumber(key.pitchClass) : undefined,
      tonality: key?.tonality,
      keyConfidence: analysis?.keyConfidence,
    };
  }

  // Planning a transition out of a record that is itself pitched.
  const state = describePlayback({
    nativeBpm: bpm ?? 0,
    nativeKey: key,
    pitchPercent: pitch,
  });
  return {
    bpm: state.playbackBpm,
    effectivePitchClass: state.effectivePitchClass,
    tonality: key?.tonality,
    keyConfidence: analysis?.keyConfidence,
  };
}
