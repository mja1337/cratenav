import { analysePcm, type AnalysisProfile } from './audio';

interface AnalysisRequest {
  samples: ArrayBuffer;
  sampleRate: number;
  profile: AnalysisProfile;
  at: number;
  generation: number;
}

const workerScope = globalThis as unknown as {
  onmessage: ((event: MessageEvent<AnalysisRequest>) => void) | null;
  postMessage(message: unknown): void;
};

workerScope.onmessage = (event) => {
  const { samples, sampleRate, profile, at, generation } = event.data;
  const detection = analysePcm(new Float32Array(samples), sampleRate, profile);
  workerScope.postMessage({ detection, at, generation });
};
