import { describe, expect, it } from 'vitest';
import { createAnalyser, detectBpm, detectKey, type AudioSource } from '@/analysis/audio';

/**
 * Signal-level regression tests for the microphone DSP.
 *
 * These exist because the detectors previously produced confident garbage:
 * every key came back as 3A (A# minor) regardless of input, and anything
 * faster than about 170 BPM was reported at half tempo. Both were structural,
 * so both need a signal with a known answer to stay fixed.
 */

const SR = 48000;

/** Kick on every beat, snare on the backbeat, hats on the offbeat, plus noise. */
function groove(bpm: number, seconds = 8, noise = 0.02): Float32Array {
  const out = new Float32Array(SR * seconds);
  const beat = (60 / bpm) * SR;
  const hit = (at: number, freq: number, decay: number, gain: number) => {
    const start = Math.floor(at);
    for (let i = 0; i < 3000 && start + i < out.length; i += 1) {
      out[start + i] =
        out[start + i]! + Math.sin((2 * Math.PI * freq * i) / SR) * Math.exp(-i / decay) * gain;
    }
  };
  for (let b = 0; b * beat < out.length; b += 1) {
    hit(b * beat, 55, 500, 0.9);
    if (b % 2 === 1) hit(b * beat, 200, 300, 0.6);
    hit(b * beat + beat / 2, 8000, 90, 0.25);
  }
  for (let i = 0; i < out.length; i += 1) {
    out[i] = out[i]! + (Math.random() * 2 - 1) * noise;
  }
  return out;
}

function tones(freqs: readonly number[], seconds = 8): Float32Array {
  const out = new Float32Array(SR * seconds);
  for (let i = 0; i < out.length; i += 1) {
    let value = 0;
    for (const freq of freqs) value += Math.sin((2 * Math.PI * freq * i) / SR);
    out[i] = (value / freqs.length) * 0.5;
  }
  return out;
}

function whiteNoise(seconds = 8): Float32Array {
  const out = new Float32Array(SR * seconds);
  for (let i = 0; i < out.length; i += 1) out[i] = (Math.random() * 2 - 1) * 0.3;
  return out;
}

describe('tempo detection', () => {
  // Covers the whole DJ-relevant span, and deliberately dwells on 168-186
  // where the old octave logic reported half tempo.
  const tempos = [88, 100, 118, 128, 133, 140, 145, 150, 168, 172, 174, 176, 180, 186, 200];

  it.each(tempos)('detects %i BPM within 2%%', (bpm) => {
    const result = detectBpm(groove(bpm), SR);
    expect(result.bpm, `no tempo detected for ${bpm}`).toBeDefined();
    const error = Math.abs((result.bpm! - bpm) / bpm) * 100;
    expect(error, `detected ${result.bpm} for ${bpm}`).toBeLessThan(2);
  });

  it('never reports half or double tempo across the range', () => {
    for (const bpm of tempos) {
      const detected = detectBpm(groove(bpm), SR).bpm!;
      // The specific failure mode: a plausible-looking answer at 2x or 0.5x.
      expect(Math.abs(detected - bpm / 2), `${bpm} halved`).toBeGreaterThan(bpm * 0.1);
      expect(Math.abs(detected - bpm * 2), `${bpm} doubled`).toBeGreaterThan(bpm * 0.1);
    }
  });

  it('reports nothing for silence', () => {
    expect(detectBpm(new Float32Array(SR * 8), SR).bpm).toBeUndefined();
  });

  it('reports nothing for white noise rather than inventing a tempo', () => {
    // Noise has no pulse. The peakiness guard exists so the highest point of a
    // flat autocorrelation is not passed off as a tempo.
    expect(detectBpm(whiteNoise(), SR).bpm).toBeUndefined();
  });

  it('needs enough audio before answering', () => {
    expect(detectBpm(groove(128, 1), SR).bpm).toBeUndefined();
  });

  it('exposes independent D&B band votes and canonicalises half-time evidence', () => {
    const result = detectBpm(groove(87), SR, 'drum-and-bass');
    expect(result.bpm).toBeGreaterThan(170);
    expect(result.bpm).toBeLessThan(178);
    expect(result.bpmDiagnostics?.profile).toBe('drum-and-bass');
    expect(result.bpmDiagnostics?.bands.map((entry) => entry.band)).toEqual([
      'full', 'low', 'mid', 'high',
    ]);
    expect(result.bpmDiagnostics?.candidates.length).toBeGreaterThan(0);
  });
});

