import type {
  CamelotKey,
  ConfidenceBand,
  MusicalKey,
  PitchClass,
  Tonality,
} from '@/domain/types';
import { musicalKeyToCamelot } from '@/harmonic/camelot';

/** Audio capture + rolling analysis. Raw samples never leave this browser. */

export type AudioSourceKind = 'microphone' | 'file' | 'usb' | 'native';

/** Browser-visible capture device for the microphone picker. */
export interface AudioInputDevice {
  id: string;
  label: string;
}

/**
 * Enumerate microphone/line inputs without leaking browser MediaDeviceInfo
 * shapes into the UI. Labels are intentionally allowed to be blank before
 * the browser has been granted microphone permission.
 */
export async function listAudioInputs(): Promise<AudioInputDevice[]> {
  if (!navigator.mediaDevices?.enumerateDevices) return [];
  const devices = await navigator.mediaDevices.enumerateDevices();
  return devices
    .filter((device) => device.kind === 'audioinput')
    .map((device, index) => ({
      id: device.deviceId,
      label: device.label || `Audio input ${index + 1}`,
    }));
}

export interface AudioChunk {
  readonly samples: Float32Array;
  readonly sampleRate: number;
  /** Milliseconds on the source's monotonic clock. */
  readonly at: number;
}

export interface AudioSource {
  readonly kind: AudioSourceKind;
  readonly active: boolean;
  /** Resolves once audio is actually flowing. May prompt for permission. */
  start(): Promise<void>;
  stop(): Promise<void>;
  onSamples(listener: (chunk: AudioChunk) => void): () => void;
}

/** A single observation over the current audio window. */
export interface AnalysisFrame {
  at: number;
  bpm?: number;
  /** Confidence for this frame alone, 0..1. */
  bpmConfidence?: number;
  bpmDiagnostics?: BpmDiagnostics;
  key?: MusicalKey;
  camelot?: CamelotKey;
  keyConfidence?: number;
  keyDiagnostics?: KeyDiagnostics;
  /** Side-by-side Essentia/custom result over this exact PCM snapshot. */
  keyComparison?: KeyEngineComparison;
}

/** Aggregated result over multiple overlapping observations. */
export interface RollingResult {
  bpm?: number;
  bpmConfidence?: number;
  bpmBand: ConfidenceBand;
  key?: MusicalKey;
  camelot?: CamelotKey;
  keyConfidence?: number;
  keyBand: ConfidenceBand;
  /** Stability is series agreement, deliberately not an alias for confidence. */
  stable: boolean;
  /** True when recent readings alternate between half and double time. */
  octaveAmbiguity: boolean;
  frames: readonly AnalysisFrame[];
}

/**
 * Live view of what the microphone is actually delivering.
 *
 * Detection guards deliberately refuse to answer on a weak signal, so without
 * this the UI cannot distinguish "no audio is arriving" from "audio is fine but
 * the analysis will not commit". Those need different actions from the user.
 */
export interface InputLevel {
  /** RMS of the most recent chunk, 0..1. */
  rms: number;
  /** Peak sample magnitude of the most recent chunk, 0..1. */
  peak: number;
  /** Highest peak seen this session, so a brief transient is not missed. */
  peakHold: number;
  /** True once any chunk has arrived from the capture graph. */
  receiving: boolean;
  /** How much audio is buffered, in seconds. */
  secondsBuffered: number;
  /** Total capture duration; unlike the bounded DSP window this can reach 90s+. */
  secondsCaptured: number;
  /** Seconds still needed before the first reading can be produced. */
  secondsUntilFirstReading: number;
  /** Downsampled envelope for drawing, newest last, values 0..1. */
  waveform: Float32Array;
  /** Why the key detector last committed or declined, when known. */
  keyDiagnostics?: KeyDiagnostics;
}

export interface Analyser {
  readonly running: boolean;
  attach(source: AudioSource): Promise<void>;
  detach(): Promise<void>;
  result(): RollingResult;
  /** Current input metering, independent of whether detection has committed. */
  input(): InputLevel;
  reset(): void;
  onFrame(listener: (frame: AnalysisFrame, result: RollingResult) => void): () => void;
}

export class MicrophoneAnalysisError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'MicrophoneAnalysisError';
  }
}

/**
 * Browser microphone source backed by AudioWorklet. The worklet batches 2048
 * mono samples before crossing to the main thread; the graph is connected
 * through a zero-gain node so capture is processed but never played aloud.
 */
class MicrophoneAudioSource implements AudioSource {
  readonly kind = 'microphone' as const;
  private stream?: MediaStream;
  private context?: AudioContext;
  private input?: MediaStreamAudioSourceNode;
  private worklet?: AudioWorkletNode;
  private mute?: GainNode;
  private moduleUrl?: string;
  private listeners = new Set<(chunk: AudioChunk) => void>();

  constructor(private readonly deviceId?: string) {}

  get active(): boolean {
    return Boolean(this.context && this.context.state !== 'closed');
  }

  onSamples(listener: (chunk: AudioChunk) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async start(): Promise<void> {
    if (this.active) return;
    if (typeof window === 'undefined' || !window.isSecureContext) {
      throw new MicrophoneAnalysisError(
        'Microphone analysis needs a secure page. Use localhost, 127.0.0.1, or HTTPS.',
      );
    }
    if (!navigator.mediaDevices?.getUserMedia) {
      throw new MicrophoneAnalysisError('This browser does not provide microphone access.');
    }
    if (!window.AudioContext || !window.AudioWorkletNode) {
      throw new MicrophoneAnalysisError('This browser does not support AudioWorklet analysis.');
    }

    try {
      this.stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          ...(this.deviceId ? { deviceId: { exact: this.deviceId } } : {}),
          autoGainControl: false,
          echoCancellation: false,
          noiseSuppression: false,
        },
        video: false,
      });

      this.context = new AudioContext({ latencyHint: 'interactive' });
      this.moduleUrl = URL.createObjectURL(new Blob([WORKLET_SOURCE], { type: 'text/javascript' }));
      await this.context.audioWorklet.addModule(this.moduleUrl);
      this.input = this.context.createMediaStreamSource(this.stream);
      this.worklet = new AudioWorkletNode(this.context, 'cratenav-capture');
      this.mute = this.context.createGain();
      this.mute.gain.value = 0;

      const sampleRate = this.context.sampleRate;
      this.worklet.port.onmessage = (event: MessageEvent<ArrayBuffer>) => {
        const samples = new Float32Array(event.data);
        const chunk: AudioChunk = { samples, sampleRate, at: performance.now() };
        for (const listener of this.listeners) listener(chunk);
      };

      this.input.connect(this.worklet).connect(this.mute).connect(this.context.destination);
      await this.context.resume();
    } catch (error) {
      await this.stop();
      if (error instanceof MicrophoneAnalysisError) throw error;
      if (error instanceof DOMException && error.name === 'NotAllowedError') {
        throw new MicrophoneAnalysisError(
          'Microphone permission was not granted. Allow it in the browser site settings and try again.',
          { cause: error },
        );
      }
      throw new MicrophoneAnalysisError('The microphone could not be started.', { cause: error });
    }
  }

  async stop(): Promise<void> {
    this.worklet?.disconnect();
    this.input?.disconnect();
    this.mute?.disconnect();
    this.stream?.getTracks().forEach((track) => track.stop());
    if (this.context && this.context.state !== 'closed') await this.context.close();
    if (this.moduleUrl) URL.revokeObjectURL(this.moduleUrl);
    this.stream = undefined;
    this.context = undefined;
    this.input = undefined;
    this.worklet = undefined;
    this.mute = undefined;
    this.moduleUrl = undefined;
  }
}

const WORKLET_SOURCE = `
class CrateNavCapture extends AudioWorkletProcessor {
  constructor() {
    super();
    this.buffer = new Float32Array(2048);
    this.offset = 0;
  }
  process(inputs) {
    const channels = inputs[0];
    if (!channels || !channels[0]) return true;
    const frames = channels[0].length;
    for (let i = 0; i < frames; i += 1) {
      let sample = 0;
      for (let channel = 0; channel < channels.length; channel += 1) {
        sample += channels[channel][i] || 0;
      }
      this.buffer[this.offset] = sample / channels.length;
      this.offset += 1;
      if (this.offset === this.buffer.length) {
        const completed = this.buffer;
        this.port.postMessage(completed.buffer, [completed.buffer]);
        this.buffer = new Float32Array(2048);
        this.offset = 0;
      }
    }
    return true;
  }
}
registerProcessor('cratenav-capture', CrateNavCapture);
`;

/**
 * Why the key detector did or did not commit.
 *
 * Surfaced to the UI on purpose: the guards refuse to answer on weak evidence,
 * and without the numbers behind that refusal there is no way to tell a mic
 * problem from a threshold set too tight. Guessing at the values from synthetic
 * signals is exactly how the thresholds came to be wrong.
 */
export interface KeyDiagnostics {
  /** Normalised 12-bin chroma, 0..1 relative to its own maximum. */
  chroma: number[];
  /** Relative spread of the chroma; a flat one carries no tonal information. */
  spread: number;
  /** Best Krumhansl correlation found. */
  best: number;
  /** Gap to the best candidate on a different tonic. */
  margin: number;
  /** Gap between major and minor interpretations on the winning tonic. */
  modeMargin?: number;
  /** The leading candidate, whether or not it was accepted. */
  candidate?: string;
  /** Leading alternatives before thresholding, for an explainable capture UI. */
  candidates?: { name: string; score: number }[];
  /** Tonal-window gate used by the D&B profile. */
  windows?: { accepted: number; rejected: number };
  /** Strong spectral peaks retained after leakage rejection. */
  peaks?: {
    frequency: number;
    note: string;
    weight: number;
    harmonicOf?: string;
  }[];
  peakCounts?: { accepted: number; rejected: number; harmonicsFolded: number };
  /** Raw pitch-class energy before harmonic deconvolution. */
  observedChroma?: number[];
  /** Independent tonal-window votes inside the current analysis frame. */
  sectionVotes?: { key: string; windows: number }[];
  /** Share of accepted tonal windows supporting the leading local key. */
  sectionAgreement?: number;
  /** Independent note-transcription evidence from bass and upper registers. */
  rangeEvidence?: { bassRoot?: string; upperKey?: string; agreed?: boolean };
  /** Energy split after harmonic/percussive median masking. */
  separation?: { harmonic: number; percussive: number };
  transientPeaksAttenuated?: number;
  /**
   * Measured detuning of the captured audio, in cents, and how much it varied.
   *
   * This is the first thing to look at when two key estimates differ by one
   * semitone or a separating note comes back near-tied. Equal temperament is an
   * assumption: a record cut sharp, or a deck off zero, puts every note between
   * two semitones and the chroma smears across BOTH, at which point neither
   * engine can be believed. Near +/-50 cents the reading is a coin toss by
   * construction, because every note is equidistant from two names.
   */
  tuning?: { cents: number; spread: number; windows: number };
  /** Which guard stopped it, if any. */
  rejectedBy?: 'no-audio' | 'no-peaks' | 'spread' | 'correlation' | 'margin' | 'mode' | 'section';
  /** Thresholds in force, so the UI can state them rather than hardcode them. */
  thresholds: { spread: number; correlation: number; margin: number; modeMargin: number; sectionAgreement: number };
}

