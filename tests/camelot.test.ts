import { describe, expect, it } from 'vitest';
import {
  allCamelotKeys,
  camelotToMusicalKey,
  formatCamelot,
  formatCombined,
  formatMusicalKey,
  musicalKeyToCamelot,
  parseCamelot,
  parseKey,
} from '@/harmonic/camelot';
import type { MusicalKey } from '@/domain/types';

const key = (pitchClass: MusicalKey['pitchClass'], tonality: MusicalKey['tonality']): MusicalKey => ({
  pitchClass,
  tonality,
});

describe('camelot conversion', () => {
  // The four anchors given explicitly in spec §12.
  it('matches the spec reference mappings', () => {
    expect(formatCamelot(musicalKeyToCamelot(key('A', 'minor'))!)).toBe('8A');
    expect(formatCamelot(musicalKeyToCamelot(key('C', 'major'))!)).toBe('8B');
    expect(formatCamelot(musicalKeyToCamelot(key('E', 'minor'))!)).toBe('9A');
    expect(formatCamelot(musicalKeyToCamelot(key('G', 'major'))!)).toBe('9B');
  });

  it('round-trips all 24 wheel positions', () => {
    const positions = allCamelotKeys();
    expect(positions).toHaveLength(24);
    for (const camelot of positions) {
      const musical = camelotToMusicalKey(camelot);
      expect(musical, `no key for ${formatCamelot(camelot)}`).not.toBeNull();
      const back = musicalKeyToCamelot(musical!);
      expect(formatCamelot(back!)).toBe(formatCamelot(camelot));
    }
  });

  it('assigns every wheel number a distinct relative major/minor pair', () => {
    const seen = new Set<string>();
    for (const camelot of allCamelotKeys()) {
      const musical = camelotToMusicalKey(camelot)!;
      const signature = `${musical.pitchClass}-${musical.tonality}`;
      expect(seen.has(signature), `duplicate key ${signature}`).toBe(false);
      seen.add(signature);
    }
    expect(seen.size).toBe(24);
  });

  it('moves up a perfect fifth when the wheel number increments', () => {
    // 8B = C major, 9B = G major, 10B = D major.
    expect(formatMusicalKey(camelotToMusicalKey({ number: 8, letter: 'B' })!)).toBe('C major');
    expect(formatMusicalKey(camelotToMusicalKey({ number: 9, letter: 'B' })!)).toBe('G major');
    expect(formatMusicalKey(camelotToMusicalKey({ number: 10, letter: 'B' })!)).toBe('D major');
  });

  it('pairs A and B at the same number as relative minor/major', () => {
    // 8A/8B = A minor / C major.
    expect(formatMusicalKey(camelotToMusicalKey({ number: 8, letter: 'A' })!)).toBe('A minor');
    expect(formatMusicalKey(camelotToMusicalKey({ number: 8, letter: 'B' })!)).toBe('C major');
  });

  it('rejects out-of-range camelot input', () => {
    expect(parseCamelot('0A')).toBeNull();
    expect(parseCamelot('13A')).toBeNull();
    expect(parseCamelot('8C')).toBeNull();
    expect(parseCamelot('rubbish')).toBeNull();
  });

  it('formats the combined display from spec §12', () => {
    expect(formatCombined(key('A', 'minor'))).toBe('8A · A minor');
  });
});

describe('key parsing', () => {
  it('parses the notations providers actually emit', () => {
    const cases: Array<[string, string]> = [
      ['A minor', '8A'],
      ['Am', '8A'],
      ['A min', '8A'],
      ['a MINOR', '8A'],
      ['C major', '8B'],
      ['C', '8B'],
      ['Cmaj', '8B'],
      ['F# minor', '11A'],
      ['Gb minor', '11A'],   // enharmonic of F# minor
      ['Bbm', '3A'],         // Bb minor = A# minor = 3A
      ['Db major', '3B'],    // Db major = C# major = 3B
      ['8A', '8A'],          // camelot passthrough
      ['F♯ major', '2B'],    // unicode sharp
      ['E♭ minor', '2A'],    // unicode flat
    ];
    for (const [input, expected] of cases) {
      const parsed = parseKey(input);
      expect(parsed, `failed to parse "${input}"`).not.toBeNull();
      expect(formatCamelot(musicalKeyToCamelot(parsed!)!), `wrong camelot for "${input}"`).toBe(expected);
    }
  });

  it('returns null rather than guessing on unusable input', () => {
    for (const input of ['', '   ', 'H minor', 'unknown', 'A lydian', 'key of A', undefined, null]) {
      expect(parseKey(input as string), `should not parse "${input}"`).toBeNull();
    }
  });
});
