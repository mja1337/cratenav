import { describe, expect, it } from 'vitest';
import {
  centsDistance,
  describePlayback,
  pitchClassFromNumber,
  pitchClassNumber,
  pitchPercentForSemitones,
  pitchShiftCents,
  pitchShiftFromBpm,
  pitchShiftSemitones,
  playbackBpm,
  requiredPitchPercent,
  semitoneDistance,
  signedSemitoneDistance,
  wrapPitchClass,
} from '@/pitch/calculations';
import {
  classify,
  DEFAULT_SCORING,
  DEFAULT_TOLERANCE,
  findDeckProfile,
  isWithinDeckRange,
  TECHNICS_VINYL,
  type DeckProfile,
  type PitchTolerance,
} from '@/pitch/deck';
import { computeDetuneFactor, computePitchPenalty, matchAtPitch } from '@/pitch/matching';
import { normaliseBpm } from '@/bpm/normalise';
import {
  continuousCamelotNumber,
  formatCamelot,
  musicalKeyToCamelot,
  parseKey,
} from '@/harmonic/camelot';

/** Spec v1.1 §27: every pitch calculation is covered. */

describe('playback BPM (spec v1.1 §2)', () => {
  it('is unchanged at zero pitch', () => {
    expect(playbackBpm(174, 0)).toBe(174);
  });

  it('matches the worked example: 174 at +4%', () => {
    expect(playbackBpm(174, 4)).toBeCloseTo(180.96, 2);
  });

  it('works symmetrically downwards', () => {
    expect(playbackBpm(174, -4)).toBeCloseTo(167.04, 2);
  });

  it('handles the deck extremes', () => {
    expect(playbackBpm(174, 8)).toBeCloseTo(187.92, 2);
    expect(playbackBpm(174, -8)).toBeCloseTo(160.08, 2);
  });
});

describe('pitch shift in semitones (spec v1.1 §2, §3)', () => {
  it('is zero at nominal speed', () => {
    expect(pitchShiftSemitones(0)).toBe(0);
  });

  // The reference table from spec v1.1 §3, verbatim.
  it('matches the reference table', () => {
    const cases: [number, number][] = [
      [1, 0.17],
      [2, 0.34],
      [3, 0.51],
      [4, 0.68],
      [5, 0.84],
      [5.95, 1.0],
      [8, 1.33],
    ];
    for (const [percent, expected] of cases) {
      expect(pitchShiftSemitones(percent), `at +${percent}%`).toBeCloseTo(expected, 2);
    }
  });

  it('is symmetric in behaviour but not in magnitude', () => {
    // Logarithmic, so -4% moves slightly further than +4% does.
    expect(pitchShiftSemitones(-4)).toBeCloseTo(-0.71, 2);
    expect(Math.abs(pitchShiftSemitones(-4))).toBeGreaterThan(pitchShiftSemitones(4));
  });

  it('reaches exactly one semitone at +5.946%', () => {
    expect(pitchShiftSemitones(5.946)).toBeCloseTo(1, 3);
  });

  it('reaches exactly minus one semitone at -5.613%', () => {
    // 2^(-1/12) - 1 = -5.6126%
    expect(pitchShiftSemitones(-5.6126)).toBeCloseTo(-1, 3);
  });

  it('converts to cents', () => {
    expect(pitchShiftCents(4)).toBeCloseTo(67.9, 1);
    expect(pitchShiftCents(0)).toBe(0);
  });

  it('inverts back to a pitch percentage', () => {
    expect(pitchPercentForSemitones(1)).toBeCloseTo(5.946, 3);
    expect(pitchPercentForSemitones(0)).toBe(0);
    expect(pitchPercentForSemitones(-1)).toBeCloseTo(-5.613, 3);
  });

  it('derives the shift from two tempos', () => {
    expect(pitchShiftFromBpm(174, 180.96)).toBeCloseTo(0.68, 2);
    expect(pitchShiftFromBpm(172, 176)).toBeCloseTo(0.4, 2);
  });

  it('is not one octave just because the BPM doubled', () => {
    // A genuine double-speed playback IS an octave; this guards the maths, and
    // the normalisation test below guards the far more likely confusion.
    expect(pitchShiftSemitones(100)).toBeCloseTo(12, 6);
  });
});

