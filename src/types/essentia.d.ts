declare module 'essentia.js/dist/essentia.js-core.es.js' {
  export default class Essentia {
    constructor(module: unknown, isDebug?: boolean);
    readonly version: string;
    arrayToVector(values: Float32Array): { delete?: () => void };
    KeyExtractor(
      audio: unknown,
      averageDetuningCorrection?: boolean,
      frameSize?: number,
      hopSize?: number,
      hpcpSize?: number,
      maxFrequency?: number,
      maximumSpectralPeaks?: number,
      minFrequency?: number,
      pcpThreshold?: number,
      profileType?: string,
      sampleRate?: number,
      spectralPeaksThreshold?: number,
      tuningFrequency?: number,
      weightType?: string,
      windowType?: string,
    ): { key?: string; scale?: string; strength?: number };
  }
}

declare module 'essentia.js/dist/essentia-wasm.es.js' {
  export const EssentiaWASM: unknown;
}
