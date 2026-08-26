import { describe, expect, it } from 'vitest';
import { combineKeyEngines, parseEssentiaKey } from '@/analysis/essentia-key';
import type { Detection, KeyEngineReading } from '@/analysis/audio';

describe('Essentia key adapter', () => {
  it('maps sharp, flat and natural results into the domain key model', () => {
    expect(parseEssentiaKey('A', 'minor')).toEqual({ pitchClass: 'A', tonality: 'minor' });
    expect(parseEssentiaKey('Bb', 'major')).toEqual({ pitchClass: 'A#', tonality: 'major' });
    expect(parseEssentiaKey('F♯', 'minor')).toEqual({ pitchClass: 'F#', tonality: 'minor' });
  });

  it('refuses unknown scales rather than inventing a major/minor result', () => {
    expect(parseEssentiaKey('A', 'majmin')).toBeUndefined();
    expect(parseEssentiaKey(undefined, 'minor')).toBeUndefined();
  });

  it('selects a usable Essentia result while retaining the custom comparison', () => {
    const custom: Detection = {
      key: { pitchClass: 'C', tonality: 'major' },
      keyConfidence: 0.72,
    };
    const essentia: KeyEngineReading = {
      engine: 'essentia',
      key: { pitchClass: 'A', tonality: 'minor' },
      confidence: 0.81,
      status: 'result',
    };
    const combined = combineKeyEngines(custom, essentia);

    expect(combined.key).toEqual({ pitchClass: 'A', tonality: 'minor' });
    expect(combined.keyComparison).toMatchObject({ selected: 'essentia', agreed: false, sameSamples: true });
    expect(combined.keyComparison?.custom.key).toEqual(custom.key);
  });

  it('falls back to custom DSP when Essentia declines or fails', () => {
    const custom: Detection = {
      key: { pitchClass: 'E', tonality: 'minor' },
      keyConfidence: 0.68,
    };
    for (const status of ['no-result', 'error'] as const) {
      const combined = combineKeyEngines(custom, { engine: 'essentia', status });
      expect(combined.key).toEqual(custom.key);
      expect(combined.keyComparison?.selected).toBe('custom');
    }
  });
});