export type AnalysisProfile = 'general' | 'drum-and-bass';

export interface BpmDiagnostics {
  profile: AnalysisProfile;
  /** Independent tempo estimates from the full signal and D&B frequency bands. */
  bands: { band: 'full' | 'low' | 'mid' | 'high' | 'percussive'; bpm?: number; confidence?: number }[];
  /** Canonical hypotheses after D&B half-time interpretation. */
  candidates: { bpm: number; support: number; bands: string[] }[];
  agreement: number;
}

export interface Detection {
  bpm?: number;
  bpmConfidence?: number;
  bpmDiagnostics?: BpmDiagnostics;
  key?: MusicalKey;
  keyConfidence?: number;
  keyDiagnostics?: KeyDiagnostics;
  keyComparison?: KeyEngineComparison;
}

export interface KeyEngineReading {
  engine: 'essentia' | 'custom';
  key?: MusicalKey;
  confidence?: number;
  status: 'result' | 'no-result' | 'error';
  detail?: string;
  elapsedMs?: number;
}

export interface KeyEngineComparison {
  custom: KeyEngineReading;
  essentia: KeyEngineReading;
  agreed?: boolean;
  selected: 'essentia' | 'custom';
  /** Always true: both engines consume the same captured PCM snapshot. */
  sameSamples: true;
  /**
   * How the two readings relate. `relative` is the important one: the engines
   * name the SAME seven notes and differ only over which is the tonic, which is
   * an agreement about the music reported as a disagreement.
   */
  relation?: 'same' | 'relative' | 'different' | 'unknown';
  /** How many of the seven notes both readings contain. */
  sharedNotes?: number;
  /** Why this engine's answer was taken, in words. */
  selectedBecause?: string;
  /**
   * True when the engines name different note sets and nothing available can
   * arbitrate. The value is still reported, but it is a coin toss dressed up.
   */
  unresolved?: boolean;
  /**
   * The notes present in one reading and not the other, with the energy each
   * actually has. When two keys differ by a single note, this measurement is
   * what settles which one the record is in.
   */
  discriminating?: { note: PitchClass; strength: number; supports: 'custom' | 'essentia' }[];
}

/**
 * Key-detection guards. Loosened from the values first shipped, which were set
 * against clean synthetic triads correlating above 0.78 and rejected real
 * material outright. The spread and margin checks are what actually stop noise
 * being reported, so those carry the weight rather than a high correlation bar.
 */
export const KEY_THRESHOLDS = {
  spread: 0.14,
  correlation: 0.32,
  margin: 0.03,
  modeMargin: 0.015,
  sectionAgreement: 0.45,
} as const;

const PITCH_CLASSES: readonly PitchClass[] = [
  'C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B',
];

/**
 * Key profiles: the expected relative weight of each pitch class in a key.
 *
 * Krumhansl-Kessler are probe-tone ratings — listeners scoring how well a tone
 * fits a preceding context — collected on Western classical material. They are
 * the textbook set and were the original choice here, but their major and minor
 * shapes are close enough that the parallel-mode decision is weak, which is
 * what the `mode` guard keeps having to refuse on.
 *
 * Temperley's are derived from counting actual pitch usage in a scored corpus
 * rather than from ratings, and separate the modes more sharply: note the third
 * (index 4 major, 3 minor) and the flat sixth. Which set is in use is decided by
 * measurement in tests/audio-dsp.test.ts, not by preference.
 *
 * Only the SHAPE matters — every use goes through `correlation`, which is scale
 * and offset invariant, so the two sets' different absolute ranges are moot.
 */
export const KRUMHANSL_MAJOR = [
  6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88,
];
export const KRUMHANSL_MINOR = [
  6.33, 2.68, 3.52, 5.38, 2.6, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17,
];
export const TEMPERLEY_MAJOR = [
  0.748, 0.06, 0.488, 0.082, 0.67, 0.46, 0.096, 0.715, 0.104, 0.366, 0.057, 0.4,
];
export const TEMPERLEY_MINOR = [
  0.712, 0.084, 0.474, 0.618, 0.049, 0.46, 0.105, 0.747, 0.404, 0.067, 0.133, 0.33,
];

const MAJOR_PROFILE = TEMPERLEY_MAJOR;
const MINOR_PROFILE = TEMPERLEY_MINOR;

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}

function mean(values: readonly number[]): number {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
}

function median(values: readonly number[]): number {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2
    ? sorted[middle]!
    : (sorted[middle - 1]! + sorted[middle]!) / 2;
}

function confidenceBand(confidence: number | undefined, stable: boolean): ConfidenceBand {
  if (confidence === undefined) return 'LOW';
  if (!stable) return 'UNSTABLE';
  if (confidence >= 0.82) return 'HIGH';
  if (confidence >= 0.62) return 'MEDIUM';
  return 'LOW';
}

const ONSET_FRAME = 1024;
/**
 * The flux voter runs at a coarser hop than the amplitude envelope.
 *
 * It corroborates rather than sets precision — the amplitude bands provide
 * that — and an STFT at hop 128 over an eight second window tripled the cost of
 * a D&B analysis. This is a mobile-first app, so a voter that could push one
 * frame past the two second cadence on a phone is not worth its own resolution.
 * At 187 Hz a 174 BPM beat is still 65 frames, and the selection interpolates
 * fractional lags anyway.
 */
const ONSET_FLUX_HOP = 256;
// 128-sample hop gives a 375 Hz onset envelope. At 256 the frame quantisation
// alone cost the fundamental period most of its correlation whenever the beat
// did not land near a whole frame: at 186 BPM the true lag scored 0.71 while
// two beats, landing almost exactly on a frame, scored 0.96 — so the detector
// reported half tempo for arithmetic reasons rather than musical ones.
const ONSET_HOP = 128;

/**
 * Onset strength as PER-BIN spectral flux, not broadband energy flux.
 *
 * The previous envelope was `max(0, rms - previousRms)`: the whole spectrum
 * collapsed to one number before differencing. That cannot separate a kick from
 * a pad, because both move RMS — and it does not even need the pad to change
 * volume, since several sustained partials interfering inside one analysis frame
 * modulate the total on their own. Measured on a break with a sustained A minor
 * pad at a quarter of drum level, every tempo from 140 to 186 came back as
 * 177.2: the pad's own interference, not the music.
 *
 * Two defences, both standard and both cheap:
 *
 *   - Difference each BIN against a MAXIMUM-FILTERED earlier frame (SuperFlux,
 *     Böck & Widmer). A steady partial cancels against itself, and the max over
 *     neighbouring bins absorbs vibrato and turntable wow that would otherwise
 *     read as a new onset every time a partial drifted across a bin edge.
 *   - Subtract a slow per-bin steady level first, so a sustained layer sits at
 *     its own floor and contributes nothing while a transient still rises above
 *     it. This is what makes the tempo path see percussion only.
 *
 * Only increases count: an onset is new energy appearing, never energy leaving.
 */
function onsetEnvelope(
  samples: Float32Array,
  sampleRate: number,
  lowestHz = 0,
  highestHz = Infinity,
): number[] {
  const frameSize = ONSET_FRAME;
  const hop = ONSET_FLUX_HOP;
  const bins = frameSize / 2;
  const firstBin = Math.max(1, Math.floor((lowestHz * frameSize) / sampleRate));
  const lastBin = Math.min(bins - 1, Math.ceil((highestHz * frameSize) / sampleRate));
  if (lastBin <= firstBin) return [];

  // Hann window, precomputed once.
  const window = new Float64Array(frameSize);
  for (let i = 0; i < frameSize; i += 1) {
    window[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (frameSize - 1));
  }

  // SuperFlux compares against a frame a little way back, not the immediately
  // preceding one: at a 375 Hz frame rate adjacent frames overlap by 94% and
  // barely differ, so the flux is dominated by noise rather than by onsets.
  const LAG = 3;
  const history: Float64Array[] = [];
  /**
   * Per-bin steady FLOOR, tracked as a slow minimum rather than a mean.
   *
   * A mean-following level was tried first and halved the tempo on almost every
   * fixture: with a time constant near one beat it tracked the kick train
   * itself, cancelling every second kick and leaving the kick/snare alternation
   * — a two-beat period — as the strongest thing in the envelope.
   *
   * The floor has to be what a bin sits at BETWEEN events. It falls instantly
   * and rises over seconds, so a sustained pad converges onto its own level and
   * contributes nothing, while a kick train keeps its quiet gaps and every kick
   * still rises clear of the floor.
   */
  const floor = new Float64Array(lastBin + 1);
  const floorRise = 1 - Math.exp(-hop / (2 * sampleRate));
  const envelope: number[] = [];

  const real = new Float64Array(frameSize);
  const imag = new Float64Array(frameSize);

  for (let offset = 0; offset + frameSize <= samples.length; offset += hop) {
    for (let i = 0; i < frameSize; i += 1) {
      real[i] = samples[offset + i]! * window[i]!;
      imag[i] = 0;
    }
    fft(real, imag);

    const magnitudes = new Float64Array(lastBin + 1);
    for (let bin = firstBin; bin <= lastBin; bin += 1) {
      // Square root compresses the dynamic range so the whole break, not just
      // the loudest kick, shapes this envelope.
      magnitudes[bin] = Math.sqrt(Math.hypot(real[bin]!, imag[bin]!));
    }

    // Novelty against the steady floor: a sustained layer contributes 0.
    const novelty = new Float64Array(lastBin + 1);
    for (let bin = firstBin; bin <= lastBin; bin += 1) {
      const magnitude = magnitudes[bin]!;
      floor[bin] = magnitude < floor[bin]!
        ? magnitude
        : floor[bin]! + floorRise * (magnitude - floor[bin]!);
      novelty[bin] = Math.max(0, magnitude - floor[bin]!);
    }

    const past = history[history.length - LAG];
    let flux = 0;
    if (past) {
      for (let bin = firstBin; bin <= lastBin; bin += 1) {
        // Maximum filter across +/-1 bin absorbs small frequency drift.
        let reference = past[bin]!;
        if (bin > firstBin) reference = Math.max(reference, past[bin - 1]!);
        if (bin < lastBin) reference = Math.max(reference, past[bin + 1]!);
        const rise = novelty[bin]! - reference;
        if (rise > 0) flux += rise;
      }
    }
    envelope.push(flux);

    history.push(novelty);
    if (history.length > LAG + 1) history.shift();
  }

  return envelope;
}

/**
 * Tempo estimate from a percussive onset envelope. Additive voter.
 *
 * Kept SEPARATE from `detectBpmCore` rather than replacing its envelope. The
 * metrical selection below is tuned against the amplitude envelope's weighting
 * of a loud kick versus a quiet hat; swapping in spectral flux changed that
 * balance and halved or doubled twelve of the pinned fixtures — the same
 * retuning swamp the superseded formulations in this file came out of. As one
 * more voice in the D&B vote it can correct a pad-fooled reading without any
 * proven path depending on it.
 */
function detectBpmPercussive(
  samples: Float32Array,
  sampleRate: number,
): Pick<Detection, 'bpm' | 'bpmConfidence'> {
  if (samples.length < sampleRate * 4) return {};
  const envelope = onsetEnvelope(samples, sampleRate);
  if (envelope.length < 32) return {};
  return periodFromEnvelope(envelope, sampleRate / ONSET_FLUX_HOP);
}

