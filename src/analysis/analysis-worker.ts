import { analysePcm, type AnalysisProfile } from './audio';
import { analyseKeyWithEssentia, combineKeyEngines } from './essentia-key';

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

workerScope.onmessage = async (event) => {
  const { samples, sampleRate, profile, at, generation } = event.data;
  const pcm = new Float32Array(samples);
  const customStartedAt = performance.now();
  const customDetection = analysePcm(pcm, sampleRate, profile);
  const customElapsedMs = performance.now() - customStartedAt;
  const essentia = await analyseKeyWithEssentia(pcm, sampleRate);
  const detection = combineKeyEngines(customDetection, essentia, customElapsedMs);
  workerScope.postMessage({ detection, at, generation });
};
