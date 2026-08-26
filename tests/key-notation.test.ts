import { describe, expect, it } from 'vitest';
import { formatKeyNamePair, formatKeyPair } from '@/components/format';
import type { MusicalKey } from '@/domain/types';

const A_MINOR: MusicalKey = { pitchClass: 'A', tonality: 'minor' };

/**
 * Every key shown during analysis carries its Camelot reference.
 *
 * A semitone is SEVEN Camelot steps, so converting between the two notations in
 * your head mid-mix is exactly the arithmetic that goes wrong. The spec §12
 * toggle chooses which notation LEADS, never whether the other is available.
 */
describe('key display in both notations', () => {
  it('leads with Camelot when that is the chosen notation', () => {
    expect(formatKeyPair(A_MINOR, { number: 8, letter: 'A' }, 'camelot')).toBe('8A · A minor');
  });

  it('leads with the musical name when that is the chosen notation', () => {
    expect(formatKeyPair(A_MINOR, { number: 8, letter: 'A' }, 'musical')).toBe('A minor · 8A');
  });

  it('derives the Camelot reference when only the musical key is stored', () => {
    // Analysis rows predate camelotKey being written alongside; the wheel
    // number must still appear rather than the row looking half-populated.
    expect(formatKeyPair(A_MINOR, undefined, 'camelot')).toBe('8A · A minor');
  });

  it('shows what it has rather than nothing', () => {
    expect(formatKeyPair(undefined, { number: 8, letter: 'A' }, 'camelot')).toBe('8A');
    expect(formatKeyPair(undefined, undefined, 'camelot')).toBeUndefined();
  });

  it('annotates a key the detector rendered as a name', () => {
    // Diagnostics and tonal-section votes carry strings, not typed keys.
    expect(formatKeyNamePair('A minor', 'camelot')).toBe('8A · A minor');
    expect(formatKeyNamePair('C major', 'musical')).toBe('C major · 8B');
  });

  it('leaves an unparseable label alone instead of dropping it', () => {
    expect(formatKeyNamePair('not a key', 'camelot')).toBe('not a key');
    expect(formatKeyNamePair(undefined, 'camelot')).toBeUndefined();
  });
});