/** Core tempo estimate from the amplitude onset envelope. The proven path. */
function detectBpmCore(samples: Float32Array, sampleRate: number): Pick<Detection, 'bpm' | 'bpmConfidence'> {
  const frameSize = 1024;
  const hop = ONSET_HOP;
  if (samples.length < sampleRate * 4) return {};

  const envelope: number[] = [];
  let previous = 0;
  for (let offset = 0; offset + frameSize <= samples.length; offset += hop) {
    let energy = 0;
    for (let i = 0; i < frameSize; i += 1) {
      const value = samples[offset + i]!;
      energy += value * value;
    }
    const rms = Math.sqrt(energy / frameSize);
    envelope.push(Math.max(0, rms - previous));
    previous = rms;
  }
  return periodFromEnvelope(envelope, sampleRate / hop);
}

/** Metrical selection over an onset-strength signal, whatever produced it. */
function periodFromEnvelope(
  envelope: number[],
  envelopeRate: number,
): Pick<Detection, 'bpm' | 'bpmConfidence'> {
  const envelopeMean = mean(envelope);
  if (envelopeMean < 1e-9) return {};
  for (let i = 0; i < envelope.length; i += 1) {
    envelope[i] = Math.max(0, envelope[i]! - envelopeMean * 0.35);
  }

  // Light smoothing widens each onset over a few frames. A one-frame spike
  // train is pathologically sensitive to sub-frame misalignment, which is what
  // let a beat multiple out-score the beat itself.
  const smoothed = envelope.slice();
  for (let i = 1; i < envelope.length - 1; i += 1) {
    smoothed[i] = envelope[i - 1]! * 0.25 + envelope[i]! * 0.5 + envelope[i + 1]! * 0.25;
  }
  for (let i = 0; i < envelope.length; i += 1) envelope[i] = smoothed[i]!;

  const minBpm = 60;
  const maxBpm = 210;
  const minLag = Math.floor((60 * envelopeRate) / maxBpm);
  const maxLag = Math.ceil((60 * envelopeRate) / minBpm);
  /**
   * The autocorrelation is computed far past the slowest candidate tempo.
   *
   * Comb support needs the multiples of a candidate period, and at 172 BPM the
   * beat is about 131 frames while the 60 BPM limit is 375 — only two multiples
   * fit. With so little support a dotted-note period scored higher than the
   * beat, which is how 172 came back as 114.8.
   */
  const combCeiling = Math.min(maxLag * 4, Math.floor(envelope.length / 2));
  const scores: { lag: number; score: number }[] = [];

  for (let lag = minLag; lag <= combCeiling; lag += 1) {
    let dot = 0;
    let left = 0;
    let right = 0;
    for (let i = lag; i < envelope.length; i += 1) {
      const a = envelope[i]!;
      const b = envelope[i - lag]!;
      dot += a * b;
      left += a * a;
      right += b * b;
    }
    const correlation = left && right ? dot / Math.sqrt(left * right) : 0;
    scores.push({ lag, score: correlation });
  }

  /**
   * Autocorrelation sampled at a FRACTIONAL lag, linearly interpolated.
   *
   * Real beat periods are almost never a whole number of envelope frames
   * (140 BPM is 80.36 frames here), so rounding before probing a multiple
   * throws away the alignment the comb filter depends on and the true tempo
   * loses to its own double.
   */
  const scoreAt = (lag: number): number => {
    if (lag < minLag || lag > combCeiling) return 0;
    const position = lag - minLag;
    const low = Math.floor(position);
    const high = Math.min(scores.length - 1, low + 1);
    const fraction = position - low;
    const a = scores[low]?.score ?? 0;
    const b = scores[high]?.score ?? 0;
    return a + (b - a) * fraction;
  };

  /**
   * Noise floor of the autocorrelation, as a robust median.
   *
   * Dense percussion raises correlation everywhere — 16th hats lift it to about
   * 0.21 at every lag — so absolute values mean little. What matters is how far
   * a peak rises ABOVE the floor.
   */
  const floorSamples: number[] = [];
  for (let lag = minLag; lag <= combCeiling; lag += 1) floorSamples.push(scoreAt(lag));
  const acfFloor = median(floorSamples);

  /**
   * Support for a candidate period: how far its whole harmonic series rises
   * above the floor.
   *
   * The beat is the period every one of whose multiples is elevated. A dotted
   * note always has a multiple landing between beats, at the floor. Measured on
   * a busy 176 BPM break, the beat had all four multiples elevated while 1.5
   * beats had two at the floor.
   *
   * Taking the plain minimum across multiples was tried and fails here: with a
   * raised floor every candidate returns that floor and the statistic collapses
   * (0.216 at the range boundary against 0.231 for the true beat). Averaging the
   * elevations discriminates, while a penalty for any multiple sitting at the
   * floor keeps a dotted note from winning on strength alone.
   */
  const AT_FLOOR = 0.03;

  /**
   * Find the beat as an integer subdivision of the dominant periodicity.
   *
   * Every statistic computed only inside the 60-210 BPM window proved
   * defeatable, because the strongest periodicity in real music is the BAR and
   * it usually sits outside that window. Measured: a busy 176 BPM break has the
   * bar at 0.781 while the beat itself is 0.253 and a dotted note 0.477. Any
   * scheme ranking candidates on their own strength therefore prefers the
   * dotted note, and anything ranking on a floor-relative average prefers two
   * beats because the bar inflates it.
   *
   * Two facts make the subdivision approach robust where those failed:
   *   - a real beat divides the dominant period a whole number of times, so a
   *     dotted note and the range boundary are excluded by construction;
   *   - among the divisors, the beat is the one that actually correlates. For a
   *     plain click track every multiple ties, so the tie breaks towards the
   *     faster reading, which is the beat rather than a bar of it.
   */
  let dominantLag = 0;
  let dominantScore = 0;
  for (let lag = minLag; lag <= combCeiling; lag += 0.5) {
    const value = scoreAt(lag);
    if (value > dominantScore) {
      dominantScore = value;
      dominantLag = lag;
    }
  }
  // Noise has a flat autocorrelation; its highest point is not a tempo.
  if (!dominantLag || dominantScore - acfFloor < 0.12) return {};

  interface Subdivision {
    lag: number;
    strength: number;
  }
  const subdivisions: Subdivision[] = [];
  // Up to eight, so a bar of 4/4 reaches the eighth note and a 5- or 7-beat
  // argmax on a metronomic signal still recovers the beat.
  for (let divisor = 1; divisor <= 8; divisor += 1) {
    const raw = dominantLag / divisor;
    if (raw < minLag - 2 || raw > maxLag + 2) continue;
    // Snap to the real peak: a divisor rarely lands exactly on it, and for
    // sharp onsets being a frame out costs most of the correlation.
    let lag = raw;
    let strength = scoreAt(raw);
    const window = Math.max(1.5, raw * 0.02);
    for (let probe = raw - window; probe <= raw + window; probe += 0.1) {
      const value = scoreAt(probe);
      if (value > strength) {
        strength = value;
        lag = probe;
      }
    }
    if (lag < minLag || lag > maxLag) continue;
    if (strength - acfFloor <= AT_FLOOR) continue;
    subdivisions.push({ lag, strength });
  }

  if (!subdivisions.length) return {};

  const strongest = Math.max(...subdivisions.map((entry) => entry.strength));
  /**
   * Among comparably strong subdivisions, prefer the faster reading.
   *
   * The tolerance is wide because a kick/snare alternation genuinely repeats
   * every two beats, so the two-beat period is a real periodicity and not an
   * artefact — at 190-200 BPM a strict window picked it and halved the tempo.
   * A subdivision faster than the beat cannot be chosen in its place: it would
   * fall outside the 60-210 BPM range.
   */
  const contenders = subdivisions.filter((entry) => entry.strength >= strongest * 0.9);
  contenders.sort((a, b) => a.lag - b.lag);

  const chosenLag = contenders[0]!.lag;

  let inRangeBest = 0;
  for (let lag = minLag; lag <= maxLag; lag += 0.25) {
    inRangeBest = Math.max(inRangeBest, scoreAt(lag));
  }
  if (inRangeBest - acfFloor < 0.1) return {};

  // Refine on the raw autocorrelation. This matters for accuracy as well as
  // precision: candidates are accepted through a proportional tolerance, so
  // without snapping to the true peak every reading came out around 0.7% fast.
  const refineWindow = Math.max(1.5, chosenLag * 0.02);
  let refinedLag = chosenLag;
  let bestLocal = scoreAt(chosenLag);
  for (let probe = chosenLag - refineWindow; probe <= chosenLag + refineWindow; probe += 0.05) {
    const value = scoreAt(probe);
    if (value > bestLocal) {
      bestLocal = value;
      refinedLag = probe;
    }
  }
  const bpm = (60 * envelopeRate) / refinedLag;

  // Confidence must reflect how much better this period is than an unrelated
  // one. Anything within a main lobe, or at a tempo multiple, is not a rival.
  // Confidence compares the chosen period against the best UNRELATED one.
  // A lag inside the same main lobe, or at a whole-number tempo multiple, is
  // corroboration rather than competition.
  const chosenScore = scoreAt(chosenLag);
  let rivalScore = 0;
  for (let lag = minLag; lag <= maxLag; lag += 0.25) {
    if (Math.abs(lag - chosenLag) <= 4) continue;
    const ratio = Math.max(lag, chosenLag) / Math.min(lag, chosenLag);
    let related = false;
    for (const harmonic of [1.5, 2, 3, 4]) {
      if (Math.abs(ratio - harmonic) < 0.06) related = true;
    }
    if (related) continue;
    rivalScore = Math.max(rivalScore, scoreAt(lag));
  }
  const margin = chosenScore - rivalScore;

  /**
   * Confidence is calibrated against the statistic the decision actually used,
   * and against what real music looks like.
   *
   * Absolute autocorrelation near 1.0 only happens for a metronome. A correct
   * reading on a syncopated break sits around 0.3, and scaling confidence
   * straight off that reported a right answer at 0.10 — which reads in the UI
   * as "do not trust this". `SOLID_SUPPORT` is the level at which a period's
   * whole harmonic series counts as convincingly present.
   */
  const SOLID_SUPPORT = 0.3;
  const seriesStrength = Math.min(1, Math.max(0, scoreAt(chosenLag) - acfFloor) / SOLID_SUPPORT);
  const uniqueness = Math.min(1, Math.max(0, margin) / 0.15);
  const confidence = clamp01(0.3 + seriesStrength * 0.45 + uniqueness * 0.25);
  return { bpm: Math.round(bpm * 10) / 10, bpmConfidence: confidence };
}

/** Split a line input into the rhythm regions that matter for D&B. */
function rhythmBands(samples: Float32Array, sampleRate: number): {
  low: Float32Array;
  mid: Float32Array;
  high: Float32Array;
} {
  const low = new Float32Array(samples.length);
  const mid = new Float32Array(samples.length);
  const high = new Float32Array(samples.length);
  const coefficient = (hz: number) => 1 - Math.exp((-2 * Math.PI * hz) / sampleRate);
  const a30 = coefficient(30);
  const a180 = coefficient(180);
  const a2500 = coefficient(2500);
  let lp30 = 0;
  let lp180 = 0;
  let lp2500 = 0;
  for (let index = 0; index < samples.length; index += 1) {
    const value = samples[index]!;
    lp30 += a30 * (value - lp30);
    lp180 += a180 * (value - lp180);
    lp2500 += a2500 * (value - lp2500);
    low[index] = lp180 - lp30;
    mid[index] = lp2500 - lp180;
    high[index] = value - lp2500;
  }
  return { low, mid, high };
}

