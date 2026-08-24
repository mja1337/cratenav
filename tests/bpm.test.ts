import { describe, expect, it } from 'vitest';
import { doubleBpm, halveBpm, normaliseBpm, resolveBand } from '@/bpm/normalise';

const dnb = { genres: ['Electronic'], styles: ['Drum n Bass'] };
const jungle = { genres: ['Electronic'], styles: ['Jungle'] };
const garage = { genres: ['Electronic'], styles: ['UK Garage'] };
const house = { genres: ['Electronic'], styles: ['House'] };
const hiphop = { genres: ['Hip Hop'], styles: ['Boom Bap'] };

describe('bpm normalisation — spec §11 reference cases', () => {
  it('doubles half-time drum & bass', () => {
    const result = normaliseBpm({ bpm: 87, ...dnb });
    expect(result.canonicalBpm).toBe(174);
    expect(result.sourceBpm).toBe(87);
    expect(result.factor).toBe(2);
    expect(result.confident).toBe(true);
    expect(result.reason).toMatch(/doubled/i);
  });

  it('doubles fractional half-time drum & bass', () => {
    expect(normaliseBpm({ bpm: 86.5, ...dnb }).canonicalBpm).toBe(173);
  });

  it('leaves correct drum & bass untouched', () => {
    const result = normaliseBpm({ bpm: 174, ...dnb });
    expect(result.canonicalBpm).toBe(174);
    expect(result.factor).toBe(1);
    expect(result.confident).toBe(true);
  });

  it('doubles half-time garage', () => {
    const result = normaliseBpm({ bpm: 64, ...garage });
    expect(result.canonicalBpm).toBe(128);
    expect(result.factor).toBe(2);
  });

  it('leaves correct garage untouched', () => {
    expect(normaliseBpm({ bpm: 128, ...garage }).canonicalBpm).toBe(128);
  });

  it('handles jungle the same as drum & bass', () => {
    expect(normaliseBpm({ bpm: 87, ...jungle }).canonicalBpm).toBe(174);
  });
});

describe('bpm normalisation — restraint', () => {
  it('does NOT double a low BPM when there is no genre context', () => {
    const result = normaliseBpm({ bpm: 87 });
    expect(result.canonicalBpm).toBe(87);
    expect(result.factor).toBe(1);
    expect(result.confident).toBe(false);
    expect(result.reason).toMatch(/no genre context/i);
  });

  it('does NOT double legitimate slow hip-hop', () => {
    const result = normaliseBpm({ bpm: 92, ...hiphop });
    expect(result.canonicalBpm).toBe(92);
    expect(result.factor).toBe(1);
  });

  it('does not halve house that is already correct', () => {
    expect(normaliseBpm({ bpm: 124, ...house }).canonicalBpm).toBe(124);
  });

  it('halves double-time values that overshoot the band', () => {
    // 250 BPM tagged as house is almost certainly a double-time reading.
    const result = normaliseBpm({ bpm: 250, ...house });
    expect(result.canonicalBpm).toBe(125);
    expect(result.factor).toBe(0.5);
  });

  it('flags low confidence when nothing fits the band', () => {
    const result = normaliseBpm({ bpm: 300, ...garage });
    expect(result.confident).toBe(false);
  });

  it('rejects nonsense input without transforming it', () => {
    for (const bpm of [0, -5, Number.NaN, Number.POSITIVE_INFINITY]) {
      const result = normaliseBpm({ bpm, ...dnb });
      expect(result.factor).toBe(1);
      expect(result.confident).toBe(false);
    }
  });

  it('uses sibling tracks to break an ambiguous read', () => {
    // Techno band is 120-145, so 130 and 65*2 both fit; siblings disambiguate.
    const result = normaliseBpm({
      bpm: 70,
      genres: ['Electronic'],
      styles: ['Techno'],
      siblingBpms: [140, 141],
    });
    expect(result.canonicalBpm).toBe(140);
  });
});

describe('band resolution', () => {
  it('prefers the specific style over the broad genre', () => {
    // "Electronic" alone is useless; "Jungle" is decisive.
    expect(resolveBand(['Electronic'], ['Jungle'])?.label).toBe('Jungle / D&B');
  });

  it('matches the Discogs style spellings that actually occur', () => {
    for (const style of ['Drum n Bass', 'Drum & Bass', 'Jungle', 'Liquid Funk', 'Neurofunk']) {
      expect(resolveBand([], [style])?.label, `no band for "${style}"`).toBe('Jungle / D&B');
    }
    for (const style of ['UK Garage', 'Speed Garage', '2-Step', 'Bassline']) {
      expect(resolveBand([], [style])?.label, `no band for "${style}"`).toBe('UK Garage');
    }
  });

  it('returns null for genres with no meaningful tempo band', () => {
    expect(resolveBand(['Spoken Word'], ['Interview'])).toBeNull();
  });

  it('honours user overrides', () => {
    const band = resolveBand([], ['Jungle'], { Jungle: [150, 200] });
    expect(band).toEqual({ label: 'Jungle', min: 150, max: 200 });
  });
});

describe('manual overrides', () => {
  it('halves and doubles to one decimal place', () => {
    expect(halveBpm(174)).toBe(87);
    expect(doubleBpm(86.5)).toBe(173);
    expect(halveBpm(173)).toBe(86.5);
  });
});
