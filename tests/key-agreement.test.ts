import { describe, expect, it } from 'vitest';
import {
  compareKeyEstimates,
  discriminatingNotes,
  pitchClassIndex,
  pitchClassesOf,
  separatingSupport,
  tonicFromBass,
} from '@/analysis/key-agreement';
import type { MusicalKey } from '@/domain/types';

const key = (pitchClass: MusicalKey['pitchClass'], tonality: MusicalKey['tonality']): MusicalKey =>
  ({ pitchClass, tonality });

/** Chroma with only the named notes present. */
function chromaOf(notes: readonly MusicalKey['pitchClass'][]): number[] {
  const out = Array<number>(12).fill(0.05);
  for (const note of notes) out[pitchClassIndex(note)] = 1;
  return out;
}

describe('comparing two key estimates', () => {
  it('calls a relative pair an agreement about the notes', () => {
    // The real case: Essentia said B major, the custom engine said G# minor.
    // Those are the same seven notes, so "engines differ" was misleading.
    const difference = compareKeyEstimates(key('B', 'major'), key('G#', 'minor'));
    expect(difference.relation).toBe('relative');
    expect(difference.sharedNotes).toBe(7);
    expect(difference.onlyInFirst).toEqual([]);
    expect(difference.onlyInSecond).toEqual([]);
  });

  it('recognises the identical key', () => {
    expect(compareKeyEstimates(key('A', 'minor'), key('A', 'minor')).relation).toBe('same');
  });

  it('names the single note that separates two adjacent keys', () => {
    // B major against E major: six notes shared, and the whole argument is
    // A sharp against A natural.
    const difference = compareKeyEstimates(key('B', 'major'), key('E', 'major'));
    expect(difference.relation).toBe('different');
    expect(difference.sharedNotes).toBe(6);
    expect(difference.onlyInFirst).toEqual(['A#']);
    expect(difference.onlyInSecond).toEqual(['A']);
  });

  it('reports nothing useful when an estimate is missing', () => {
    expect(compareKeyEstimates(undefined, key('A', 'minor')).relation).toBe('unknown');
    expect(compareKeyEstimates(key('A', 'minor'), undefined).sharedNotes).toBe(0);
  });

  it('uses natural minor, not harmonic minor', () => {
    // A natural minor has G, not G#. Harmonic minor would raise the seventh
    // and break every relative-pair comparison.
    expect(pitchClassesOf(key('A', 'minor')).sort((a, b) => a - b))
      .toEqual([0, 2, 4, 5, 7, 9, 11]);
  });
});

describe('breaking a relative tie with the bass', () => {
  it('picks the estimate the bass names', () => {
    expect(tonicFromBass('G#', key('B', 'major'), key('G#', 'minor'))).toBe('second');
    expect(tonicFromBass('B', key('B', 'major'), key('G#', 'minor'))).toBe('first');
  });

  it('decides nothing when the bass names neither', () => {
    // Must not pretend: a bass on the fifth resolves nothing, and the caller
    // has to fall back rather than pick arbitrarily.
    expect(tonicFromBass('D#', key('B', 'major'), key('G#', 'minor'))).toBeUndefined();
    expect(tonicFromBass(undefined, key('B', 'major'), key('G#', 'minor'))).toBeUndefined();
  });
});

describe('discriminating notes', () => {
  it('ranks the separating notes by how much energy each has', () => {
    // A chroma containing A# but not A supports B major over E major.
    const difference = compareKeyEstimates(key('B', 'major'), key('E', 'major'));
    const notes = discriminatingNotes(difference, chromaOf(['B', 'C#', 'D#', 'E', 'F#', 'G#', 'A#']));
    expect(notes[0]).toMatchObject({ note: 'A#', supports: 'first' });
    expect(notes[0]!.strength).toBeGreaterThan(notes[1]!.strength);
    expect(notes[1]).toMatchObject({ note: 'A', supports: 'second' });
  });

  it('has nothing to say about a relative pair', () => {
    // Same notes, so no note can separate them — the tonic is the only
    // question and the chroma cannot answer it.
    const difference = compareKeyEstimates(key('B', 'major'), key('G#', 'minor'));
    expect(discriminatingNotes(difference, chromaOf(['B', 'C#']))).toEqual([]);
  });

  it('returns nothing without a chroma to measure', () => {
    const difference = compareKeyEstimates(key('B', 'major'), key('E', 'major'));
    expect(discriminatingNotes(difference, undefined)).toEqual([]);
    expect(discriminatingNotes(difference, [1, 2, 3])).toEqual([]);
  });
});

describe('aggregating separating-note evidence', () => {
  /**
   * Comparing only the two strongest separating notes was wrong and quietly
   * useless. Keys sharing two of seven notes have five separating notes each,
   * and the two strongest are frequently on the SAME side — a measured frame
   * had G# at 100% and A# at 92%, both exclusive to one candidate — so the
   * comparison said nothing about which key was supported and came back
   * "tied" almost every time.
   */
  const note = (
    name: MusicalKey['pitchClass'],
    strength: number,
    supports: 'first' | 'second',
  ) => ({ note: name, strength, supports });

  it('decides when the top two notes are on the same side', () => {
    // Exactly the measured frame: the strongest two both support `first`.
    const support = separatingSupport([
      note('G#', 1.0, 'first'), note('A#', 0.92, 'first'),
      note('A', 0.7, 'second'), note('D#', 0.65, 'first'),
      note('C#', 0.5, 'first'), note('B', 0.47, 'second'),
      note('E', 0.43, 'second'), note('D', 0.37, 'second'),
    ]);
    expect(support.winner).toBe('first');
    expect(support.firstNotes).toBe(4);
    expect(support.secondNotes).toBe(4);
    expect(support.first).toBeGreaterThan(support.second);
  });

  it('averages rather than sums, so more notes is not an advantage', () => {
    // One strong note against three weak ones: the single note wins on mean.
    const support = separatingSupport([
      note('A#', 0.9, 'first'),
      note('C', 0.3, 'second'), note('D', 0.3, 'second'), note('E', 0.3, 'second'),
    ]);
    expect(support.winner).toBe('first');
    expect(support.first).toBeCloseTo(0.9, 5);
    expect(support.second).toBeCloseTo(0.3, 5);
  });

  it('declines to decide when the two sides are comparable', () => {
    const support = separatingSupport([
      note('C', 0.44, 'first'), note('C#', 0.43, 'second'),
    ]);
    expect(support.winner).toBeUndefined();
  });

  it('declines when only one side has exclusive notes', () => {
    // Nothing to compare against, so the comparison is meaningless.
    const support = separatingSupport([note('A#', 0.9, 'first')]);
    expect(support.winner).toBeUndefined();
  });

  it('has nothing to say about a relative pair', () => {
    expect(separatingSupport([]).winner).toBeUndefined();
  });
});
