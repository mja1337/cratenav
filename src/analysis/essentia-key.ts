import type { Detection, KeyEngineReading, KeyEngineComparison } from './audio';
import {
  bassSupportsScale,
  compareKeyEstimates,
  decisiveSeparatingNote,
  discriminatingNotes,
  tonicFromBass,
} from './key-agreement';
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
  const essentiaAnswered = essentia.status === 'result' && Boolean(essentia.key);
  const customAnswered = Boolean(custom.key);
  const difference = compareKeyEstimates(custom.key, essentia.key);
  const bassRoot = customDetection.keyDiagnostics?.rangeEvidence?.bassRoot;

  /*
   * Essentia used to win whenever it returned anything at all, regardless of
   * confidence or of what the other engine said. On a real recording that meant
   * B major was reported on every window while the custom engine said G# minor
   * at HIGHER confidence — and those two are relative keys, so the engines
   * actually agreed about the notes and the precedence rule was silently
   * deciding the tonic on its own.
   *
   * Confidence is only compared as a last resort, because the two engines'
   * confidence figures are not calibrated against each other: Essentia's key
   * strength and this detector's guard-derived confidence measure different
   * things and are only loosely comparable.
   */
  const higherConfidence = (): 'essentia' | 'custom' =>
    (essentia.confidence ?? 0) > (custom.confidence ?? 0) ? 'essentia' : 'custom';

  const separating = discriminatingNotes(difference, customDetection.keyDiagnostics?.chroma);

  let selected: 'essentia' | 'custom';
  let selectedBecause: string;
  let unresolved = false;

  if (essentiaAnswered && !customAnswered) {
    selected = 'essentia';
    selectedBecause = 'only Essentia answered';
  } else if (customAnswered && !essentiaAnswered) {
    selected = 'custom';
    selectedBecause = 'only the custom engine answered';
  } else if (!customAnswered && !essentiaAnswered) {
    selected = 'custom';
    selectedBecause = 'neither engine answered';
  } else if (difference.relation === 'same') {
    selected = higherConfidence();
    selectedBecause = 'both engines agree';
  } else if (difference.relation === 'relative') {
    // Same seven notes, so only the tonic is in question and the lowest
    // register is the evidence qualified to settle it.
    const fromBass = tonicFromBass(bassRoot, custom.key, essentia.key);
    if (fromBass) {
      selected = fromBass === 'first' ? 'custom' : 'essentia';
      selectedBecause = `same notes; bass on ${bassRoot} names the tonic`;
    } else {
      selected = higherConfidence();
      selectedBecause = 'same notes; bass inconclusive, took the higher confidence';
    }
  } else {
    /*
     * Different note sets. There is real evidence available here and it used to
     * be thrown away in favour of a confidence comparison between two engines
     * whose confidences are not comparable. On a real capture the separating
     * notes came back at 44% against 43% — the chroma plainly could not tell —
     * while the dominant bass note was C#, which B minor contains and E minor
     * does not. That is a decision the bass can make and the confidence figures
     * cannot.
     */
    const shared = `different notes (${difference.sharedNotes}/7 shared)`;
    const byNote = decisiveSeparatingNote(separating);
    const byBass = bassSupportsScale(bassRoot, custom.key, essentia.key);
    if (byNote) {
      selected = byNote === 'first' ? 'custom' : 'essentia';
      const note = separating[0]!.note;
      selectedBecause = `${shared}; ${note} clearly present`;
    } else if (byBass) {
      selected = byBass === 'first' ? 'custom' : 'essentia';
      selectedBecause = `${shared}; separating notes tied, but bass ${bassRoot} is only in this scale`;
    } else {
      selected = higherConfidence();
      selectedBecause = `${shared}; no evidence separates them, took the higher confidence`;
      unresolved = true;
    }
  }

  const chosen = selected === 'essentia' ? essentia : custom;
  const comparison: KeyEngineComparison = {
    custom,
    essentia,
    agreed: sameKey(custom.key, essentia.key),
    selected,
    sameSamples: true,
    relation: difference.relation,
    sharedNotes: difference.sharedNotes,
    selectedBecause,
    unresolved,
    discriminating: separating
      .map((entry) => ({
        note: entry.note,
        strength: entry.strength,
        // `first` is the custom reading, as passed to compareKeyEstimates.
        supports: entry.supports === 'first' ? ('custom' as const) : ('essentia' as const),
      })),
  };

  return {
    ...customDetection,
    key: chosen.key,
    keyConfidence: chosen.confidence,
    keyComparison: comparison,
  };
}
