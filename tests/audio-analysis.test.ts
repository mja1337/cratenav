import { describe, expect, it } from 'vitest';
import {
  aggregateFrames,
  detectBpm,
  detectKey,
  type AnalysisFrame,
} from '@/analysis/audio';

const SAMPLE_RATE = 22_050;

function clickTrack(bpm: number, seconds = 12): Float32Array {
  const samples = new Float32Array(SAMPLE_RATE * seconds);
  const beatLength = (SAMPLE_RATE * 60) / bpm;
  for (let beat = 0; beat * beatLength < samples.length; beat += 1) {
    const start = Math.round(beat * beatLength);
    for (let index = 0; index < 220 && start + index < samples.length; index += 1) {
      samples[start + index] = Math.exp(-index / 32) * Math.sin((2 * Math.PI * 900 * index) / SAMPLE_RATE);
    }
  }
  return samples;
}

function chord(frequencies: readonly number[], seconds = 5): Float32Array {
  const samples = new Float32Array(SAMPLE_RATE * seconds);
  for (let index = 0; index < samples.length; index += 1) {
    const attack = Math.min(1, index / (SAMPLE_RATE * 0.05));
    samples[index] = frequencies.reduce(
      (sum, frequency) => sum + Math.sin((2 * Math.PI * frequency * index) / SAMPLE_RATE),
      0,
    ) / frequencies.length * attack;
  }
  return samples;
}

describe('local audio analysis', () => {
  it.each([120, 174])('finds a %i BPM pulse train', (expected) => {
    const result = detectBpm(clickTrack(expected), SAMPLE_RATE);
    expect(Math.abs(result.bpm! - expected)).toBeLessThan(1.5);
    expect(result.bpmConfidence).toBeGreaterThan(0.5);
  });

  it('finds A minor from a sustained A-C-E chord', () => {
    const result = detectKey(chord([220, 261.63, 329.63]), SAMPLE_RATE);
    expect(result.key).toEqual({ pitchClass: 'A', tonality: 'minor' });
    expect(result.keyConfidence).toBeGreaterThan(0.5);
  });

  it('locks only after several agreeing windows', () => {
    const frames: AnalysisFrame[] = Array.from({ length: 4 }, (_, index) => ({
      at: index * 2_000,
      bpm: 173.8 + index * 0.1,
      bpmConfidence: 0.9,
      key: { pitchClass: 'A', tonality: 'minor' },
      keyConfidence: 0.86,
    }));
    const result = aggregateFrames(frames);
    expect(result.stable).toBe(true);
    expect(result.bpmBand).toBe('HIGH');
    expect(result.keyBand).toBe('HIGH');
    expect(result.camelot).toEqual({ number: 8, letter: 'A' });
  });

  it('flags alternating half/double readings as ambiguous and unstable', () => {
    const frames: AnalysisFrame[] = [87, 174, 87.2, 174.1].map((bpm, index) => ({
      at: index * 2_000,
      bpm,
      bpmConfidence: 0.9,
    }));
    const result = aggregateFrames(frames);
    expect(result.octaveAmbiguity).toBe(true);
    expect(result.stable).toBe(false);
    expect(result.bpmBand).toBe('UNSTABLE');
  });

  it('keeps a changing key unstable even when each window is confident', () => {
    const keys: NonNullable<AnalysisFrame['key']>[] = [
      { pitchClass: 'A', tonality: 'minor' },
      { pitchClass: 'C', tonality: 'major' },
      { pitchClass: 'A', tonality: 'minor' },
      { pitchClass: 'C', tonality: 'major' },
    ];
    const frames: AnalysisFrame[] = keys.map((key, index) => ({
      at: index * 2_000,
      key,
      keyConfidence: 0.92,
    }));
    const result = aggregateFrames(frames);
    expect(result.stable).toBe(false);
    expect(result.keyBand).toBe('UNSTABLE');
  });
});
