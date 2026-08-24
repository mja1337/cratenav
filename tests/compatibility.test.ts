import { describe, expect, it } from 'vitest';
import { compareBpm, compareKeys, compatibleKeys } from '@/harmonic/compatibility';
import { formatCamelot, parseCamelot } from '@/harmonic/camelot';

const c = (s: string) => parseCamelot(s)!;

describe('harmonic compatibility — spec §38 safe relationships', () => {
  it('scores the same key highest', () => {
    const result = compareKeys(c('8A'), c('8A'));
    expect(result.score).toBe(1);
    expect(result.relation).toBe('same');
    expect(result.safe).toBe(true);
  });

  it('treats +1 and -1 on the same letter as safe', () => {
    expect(compareKeys(c('8A'), c('9A')).relation).toBe('fifth-up');
    expect(compareKeys(c('8A'), c('7A')).relation).toBe('fifth-down');
    expect(compareKeys(c('8A'), c('9A')).safe).toBe(true);
    expect(compareKeys(c('8A'), c('7A')).safe).toBe(true);
  });

  it('treats the A/B switch at the same number as safe', () => {
    const result = compareKeys(c('8A'), c('8B'));
    expect(result.relation).toBe('relative');
    expect(result.safe).toBe(true);
    expect(result.label).toBe('Relative major');
  });

  it('wraps around the wheel boundary', () => {
    // 12A -> 1A is +1, not +11.
    expect(compareKeys(c('12A'), c('1A')).relation).toBe('fifth-up');
    expect(compareKeys(c('1A'), c('12A')).relation).toBe('fifth-down');
  });

  it('rates distant keys as incompatible', () => {
    expect(compareKeys(c('8A'), c('2A')).score).toBe(0);
    expect(compareKeys(c('8A'), c('3B')).score).toBe(0);
  });

  it('ranks safe relationships above creative ones', () => {
    const safe = compareKeys(c('8A'), c('9A')).score;
    const creative = compareKeys(c('8A'), c('10A')).score;
    expect(safe).toBeGreaterThan(creative);
    expect(creative).toBeGreaterThan(0);
  });

  it('reports unknown keys as unknown, not as a clash', () => {
    expect(compareKeys(undefined, c('8A')).label).toBe('Key unknown');
    expect(compareKeys(c('8A'), undefined).label).toBe('Key unknown');
  });

  it('returns exactly the four safe neighbours', () => {
    const neighbours = compatibleKeys(c('8A')).map(formatCamelot);
    expect(neighbours).toEqual(['8A', '9A', '7A', '8B']);
  });

  it('wraps safe neighbours at the boundary', () => {
    expect(compatibleKeys(c('12B')).map(formatCamelot)).toEqual(['12B', '1B', '11B', '12A']);
    expect(compatibleKeys(c('1A')).map(formatCamelot)).toEqual(['1A', '2A', '12A', '1B']);
  });
});

describe('bpm compatibility', () => {
  it('scores an exact tempo match highest', () => {
    const result = compareBpm(174, 174);
    expect(result.score).toBe(1);
    expect(result.pitchPercent).toBe(0);
    expect(result.viaOctave).toBe(false);
  });

  it('degrades as required pitch increases', () => {
    const close = compareBpm(174, 176).score;
    const mid = compareBpm(174, 182).score;
    const far = compareBpm(174, 200).score;
    expect(close).toBeGreaterThan(mid);
    expect(mid).toBeGreaterThan(far);
  });

  it('reports the signed pitch percentage needed', () => {
    expect(compareBpm(170, 174).pitchPercent).toBeCloseTo(2.4, 1);
    expect(compareBpm(174, 170).pitchPercent).toBeCloseTo(-2.3, 1);
  });

  it('finds half/double-time matches but ranks them below direct ones', () => {
    const octave = compareBpm(174, 87);
    expect(octave.viaOctave).toBe(true);
    expect(octave.score).toBeGreaterThan(0);
    expect(octave.score).toBeLessThan(compareBpm(174, 174).score);
  });

  it('rejects genuinely incompatible tempos', () => {
    expect(compareBpm(128, 174).score).toBe(0);
  });

  it('reports unknown BPM as unknown', () => {
    expect(compareBpm(undefined, 174).label).toBe('BPM unknown');
    expect(compareBpm(174, undefined).label).toBe('BPM unknown');
  });
});