describe('required pitch (spec v1.1 §8, §36)', () => {
  it('answers the acceptance question: 172 record, 176 target', () => {
    expect(requiredPitchPercent(172, 176)).toBeCloseTo(2.3256, 3);
  });

  it('needs no pitch when the tempos already agree', () => {
    expect(requiredPitchPercent(174, 174)).toBe(0);
  });

  it('goes negative to slow a record down', () => {
    expect(requiredPitchPercent(176, 172)).toBeCloseTo(-2.2727, 3);
  });

  it('detects the out-of-range example from the spec', () => {
    const required = requiredPitchPercent(170, 186);
    expect(required).toBeCloseTo(9.4118, 3);
    expect(isWithinDeckRange(required, TECHNICS_VINYL)).toBe(false);
  });

  it('refuses to divide by zero', () => {
    expect(Number.isNaN(requiredPitchPercent(0, 174))).toBe(true);
  });
});

describe('deck profiles (spec v1.1 §7)', () => {
  it('defaults to Technics-style vinyl with no key lock', () => {
    expect(TECHNICS_VINYL.pitchRangeMin).toBe(-8);
    expect(TECHNICS_VINYL.pitchRangeMax).toBe(8);
    expect(TECHNICS_VINYL.keyLockAvailable).toBe(false);
    expect(TECHNICS_VINYL.mode).toBe('VINYL');
  });

  it('accepts a wider custom profile', () => {
    const custom: DeckProfile = {
      id: 'custom', name: 'Custom', pitchRangeMin: -16, pitchRangeMax: 16,
      keyLockAvailable: false, mode: 'VINYL',
    };
    const required = requiredPitchPercent(170, 186);
    expect(isWithinDeckRange(required, TECHNICS_VINYL)).toBe(false);
    // The same record IS reachable on a wider deck.
    expect(isWithinDeckRange(required, custom)).toBe(true);
  });

  it('handles asymmetric ranges', () => {
    const odd: DeckProfile = {
      id: 'odd', name: 'Odd', pitchRangeMin: -4, pitchRangeMax: 12,
      keyLockAvailable: false, mode: 'VINYL',
    };
    expect(isWithinDeckRange(10, odd)).toBe(true);
    expect(isWithinDeckRange(-6, odd)).toBe(false);
  });

  it('falls back to the vinyl default for an unknown id', () => {
    expect(findDeckProfile('nope').id).toBe(TECHNICS_VINYL.id);
    expect(findDeckProfile(undefined).id).toBe(TECHNICS_VINYL.id);
  });
});

describe('key lock (spec v1.1 §22)', () => {
  it('moves tempo without moving pitch', () => {
    const state = describePlayback({
      nativeBpm: 174,
      nativeKey: parseKey('A minor')!,
      pitchPercent: 4,
      mode: 'KEY_LOCK',
    });
    expect(state.playbackBpm).toBeCloseTo(180.96, 2);
    expect(state.pitchShiftSemitones).toBe(0);
    expect(state.effectiveCamelotApproximation && formatCamelot(state.effectiveCamelotApproximation)).toBe('8A');
  });

  it('moves both on vinyl', () => {
    const state = describePlayback({
      nativeBpm: 174,
      nativeKey: parseKey('A minor')!,
      pitchPercent: 4,
      mode: 'VINYL',
    });
    expect(state.pitchShiftSemitones).toBeCloseTo(0.68, 2);
    // A minor is pitch class 9; +0.68 lands at 9.68, which rounds to A#/Bb.
    expect(state.effectivePitchClass).toBeCloseTo(9.68, 2);
    expect(state.effectiveKeyApproximation?.pitchClass).toBe('A#');
    expect(state.effectiveKeyApproximation?.tonality).toBe('minor');
  });

  it('never changes major or minor', () => {
    for (const pitch of [-8, -4, 0, 4, 8]) {
      const state = describePlayback({
        nativeBpm: 174, nativeKey: parseKey('C major')!, pitchPercent: pitch,
      });
      expect(state.effectiveKeyApproximation?.tonality).toBe('major');
    }
  });

  it('reports how far the effective centre sits from the key it is called', () => {
    const state = describePlayback({
      nativeBpm: 174, nativeKey: parseKey('A minor')!, pitchPercent: 4,
    });
    // 9.68 is 32 cents flat of A# (pitch class 10).
    expect(state.harmonicDeviationCents).toBe(-32);
  });

  it('wraps around the octave at the top of the range', () => {
    const state = describePlayback({
      nativeBpm: 174, nativeKey: parseKey('B minor')!, pitchPercent: 8,
    });
    // B is 11; +1.33 semitones wraps past 12 to 0.33 (C).
    expect(state.effectivePitchClass).toBeCloseTo(0.33, 2);
    expect(state.effectiveKeyApproximation?.pitchClass).toBe('C');
  });
});