function dnbCanonicalBpm(value: number): number {
  const doubled = value >= 72 && value <= 105 ? value * 2 : value;
  return Math.round(doubled * 10) / 10;
}

/**
 * Detect tempo with an explicit D&B mode.
 *
 * General analysis retains the proven full-band detector. D&B additionally
 * asks kick/sub, snare/break and hats to vote independently, canonicalises an
 * exact half-time interpretation, and reports the correlations behind the
 * decision instead of hiding them in one percentage.
 */
export function detectBpm(
  samples: Float32Array,
  sampleRate: number,
  profile: AnalysisProfile = 'general',
): Pick<Detection, 'bpm' | 'bpmConfidence' | 'bpmDiagnostics'> {
  const full = detectBpmCore(samples, sampleRate);
  if (profile === 'general') {
    return {
      ...full,
      bpmDiagnostics: {
        profile,
        bands: [{ band: 'full', bpm: full.bpm, confidence: full.bpmConfidence }],
        candidates: full.bpm === undefined ? [] : [{ bpm: full.bpm, support: full.bpmConfidence ?? 0, bands: ['full'] }],
        agreement: full.bpm === undefined ? 0 : 1,
      },
    };
  }

  const split = rhythmBands(samples, sampleRate);
  const readings = [
    { band: 'full' as const, ...full },
    { band: 'low' as const, ...detectBpmCore(split.low, sampleRate) },
    { band: 'mid' as const, ...detectBpmCore(split.mid, sampleRate) },
    { band: 'high' as const, ...detectBpmCore(split.high, sampleRate) },
    // Spectral flux over a steady-floor-suppressed spectrum. The amplitude
    // envelope cannot separate a kick from a sustained pad — several partials
    // interfering inside one frame modulate the total on their own, and a pad
    // at a quarter of drum level pulled every tempo from 140 to 186 onto the
    // same 177.2 reading. This voter is deaf to anything that holds still.
    { band: 'percussive' as const, ...detectBpmPercussive(samples, sampleRate) },
  ];
  const groups: { bpm: number; support: number; bands: string[]; values: number[] }[] = [];
  for (const reading of readings) {
    if (reading.bpm === undefined) continue;
    const bpm = dnbCanonicalBpm(reading.bpm);
    const group = groups.find((candidate) => Math.abs(candidate.bpm - bpm) / candidate.bpm <= 0.018);
    const weight = reading.bpmConfidence ?? 0.4;
    if (group) {
      group.values.push(bpm);
      group.support += weight;
      group.bands.push(reading.band);
      group.bpm = median(group.values);
    } else {
      groups.push({ bpm, support: weight, bands: [reading.band], values: [bpm] });
    }
  }
  groups.sort((a, b) => b.support - a.support || b.bands.length - a.bands.length);
  const winner = groups[0];
  const totalSupport = groups.reduce((sum, group) => sum + group.support, 0);
  const agreement = winner && totalSupport ? winner.support / totalSupport : 0;
  const meanWinnerConfidence = winner
    ? mean(readings.filter((reading) => winner.bands.includes(reading.band)).map((reading) => reading.bpmConfidence ?? 0))
    : 0;
  // Agreement is a measured vote share, not an invented accuracy percentage.
  const confidence = winner ? clamp01(meanWinnerConfidence * 0.65 + agreement * 0.35) : undefined;
  return {
    bpm: winner ? Math.round(winner.bpm * 10) / 10 : undefined,
    bpmConfidence: confidence,
    bpmDiagnostics: {
      profile,
      bands: readings.map(({ band, bpm, bpmConfidence }) => ({ band, bpm, confidence: bpmConfidence })),
      candidates: groups.slice(0, 5).map(({ bpm, support, bands }) => ({ bpm, support, bands })),
      agreement,
    },
  };
}

/** In-place radix-2 FFT. */
function fft(real: Float64Array, imag: Float64Array): void {
  const length = real.length;
  for (let i = 1, j = 0; i < length; i += 1) {
    let bit = length >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      [real[i], real[j]] = [real[j]!, real[i]!];
      [imag[i], imag[j]] = [imag[j]!, imag[i]!];
    }
  }
  for (let size = 2; size <= length; size <<= 1) {
    const angle = (-2 * Math.PI) / size;
    const stepReal = Math.cos(angle);
    const stepImag = Math.sin(angle);
    for (let start = 0; start < length; start += size) {
      let currentReal = 1;
      let currentImag = 0;
      const half = size >> 1;
      for (let offset = 0; offset < half; offset += 1) {
        const even = start + offset;
        const odd = even + half;
        const oddReal = real[odd]! * currentReal - imag[odd]! * currentImag;
        const oddImag = real[odd]! * currentImag + imag[odd]! * currentReal;
        real[odd] = real[even]! - oddReal;
        imag[odd] = imag[even]! - oddImag;
        real[even] = real[even]! + oddReal;
        imag[even] = imag[even]! + oddImag;
        const nextReal = currentReal * stepReal - currentImag * stepImag;
        currentImag = currentReal * stepImag + currentImag * stepReal;
        currentReal = nextReal;
      }
    }
  }
}

function correlation(left: readonly number[], right: readonly number[]): number {
  const leftMean = mean(left);
  const rightMean = mean(right);
  let numerator = 0;
  let leftSquare = 0;
  let rightSquare = 0;
  for (let index = 0; index < left.length; index += 1) {
    const a = left[index]! - leftMean;
    const b = right[index]! - rightMean;
    numerator += a * b;
    leftSquare += a * a;
    rightSquare += b * b;
  }
  return leftSquare && rightSquare ? numerator / Math.sqrt(leftSquare * rightSquare) : 0;
}

function rotatedProfile(profile: readonly number[], tonic: number): number[] {
  return PITCH_CLASSES.map((_, pitchClass) => profile[(pitchClass - tonic + 12) % 12]!);
}

/**
 * Estimate non-negative fundamental pitch classes from their overtone mixture.
 * This small multiplicative NNLS solve reduces the false fifth/major-third
 * signature of one bass note. A little observed chroma is retained so genuine
 * chord tones are not erased when their own harmonic series is weak.
 */
function deconvolveHarmonics(observed: readonly number[]): number[] {
  const basis = Array.from({ length: 12 }, () => Array<number>(12).fill(0));
  for (let fundamental = 0; fundamental < 12; fundamental += 1) {
    for (let harmonic = 1; harmonic <= 10; harmonic += 1) {
      const offset = Math.round(12 * Math.log2(harmonic)) % 12;
      const pitchClass = (fundamental + offset) % 12;
      basis[pitchClass]![fundamental] = basis[pitchClass]![fundamental]! + 1 / harmonic;
    }
  }
  let estimate = observed.map((value) => Math.max(1e-6, value));
  for (let iteration = 0; iteration < 40; iteration += 1) {
    const reconstructed = basis.map((row) =>
      row.reduce((sum, value, index) => sum + value * estimate[index]!, 0),
    );
    estimate = estimate.map((value, fundamental) => {
      let numerator = 0;
      let denominator = 0.015;
      for (let pitchClass = 0; pitchClass < 12; pitchClass += 1) {
        numerator += basis[pitchClass]![fundamental]! * observed[pitchClass]!;
        denominator += basis[pitchClass]![fundamental]! * reconstructed[pitchClass]!;
      }
      return Math.max(0, value * numerator / Math.max(1e-9, denominator));
    });
  }
  return estimate.map((value, index) => value * 0.7 + observed[index]! * 0.3);
}

interface SpectralFrame {
  magnitudes: Float64Array;
}

interface NoteActivation {
  midi: number;
  strength: number;
}

function medianSlice(values: ArrayLike<number>, from: number, to: number): number {
  const slice: number[] = [];
  for (let index = Math.max(0, from); index <= Math.min(values.length - 1, to); index += 1) {
    slice.push(values[index]!);
  }
  slice.sort((a, b) => a - b);
  return slice[Math.floor(slice.length / 2)] ?? 0;
}

/**
 * Median-filter HPSS mask in the magnitude domain.
 *
 * Sustained notes form horizontal ridges across time, while drums form broad
 * vertical ridges across frequency. The mask deliberately leaves uncertain
 * residual energy out of the key stream instead of forcing it into a note.
 */
function harmonicSpectrum(
  frames: readonly SpectralFrame[],
  frameIndex: number,
): { magnitudes: Float64Array; harmonic: number; percussive: number } {
  const source = frames[frameIndex]!.magnitudes;
  const output = new Float64Array(source.length);
  let harmonicEnergy = 0;
  let percussiveEnergy = 0;
  for (let bin = 0; bin < source.length; bin += 1) {
    const acrossTime: number[] = [];
    for (let offset = -2; offset <= 2; offset += 1) {
      const neighbour = frames[frameIndex + offset];
      if (neighbour) acrossTime.push(neighbour.magnitudes[bin]!);
    }
    acrossTime.sort((a, b) => a - b);
    const harmonicMedian = acrossTime[Math.floor(acrossTime.length / 2)] ?? 0;
    const percussiveMedian = medianSlice(source, bin - 8, bin + 8);
    const harmonicSquare = harmonicMedian * harmonicMedian;
    const percussiveSquare = percussiveMedian * percussiveMedian;
    const mask = harmonicSquare / Math.max(1e-12, harmonicSquare + percussiveSquare);
    output[bin] = source[bin]! * mask;
    harmonicEnergy += source[bin]! * mask;
    percussiveEnergy += source[bin]! * (1 - mask);
  }
  return { magnitudes: output, harmonic: harmonicEnergy, percussive: percussiveEnergy };
}

function interpolatedMagnitude(
  magnitudes: Float64Array,
  frequency: number,
  firstBin: number,
  fftSize: number,
  sampleRate: number,
): number {
  const position = (frequency * fftSize) / sampleRate - firstBin;
  const lower = Math.floor(position);
  const fraction = position - lower;
  const left = magnitudes[lower] ?? 0;
  const right = magnitudes[lower + 1] ?? left;
  return left + (right - left) * fraction;
}

/**
 * Approximate note-level NNLS transcription on a three-bins-per-semitone
 * log-frequency spectrum. Unlike pitch-class deconvolution, this retains the
 * octave of each possible fundamental until its harmonic series is explained.
 */