describe('key detection', () => {
  it('identifies a minor triad', () => {
    const result = detectKey(tones([220, 261.63, 329.63]), SR); // A C E
    expect(result.key).toEqual({ pitchClass: 'A', tonality: 'minor' });
  });

  it('identifies triads in other keys', () => {
    expect(detectKey(tones([369.99, 440, 554.37]), SR).key).toEqual({
      pitchClass: 'F#',
      tonality: 'minor',
    });
    expect(detectKey(tones([329.63, 415.3, 493.88]), SR).key).toEqual({
      pitchClass: 'E',
      tonality: 'major',
    });
  });

  it('does not report the same key for everything', () => {
    // The original bug: a flat chroma correlated 0.42 with A# minor, so 3A came
    // back for every input including noise.
    const keys = [
      tones([220, 261.63, 329.63]),
      tones([369.99, 440, 554.37]),
      tones([329.63, 415.3, 493.88]),
    ].map((samples) => detectKey(samples, SR).key);

    const distinct = new Set(keys.map((key) => key && `${key.pitchClass} ${key.tonality}`));
    expect(distinct.size).toBe(3);
    expect(distinct.has('A# minor')).toBe(false);
  });

  it('reports nothing for white noise', () => {
    // This is the guard that matters most: garbage at high confidence is worse
    // than an honest absence.
    const result = detectKey(whiteNoise(), SR);
    expect(result.key).toBeUndefined();
    expect(result.keyConfidence).toBeUndefined();
  });

  it('reports nothing for silence', () => {
    expect(detectKey(new Float32Array(SR * 8), SR).key).toBeUndefined();
  });

  it('is not fooled by a flat spectrum', () => {
    // A chirp sweeping the range excites every bin roughly evenly. With the old
    // bin-density bias this alone produced a confident key.
    const out = new Float32Array(SR * 8);
    for (let i = 0; i < out.length; i += 1) {
      const t = i / SR;
      out[i] = Math.sin(2 * Math.PI * (110 + (2000 * t) / 8) * t) * 0.4;
    }
    const result = detectKey(out, SR);
    if (result.key) {
      // If it commits at all it must not be the old constant answer.
      expect(`${result.key.pitchClass} ${result.key.tonality}`).not.toBe('A# minor');
    }
  });

  it('can use sub-bass fundamentals in the D&B profile', () => {
    const result = detectKey(tones([55, 65.41, 82.41]), SR, 'drum-and-bass'); // A1 C2 E2
    expect(result.key).toEqual({ pitchClass: 'A', tonality: 'minor' });
    expect(result.keyDiagnostics?.candidates?.length).toBeGreaterThan(1);
  });

  it('does not turn one bass note and its harmonics into a different chord root', () => {
    const out = new Float32Array(SR * 8);
    for (let i = 0; i < out.length; i += 1) {
      for (let harmonic = 1; harmonic <= 8; harmonic += 1) {
        out[i] = out[i]! + Math.sin((2 * Math.PI * 110 * harmonic * i) / SR) * (0.5 / harmonic);
      }
    }
    const result = detectKey(out, SR, 'drum-and-bass');
    if (result.key) expect(result.key.pitchClass).toBe('A');
    expect(result.keyDiagnostics?.peakCounts?.harmonicsFolded).toBeGreaterThan(0);
  });
});

