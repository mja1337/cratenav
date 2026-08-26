import type { Detection, KeyEngineReading, KeyEngineComparison } from './audio';
import type { MusicalKey, PitchClass, Tonality } from '@/domain/types';

const ESSENTIA_MIN_STRENGTH = 0.25;

interface EssentiaInstance {
  readonly version: string;
  arrayToVector(values: Float32Array): { delete?: () => void };
  KeyExtractor(
    audio: unknown,
    averageDetuningCorrection: boolean,
    frameSize: number,
    hopSize: number,
    hpcpSize: number,
    maxFrequency: number,
    maximumSpectralPeaks: number,
    minFrequency: number,
    pcpThreshold: number,
    profileType: string,
    sampleRate: number,
    spectralPeaksThreshold: number,
    tuningFrequency: number,
    weightType: string,
    windowType: string,
  ): { key?: string; scale?: string; strength?: number };
}

let runtimePromise: Promise<EssentiaInstance> | undefined;

async function runtime(): Promise<EssentiaInstance> {
  runtimePromise ??= Promise.all([
    import('essentia.js/dist/essentia.js-core.es.js'),
    import('essentia.js/dist/essentia-wasm.es.js'),
  ]).then(([core, wasm]) => new core.default(wasm.EssentiaWASM));
  return runtimePromise;
}

const PITCH_CLASS_ALIASES: Record<string, PitchClass> = {
  C: 'C', 'C#': 'C#', DB: 'C#', D: 'D', 'D#': 'D#', EB: 'D#',
  E: 'E', FB: 'E', 'E#': 'F', F: 'F', 'F#': 'F#', GB: 'F#',
  G: 'G', 'G#': 'G#', AB: 'G#', A: 'A', 'A#': 'A#', BB: 'A#',
  B: 'B', CB: 'B', 'B#': 'C',
};

/** Convert Essentia's string result into cratenav's typed key model. */
export function parseEssentiaKey(key: string | undefined, scale: string | undefined): MusicalKey | undefined {
  const normalisedKey = key?.trim().replace('♭', 'b').replace('♯', '#').toUpperCase();
  const pitchClass = normalisedKey ? PITCH_CLASS_ALIASES[normalisedKey] : undefined;
  const normalisedScale = scale?.trim().toLowerCase();
  const tonality: Tonality | undefined = normalisedScale === 'major' || normalisedScale === 'minor'
    ? normalisedScale
    : undefined;
  return pitchClass && tonality ? { pitchClass, tonality } : undefined;
}

function sameKey(left: MusicalKey | undefined, right: MusicalKey | undefined): boolean | undefined {
  if (!left || !right) return undefined;
  return left.pitchClass === right.pitchClass && left.tonality === right.tonality;
}

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}

/**
 * Run Essentia and the custom detector over the same PCM snapshot.
 *
 * Execution is sequential inside one worker to avoid competing for a phone's
 * CPU. It is still an apples-to-apples comparison: neither engine receives a
 * different time slice or a differently prepared capture.
 */
export async function analyseKeyWithEssentia(
  samples: Float32Array,
  sampleRate: number,
): Promise<KeyEngineReading> {
  const startedAt = performance.now();
  try {
    const essentia = await runtime();
    const signal = essentia.arrayToVector(samples);
    try {
      const raw = essentia.KeyExtractor(
        signal,
        true, // average detuning correction
        4096,
        2048,
        36, // three HPCP bins per semitone
        3500,
        100,
        40, // retain D&B sub/root evidence
        0.1,
        'bgate',
        sampleRate,
        0.00001,
        440,
        'cosine',
        'hann',
      );
      const key = parseEssentiaKey(raw.key, raw.scale);
      const strength = Number.isFinite(raw.strength) ? clamp01(raw.strength!) : undefined;
      return {
        engine: 'essentia',
        key,
        confidence: strength,
        status: key && (strength ?? 0) >= ESSENTIA_MIN_STRENGTH ? 'result' : 'no-result',
        detail: key
          ? (strength ?? 0) >= ESSENTIA_MIN_STRENGTH
            ? `Essentia ${essentia.version}`
            : `Below Essentia strength floor ${ESSENTIA_MIN_STRENGTH}`
          : `Essentia ${essentia.version} returned no major/minor key`,
        elapsedMs: performance.now() - startedAt,
      };
    } finally {
      signal.delete?.();
    }
  } catch (error) {
    return {
      engine: 'essentia',
      status: 'error',
      detail: error instanceof Error ? error.message : String(error),
      elapsedMs: performance.now() - startedAt,
    };
  }
}

/** Essentia is primary when usable; custom DSP remains an explicit fallback. */
export function combineKeyEngines(
  customDetection: Detection,
  essentia: KeyEngineReading,
  customElapsedMs?: number,
): Detection {
  const custom: KeyEngineReading = {
    engine: 'custom',
    key: customDetection.key,
    confidence: customDetection.keyConfidence,
    status: customDetection.key ? 'result' : 'no-result',
    detail: customDetection.keyDiagnostics?.rejectedBy,
    elapsedMs: customElapsedMs,
  };
  const useEssentia = essentia.status === 'result' && Boolean(essentia.key);
  const comparison: KeyEngineComparison = {
    custom,
    essentia,
    agreed: sameKey(custom.key, essentia.key),
    selected: useEssentia ? 'essentia' : 'custom',
    sameSamples: true,
  };
  return {
    ...customDetection,
    key: useEssentia ? essentia.key : customDetection.key,
    keyConfidence: useEssentia ? essentia.confidence : customDetection.keyConfidence,
    keyComparison: comparison,
  };
}