describe('BPM normalisation is not a pitch change (spec v1.1 §19, §28)', () => {
  it('keeps pitch at zero when 87 is canonicalised to 174', () => {
    const normalised = normaliseBpm({ bpm: 87, styles: ['Drum n Bass'] });
    expect(normalised.sourceBpm).toBe(87);
    expect(normalised.canonicalBpm).toBe(174);

    // Canonicalising a half-time reading is a change of REPRESENTATION.
    // The record still plays at nominal speed, so nothing moves musically.
    const state = describePlayback({
      nativeBpm: normalised.canonicalBpm,
      nativeKey: parseKey('A minor')!,
      pitchPercent: 0,
    });
    expect(state.pitchShiftSemitones).toBe(0);
    expect(state.pitchShiftCents).toBe(0);
    expect(state.harmonicDeviationCents).toBe(0);
    expect(formatCamelot(state.effectiveCamelotApproximation!)).toBe('8A');
  });

  it('does not imply an octave shift', () => {
    const doubled = normaliseBpm({ bpm: 87, styles: ['Jungle'] });
    const state = describePlayback({
      nativeBpm: doubled.canonicalBpm, nativeKey: parseKey('A minor')!, pitchPercent: 0,
    });
    expect(state.pitchShiftSemitones).not.toBeCloseTo(12, 1);
    expect(state.pitchShiftSemitones).toBe(0);
  });
});

describe('harmonic distance (spec v1.1 §29)', () => {
  it('wraps around the octave', () => {
    // B to C is one semitone, not eleven.
    expect(semitoneDistance(pitchClassNumber('B'), pitchClassNumber('C'))).toBe(1);
    expect(semitoneDistance(pitchClassNumber('C'), pitchClassNumber('B'))).toBe(1);
  });

  it('is symmetric', () => {
    expect(semitoneDistance(2, 9)).toBe(semitoneDistance(9, 2));
  });

  it('never exceeds a tritone', () => {
    for (let a = 0; a < 12; a += 1) {
      for (let b = 0; b < 12; b += 1) {
        expect(semitoneDistance(a, b)).toBeLessThanOrEqual(6);
      }
    }
  });

  it('works on continuous values', () => {
    expect(semitoneDistance(9.68, 10)).toBeCloseTo(0.32, 4);
    expect(semitoneDistance(11.8, 0.2)).toBeCloseTo(0.4, 4);
  });

  it('gives a signed direction', () => {
    expect(signedSemitoneDistance(pitchClassNumber('B'), pitchClassNumber('C'))).toBe(1);
    expect(signedSemitoneDistance(pitchClassNumber('C'), pitchClassNumber('B'))).toBe(-1);
    expect(signedSemitoneDistance(0, 6)).toBe(6);
  });

  it('converts to cents', () => {
    expect(centsDistance(9, 10)).toBe(100);
  });

  it('wraps pitch classes into range', () => {
    expect(wrapPitchClass(-1)).toBe(11);
    expect(wrapPitchClass(12)).toBe(0);
    expect(wrapPitchClass(13.5)).toBe(1.5);
    expect(pitchClassFromNumber(-1)).toBe('B');
    expect(pitchClassFromNumber(12)).toBe('C');
  });
});