describe('input metering', () => {
  /**
   * The detectors deliberately refuse to answer on a weak signal, so the UI has
   * to be able to say whether audio is arriving at all. Without that, a silent
   * capture graph and a cautious detector look identical — which is exactly the
   * state that reads as "waiting for signal" forever.
   */
  function fakeSource(): { source: AudioSource; emit: (samples: Float32Array) => void } {
    const listeners = new Set<(chunk: { samples: Float32Array; sampleRate: number; at: number }) => void>();
    let at = 0;
    return {
      source: {
        kind: 'microphone',
        get active() {
          return true;
        },
        start: async () => undefined,
        stop: async () => undefined,
        onSamples: (listener) => {
          listeners.add(listener);
          return () => listeners.delete(listener);
        },
      } as AudioSource,
      emit: (samples) => {
        at += 100;
        for (const listener of listeners) listener({ samples, sampleRate: SR, at });
      },
    };
  }

  it('reports nothing received before any audio arrives', async () => {
    const analyser = createAnalyser();
    const { source } = fakeSource();
    await analyser.attach(source);
    const input = analyser.input();
    expect(input.receiving).toBe(false);
    expect(input.rms).toBe(0);
    expect(input.secondsBuffered).toBe(0);
  });

  it('reports level and buffering once audio flows', async () => {
    const analyser = createAnalyser();
    const { source, emit } = fakeSource();
    await analyser.attach(source);

    const chunk = new Float32Array(4096);
    for (let i = 0; i < chunk.length; i += 1) chunk[i] = Math.sin((2 * Math.PI * 440 * i) / SR) * 0.5;
    for (let n = 0; n < 10; n += 1) emit(chunk);

    const input = analyser.input();
    expect(input.receiving).toBe(true);
    // A 0.5-amplitude sine has an RMS near 0.354.
    expect(input.rms).toBeGreaterThan(0.3);
    expect(input.peak).toBeGreaterThan(0.45);
    expect(input.secondsBuffered).toBeGreaterThan(0);
    expect(input.waveform.some((value) => value > 0)).toBe(true);
  });

  it('distinguishes a very quiet signal from silence', async () => {
    const analyser = createAnalyser();
    const { source, emit } = fakeSource();
    await analyser.attach(source);

    const faint = new Float32Array(4096);
    for (let i = 0; i < faint.length; i += 1) faint[i] = Math.sin((2 * Math.PI * 440 * i) / SR) * 0.001;
    emit(faint);

    const input = analyser.input();
    // Audio IS arriving, it is simply too quiet to analyse. The UI needs both
    // facts to give the user the right instruction.
    expect(input.receiving).toBe(true);
    expect(input.rms).toBeGreaterThan(0);
    expect(input.rms).toBeLessThan(0.004);
  });

  it('counts down to the first reading', async () => {
    const analyser = createAnalyser();
    const { source, emit } = fakeSource();
    await analyser.attach(source);

    const chunk = new Float32Array(SR); // one second
    for (let i = 0; i < chunk.length; i += 1) chunk[i] = Math.sin((2 * Math.PI * 220 * i) / SR) * 0.4;

    emit(chunk);
    const afterOne = analyser.input().secondsUntilFirstReading;
    emit(chunk);
    const afterTwo = analyser.input().secondsUntilFirstReading;

    expect(afterOne).toBeGreaterThan(0);
    expect(afterTwo).toBeLessThan(afterOne);
  });

  it('clears metering on reset', async () => {
    const analyser = createAnalyser();
    const { source, emit } = fakeSource();
    await analyser.attach(source);
    const chunk = new Float32Array(4096).fill(0.3);
    emit(chunk);
    expect(analyser.input().receiving).toBe(true);
    analyser.reset();
    expect(analyser.input().receiving).toBe(false);
    expect(analyser.input().rms).toBe(0);
  });
});

describe('key diagnostics', () => {
  /**
   * The guards refuse to answer on weak evidence, so they must explain
   * themselves. Thresholds were originally set against clean synthetic triads
   * correlating above 0.78, which rejected real material outright; the only way
   * to tune them honestly is to surface the numbers.
   */
  it('reports the reason when it declines on noise', () => {
    const result = detectKey(whiteNoise(), SR);
    expect(result.key).toBeUndefined();
    const diagnostics = result.keyDiagnostics;
    expect(diagnostics).toBeDefined();
    expect(diagnostics!.rejectedBy).toBeDefined();
    // Even loosened, noise must never be reported as a key.
    expect(['spread', 'correlation', 'margin', 'no-peaks', 'no-audio']).toContain(
      diagnostics!.rejectedBy,
    );
  });

  it('still rejects noise at the loosened thresholds', () => {
    // Guard against future loosening quietly re-enabling the original bug.
    for (let attempt = 0; attempt < 5; attempt += 1) {
      expect(detectKey(whiteNoise(), SR).key).toBeUndefined();
    }
  });

  it('reports a populated chroma and no rejection when it commits', () => {
    const result = detectKey(tones([220, 261.63, 329.63]), SR);
    expect(result.key).toEqual({ pitchClass: 'A', tonality: 'minor' });
    const diagnostics = result.keyDiagnostics!;
    expect(diagnostics.rejectedBy).toBeUndefined();
    expect(diagnostics.chroma).toHaveLength(12);
    // Normalised against its own peak, so the strongest class reads 1.
    expect(Math.max(...diagnostics.chroma)).toBeCloseTo(1, 5);
    expect(diagnostics.best).toBeGreaterThanOrEqual(diagnostics.thresholds.correlation);
    expect(diagnostics.candidate).toBe('A minor');
  });

  it('names the leading candidate even when rejected', () => {
    // A near-flat chroma still has a best-fitting profile; saying which one it
    // was is what lets a threshold be judged rather than guessed at.
    const result = detectKey(whiteNoise(), SR);
    const diagnostics = result.keyDiagnostics!;
    if (diagnostics.rejectedBy !== 'no-peaks' && diagnostics.rejectedBy !== 'no-audio') {
      expect(diagnostics.candidate).toBeTruthy();
    }
  });

  it('states the thresholds in force', () => {
    const diagnostics = detectKey(tones([220, 261.63, 329.63]), SR).keyDiagnostics!;
    expect(diagnostics.thresholds.correlation).toBeGreaterThan(0);
    expect(diagnostics.thresholds.spread).toBeGreaterThan(0);
  });
});

