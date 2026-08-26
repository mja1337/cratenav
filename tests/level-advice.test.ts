import { describe, expect, it } from 'vitest';
import { levelAdvice } from '@/components/live-audio-analysis';
import type { InputLevel } from '@/analysis/audio';

/**
 * The advice used to be binary: clear a hard gate and you were told "Good
 * signal". A real capture arrived at 1.8% RMS with a 4% peak — roughly 28 dB of
 * headroom unused — and was described as healthy while both key engines
 * thrashed at low confidence.
 */
function input(overrides: Partial<InputLevel> = {}): InputLevel {
  return {
    rms: 0.2,
    peak: 0.6,
    peakHold: 0.6,
    receiving: true,
    secondsCaptured: 10,
    secondsUntilFirstReading: 0,
    waveform: new Float32Array(8),
    ...overrides,
  } as InputLevel;
}

describe('input level advice', () => {
  it('warns about a quiet-but-usable line input and states the headroom', () => {
    const advice = levelAdvice(input({ rms: 0.018, peak: 0.04 }));
    expect(advice.warn).toBe(true);
    // 20*log10(1/0.04) is about 28 dB.
    expect(advice.caption).toMatch(/28 dB of headroom unused/);
    expect(advice.caption).not.toMatch(/Good signal/);
  });

  it('still calls a healthy level good', () => {
    const advice = levelAdvice(input({ rms: 0.2, peak: 0.6 }));
    expect(advice.warn).toBe(false);
    expect(advice.caption).toMatch(/Good signal/);
  });

  it('keeps the existing silent, clipping and no-input cases', () => {
    expect(levelAdvice(input({ receiving: false })).caption).toMatch(/No audio is reaching/);
    expect(levelAdvice(input({ peak: 1 })).caption).toMatch(/clipping/);
    expect(levelAdvice(input({ rms: 0.001, peak: 0.003 })).caption).toMatch(/very quiet/);
  });

  it('mentions the wait before the first reading only when there is one', () => {
    expect(levelAdvice(input({ secondsUntilFirstReading: 4 })).caption).toMatch(/about 4s/);
    expect(levelAdvice(input({ secondsUntilFirstReading: 0 })).caption).toMatch(/Analysing/);
  });
});