function transcribeNotes(
  magnitudes: Float64Array,
  firstBin: number,
  fftSize: number,
  sampleRate: number,
  tuningOffset: number,
  lowestHz: number,
  highestHz: number,
): NoteActivation[] {
  const binsPerSemitone = 3;
  const minimumMidi = Math.ceil(69 + 12 * Math.log2(lowestHz / 440));
  const maximumMidi = Math.floor(69 + 12 * Math.log2(highestHz / 440));
  const logBinCount = (maximumMidi - minimumMidi) * binsPerSemitone + 1;
  const observation = new Float64Array(logBinCount);
  for (let logBin = 0; logBin < logBinCount; logBin += 1) {
    const midi = minimumMidi + logBin / binsPerSemitone;
    const frequency = 440 * 2 ** ((midi + tuningOffset - 69) / 12);
    observation[logBin] = Math.sqrt(Math.max(0, interpolatedMagnitude(
      magnitudes, frequency, firstBin, fftSize, sampleRate,
    )));
  }

  const noteCount = maximumMidi - minimumMidi + 1;
  const basis = Array.from({ length: logBinCount }, () => new Float64Array(noteCount));
  for (let note = 0; note < noteCount; note += 1) {
    const fundamentalMidi = minimumMidi + note;
    for (let harmonic = 1; harmonic <= 10; harmonic += 1) {
      const harmonicMidi = fundamentalMidi + 12 * Math.log2(harmonic);
      const position = (harmonicMidi - minimumMidi) * binsPerSemitone;
      if (position < 0 || position >= logBinCount - 1) break;
      const lower = Math.floor(position);
      const fraction = position - lower;
      const weight = 1 / Math.sqrt(harmonic);
      basis[lower]![note] = basis[lower]![note]! + weight * (1 - fraction);
      basis[lower + 1]![note] = basis[lower + 1]![note]! + weight * fraction;
    }
  }

  let estimate = new Float64Array(noteCount);
  for (let note = 0; note < noteCount; note += 1) {
    estimate[note] = Math.max(1e-6, observation[note * binsPerSemitone] ?? 0);
  }
  for (let iteration = 0; iteration < 24; iteration += 1) {
    const reconstruction = new Float64Array(logBinCount);
    for (let bin = 0; bin < logBinCount; bin += 1) {
      let value = 0;
      for (let note = 0; note < noteCount; note += 1) value += basis[bin]![note]! * estimate[note]!;
      reconstruction[bin] = value;
    }
    const next = new Float64Array(noteCount);
    for (let note = 0; note < noteCount; note += 1) {
      let numerator = 0;
      let denominator = 0.02;
      for (let bin = 0; bin < logBinCount; bin += 1) {
        const weight = basis[bin]![note]!;
        numerator += weight * observation[bin]!;
        denominator += weight * reconstruction[bin]!;
      }
      next[note] = Math.max(0, estimate[note]! * numerator / Math.max(1e-9, denominator));
    }
    estimate = next;
  }

  const peak = Math.max(...estimate);
  if (!peak) return [];
  const activations: NoteActivation[] = [];
  for (let note = 0; note < noteCount; note += 1) {
    if (estimate[note]! < peak * 0.035) continue;
    activations.push({ midi: minimumMidi + note, strength: estimate[note]! });
  }
  return activations;
}

function keyModelScore(
  chroma: readonly number[],
  tonic: number,
  tonality: Tonality,
  profile: AnalysisProfile,
  bassSupport = 0,
): number {
  const profileScore = correlation(
    chroma,
    rotatedProfile(tonality === 'major' ? MAJOR_PROFILE : MINOR_PROFILE, tonic),
  );
  if (profile !== 'drum-and-bass') return profileScore;
  const peak = Math.max(...chroma);
  const third = (tonic + (tonality === 'major' ? 4 : 3)) % 12;
  const fifth = (tonic + 7) % 12;
  const chordSupport = peak
    ? (chroma[tonic]! + chroma[third]! + chroma[fifth]!) / (peak * 3)
    : 0;
  return profileScore * 0.72 + chordSupport * 0.2 + bassSupport * 0.08;
}

/**
 * Detect musical key from harmonic/percussive separation, log-frequency note
 * transcription and key-profile scoring.
 *
 * Two things here are load-bearing and were previously wrong:
 *
 * 1. FFT bins are LINEARLY spaced, so the number of bins landing on each
 *    pitch class grows with frequency (about 22 for D, 39 for B at 4096/48k).
 *    Summing bin magnitudes therefore encodes bin density, not music: a flat
 *    spectrum used to correlate at 0.42 with Bb minor, so the detector
 *    reported 3A for white noise and for most real input. Each pitch class is
 *    now a MEAN over its bins, which removes the density term entirely.
 *
 * 2. Broadband noise (cymbals, vinyl surface noise, room) lands in every bin.
 *    Subtracting a per-window median whitens the spectrum so only tonal peaks
 *    survive, which is what a chroma is supposed to measure.
 */
