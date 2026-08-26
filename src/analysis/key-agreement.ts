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

/**
 * Which estimate's scale contains the bass note, when only one of them does.
 *
 * Weaker evidence than the bass naming a tonic outright, but discriminating:
 * a recording whose dominant bass note is C# cannot plausibly be in E minor,
 * which has no C# in it. Returns undefined when both scales contain the note or
 * neither does, because then it says nothing.
 */
export function bassSupportsScale(
  bassRoot: string | undefined,
  first: MusicalKey | undefined,
  second: MusicalKey | undefined,
): 'first' | 'second' | undefined {
  if (!bassRoot || !first || !second) return undefined;
  const index = NAMES.indexOf(bassRoot as PitchClass);
  if (index < 0) return undefined;
  const inFirst = pitchClassesOf(first).includes(index);
  const inSecond = pitchClassesOf(second).includes(index);
  if (inFirst === inSecond) return undefined;
  return inFirst ? 'first' : 'second';
}

/**
 * Minimum relative gap for the separating notes to have settled the question.
 *
 * A judgement, not a measurement: it is set well clear of the near-ties seen on
 * real captures (65 against 53, 53 against 49, 44 against 43 — all of which
 * mean the chroma cannot tell) while still firing on a clean difference like 82
 * against 14. Below it, the note evidence is declared inconclusive rather than
 * being read as a decision.
 */
const SEPARATING_DECISIVE = 0.2;

/**
 * Which estimate the separating notes support, if either.
 *
 * When two keys differ by a single note, the note the recording actually
 * contains names the key — but only when one of them clearly outweighs the
 * other. Near-tied energy means the chroma is smeared or the material is
 * chromatic, and forcing a choice there would be inventing an answer.
 */
export interface SeparatingSupport {
  /** Mean strength of the notes exclusive to each estimate. */
  first: number;
  second: number;
  firstNotes: number;
  secondNotes: number;
  /** Which side the note evidence favours, if the gap is decisive. */
  winner?: 'first' | 'second';
}

/**
 * Which side the separating notes support, aggregated PER SIDE.
 *
 * Comparing only the top two notes was wrong and quietly useless. Two keys
 * sharing just two of seven notes have five separating notes each, and the two
 * strongest are frequently on the SAME side — a measured frame had G# at 100%
 * and A# at 92%, both exclusive to the same candidate, so the comparison said
 * nothing about which key was supported and nearly always came back "tied".
 *
 * The question is whether one key's exclusive notes are present and the other's
 * are absent, so the means of the two groups are what to compare. Mean rather
 * than sum, or a key with more exclusive notes would win by having more terms.
 */
export function separatingSupport(
  notes: readonly DiscriminatingNote[],
): SeparatingSupport {
  const mean = (side: 'first' | 'second') => {
    const values = notes.filter((note) => note.supports === side).map((note) => note.strength);
    return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
  };
  const first = mean('first');
  const second = mean('second');
  const firstNotes = notes.filter((note) => note.supports === 'first').length;
  const secondNotes = notes.filter((note) => note.supports === 'second').length;

  const top = Math.max(first, second);
  const support: SeparatingSupport = { first, second, firstNotes, secondNotes };
  // Both sides need exclusive notes for the comparison to mean anything.
  if (!firstNotes || !secondNotes || top <= 0) return support;
  if ((top - Math.min(first, second)) / top >= SEPARATING_DECISIVE) {
    support.winner = first > second ? 'first' : 'second';
  }
  return support;
}
