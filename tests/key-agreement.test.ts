import { describe, expect, it } from 'vitest';
import {
  compareKeyEstimates,
  discriminatingNotes,
  pitchClassIndex,
  pitchClassesOf,
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