export function detectKey(
  samples: Float32Array,
  sampleRate: number,
  profile: AnalysisProfile = 'general',
): Pick<Detection, 'key' | 'keyConfidence' | 'keyDiagnostics'> {
  // D&B needs enough resolution to see the 40–100 Hz sub/root region. The
  // general detector stays cheaper; the D&B path uses a longer FFT and wider
  // overlap, then rejects non-tonal windows with the same guards below.
  const fftSize = profile === 'drum-and-bass' ? 32768 : 8192;
  const hop = profile === 'drum-and-bass' ? 16384 : 8192;
  if (samples.length < fftSize * 2) return {};

  const chromaSum = Array<number>(12).fill(0);
  const chromaBins = Array<number>(12).fill(0);
  let windows = 0;
  let rejectedWindows = 0;
  let acceptedPeaks = 0;
  let rejectedPeaks = 0;
  let harmonicsFolded = 0;
  let transientPeaksAttenuated = 0;
  const peakEvidence: NonNullable<KeyDiagnostics['peaks']> = [];
  const sectionVoteCounts = new Map<string, number>();
  let previousWhitened: Float64Array | undefined;
  // Per-window detuning, accumulated as a circular mean: the offset is measured
  // modulo one semitone, so a plain average of +0.45 and -0.45 would report 0
  // when both windows are in fact half a semitone out.
  let tuningX = 0;
  let tuningY = 0;
  let tuningWindows = 0;
  const bassChroma = Array<number>(12).fill(0);
  const bassPeakVotes = Array<number>(12).fill(0);
  const upperChroma = Array<number>(12).fill(0);
  let harmonicEnergy = 0;
  let percussiveEnergy = 0;

  // Pitch matters most between A2 and C7; below that a semitone is narrower
  // than an FFT bin, above it harmonics dominate over the tonal centre.
  const lowestHz = profile === 'drum-and-bass' ? 45 : 110;
  const highestHz = 2100;
  const firstBin = Math.max(1, Math.ceil((lowestHz * fftSize) / sampleRate));
  const lastBin = Math.min(fftSize / 2 - 1, Math.floor((highestHz * fftSize) / sampleRate));
  if (lastBin <= firstBin) return {};

  const spectralFrames: SpectralFrame[] = [];
  for (let offset = 0; offset + fftSize <= samples.length; offset += hop) {
    const real = new Float64Array(fftSize);
    const imag = new Float64Array(fftSize);
    let energy = 0;
    for (let index = 0; index < fftSize; index += 1) {
      const value = samples[offset + index]!;
      energy += value * value;
      real[index] = value * (0.5 - 0.5 * Math.cos((2 * Math.PI * index) / (fftSize - 1)));
    }
    if (energy / fftSize < 1e-7) continue;
    fft(real, imag);
    const magnitudes = new Float64Array(lastBin - firstBin + 1);
    for (let bin = firstBin; bin <= lastBin; bin += 1) {
      magnitudes[bin - firstBin] = Math.hypot(real[bin]!, imag[bin]!);
    }
    spectralFrames.push({ magnitudes });
  }

  for (let frameIndex = 0; frameIndex < spectralFrames.length; frameIndex += 1) {
    const windowChromaSum = Array<number>(12).fill(0);
    const windowChromaBins = Array<number>(12).fill(0);
    const windowPitchPeaks: { frequency: number; pitchClass: number; weight: number }[] = [];
    const rawMagnitudes = spectralFrames[frameIndex]!.magnitudes;
    const separated = profile === 'drum-and-bass'
      ? harmonicSpectrum(spectralFrames, frameIndex)
      : { magnitudes: rawMagnitudes, harmonic: 0, percussive: 0 };
    const magnitudes = separated.magnitudes;
    harmonicEnergy += separated.harmonic;
    percussiveEnergy += separated.percussive;

    // A sparse tonal spectrum has a low geometric/arithmetic mean ratio;
    // broadband noise is close to flat. Peak-picking alone can turn random
    // noise bumps into convincing-looking notes, so reject flat windows before
    // asking which bins are peaks.
    const magnitudeValues = [...magnitudes];
    const magnitudeMean = mean(magnitudeValues);
    const logMean = magnitudeMean
      ? mean(magnitudeValues.map((value) => Math.log(Math.max(1e-12, value))))
      : 0;
    const spectralFlatness = magnitudeMean ? Math.exp(logMean) / magnitudeMean : 1;
    if (spectralFlatness > 0.62) {
      rejectedWindows += 1;
      continue;
    }

    /**
     * Estimate how far this window is detuned from A440, in semitones.
     *
     * Equal temperament is an assumption, not a measurement. A record played
     * off zero pitch — or simply cut slightly sharp — puts every note between
     * two semitones, and the chroma smears across both. Measured on an A minor
     * chord: at 50 cents it reported C# minor and at 68 cents (a +4% fader,
     * exactly the case v1.1 exists for) it reported A# minor. Confidently
     * wrong, which is worse than silent.
     *
     * The offset is the magnitude-weighted circular mean of each peak's
     * distance to its nearest semitone, over a one-semitone period.
     */
    const tuningFloorIndex = Math.floor(magnitudes.length / 2);
    const tuningFloor = Float64Array.from(magnitudes).sort()[tuningFloorIndex] ?? 0;
    let offsetX = 0;
    let offsetY = 0;
    for (let bin = firstBin; bin <= lastBin; bin += 1) {
      const magnitude = magnitudes[bin - firstBin]! - tuningFloor;
      if (magnitude <= 0) continue;
      const frequency = (bin * sampleRate) / fftSize;
      const midi = 69 + 12 * Math.log2(frequency / 440);
      const deviation = midi - Math.round(midi); // -0.5 .. 0.5 semitones
      const angle = 2 * Math.PI * deviation;
      offsetX += Math.cos(angle) * magnitude;
      offsetY += Math.sin(angle) * magnitude;
    }
    const tuningOffset =
      offsetX || offsetY ? Math.atan2(offsetY, offsetX) / (2 * Math.PI) : 0;

    // Whitening floor: the median is a robust stand-in for the noise floor,
    // so only genuine spectral peaks contribute to the chroma.
    const sorted = Float64Array.from(magnitudes).sort();
    const floor = sorted[Math.floor(sorted.length / 2)] ?? 0;
    const whitened = Float64Array.from(magnitudes, (value) => Math.max(0, value - floor));
    let strongestAboveFloor = 0;
    for (const rawMagnitude of magnitudes) {
      strongestAboveFloor = Math.max(strongestAboveFloor, rawMagnitude - floor);
    }
    let peaked = false;

    for (let bin = firstBin; bin <= lastBin; bin += 1) {
      const magnitude = whitened[bin - firstBin]!;
      const frequency = (bin * sampleRate) / fftSize;
      // Correct to the tuning this window is actually in, so a pitched record
      // lands on the grid instead of between it.
      const midi = 69 + 12 * Math.log2(frequency / 440) - tuningOffset;

      // Split each bin between its two nearest semitones by fractional
      // distance rather than rounding to one. A bin often sits near a semitone
      // boundary — C4 straddles bins 44 and 45 at this resolution, and bin 45
      // rounds up to C# — so rounding smears a clean note into its neighbour
      // and a triad can end up correlating with the wrong key.
      const lowerNote = Math.floor(midi);
      const upperFraction = midi - lowerNote;
      const lowerClass = ((lowerNote % 12) + 12) % 12;
      const upperClass = (((lowerNote + 1) % 12) + 12) % 12;

      windowChromaBins[lowerClass] = windowChromaBins[lowerClass]! + (1 - upperFraction);
      windowChromaBins[upperClass] = windowChromaBins[upperClass]! + upperFraction;
      if (magnitude <= 0) continue;

      // Hann-window leakage paints one real sinusoid across several adjacent
      // FFT bins. Counting every positive bin made those skirts look like
      // extra notes. Keep only a true local maximum that clears a small
      // window-relative prominence floor.
      const magnitudeIndex = bin - firstBin;
      const neighbourhood = 2;
      let localMaximum = true;
      for (let offset = -neighbourhood; offset <= neighbourhood; offset += 1) {
        if (!offset) continue;
        const neighbour = magnitudes[magnitudeIndex + offset];
        if (neighbour !== undefined && neighbour - floor > magnitude) {
          localMaximum = false;
          break;
        }
      }
      if (!localMaximum || magnitude < strongestAboveFloor * 0.025) {
        rejectedPeaks += 1;
        continue;
      }
      peaked = true;
      acceptedPeaks += 1;

      // Square-root compression stops one loud fundamental from swamping the
      // rest of the chord; the gentle low-frequency emphasis reflects that the
      // bass usually carries the root.
      const rootWeight = 1 / Math.sqrt(Math.max(1, frequency / lowestHz));
      let persistenceWeight = 1;
      if (profile === 'drum-and-bass') {
        let previousStrength = 0;
        if (previousWhitened) {
          for (let neighbour = -2; neighbour <= 2; neighbour += 1) {
            previousStrength = Math.max(previousStrength, previousWhitened[magnitudeIndex + neighbour] ?? 0);
          }
        }
        const persistence = previousWhitened ? clamp01((previousStrength / magnitude) * 1.5) : 0;
        persistenceWeight = 0.25 + persistence * 0.75;
        if (persistenceWeight < 0.8) transientPeaksAttenuated += 1;
      }
      const contribution = Math.sqrt(magnitude) * rootWeight * persistenceWeight;

      // If a strong lower peak explains this one as an integer harmonic,
      // retain some direct evidence but fold most of it back to the likely
      // fundamental. This attacks the classic single-bass-note → false major
      // chord failure without deleting genuine chord tones outright.
      let harmonicParent: { harmonic: number; frequency: number; midi: number } | undefined;
      for (let harmonic = 2; harmonic <= 6; harmonic += 1) {
        const parentFrequency = frequency / harmonic;
        if (parentFrequency < lowestHz) continue;
        const parentBin = Math.round((parentFrequency * fftSize) / sampleRate);
        const parentMagnitude = whitened[parentBin - firstBin] ?? 0;
        if (parentMagnitude >= magnitude * 0.18) {
          harmonicParent = {
            harmonic,
            frequency: parentFrequency,
            midi: 69 + 12 * Math.log2(parentFrequency / 440) - tuningOffset,
          };
          break;
        }
      }

      const directShare = harmonicParent ? 0.35 : 1;
      windowChromaSum[lowerClass] = windowChromaSum[lowerClass]! + contribution * directShare * (1 - upperFraction);
      windowChromaSum[upperClass] = windowChromaSum[upperClass]! + contribution * directShare * upperFraction;
      let harmonicOf: string | undefined;
      if (harmonicParent) {
        harmonicsFolded += 1;
        const parentNote = Math.round(harmonicParent.midi);
        const parentClass = ((parentNote % 12) + 12) % 12;
        harmonicOf = `${PITCH_CLASSES[parentClass]!} ×${harmonicParent.harmonic}`;
        windowChromaSum[parentClass] = windowChromaSum[parentClass]! + contribution * (1 - directShare);
      }
      const nearestNote = ((Math.round(midi) % 12) + 12) % 12;
      peakEvidence.push({
        frequency,
        note: PITCH_CLASSES[nearestNote]!,
        weight: contribution,
        ...(harmonicOf ? { harmonicOf } : {}),
      });
      windowPitchPeaks.push({
        // Root evidence must come from an observed peak. A weak kick bin can
        // make the harmonic folder hypothesise an octave-down parent that was
        // never actually present, which is useful for chroma but unsafe as a
        // bass-note label.
        frequency,
        pitchClass: nearestNote,
        weight: contribution,
      });
    }

    // Register evidence, for both profiles: the bass names the root far more
    // reliably than a full-spectrum chroma, and the third that decides major
    // from minor lives in the upper harmony. Previously only D&B collected it,
    // which is why the general detector refused an A-in-the-bass over a C-E-G
    // voicing outright — it had nothing to break the relative-major tie with.
    const strongestPitchPeak = Math.max(0, ...windowPitchPeaks.map((entry) => entry.weight));
    const dominantBassPeak = windowPitchPeaks
      .filter((entry) => entry.frequency <= 300 && entry.weight >= strongestPitchPeak * 0.18)
      .sort((left, right) => right.weight - left.weight)[0];
    if (dominantBassPeak) {
      bassPeakVotes[dominantBassPeak.pitchClass] =
        bassPeakVotes[dominantBassPeak.pitchClass]! + dominantBassPeak.weight;
    }
    if (profile !== 'drum-and-bass') {
      // D&B derives these from unmixed note activations below; the general
      // path uses the accepted peaks it already has.
      for (const entry of windowPitchPeaks) {
        const range = entry.frequency <= 300 ? bassChroma : upperChroma;
        range[entry.pitchClass] = range[entry.pitchClass]! + entry.weight;
      }
    }

    if (profile === 'drum-and-bass') {
      const activations = transcribeNotes(
        whitened,
        firstBin,
        fftSize,
        sampleRate,
        tuningOffset,
        lowestHz,
        highestHz,
      );
      if (activations.length) {
        const noteChroma = Array<number>(12).fill(0);
        for (const activation of activations) {
          const pitchClass = ((activation.midi % 12) + 12) % 12;
          const weight = Math.sqrt(activation.strength);
          noteChroma[pitchClass] = noteChroma[pitchClass]! + weight;
          const range = activation.midi <= 55 ? bassChroma : upperChroma;
          range[pitchClass] = range[pitchClass]! + weight;
        }
        const peakChromaMaximum = Math.max(...windowChromaSum);
        const noteChromaMaximum = Math.max(...noteChroma);
        for (let pitchClass = 0; pitchClass < 12; pitchClass += 1) {
          const peakValue = peakChromaMaximum ? windowChromaSum[pitchClass]! / peakChromaMaximum : 0;
          const noteValue = noteChromaMaximum ? noteChroma[pitchClass]! / noteChromaMaximum : 0;
          windowChromaSum[pitchClass] = peakValue * 0.25 + noteValue * 0.75;
          windowChromaBins[pitchClass] = 1;
        }
        peaked = true;
      }
    }
    previousWhitened = whitened;
    if (!peaked) continue;

    // Breaks and cymbals can have peaks without carrying a tonal centre. In
    // D&B mode, only windows whose chroma has meaningful shape contribute to
    // the track key; rejected windows remain visible in diagnostics.
    const localChroma = windowChromaSum.map((total, pitchClass) =>
      windowChromaBins[pitchClass] ? total / windowChromaBins[pitchClass]! : 0,
    );
    const localMean = mean(localChroma);
    const localSpread = localMean
      ? Math.sqrt(mean(localChroma.map((value) => (value - localMean) ** 2))) / localMean
      : 0;
    if (profile === 'drum-and-bass' && localSpread < 0.1) {
      rejectedWindows += 1;
      continue;
    }
    // D&B note activations have already been unmixed at their original
    // octaves; a second pitch-class deconvolution would erase real chord tones.
    const localModel = localChroma;
    const localCandidates: { name: string; score: number }[] = [];
    for (let tonic = 0; tonic < 12; tonic += 1) {
      localCandidates.push({ name: `${PITCH_CLASSES[tonic]!} major`, score: keyModelScore(localModel, tonic, 'major', profile) });
      localCandidates.push({ name: `${PITCH_CLASSES[tonic]!} minor`, score: keyModelScore(localModel, tonic, 'minor', profile) });
    }
    localCandidates.sort((a, b) => b.score - a.score);
    const localWinner = localCandidates[0];
    const localRival = localCandidates[1];
    if (localWinner && localWinner.score >= 0.22 && localWinner.score - (localRival?.score ?? 0) >= 0.015) {
      sectionVoteCounts.set(localWinner.name, (sectionVoteCounts.get(localWinner.name) ?? 0) + 1);
    }
    for (let pitchClass = 0; pitchClass < 12; pitchClass += 1) {
      chromaSum[pitchClass] = chromaSum[pitchClass]! + windowChromaSum[pitchClass]!;
      chromaBins[pitchClass] = chromaBins[pitchClass]! + windowChromaBins[pitchClass]!;
    }
    const tuningAngle = 2 * Math.PI * tuningOffset;
    tuningX += Math.cos(tuningAngle);
    tuningY += Math.sin(tuningAngle);
    tuningWindows += 1;
    windows += 1;
  }

  const emptyChroma = Array<number>(12).fill(0);
  const thresholds = { ...KEY_THRESHOLDS };
  const bail = (
    rejectedBy: NonNullable<KeyDiagnostics['rejectedBy']>,
    extra: Partial<KeyDiagnostics> = {},
  ): Pick<Detection, 'key' | 'keyConfidence' | 'keyDiagnostics'> => ({
    keyDiagnostics: {
      chroma: emptyChroma,
      spread: 0,
      best: 0,
      margin: 0,
      thresholds,
      windows: { accepted: windows, rejected: rejectedWindows },
      peakCounts: { accepted: acceptedPeaks, rejected: rejectedPeaks, harmonicsFolded },
      rejectedBy,
      ...extra,
    },
  });

  if (!windows) return bail('no-peaks');

  // MEAN per pitch class, not sum: this is the density correction.
  const observedChroma = chromaSum.map((total, pitchClass) =>
    chromaBins[pitchClass] ? total / chromaBins[pitchClass]! : 0,
  );
  const transcribedEnergy = [...bassChroma, ...upperChroma].reduce((sum, value) => sum + value, 0);
  const chroma = profile === 'drum-and-bass' && !transcribedEnergy
    ? deconvolveHarmonics(observedChroma)
    : observedChroma;
  const chromaTotal = chroma.reduce((sum, value) => sum + value, 0);
  if (chromaTotal <= 0) return bail('no-audio');

  const peak = Math.max(...chroma);
  const normalised = chroma.map((value) => (peak > 0 ? value / peak : 0));

  // A near-flat chroma carries no tonal information. Refusing here is what
  // stops noise being reported as a key at high confidence.
  const chromaMean = chromaTotal / 12;
  const spread = Math.sqrt(
    chroma.reduce((sum, value) => sum + (value - chromaMean) ** 2, 0) / 12,
  ) / chromaMean;

  const bassPeak = Math.max(...bassPeakVotes);
  const bassRootIndex = bassPeak ? bassPeakVotes.indexOf(bassPeak) : -1;
  const candidates: { tonic: number; tonality: Tonality; score: number }[] = [];
  for (let tonic = 0; tonic < 12; tonic += 1) {
    for (const tonality of ['major', 'minor'] as const) {
      // A profile alone can call a sparse root-position triad by its third
      // (E-G#-B as G# minor, for example). Complete chord support and the
      // lowest stable note provide bounded D&B-specific evidence.
      const bassSupport = bassPeak ? bassPeakVotes[tonic]! / bassPeak : 0;
      const score = keyModelScore(chroma, tonic, tonality, profile, bassSupport);
      candidates.push({ tonic, tonality, score });
    }
  }
  candidates.sort((a, b) => b.score - a.score);

  /**
   * Bounded re-rank on register evidence.
   *
   * Deliberately NOT another term added into the score: the acceptance
   * thresholds are calibrated against the profile correlation, and inflating
   * every candidate's score would quietly loosen them and let noise through.
   * Only candidates already within a whisker of the leader are reconsidered,
   * and the register evidence decides between them. A relative major and its
   * minor always sit that close — they share all seven notes — which is exactly
   * the tie the bass is qualified to break.
   *
   * Reordering the list is the dangerous part, and getting it wrong produced
   * two failures at once. Promoting a lower-scoring candidate and then
   * measuring `best.score - rival.score` gave a NEGATIVE tonic margin, so the
   * guard refused the decision the re-rank had just made — a real recording
   * reported "tonic -0.04 / 0.03" and declined a key it had identified. Patching
   * that by skipping any rival the bass contradicted then left no rival at all
   * on some voicings, and the margin collapsed to `best.score - 0`, which
   * passes trivially and disabled the guard instead.
   *
   * So: the re-rank only fires when the register evidence is DECISIVE and the
   * tie is genuinely two- or three-way, and when it fires the margin is
   * measured from the tie group's top score against the best candidate OUTSIDE
   * the group. Within the group the bass has already decided; outside it the
   * comparison is still meaningful. When it does not fire, the margin is
   * exactly what it was before register evidence existed.
   */
  const TIE_BAND = 0.05;
  const REGISTER_DECISIVE = 0.25;
  const MAX_TIE = 3;

  const upperPeak = Math.max(...upperChroma);
  const registerSupport = (tonic: number, tonality: Tonality): number => {
    const bass = bassPeak ? bassPeakVotes[tonic]! / bassPeak : 0;
    if (!upperPeak) return bass;
    const third = upperChroma[(tonic + (tonality === 'major' ? 4 : 3)) % 12]! / upperPeak;
    const otherThird = upperChroma[(tonic + (tonality === 'major' ? 3 : 4)) % 12]! / upperPeak;
    return bass + Math.max(0, third - otherThird) * 0.5;
  };

  const profileLeader = candidates[0];
  const tieGroup = profileLeader
    ? candidates.filter((candidate) => profileLeader.score - candidate.score <= TIE_BAND)
    : [];

  let best = profileLeader;
  let registerDecided = false;
  if (profileLeader && tieGroup.length > 1 && tieGroup.length <= MAX_TIE) {
    const ranked = [...tieGroup].sort(
      (a, b) =>
        registerSupport(b.tonic, b.tonality) - registerSupport(a.tonic, a.tonality) ||
        b.score - a.score,
    );
    const winner = ranked[0]!;
    const runnerUp = ranked[1]!;
    /*
     * The gap is between the register evidence's first and second choice, not
     * between it and the profile leader. Measuring against the leader meant
     * register evidence could only ever PROMOTE a different candidate: when the
     * bass already agreed with the leader the gap was zero, nothing was decided,
     * and the near-tied rival still vetoed it — an A in the bass under a C-E-G
     * triad refused at a tonic margin of 0.003. Confirming the leader is just as
     * much a decision as overturning it.
     */
    const gap = registerSupport(winner.tonic, winner.tonality) -
      registerSupport(runnerUp.tonic, runnerUp.tonality);
    if (gap >= REGISTER_DECISIVE) {
      best = winner;
      registerDecided = true;
      // Surface the chosen key first, so the candidate list reads as the
      // decision that was actually taken.
      const index = candidates.indexOf(winner);
      if (index > 0) {
        candidates.splice(index, 1);
        candidates.unshift(winner);
      }
    }
  }

  // Tonic and mode are independent decisions. The old detector ignored the
  // opposite mode on the same tonic entirely, allowing A major versus A minor
  // ambiguity to retain high confidence.
  const rival = best
    ? candidates.find((candidate) =>
        candidate.tonic !== best.tonic &&
        // Only a register-decided tie excuses a rival from the comparison.
        !(registerDecided && tieGroup.includes(candidate)))
    : undefined;
  const marginBasis = registerDecided && profileLeader ? profileLeader.score : best?.score ?? 0;
  const margin = best ? marginBasis - (rival?.score ?? 0) : 0;
  const parallelMode = best
    ? candidates.find((candidate) => candidate.tonic === best.tonic && candidate.tonality !== best.tonality)
    : undefined;
  const profileModeMargin = best ? best.score - (parallelMode?.score ?? 0) : 0;
  const chromaPeak = Math.max(...chroma);
  const expectedThird = best
    ? chroma[(best.tonic + (best.tonality === 'major' ? 4 : 3)) % 12]!
    : 0;
  const oppositeThird = best
    ? chroma[(best.tonic + (best.tonality === 'major' ? 3 : 4)) % 12]!
    : 0;
  const thirdModeMargin = chromaPeak ? (expectedThird - oppositeThird) / chromaPeak : 0;
  const modeMargin = Math.min(profileModeMargin, thirdModeMargin);
  const candidateName = best
    ? `${PITCH_CLASSES[best.tonic]!} ${best.tonality}`
    : undefined;
  const sectionVotes = [...sectionVoteCounts.entries()]
    .sort((a, b) => b[1] - a[1]);
  const sectionVoteTotal = sectionVotes.reduce((sum, entry) => sum + entry[1], 0);
  const sectionAgreement = sectionVoteTotal ? (sectionVotes[0]?.[1] ?? 0) / sectionVoteTotal : 0;
  const upperCandidates: { name: string; score: number }[] = [];
  if (Math.max(...upperChroma) > 0) {
    for (let tonic = 0; tonic < 12; tonic += 1) {
      upperCandidates.push({ name: `${PITCH_CLASSES[tonic]!} major`, score: correlation(upperChroma, rotatedProfile(MAJOR_PROFILE, tonic)) });
      upperCandidates.push({ name: `${PITCH_CLASSES[tonic]!} minor`, score: correlation(upperChroma, rotatedProfile(MINOR_PROFILE, tonic)) });
    }
    upperCandidates.sort((a, b) => b.score - a.score);
  }
  const upperKey = upperCandidates[0]?.name;
  const bassRoot = bassRootIndex >= 0 ? PITCH_CLASSES[bassRootIndex] : undefined;
  const rangeAgreed = best && bassRootIndex >= 0 && upperKey
    ? bassRootIndex === best.tonic && upperKey === candidateName
    : undefined;
  const separatedTotal = harmonicEnergy + percussiveEnergy;

  const diagnostics: KeyDiagnostics = {
    chroma: normalised,
    spread,
    best: best?.score ?? 0,
    margin,
    modeMargin,
    thresholds,
    windows: { accepted: windows, rejected: rejectedWindows },
    peaks: peakEvidence.sort((a, b) => b.weight - a.weight).slice(0, 30),
    peakCounts: { accepted: acceptedPeaks, rejected: rejectedPeaks, harmonicsFolded },
    observedChroma: (() => {
      const observedPeak = Math.max(...observedChroma);
      return observedChroma.map((value) => observedPeak ? value / observedPeak : 0);
    })(),
    sectionVotes: sectionVotes
      .slice(0, 5)
      .map(([key, windows]) => ({ key, windows })),
    sectionAgreement,
    rangeEvidence: {
      ...(bassRoot ? { bassRoot } : {}),
      ...(upperKey ? { upperKey } : {}),
      ...(rangeAgreed !== undefined ? { agreed: rangeAgreed } : {}),
    },
    ...(separatedTotal ? {
      separation: {
        harmonic: harmonicEnergy / separatedTotal,
        percussive: percussiveEnergy / separatedTotal,
      },
    } : {}),
    transientPeaksAttenuated,
    ...(tuningWindows ? {
      tuning: {
        cents: (Math.atan2(tuningY / tuningWindows, tuningX / tuningWindows) / (2 * Math.PI)) * 100,
        // Resultant length: 1 means every window agreed on the detuning, 0
        // means they disagreed completely and the estimate means nothing.
        spread: 1 - Math.hypot(tuningX / tuningWindows, tuningY / tuningWindows),
        windows: tuningWindows,
      },
    } : {}),
    ...(candidateName ? { candidate: candidateName } : {}),
    candidates: candidates.slice(0, 5).map((candidate) => ({
      name: `${PITCH_CLASSES[candidate.tonic]!} ${candidate.tonality}`,
      score: candidate.score,
    })),
  };

  if (spread < thresholds.spread) return { keyDiagnostics: { ...diagnostics, rejectedBy: 'spread' } };
  if (!best || best.score < thresholds.correlation) {
    return { keyDiagnostics: { ...diagnostics, rejectedBy: 'correlation' } };
  }
  if (margin < thresholds.margin) {
    return { keyDiagnostics: { ...diagnostics, rejectedBy: 'margin' } };
  }
  if (modeMargin < thresholds.modeMargin) {
    return { keyDiagnostics: { ...diagnostics, rejectedBy: 'mode' } };
  }
  if (
    profile === 'drum-and-bass' &&
    sectionVoteTotal >= 4 &&
    (sectionVotes[0]?.[0] !== candidateName || sectionAgreement < thresholds.sectionAgreement)
  ) {
    return { keyDiagnostics: { ...diagnostics, rejectedBy: 'section' } };
  }

  const confidence = clamp01(
    0.16 + best.score * 0.5 + Math.min(0.18, margin * 1.25) + Math.min(0.16, modeMargin * 2),
  );
  return {
    key: { pitchClass: PITCH_CLASSES[best.tonic]!, tonality: best.tonality },
    keyConfidence: confidence,
    keyDiagnostics: diagnostics,
  };
}

