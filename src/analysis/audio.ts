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
  key?: MusicalKey;
  camelot?: CamelotKey;
  keyConfidence?: number;
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

export interface Analyser {
  readonly running: boolean;
  attach(source: AudioSource): Promise<void>;
  detach(): Promise<void>;
  result(): RollingResult;
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

export interface Detection {
  bpm?: number;
  bpmConfidence?: number;
  key?: MusicalKey;
  keyConfidence?: number;
}

const PITCH_CLASSES: readonly PitchClass[] = [
  'C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B',
];

const MAJOR_PROFILE = [
  6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88,
];
const MINOR_PROFILE = [
  6.33, 2.68, 3.52, 5.38, 2.6, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17,
];

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

/** Detect tempo from an onset-strength envelope. Exported for deterministic tests. */
export function detectBpm(samples: Float32Array, sampleRate: number): Pick<Detection, 'bpm' | 'bpmConfidence'> {
  const frameSize = 1024;
  const hop = 256;
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

  const envelopeMean = mean(envelope);
  if (envelopeMean < 1e-5) return {};
  for (let i = 0; i < envelope.length; i += 1) {
    envelope[i] = Math.max(0, envelope[i]! - envelopeMean * 0.35);
  }

  const envelopeRate = sampleRate / hop;
  const minBpm = 60;
  const maxBpm = 210;
  const minLag = Math.floor((60 * envelopeRate) / maxBpm);
  const maxLag = Math.ceil((60 * envelopeRate) / minBpm);
  const scores: { lag: number; score: number }[] = [];

  for (let lag = minLag; lag <= maxLag; lag += 1) {
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

  const ranked = [...scores].sort((a, b) => b.score - a.score || a.lag - b.lag);
  const strongest = ranked[0];
  if (!strongest || strongest.score < 0.08) return {};

  // Autocorrelation often makes the two-beat lag slightly stronger because it
  // has less timing jitter. Prefer its half-lag only when that faster pulse is
  // itself a strong peak; a genuinely slow record will not have one there.
  let nearPeak = strongest;
  const doubleTempo = scores.reduce<typeof strongest | undefined>((closest, candidate) =>
    Math.abs(candidate.lag - strongest.lag / 2) < Math.abs((closest?.lag ?? Infinity) - strongest.lag / 2)
      ? candidate
      : closest, undefined);
  if (doubleTempo && doubleTempo.score >= strongest.score * 0.78) nearPeak = doubleTempo;

  // Parabolic interpolation gives sub-envelope-frame precision (important at
  // fast tempos, where one integer lag can otherwise be several BPM).
  const before = scores.find((candidate) => candidate.lag === nearPeak.lag - 1)?.score;
  const after = scores.find((candidate) => candidate.lag === nearPeak.lag + 1)?.score;
  let refinedLag = nearPeak.lag;
  if (before !== undefined && after !== undefined) {
    const denominator = before - 2 * nearPeak.score + after;
    if (Math.abs(denominator) > 1e-9) {
      refinedLag += Math.max(-0.5, Math.min(0.5, 0.5 * (before - after) / denominator));
    }
  }
  const bpm = (60 * envelopeRate) / refinedLag;
  const unrelatedRunnerUp = ranked.find((candidate) => {
    const ratio = Math.max(candidate.lag, nearPeak.lag) / Math.min(candidate.lag, nearPeak.lag);
    return Math.abs(candidate.lag - nearPeak.lag) > 2 && Math.abs(ratio - 2) > 0.08;
  });
  const margin = nearPeak.score - (unrelatedRunnerUp?.score ?? 0);
  const confidence = clamp01(nearPeak.score * 0.72 + Math.max(0, margin) * 0.9 + 0.1);
  return { bpm: Math.round(bpm * 10) / 10, bpmConfidence: confidence };
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

/** Detect musical key with FFT chroma and major/minor key-profile correlation. */
export function detectKey(samples: Float32Array, sampleRate: number): Pick<Detection, 'key' | 'keyConfidence'> {
  const fftSize = 4096;
  // Sampling every other FFT window keeps rolling analysis responsive on
  // phones while still producing dozens of chroma observations per pass.
  const hop = 8192;
  if (samples.length < fftSize * 2) return {};
  const chroma = Array<number>(12).fill(0);
  let windows = 0;

  for (let offset = 0; offset + fftSize <= samples.length; offset += hop) {
    const real = new Float64Array(fftSize);
    const imag = new Float64Array(fftSize);
    let energy = 0;
    for (let i = 0; i < fftSize; i += 1) {
      const value = samples[offset + i]!;
      energy += value * value;
      real[i] = value * (0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (fftSize - 1)));
    }
    if (energy / fftSize < 1e-7) continue;
    fft(real, imag);
    windows += 1;

    const firstBin = Math.max(1, Math.ceil((55 * fftSize) / sampleRate));
    const lastBin = Math.min(fftSize / 2, Math.floor((4200 * fftSize) / sampleRate));
    for (let bin = firstBin; bin <= lastBin; bin += 1) {
      const frequency = (bin * sampleRate) / fftSize;
      const midi = 69 + 12 * Math.log2(frequency / 440);
      const pitchClass = ((Math.round(midi) % 12) + 12) % 12;
      const magnitude = Math.hypot(real[bin]!, imag[bin]!);
      // Square-root compression stops one loud fundamental overwhelming the
      // chord while a gentle high-frequency roll-off reduces cymbal influence.
      chroma[pitchClass] = chroma[pitchClass]!
        + Math.sqrt(magnitude) / Math.sqrt(Math.max(1, frequency / 220));
    }
  }

  if (!windows || chroma.every((value) => value === 0)) return {};
  const candidates: { tonic: number; tonality: Tonality; score: number }[] = [];
  for (let tonic = 0; tonic < 12; tonic += 1) {
    candidates.push({ tonic, tonality: 'major', score: correlation(chroma, rotatedProfile(MAJOR_PROFILE, tonic)) });
    candidates.push({ tonic, tonality: 'minor', score: correlation(chroma, rotatedProfile(MINOR_PROFILE, tonic)) });
  }
  candidates.sort((a, b) => b.score - a.score);
  const best = candidates[0];
  const second = candidates[1];
  if (!best || best.score < 0.12) return {};
  const margin = best.score - (second?.score ?? 0);
  const confidence = clamp01(0.18 + Math.max(0, best.score) * 0.58 + Math.max(0, margin) * 1.5);
  return {
    key: { pitchClass: PITCH_CLASSES[best.tonic]!, tonality: best.tonality },
    keyConfidence: confidence,
  };
}

export function analysePcm(samples: Float32Array, sampleRate: number): Detection {
  return { ...detectBpm(samples, sampleRate), ...detectKey(samples, sampleRate) };
}

function sameKey(left: MusicalKey, right: MusicalKey): boolean {
  return left.pitchClass === right.pitchClass && left.tonality === right.tonality;
}

/** Pure rolling aggregation, exported so stability policy is testable. */
export function aggregateFrames(allFrames: readonly AnalysisFrame[], limit = 8): RollingResult {
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

  const keyFrames = frames.filter((frame) => frame.key !== undefined);
  const keyGroups: { key: MusicalKey; frames: AnalysisFrame[] }[] = [];
  for (const frame of keyFrames) {
    const group = keyGroups.find((entry) => sameKey(entry.key, frame.key!));
    if (group) group.frames.push(frame);
    else keyGroups.push({ key: frame.key!, frames: [frame] });
  }
  keyGroups.sort((a, b) => b.frames.length - a.frames.length);
  const winningKey = keyGroups[0];
  const key = winningKey?.key;
  const keyAgreement = keyFrames.length ? (winningKey?.frames.length ?? 0) / keyFrames.length : 0;
  const keyConfidence = winningKey
    ? clamp01(mean(winningKey.frames.map((frame) => frame.keyConfidence ?? 0)) * 0.7 + keyAgreement * 0.3)
    : undefined;
  const keyStable = keyFrames.length >= 4 && keyAgreement >= 0.75;
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
  }

  result(): RollingResult {
    return this.current;
  }

  reset(): void {
    this.frames = [];
    this.ring?.clear();
    this.samplesSinceFrame = 0;
    this.current = aggregateFrames([]);
  }

  onFrame(listener: (frame: AnalysisFrame, result: RollingResult) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private ingest(chunk: AudioChunk): void {
    if (this.sampleRate !== chunk.sampleRate || !this.ring) {
      this.sampleRate = chunk.sampleRate;
      // Stability comes from the series of overlapping results. Keeping only
      // the most recent 16 seconds also prevents each two-second pass getting
      // progressively more expensive during a long listening session.
      this.ring = new SampleRing(Math.ceil(chunk.sampleRate * 16));
      this.samplesSinceFrame = 0;
    }
    this.ring.push(chunk.samples);
    this.samplesSinceFrame += chunk.samples.length;
    const minimum = chunk.sampleRate * 6;
    const interval = chunk.sampleRate * 2;
    if (this.ring.length < minimum || this.samplesSinceFrame < interval) return;
    this.samplesSinceFrame = 0;

    const detection = analysePcm(this.ring.snapshot(), chunk.sampleRate);
    const frame: AnalysisFrame = {
      at: chunk.at,
      ...detection,
      camelot: detection.key ? musicalKeyToCamelot(detection.key) ?? undefined : undefined,
    };
    this.frames.push(frame);
    this.current = aggregateFrames(this.frames);
    for (const listener of this.listeners) listener(frame, this.current);
  }
}

export function createAudioSource(kind: AudioSourceKind = 'microphone'): AudioSource {
  if (kind !== 'microphone') {
    throw new MicrophoneAnalysisError(`${kind} audio sources are not available in this build.`);
  }
  return new MicrophoneAudioSource();
}

export function createAnalyser(): Analyser {
  return new RollingAudioAnalyser();
}