describe('pitch penalty (spec v1.1 §24, §25)', () => {
  it('does not penalise inside the preferred range', () => {
    expect(computePitchPenalty(0)).toBe(1);
    expect(computePitchPenalty(4)).toBe(1);
    expect(computePitchPenalty(-4)).toBe(1);
  });

  it('penalises beyond the preferred range', () => {
    expect(computePitchPenalty(6)).toBeLessThan(1);
    expect(computePitchPenalty(7.8)).toBeLessThan(computePitchPenalty(6));
  });

  it('ranks a small pitch above a large one, as the spec requires', () => {
    expect(computePitchPenalty(0.8)).toBeGreaterThan(computePitchPenalty(7.8));
  });

  it('never zeroes a reachable candidate', () => {
    expect(computePitchPenalty(8)).toBeGreaterThanOrEqual(DEFAULT_SCORING.minPitchPenalty);
    expect(computePitchPenalty(16)).toBeGreaterThanOrEqual(DEFAULT_SCORING.minPitchPenalty);
  });

  it('honours a custom preferred range', () => {
    const strict: PitchTolerance = { preferredMaxPitchPercent: 2, deck: TECHNICS_VINYL };
    expect(computePitchPenalty(3, strict)).toBeLessThan(1);
    expect(computePitchPenalty(3, DEFAULT_TOLERANCE)).toBe(1);
  });
});

describe('detuning factor', () => {
  it('ignores negligible detuning', () => {
    expect(computeDetuneFactor(0)).toBe(1);
    expect(computeDetuneFactor(10)).toBe(1);
  });

  it('degrades as detuning grows', () => {
    expect(computeDetuneFactor(30)).toBeLessThan(1);
    expect(computeDetuneFactor(45)).toBeLessThan(computeDetuneFactor(30));
  });

  it('bottoms out rather than reaching zero', () => {
    expect(computeDetuneFactor(50)).toBeCloseTo(0.35, 2);
    expect(computeDetuneFactor(200)).toBeCloseTo(0.35, 2);
  });
});

describe('classification (spec v1.1 §12)', () => {
  it('marks an unreachable tempo as out of range', () => {
    expect(classify({ reachable: false, harmonicScore: 1 })).toBe('OUT_OF_RANGE');
  });

  it('grades reachable candidates by harmony', () => {
    expect(classify({ reachable: true, harmonicScore: 0.95 })).toBe('EXCELLENT');
    expect(classify({ reachable: true, harmonicScore: 0.7 })).toBe('GOOD');
    expect(classify({ reachable: true, harmonicScore: 0.4 })).toBe('RISKY');
    expect(classify({ reachable: true, harmonicScore: 0.1 })).toBe('TEMPO_ONLY');
  });
});