export function analysePcm(
  samples: Float32Array,
  sampleRate: number,
  profile: AnalysisProfile = 'general',
): Detection {
  return { ...detectBpm(samples, sampleRate, profile), ...detectKey(samples, sampleRate, profile) };
}

function sameKey(left: MusicalKey, right: MusicalKey): boolean {
  return left.pitchClass === right.pitchClass && left.tonality === right.tonality;
}

/** Pure rolling aggregation, exported so stability policy is testable. */
export function aggregateFrames(allFrames: readonly AnalysisFrame[], limit = 30): RollingResult {
  const frames = allFrames.slice(-limit);
  const bpmFrames = frames.filter((frame) => frame.bpm !== undefined);
  const bpms = bpmFrames.map((frame) => frame.bpm!);
  const bpm = bpms.length ? median(bpms) : undefined;
  const bpmSpread = bpm === undefined || bpms.length < 2
    ? 1
    : median(bpms.map((value) => Math.abs(value - bpm))) / bpm;
  const bpmAgreement = clamp01(1 - bpmSpread / 0.025);
  const bpmConfidence = bpmFrames.length
    ? clamp01(mean(bpmFrames.map((frame) => frame.bpmConfidence ?? 0)) * 0.7 + bpmAgreement * 0.3)
    : undefined;

  let octavePairs = 0;
  let comparedPairs = 0;
  for (let index = 1; index < bpms.length; index += 1) {
    const low = Math.min(bpms[index - 1]!, bpms[index]!);
    const high = Math.max(bpms[index - 1]!, bpms[index]!);
    comparedPairs += 1;
    if (Math.abs(high / low - 2) <= 0.06) octavePairs += 1;
  }
  const octaveAmbiguity = comparedPairs >= 2 && octavePairs / comparedPairs >= 0.4;
  const bpmStable = bpmFrames.length >= 4 && bpmSpread <= 0.012 && !octaveAmbiguity;

  // Key needs a longer musical context than BPM. Weight recent observations
  // more strongly so an intro note cannot keep steering the result after the
  // fuller bassline/harmony arrives, while still requiring a decisive lead.
  const keyFrames = frames.filter((frame) => frame.key !== undefined);
  const keyGroups: { key: MusicalKey; frames: AnalysisFrame[]; weight: number }[] = [];
  let totalKeyWeight = 0;
  for (const frame of keyFrames) {
    const frameIndex = frames.indexOf(frame);
    const weight = 0.35 + 0.65 * ((frameIndex + 1) / Math.max(1, frames.length));
    totalKeyWeight += weight;
    const group = keyGroups.find((entry) => sameKey(entry.key, frame.key!));
    if (group) {
      group.frames.push(frame);
      group.weight += weight;
    } else keyGroups.push({ key: frame.key!, frames: [frame], weight });
  }
  keyGroups.sort((a, b) => b.weight - a.weight);
  const winningKey = keyGroups[0];
  const runnerUpKey = keyGroups[1];
  const key = winningKey?.key;
  const keyAgreement = totalKeyWeight ? (winningKey?.weight ?? 0) / totalKeyWeight : 0;
  const keyLead = totalKeyWeight
    ? ((winningKey?.weight ?? 0) - (runnerUpKey?.weight ?? 0)) / totalKeyWeight
    : 0;
  const keyConfidence = winningKey
    ? clamp01(mean(winningKey.frames.map((frame) => frame.keyConfidence ?? 0)) * 0.7 + keyAgreement * 0.3)
    : undefined;
  const profile = frames[frames.length - 1]?.bpmDiagnostics?.profile ?? 'general';
  // D&B melodies and bass riffs often imply several keys during their first
  // few notes. Eight two-second observations gives roughly twenty seconds of
  // context before the main UI calls a key locked.
  const minimumKeyFrames = profile === 'drum-and-bass' ? 8 : 4;
  const keyStable = keyFrames.length >= minimumKeyFrames && keyAgreement >= 0.72 && keyLead >= 0.18;
  const hasBpm = bpm !== undefined;
  const hasKey = key !== undefined;
  const stable = (hasBpm || hasKey) && (!hasBpm || bpmStable) && (!hasKey || keyStable);

  return {
    bpm: bpm === undefined ? undefined : Math.round(bpm * 10) / 10,
    bpmConfidence,
    bpmBand: confidenceBand(bpmConfidence, bpmStable),
    key,
    camelot: key ? musicalKeyToCamelot(key) ?? undefined : undefined,
    keyConfidence,
    keyBand: confidenceBand(keyConfidence, keyStable),
    stable,
    octaveAmbiguity,
    frames,
  };
}