/**
 * A syncopated two-step break: kick 1, snare 2, kick 3.5, snare 4, hats on
 * eighths. Consecutive beats do not all carry a hit, which is what made a
 * dotted-note period outscore the beat.
 */
function breakbeat(bpm: number, seconds = 10): Float32Array {
  const out = new Float32Array(SR * seconds);
  const beat = (60 / bpm) * SR;
  const hit = (at: number, freq: number, decay: number, gain: number, noisy = false) => {
    const start = Math.floor(at);
    for (let i = 0; i < 4000 && start + i < out.length; i += 1) {
      const source = noisy ? Math.random() * 2 - 1 : Math.sin((2 * Math.PI * freq * i) / SR);
      out[start + i] = out[start + i]! + source * Math.exp(-i / decay) * gain;
    }
  };
  for (let bar = 0; bar * beat * 4 < out.length; bar += 1) {
    const origin = bar * beat * 4;
    hit(origin, 50, 900, 1);
    hit(origin + beat, 190, 400, 0.85, true);
    hit(origin + beat * 2.5, 50, 900, 0.9);
    hit(origin + beat * 3, 190, 400, 0.8, true);
    for (let eighth = 0; eighth < 8; eighth += 1) {
      hit(origin + beat * 0.5 * eighth, 9000, 60, 0.12, true);
    }
  }
  for (let i = 0; i < out.length; i += 1) {
    out[i] = out[i]! + (Math.random() * 2 - 1) * 0.02;
  }
  return out;
}

describe('syncopated breakbeat tempo', () => {
  /**
   * Regression for a 3:2 error reported against a mixer's own counter: 172 BPM
   * came back as 114.8. The bar is the strongest periodicity and sits outside
   * the tempo range, so inside that range a dotted note outranked the beat.
   */
  const tempos = [90, 128, 140, 171, 172, 174];

  it.each(tempos)('reads %i BPM from a two-step break', (bpm) => {
    const result = detectBpm(breakbeat(bpm), SR);
    expect(result.bpm, `no tempo for ${bpm}`).toBeDefined();
    expect(Math.abs((result.bpm! - bpm) / bpm) * 100).toBeLessThan(2);
  });

  it('never reports two thirds of the tempo', () => {
    for (const bpm of tempos) {
      const detected = detectBpm(breakbeat(bpm), SR).bpm!;
      const ratio = bpm / detected;
      // 1.5 is the specific failure: a dotted note read as the beat.
      expect(Math.abs(ratio - 1.5), `${bpm} read as 2/3`).toBeGreaterThan(0.08);
      expect(Math.abs(ratio - 2), `${bpm} halved`).toBeGreaterThan(0.1);
    }
  });
});