describe('pitch-aware matching (spec v1.1 §10, §36)', () => {
  const aMinor = parseKey('A minor')!;

  it('answers the spec worked example', () => {
    // Candidate: native 172 BPM, 8A. Target: 176 BPM.
    const match = matchAtPitch({
      target: { bpm: 176, effectivePitchClass: pitchClassNumber('A'), tonality: 'minor' },
      nativeBpm: 172,
      nativeKey: aMinor,
    });

    expect(match.reachable).toBe(true);
    expect(match.requiredPitchPercent).toBeCloseTo(2.3256, 3);
    expect(match.playbackBpm).toBeCloseTo(176, 6);
    expect(match.pitchShiftSemitones).toBeCloseTo(0.4, 2);
  });

  it('rejects a record the deck cannot reach', () => {
    const match = matchAtPitch({
      target: { bpm: 186, effectivePitchClass: pitchClassNumber('A'), tonality: 'minor' },
      nativeBpm: 170,
      nativeKey: aMinor,
    });
    expect(match.reachable).toBe(false);
    expect(match.classification).toBe('OUT_OF_RANGE');
    expect(match.score).toBe(0);
  });

  it('accepts that same record on a wider deck', () => {
    const wide = findDeckProfile('wide-vinyl');
    const match = matchAtPitch({
      target: { bpm: 186, effectivePitchClass: pitchClassNumber('A'), tonality: 'minor' },
      nativeBpm: 170,
      nativeKey: aMinor,
      tolerance: { preferredMaxPitchPercent: 4, deck: wide },
    });
    expect(match.reachable).toBe(true);
    expect(match.classification).not.toBe('OUT_OF_RANGE');
  });

  it('scores the EFFECTIVE key, not the sleeve key', () => {
    // Both records are 8A natively. Pitching one by +5.95% moves it a full
    // semitone, so at playback they are a semitone apart and clash — even
    // though the labels both say 8A.
    const semitoneUp = 174 * 1.05946;
    const match = matchAtPitch({
      target: { bpm: semitoneUp, effectivePitchClass: pitchClassNumber('A'), tonality: 'minor' },
      nativeBpm: 174,
      nativeKey: aMinor,
    });
    expect(match.reachable).toBe(true);
    // Effective centre has moved to A# (10).
    expect(match.effectivePitchClass).toBeCloseTo(10, 1);
    expect(match.effectiveKey?.pitchClass).toBe('A#');
    // A# minor against A minor is a clash, so this must not read as excellent.
    expect(match.classification).not.toBe('EXCELLENT');
    expect(match.effectiveHarmonicScore).toBeLessThan(DEFAULT_SCORING.goodHarmonic);
  });

  it('treats two records pitched into tune with each other as in tune', () => {
    // Target is itself sharp: effective centre 9.4 rather than 9.
    // A candidate pitched to the same 9.4 is a perfect unison in practice.
    const match = matchAtPitch({
      target: { bpm: 176, effectivePitchClass: 9.4, tonality: 'minor' },
      nativeBpm: 172,
      nativeKey: aMinor,
    });
    // 172 -> 176 shifts the candidate +0.40 semitones, to 9.40 as well.
    expect(match.effectivePitchClass).toBeCloseTo(9.4, 1);
    expect(match.harmonicDeviationCents).toBeLessThanOrEqual(DEFAULT_SCORING.cleanDeviationCents);
    expect(match.classification).toBe('EXCELLENT');
  });

  it('prefers the smaller pitch adjustment between equals', () => {
    const target = { bpm: 174, effectivePitchClass: pitchClassNumber('A'), tonality: 'minor' as const };
    const close = matchAtPitch({ target, nativeBpm: 173, nativeKey: aMinor });
    const far = matchAtPitch({ target, nativeBpm: 162, nativeKey: aMinor });
    expect(close.score).toBeGreaterThan(far.score);
  });

  it('reports tempo-only when the key is unknown', () => {
    const match = matchAtPitch({
      target: { bpm: 176 },
      nativeBpm: 172,
      nativeKey: aMinor,
    });
    expect(match.reachable).toBe(true);
    expect(match.classification).toBe('TEMPO_ONLY');
    expect(match.requiredPitchPercent).toBeCloseTo(2.3256, 3);
  });

  it('falls back to nominal-speed comparison with no tempo', () => {
    const match = matchAtPitch({
      target: { effectivePitchClass: pitchClassNumber('A'), tonality: 'minor' },
      nativeKey: aMinor,
    });
    expect(match.requiredPitchPercent).toBe(0);
    expect(match.relation.relation).toBe('same');
  });

  it('does not move pitch when the deck has key lock engaged', () => {
    const digital = findDeckProfile('digital-keylock');
    const match = matchAtPitch({
      target: { bpm: 186, effectivePitchClass: pitchClassNumber('A'), tonality: 'minor' },
      nativeBpm: 174,
      nativeKey: aMinor,
      tolerance: { preferredMaxPitchPercent: 8, deck: digital },
    });
    expect(match.pitchShiftSemitones).toBe(0);
    // The key never moved, so it is still a unison.
    expect(match.effectiveKey?.pitchClass).toBe('A');
    expect(match.classification).toBe('EXCELLENT');
  });

  it('softens a clash when the live key reading is shaky', () => {
    // Eb minor (2A) against A minor (8A) is a genuine clash: five steps apart.
    const target = { bpm: 174, effectivePitchClass: pitchClassNumber('D#'), tonality: 'minor' as const };
    const trusted = matchAtPitch({ target: { ...target, keyConfidence: 1 }, nativeBpm: 174, nativeKey: aMinor });
    const doubted = matchAtPitch({ target: { ...target, keyConfidence: 0.2 }, nativeBpm: 174, nativeKey: aMinor });

    expect(trusted.effectiveHarmonicScore).toBe(0);
    // We do not trust the reading, so we should not act on the clash either.
    expect(doubted.effectiveHarmonicScore).toBeGreaterThan(trusted.effectiveHarmonicScore);
  });

  it('also softens a good match when the reading is shaky', () => {
    // Reducing the weight of harmony (spec §15) has to cut both ways: a
    // claimed good match is no more trustworthy than a claimed clash.
    const target = { bpm: 174, effectivePitchClass: pitchClassNumber('A'), tonality: 'minor' as const };
    const trusted = matchAtPitch({ target: { ...target, keyConfidence: 1 }, nativeBpm: 174, nativeKey: aMinor });
    const doubted = matchAtPitch({ target: { ...target, keyConfidence: 0.2 }, nativeBpm: 174, nativeKey: aMinor });

    expect(trusted.effectiveHarmonicScore).toBe(1);
    expect(doubted.effectiveHarmonicScore).toBeLessThan(trusted.effectiveHarmonicScore);
    // Both converge towards no-opinion rather than towards zero.
    expect(doubted.effectiveHarmonicScore).toBeGreaterThan(0.5);
  });
});

