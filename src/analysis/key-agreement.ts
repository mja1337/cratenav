import type { MusicalKey, PitchClass } from '@/domain/types';

/**
 * How two key estimates relate, and which note actually separates them.
 *
 * Two engines reporting "B major" and "G# minor" look like a disagreement and
 * are not one: those are relative keys and contain the SAME seven notes, so the
 * engines agree about the music and differ only over which note is home. A flat
 * "engines differ" hid that, and hid the useful fact that a three-way argument
 * between B major, G# minor and a source claiming E major turns on exactly one
 * note — A natural against A sharp.
 *
 * Pure and separate from either engine so the relationship can be tested
 * directly rather than inferred from a recording.
 */

const NAMES: readonly PitchClass[] = [
  'C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B',
];

/** Natural minor: the mode dance music actually uses, not harmonic minor. */
const MAJOR_STEPS = [0, 2, 4, 5, 7, 9, 11] as const;
const MINOR_STEPS = [0, 2, 3, 5, 7, 8, 10] as const;

export type KeyRelation = 'same' | 'relative' | 'different' | 'unknown';

export function pitchClassIndex(name: PitchClass): number {
  return NAMES.indexOf(name);
}

export function pitchClassName(index: number): PitchClass {
  return NAMES[((index % 12) + 12) % 12]!;
}

/** The seven pitch classes of a key, as indices. */
export function pitchClassesOf(key: MusicalKey): number[] {
  const root = pitchClassIndex(key.pitchClass);
  const steps = key.tonality === 'major' ? MAJOR_STEPS : MINOR_STEPS;
  return steps.map((step) => (root + step) % 12);
}

export interface KeyDifference {
  relation: KeyRelation;
  /** How many of the seven notes both keys contain. */
  sharedNotes: number;
  /** Notes in the first key only, and in the second only. */
  onlyInFirst: PitchClass[];
  onlyInSecond: PitchClass[];
}

export function compareKeyEstimates(
  first: MusicalKey | undefined,
  second: MusicalKey | undefined,
): KeyDifference {
  if (!first || !second) {
    return { relation: 'unknown', sharedNotes: 0, onlyInFirst: [], onlyInSecond: [] };
  }
  const a = new Set(pitchClassesOf(first));
  const b = new Set(pitchClassesOf(second));
  const onlyInFirst = [...a].filter((note) => !b.has(note)).sort((x, y) => x - y);
  const onlyInSecond = [...b].filter((note) => !a.has(note)).sort((x, y) => x - y);
  const sharedNotes = [...a].filter((note) => b.has(note)).length;

  const identical = first.pitchClass === second.pitchClass && first.tonality === second.tonality;
  const relation: KeyRelation = identical
    ? 'same'
    // Identical note sets but a different tonic is the relative major/minor
    // pair: an agreement about the notes, a disagreement about the centre.
    : sharedNotes === 7 ? 'relative' : 'different';

  return {
    relation,
    sharedNotes,
    onlyInFirst: onlyInFirst.map(pitchClassName),
    onlyInSecond: onlyInSecond.map(pitchClassName),
  };
}

/**
 * Which of two relative candidates the bass supports.
 *
 * A relative pair is inseparable by profile correlation — same notes — so the
 * lowest register is the evidence qualified to break it. Returns undefined when
 * the bass names neither, in which case nothing has been decided and the caller
 * must fall back rather than pretend.
 */
export function tonicFromBass(
  bassRoot: string | undefined,
  first: MusicalKey | undefined,
  second: MusicalKey | undefined,
): 'first' | 'second' | undefined {
  if (!bassRoot) return undefined;
  if (first && bassRoot === first.pitchClass) return 'first';
  if (second && bassRoot === second.pitchClass) return 'second';
  return undefined;
}

export interface DiscriminatingNote {
  note: PitchClass;
  /** Normalised chroma strength, 0-1. */
  strength: number;
  /** Which estimate contains this note. */
  supports: 'first' | 'second';
}

/**
 * The notes that separate two estimates, with how much energy each actually has.
 *
 * This is the measurement that settles the argument: if the keys differ only by
 * A against A#, then whichever of those two the chroma actually contains names
 * the key. Sorted strongest first so the answer is the top row.
 */
export function discriminatingNotes(
  difference: KeyDifference,
  chroma: readonly number[] | undefined,
): DiscriminatingNote[] {
  if (!chroma || chroma.length < 12) return [];
  const peak = Math.max(...chroma);
  const strengthOf = (note: PitchClass) =>
    peak > 0 ? (chroma[pitchClassIndex(note)] ?? 0) / peak : 0;

  return [
    ...difference.onlyInFirst.map((note) => ({
      note, strength: strengthOf(note), supports: 'first' as const,
    })),
    ...difference.onlyInSecond.map((note) => ({
      note, strength: strengthOf(note), supports: 'second' as const,
    })),
  ].sort((a, b) => b.strength - a.strength);
}