describe('tuning offset', () => {
  /** A chord with natural harmonics, detuned as if the deck were pitched. */
  function detuned(freqs: readonly number[], cents: number, seconds = 8): Float32Array {
    const out = new Float32Array(SR * seconds);
    const shift = 2 ** (cents / 1200);
    for (let i = 0; i < out.length; i += 1) {
      let value = 0;
      for (const freq of freqs) {
        for (let harmonic = 1; harmonic <= 6; harmonic += 1) {
          value += Math.sin((2 * Math.PI * freq * shift * harmonic * i) / SR) / harmonic;
        }
      }
      out[i] = value * 0.2;
    }
    return out;
  }

  const aMinor = [220, 261.63, 329.63];

  /**
   * Regression: equal temperament was assumed rather than measured, so a record
   * cut slightly sharp or played off zero pitch smeared across semitone pairs.
   * At 50 cents an A minor chord was reported as C# minor — confidently wrong,
   * which is worse than silent.
   */
  it.each([0, 15, 30, 45])('recovers the native key at %i cents of detune', (cents) => {
    const result = detectKey(detuned(aMinor, cents), SR);
    expect(result.key, `no key at ${cents} cents`).toEqual({ pitchClass: 'A', tonality: 'minor' });
  });

  it('reports the nearer semitone beyond half a semitone of detune', () => {
    // Past 50 cents the record genuinely IS closer to the next semitone, which
    // is exactly what the v1.1 pitch model says. +68 cents is a +4% fader.
    const result = detectKey(detuned(aMinor, 68), SR);
    expect(result.key).toEqual({ pitchClass: 'A#', tonality: 'minor' });
  });

  it('does not let tuning correction leak a key out of noise', () => {
    // The correction concentrates energy, so the noise guard has to still hold.
    for (let attempt = 0; attempt < 5; attempt += 1) {
      expect(detectKey(whiteNoise(), SR).key).toBeUndefined();
    }
  });
});

/**
 * Onset-dense modern break: 16th hats, ghost snares, sustained sub-bass. The
 * hats raise the autocorrelation floor at short lags, which is what made the
 * detector latch onto the edge of its own search range.
 */
function denseBreak(bpm: number, seconds = 16): Float32Array {
  const out = new Float32Array(SR * seconds);
  const beat = (60 / bpm) * SR;
  const hit = (at: number, freq: number, decay: number, gain: number, noisy = false) => {
    const start = Math.floor(at);
    for (let i = 0; i < 3000 && start + i < out.length; i += 1) {
      const source = noisy ? Math.random() * 2 - 1 : Math.sin((2 * Math.PI * freq * i) / SR);
      out[start + i] = out[start + i]! + source * Math.exp(-i / decay) * gain;
    }
  };
  for (let bar = 0; bar * beat * 4 < out.length; bar += 1) {
    const origin = bar * beat * 4;
    hit(origin, 48, 900, 1);
    hit(origin + beat, 200, 350, 0.8, true);
    hit(origin + beat * 2.5, 48, 900, 0.85);
    hit(origin + beat * 3, 200, 350, 0.75, true);
    for (let sixteenth = 0; sixteenth < 16; sixteenth += 1) {
      hit(origin + beat * 0.25 * sixteenth, 10000, 40, 0.18, true);
    }
    for (const ghost of [1.75, 3.75]) hit(origin + beat * ghost, 210, 200, 0.3, true);
  }
  for (let i = 0; i < out.length; i += 1) {
    out[i] = out[i]! + Math.sin((2 * Math.PI * 55 * i) / SR) * 0.25 + (Math.random() * 2 - 1) * 0.02;
  }
  return out;
}

describe('onset-dense tempo', () => {
  /**
   * Regression: a 176 BPM record reported 210.3 — precisely the 210 BPM search
   * limit rather than anything musical. Dense 16th hats lift correlation
   * broadly at short lags, so any rule scanning upward from the fast end and
   * taking the first candidate over a threshold latches onto the boundary.
   */
  const tempos = [140, 172, 174, 176];

  it.each(tempos)('reads %i BPM through dense percussion', (bpm) => {
    const result = detectBpm(denseBreak(bpm), SR);
    expect(result.bpm, `no tempo for ${bpm}`).toBeDefined();
    expect(Math.abs((result.bpm! - bpm) / bpm) * 100).toBeLessThan(2.5);
  });

  it('never reports the edge of the search range', () => {
    for (const bpm of tempos) {
      const detected = detectBpm(denseBreak(bpm), SR).bpm!;
      // 210 is the search ceiling; reporting it means the boundary was chosen.
      expect(detected).toBeLessThan(205);
    }
  });
});