/** Audio required before the first reading can be produced. */
const MINIMUM_SECONDS = 6;
/** Waveform history slots, one per captured chunk. */
const WAVEFORM_POINTS = 96;

class SampleRing {
  private data: Float32Array;
  private writeAt = 0;
  private size = 0;

  constructor(capacity: number) {
    this.data = new Float32Array(capacity);
  }

  get length(): number {
    return this.size;
  }

  push(samples: Float32Array): void {
    for (const sample of samples) {
      this.data[this.writeAt] = sample;
      this.writeAt = (this.writeAt + 1) % this.data.length;
      this.size = Math.min(this.size + 1, this.data.length);
    }
  }

  clear(): void {
    this.writeAt = 0;
    this.size = 0;
  }

  snapshot(): Float32Array {
    const result = new Float32Array(this.size);
    const start = (this.writeAt - this.size + this.data.length) % this.data.length;
    for (let index = 0; index < this.size; index += 1) {
      result[index] = this.data[(start + index) % this.data.length]!;
    }
    return result;
  }
}

class RollingAudioAnalyser implements Analyser {
  private source?: AudioSource;
  private unsubscribeSource?: () => void;
  private listeners = new Set<(frame: AnalysisFrame, result: RollingResult) => void>();
  private frames: AnalysisFrame[] = [];
  private ring?: SampleRing;
  private sampleRate = 0;
  private samplesSinceFrame = 0;
  private current: RollingResult = aggregateFrames([]);

  // Input metering. Kept separate from detection so the UI can always say
  // whether audio is arriving, even when the detectors decline to commit.
  private receiving = false;
  private rms = 0;
  private peak = 0;
  private peakHold = 0;
  private readonly waveform = new Float32Array(WAVEFORM_POINTS);
  private waveformAt = 0;
  private lastDiagnostics?: KeyDiagnostics;
  private totalSamples = 0;
  private worker?: Worker;
  private analysisPending = false;
  private generation = 0;

  constructor(private readonly profile: AnalysisProfile = 'general') {}

  get running(): boolean {
    return Boolean(this.source?.active);
  }

  async attach(source: AudioSource): Promise<void> {
    await this.detach();
    this.source = source;
    this.unsubscribeSource = source.onSamples((chunk) => this.ingest(chunk));
    try {
      await source.start();
    } catch (error) {
      this.unsubscribeSource?.();
      this.unsubscribeSource = undefined;
      this.source = undefined;
      throw error;
    }
  }

  async detach(): Promise<void> {
    this.unsubscribeSource?.();
    this.unsubscribeSource = undefined;
    const source = this.source;
    this.source = undefined;
    if (source) await source.stop();
    this.generation += 1;
    this.analysisPending = false;
    this.worker?.terminate();
    this.worker = undefined;
  }

  result(): RollingResult {
    return this.current;
  }

  input(): InputLevel {
    const buffered = this.sampleRate ? (this.ring?.length ?? 0) / this.sampleRate : 0;
    // Oldest-first for drawing, since the store is a ring.
    const ordered = new Float32Array(WAVEFORM_POINTS);
    for (let i = 0; i < WAVEFORM_POINTS; i += 1) {
      ordered[i] = this.waveform[(this.waveformAt + i) % WAVEFORM_POINTS]!;
    }
    return {
      rms: this.rms,
      peak: this.peak,
      peakHold: this.peakHold,
      receiving: this.receiving,
      secondsBuffered: buffered,
      secondsCaptured: this.sampleRate ? this.totalSamples / this.sampleRate : 0,
      secondsUntilFirstReading: Math.max(0, MINIMUM_SECONDS - buffered),
      waveform: ordered,
      ...(this.lastDiagnostics ? { keyDiagnostics: this.lastDiagnostics } : {}),
    };
  }

  reset(): void {
    this.generation += 1;
    this.analysisPending = false;
    this.frames = [];
    this.ring?.clear();
    this.samplesSinceFrame = 0;
    this.current = aggregateFrames([]);
    this.receiving = false;
    this.rms = 0;
    this.peak = 0;
    this.peakHold = 0;
    this.waveform.fill(0);
    this.waveformAt = 0;
    this.lastDiagnostics = undefined;
    this.totalSamples = 0;
  }

  /** Level and waveform for the current chunk. Runs on every chunk. */
  private measure(samples: Float32Array): void {
    this.receiving = true;
    let sum = 0;
    let peak = 0;
    for (const sample of samples) {
      sum += sample * sample;
      const magnitude = Math.abs(sample);
      if (magnitude > peak) peak = magnitude;
    }
    this.rms = samples.length ? Math.sqrt(sum / samples.length) : 0;
    this.peak = peak;
    // Decay the hold slowly so a transient stays visible without sticking.
    this.peakHold = Math.max(peak, this.peakHold * 0.97);
    this.waveform[this.waveformAt] = peak;
    this.waveformAt = (this.waveformAt + 1) % WAVEFORM_POINTS;
  }

  onFrame(listener: (frame: AnalysisFrame, result: RollingResult) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private ingest(chunk: AudioChunk): void {
    if (this.sampleRate !== chunk.sampleRate || !this.ring) {
      this.sampleRate = chunk.sampleRate;
      // Each analysis window remains bounded, while the rolling vote now keeps
      // up to 60 seconds of two-second observations. This gives long captures
      // more evidence without repeatedly FFTing an ever-growing raw buffer.
      this.ring = new SampleRing(Math.ceil(chunk.sampleRate * 16));
      this.samplesSinceFrame = 0;
    }
    this.measure(chunk.samples);
    this.totalSamples += chunk.samples.length;
    this.ring.push(chunk.samples);
    this.samplesSinceFrame += chunk.samples.length;
    const minimum = chunk.sampleRate * MINIMUM_SECONDS;
    const interval = chunk.sampleRate * 2;
    if (this.ring.length < minimum || this.samplesSinceFrame < interval) return;
    this.samplesSinceFrame = 0;

    this.scheduleAnalysis(this.ring.snapshot(), chunk.sampleRate, chunk.at);
  }

  private emitDetection(detection: Detection, at: number): void {
    const frame: AnalysisFrame = {
      at,
      ...detection,
      camelot: detection.key ? musicalKeyToCamelot(detection.key) ?? undefined : undefined,
    };
    this.lastDiagnostics = detection.keyDiagnostics;
    this.frames.push(frame);
    this.current = aggregateFrames(this.frames);
    for (const listener of this.listeners) listener(frame, this.current);
  }

  private scheduleAnalysis(samples: Float32Array, sampleRate: number, at: number): void {
    if (this.analysisPending) return;
    const generation = this.generation;

    // Unit tests and older browsers use the synchronous fallback. Production
    // browsers process FFT/autocorrelation work off the UI thread.
    if (typeof Worker === 'undefined') {
      this.emitDetection(analysePcm(samples, sampleRate, this.profile), at);
      return;
    }

    if (!this.worker) {
      this.worker = new Worker(new URL('./analysis-worker.ts', import.meta.url), { type: 'module' });
      this.worker.onmessage = (event: MessageEvent<{ detection: Detection; at: number; generation: number }>) => {
        this.analysisPending = false;
        if (event.data.generation !== this.generation) return;
        this.emitDetection(event.data.detection, event.data.at);
      };
      this.worker.onerror = () => {
        this.analysisPending = false;
        this.worker?.terminate();
        this.worker = undefined;
      };
    }
    this.analysisPending = true;
    this.worker.postMessage(
      { samples: samples.buffer, sampleRate, profile: this.profile, at, generation },
      [samples.buffer],
    );
  }
}

export function createAudioSource(kind: AudioSourceKind = 'microphone', deviceId?: string): AudioSource {
  if (kind !== 'microphone') {
    throw new MicrophoneAnalysisError(`${kind} audio sources are not available in this build.`);
  }
  return new MicrophoneAudioSource(deviceId);
}

export function createAnalyser(profile: AnalysisProfile = 'general'): Analyser {
  return new RollingAudioAnalyser(profile);
}