describe('continuous Camelot position (spec v1.1 §17)', () => {
  it('places the known anchors correctly', () => {
    // 8A = A minor (pitch class 9), 8B = C major (0).
    expect(continuousCamelotNumber(9, 'minor')).toBeCloseTo(8, 6);
    expect(continuousCamelotNumber(0, 'major')).toBeCloseTo(8, 6);
  });

  it('moves SEVEN wheel steps per semitone, not one', () => {
    // The wheel is the circle of fifths, so a semitone is seven positions.
    // 9 -> 10 (A to A#) must land on 8 + 7 = 15, wrapped to 3.
    expect(continuousCamelotNumber(10, 'minor')).toBeCloseTo(3, 6);
    // And a fifth up (7 semitones) is one position: E minor is 9A.
    expect(continuousCamelotNumber(4, 'minor')).toBeCloseTo(9, 6);
  });

  it('agrees with the discrete table across all twelve minors', () => {
    for (let pitchClass = 0; pitchClass < 12; pitchClass += 1) {
      const continuous = continuousCamelotNumber(pitchClass, 'minor');
      const discrete = musicalKeyToCamelot({
        pitchClass: pitchClassFromNumber(pitchClass),
        tonality: 'minor',
      })!;
      expect(Math.round(continuous), `pitch class ${pitchClass}`).toBe(discrete.number);
    }
  });

  it('agrees with the discrete table across all twelve majors', () => {
    for (let pitchClass = 0; pitchClass < 12; pitchClass += 1) {
      const continuous = continuousCamelotNumber(pitchClass, 'major');
      const discrete = musicalKeyToCamelot({
        pitchClass: pitchClassFromNumber(pitchClass),
        tonality: 'major',
      })!;
      expect(Math.round(continuous), `pitch class ${pitchClass}`).toBe(discrete.number);
    }
  });

  it('stays inside the wheel for fractional positions', () => {
    for (const pitchClass of [9.1, 9.68, 11.9, 0.3, 6.5]) {
      const value = continuousCamelotNumber(pitchClass, 'minor');
      expect(value).toBeGreaterThanOrEqual(1);
      expect(value).toBeLessThan(13);
    }
  });

  it('lands between segments for a fractional shift', () => {
    // A minor pitched +0.68 semitones: 8 + 7*0.68 = 12.76.
    const value = continuousCamelotNumber(9.68, 'minor');
    expect(value).toBeCloseTo(12.76, 2);
    // Genuinely between two segments, not snapped.
    expect(Number.isInteger(value)).toBe(false);
  });
});
