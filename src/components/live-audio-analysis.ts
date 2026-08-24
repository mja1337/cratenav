import type { Store } from '@/app/store';
import type { AnalysisCandidate, Release, Track, TrackAnalysis } from '@/domain/types';
import {
  createAnalyser,
  createAudioSource,
  listAudioInputs,
  type Analyser,
  type AudioInputDevice,
  type RollingResult,
  type KeyDiagnostics,
  type AnalysisProfile,
} from '@/analysis/audio';
import { normaliseBpm } from '@/bpm/normalise';
import { formatCamelot, formatMusicalKey, musicalKeyToCamelot } from '@/harmonic/camelot';
import { sameTrackTitle } from '@/enrichment/matching';
import { h } from '@/utils/dom';

type ListeningStatus = 'idle' | 'starting' | 'listening' | 'stopped' | 'accepted' | 'error';

export interface LiveAudioAnalysis {
  panel(notation: 'camelot' | 'musical'): HTMLElement;
  destroy(): void;
}

/**
 * Per-track microphone session. It intentionally dies with the track view:
 * microphone permission is a focused user action, unlike background metadata
 * jobs, and capture should never continue after the user navigates away.
 */
const PITCH_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'] as const;

/** Plain-language account of why the key did or did not land. */
function keyReason(diagnostics: KeyDiagnostics): string {
  const candidate = diagnostics.candidate ? ` Closest match was ${diagnostics.candidate}.` : '';
  switch (diagnostics.rejectedBy) {
    case 'no-audio':
    case 'no-peaks':
      return 'No tonal content yet — only broadband noise is reaching the analyser.';
    case 'spread':
      return `Energy is spread evenly across all twelve notes, which carries no key.${candidate}`;
    case 'correlation':
      return `Tonal content detected but it fits no key well enough (${diagnostics.best.toFixed(2)} against ${diagnostics.thresholds.correlation}).${candidate} Try a section with clearer harmony, or less of the next record bleeding in.`;
    case 'margin':
      return `Two keys fit almost equally well, so committing would be a guess.${candidate}`;
    case 'mode':
      return `The tonic is plausible, but major and minor are still too close to call.${candidate} Keep playing a section that contains the third or fuller harmony.`;
    case 'section':
      return `Different tonal sections disagree, so the analyser is waiting for a repeatable key.${candidate}`;
    default:
      return `Key locked on chroma evidence.${candidate}`;
  }
}

function chromaLabel(diagnostics: KeyDiagnostics): string {
  const strongest = diagnostics.chroma
    .map((value, index) => ({ name: PITCH_NAMES[index]!, value }))
    .sort((a, b) => b.value - a.value)
    .slice(0, 3)
    .map((entry) => entry.name)
    .join(', ');
  return `Chroma: strongest notes ${strongest}`;
}

export function createLiveAudioAnalysis(
  store: Store,
  track: Track,
  release: Release | undefined,
  onChange: () => void,
): LiveAudioAnalysis {
  const releaseTerms = [...(release?.genres ?? []), ...(release?.styles ?? [])]
    .join(' ')
    .toLowerCase();
  const profile: AnalysisProfile = /drum\s*(?:and|&)\s*bass|drum\s*n\s*bass|dnb|jungle/.test(releaseTerms)
    ? 'drum-and-bass'
    : 'general';
  const analyser: Analyser = createAnalyser(profile);
  let status: ListeningStatus = 'idle';
  let result: RollingResult = analyser.result();
  let message = '';
  let saving = false;
  let destroyed = false;
  let inputs: AudioInputDevice[] = [];
  let selectedInputId = '';
  let inputError = '';
  let showDiagnostics = false;
  let liveMeterRoot: HTMLElement | undefined;
  let panelRoot: HTMLElement | undefined;
  let currentNotation: 'camelot' | 'musical' = store.snapshot.settings.keyNotation;

  const refreshInputs = async (): Promise<void> => {
    try {
      inputs = await listAudioInputs();
      if (selectedInputId && !inputs.some((input) => input.id === selectedInputId)) selectedInputId = '';
      inputError = '';
    } catch {
      inputError = 'Audio input devices could not be listed. Your browser can still use its default input.';
    }
    refresh();
  };
  void refreshInputs();

  const unsubscribe = analyser.onFrame((_frame, rolling) => {
    result = rolling;
    refresh();
  });

  // Detection frames land only every two seconds, so the meter needs its own
  // tick to look alive. Without it a working microphone looks identical to a
  // dead one for seconds at a time.
  let meterTimer: number | undefined;
  const updateLiveMeter = (): void => {
    if (!liveMeterRoot?.isConnected) return;
    const input = analyser.input();
    const scaled = (value: number) => Math.min(1, Math.sqrt(Math.max(0, value)));
    const level = scaled(input.rms);
    const hold = scaled(input.peakHold);
    const clipping = input.peak >= 0.99;
    const tooQuiet = input.receiving && input.rms < 0.004;
    const meter = liveMeterRoot.querySelector<HTMLElement>('.signal-meter');
    const fill = liveMeterRoot.querySelector<HTMLElement>('[data-meter-fill]');
    const holdNode = liveMeterRoot.querySelector<HTMLElement>('[data-meter-hold]');
    if (meter) meter.setAttribute('aria-label', `Input level ${Math.round(level * 100)}%`);
    if (fill) {
      fill.style.width = `${Math.round(level * 100)}%`;
      fill.className = `signal-meter__fill${clipping ? ' signal-meter__fill--clip' : ''}${tooQuiet ? ' signal-meter__fill--low' : ''}`;
    }
    if (holdNode) holdNode.style.left = `${Math.round(hold * 100)}%`;
    const bars = liveMeterRoot.querySelectorAll<HTMLElement>('.signal-wave__bar');
    input.waveform.forEach((value, index) => {
      const bar = bars[index];
      if (bar) bar.style.height = `${Math.max(2, scaled(value) * 100)}%`;
    });
    const levelNode = liveMeterRoot.querySelector<HTMLElement>('[data-meter-level]');
    const peakNode = liveMeterRoot.querySelector<HTMLElement>('[data-meter-peak]');
    const capturedNode = liveMeterRoot.querySelector<HTMLElement>('[data-meter-captured]');
    if (levelNode) levelNode.textContent = `level ${(input.rms * 100).toFixed(1)}%`;
    if (peakNode) peakNode.textContent = `peak ${(input.peak * 100).toFixed(0)}%`;
    if (capturedNode) capturedNode.textContent = `captured ${input.secondsCaptured.toFixed(1)}s`;
    const captionNode = liveMeterRoot.querySelector<HTMLElement>('[data-meter-caption]');
    if (captionNode) {
      captionNode.className = tooQuiet || !input.receiving || clipping ? 'notice notice--warning' : 'field__hint';
      captionNode.textContent = !input.receiving
        ? 'No audio is reaching cratenav yet. Check the input device and that the tab is not muted.'
        : clipping
          ? 'Input is clipping. Lower the source/interface level.'
          : tooQuiet
            ? 'Signal is very quiet — raise the interface or source level.'
            : input.secondsUntilFirstReading > 0
              ? `Good signal. First reading in about ${Math.ceil(input.secondsUntilFirstReading)}s.`
              : 'Good signal. Analysing.';
    }
  };
  const startMeter = () => {
    if (meterTimer !== undefined) return;
    meterTimer = window.setInterval(updateLiveMeter, 120);
  };
  const stopMeter = () => {
    if (meterTimer === undefined) return;
    window.clearInterval(meterTimer);
    meterTimer = undefined;
  };

  const refresh = (): void => {
    if (destroyed) return;
    if (!panelRoot) {
      onChange();
      return;
    }
    const next = buildPanel(currentNotation);
    if (panelRoot.isConnected) panelRoot.replaceWith(next);
    panelRoot = next;
  };

  const start = async (): Promise<void> => {
    status = 'starting';
    message = '';
    analyser.reset();
    result = analyser.result();
    refresh();
    try {
      await analyser.attach(createAudioSource('microphone', selectedInputId || undefined));
      if (destroyed) {
        await analyser.detach();
        return;
      }
      status = 'listening';
      startMeter();
      // Device names are normally hidden until the permission grant above.
      void refreshInputs();
    } catch (error) {
      stopMeter();
      status = 'error';
      message = error instanceof Error ? error.message : 'The microphone could not be started.';
    }
    refresh();
  };

  const stop = async (): Promise<void> => {
    await analyser.detach();
    if (destroyed) return;
    stopMeter();
    status = 'stopped';
    refresh();
  };

  const analyseLonger = (): void => {
    analyser.reset();
    result = analyser.result();
    message = '';
    refresh();
  };

  const accept = async (
    dimensions: 'bpm' | 'key' | 'both' = 'both',
    stopAfterSave = dimensions === 'both',
  ): Promise<void> => {
    const includeBpm = dimensions !== 'key' && result.bpm !== undefined && result.bpmBand !== 'UNSTABLE';
    const includeKey = dimensions !== 'bpm' && result.key !== undefined && result.keyBand !== 'UNSTABLE';
    if (!includeBpm && !includeKey) return;
    const patch: Partial<TrackAnalysis> = {
      analysisMethod: `Recorded ${includeBpm && includeKey ? 'BPM and key' : includeBpm ? 'BPM' : 'key'} set by user`,
    };

    const currentAnalysis = store.analysisFor(track.id);
    const referenceCandidates = (currentAnalysis?.candidates ?? []).filter((candidate) =>
      candidate.reviewStatus !== 'rejected' &&
      sameTrackTitle(candidate.matchedTitle, track.title) &&
      (candidate.reviewStatus === 'approved' || (candidate.matchScore ?? 0) >= 0.55),
    );
    const sourceBpms = referenceCandidates
      .map((candidate) => candidate.canonicalBpm)
      .filter((value): value is number => value !== undefined)
      .map((value) => profile === 'drum-and-bass' && value < 110 ? value * 2 : value)
      .sort((a, b) => a - b);
    const sourceBpm = sourceBpms.length ? sourceBpms[Math.floor(sourceBpms.length / 2)] : undefined;
    const keyCounts = new Map<string, {
      key: NonNullable<AnalysisCandidate['canonicalKey']>;
      count: number;
      approved: number;
    }>();
    for (const candidate of referenceCandidates) {
      if (!candidate.canonicalKey) continue;
      const label = formatMusicalKey(candidate.canonicalKey);
      const current = keyCounts.get(label);
      keyCounts.set(label, {
        key: candidate.canonicalKey,
        count: (current?.count ?? 0) + 1,
        approved: (current?.approved ?? 0) + (candidate.reviewStatus === 'approved' ? 1 : 0),
      });
    }
    const sourceKeyGroup = [...keyCounts.values()].sort((a, b) => b.approved - a.approved || b.count - a.count)[0];
    const sourceKey = sourceKeyGroup?.key;
    const latestDiagnostics = result.frames[result.frames.length - 1]?.keyDiagnostics;
    const resolvedKey = result.key;
    const resolvedCamelot = resolvedKey ? musicalKeyToCamelot(resolvedKey) ?? undefined : undefined;
    patch.localAnalysisEvidence = {
      profile,
      capturedSeconds: analyser.input().secondsCaptured,
      frameCount: result.frames.length,
      rhythmicFrames: result.frames.filter((frame) => frame.bpm !== undefined).length,
      tonalWindows: latestDiagnostics?.windows?.accepted ?? result.frames.filter((frame) => frame.key !== undefined).length,
      localBpm: result.bpm,
      localKey: result.key,
      sourceBpm,
      sourceKey,
      bpmAgreed: sourceBpm === undefined || result.bpm === undefined
        ? undefined
        : Math.abs(sourceBpm - result.bpm) <= Math.max(0.8, sourceBpm * 0.008),
      keyAgreed: sourceKey === undefined || result.key === undefined
        ? undefined
        : formatMusicalKey(sourceKey) === formatMusicalKey(result.key),
      acceptedAt: new Date().toISOString(),
    };

    if (includeBpm && result.bpm !== undefined) {
      const normalised = normaliseBpm({
        bpm: result.bpm,
        genres: release?.genres,
        styles: release?.styles,
        overrides: store.snapshot.settings.bpmPreferences,
      });
      Object.assign(patch, {
        sourceBpm: result.bpm,
        canonicalBpm: normalised.canonicalBpm,
        nativeBpm: normalised.canonicalBpm,
        bpmSource: 'local-analysis',
        bpmConfidence: result.bpmConfidence,
        verifiedBpm: true,
        normalisationReason: normalised.reason,
      });
    }

    if (includeKey && resolvedKey) {
      Object.assign(patch, {
        sourceKey: formatMusicalKey(resolvedKey),
        canonicalKey: resolvedKey,
        camelotKey: resolvedCamelot,
        nativeKey: resolvedKey,
        nativeCamelot: resolvedCamelot,
        nativeMode: resolvedKey.tonality,
        keySource: 'local-analysis',
        keyConfidence: result.keyConfidence,
        verifiedKey: true,
      });
    }

    saving = true;
    message = '';
    refresh();
    try {
      if (stopAfterSave) await analyser.detach();
      await store.updateAnalysis(track.id, patch);
      if (stopAfterSave) {
        stopMeter();
        status = 'accepted';
      }
      message = `${includeBpm && includeKey ? 'Recorded BPM and key' : includeBpm ? 'Recorded BPM' : 'Recorded key'} saved to this track.`;
    } catch (error) {
      status = 'error';
      message = error instanceof Error ? error.message : 'The analysis could not be saved.';
    } finally {
      saving = false;
      refresh();
    }
  };

  const correctManually = (): void => {
    const target = document.querySelector<HTMLElement>('#track-bpm-controls input');
    document.getElementById('track-bpm-controls')?.scrollIntoView({
      behavior: 'smooth',
      block: 'center',
    });
    target?.focus({ preventScroll: true });
  };

  const readout = (
    value: string,
    label: string,
    band: string,
    confidence: number | undefined,
  ): HTMLElement =>
    h(
      'div',
      { class: 'live-readout' },
      h('div', { class: 'live-readout__value', text: value }),
      h('div', { class: 'live-readout__label', text: label }),
      h('div', {
        class: 'live-readout__confidence',
        text: confidence === undefined
          ? 'waiting for signal'
          : `${band.toLowerCase()} · ${Math.round(confidence * 100)}%`,
      }),
    );

  /** Source consensus is comparison evidence; it never changes the local vote. */
  const sourceComparison = (): HTMLElement | null => {
    const analysis = store.analysisFor(track.id);
    // Same identity rule as track detail's candidate list, so a source cannot
    // appear in one place and be invisible in the other.
    const candidates = (analysis?.candidates ?? []).filter((candidate) =>
      candidate.reviewStatus !== 'rejected' &&
      sameTrackTitle(candidate.matchedTitle, track.title) &&
      (candidate.reviewStatus === 'approved' || (candidate.matchScore ?? 0) >= 0.55),
    );
    const savedKey = analysis?.canonicalKey ? formatMusicalKey(analysis.canonicalKey) : undefined;
    if (!candidates.length && analysis?.canonicalBpm === undefined && !savedKey && !result.frames.length) return null;

    const bpmGroups = new Map<number, typeof candidates>();
    const keyGroups = new Map<string, typeof candidates>();
    for (const candidate of candidates) {
      if (candidate.canonicalBpm !== undefined) {
        const canonical = profile === 'drum-and-bass' && candidate.canonicalBpm < 110
          ? candidate.canonicalBpm * 2
          : candidate.canonicalBpm;
        const bucket = Math.round(canonical * 2) / 2;
        bpmGroups.set(bucket, [...(bpmGroups.get(bucket) ?? []), candidate]);
      }
      const key = candidate.canonicalKey;
      if (key) {
        const label = formatMusicalKey(key);
        keyGroups.set(label, [...(keyGroups.get(label) ?? []), candidate]);
      }
    }
    const bestGroup = <T,>(groups: Map<T, typeof candidates>): [T, typeof candidates] | undefined =>
      [...groups.entries()].sort((a, b) =>
        b[1].filter((candidate) => candidate.reviewStatus === 'approved').length -
          a[1].filter((candidate) => candidate.reviewStatus === 'approved').length ||
        b[1].length - a[1].length,
      )[0];
    const bpm = bestGroup(bpmGroups);
    const key = bestGroup(keyGroups);
    const sources = [...new Set([...(bpm?.[1] ?? []), ...(key?.[1] ?? [])]
      .map((candidate) => candidate.providerName ?? candidate.source))];
    const bpmAgreement = bpm && result.bpm !== undefined
      ? Math.abs(result.bpm - bpm[0]) <= Math.max(0.8, bpm[0] * 0.008)
      : undefined;
    const localKey = result.key && result.keyBand !== 'UNSTABLE'
      ? formatMusicalKey(result.key)
      : undefined;
    const keyAgreement = key && localKey ? localKey === key[0] : undefined;
    const savedBpmAgreement = analysis?.canonicalBpm !== undefined && result.bpm !== undefined
      ? Math.abs(result.bpm - analysis.canonicalBpm) <= Math.max(0.8, analysis.canonicalBpm * 0.008)
      : undefined;
    const savedKeyAgreement = savedKey && localKey ? savedKey === localKey : undefined;
    const latestKeyDiagnostics = result.frames[result.frames.length - 1]?.keyDiagnostics;
    const sourceKeyAlternative = key
      ? latestKeyDiagnostics?.candidates?.find((candidate) => candidate.name === key[0])
      : undefined;
    const bestKeyScore = latestKeyDiagnostics?.candidates?.[0]?.score ?? 0;
    const trustedKeyBaseline = Boolean(key && (
      key[1].length >= 2 || key[1].some((candidate) => candidate.reviewStatus === 'approved')
    ));
    const assistedKey = key && localKey && localKey !== key[0] && trustedKeyBaseline &&
      sourceKeyAlternative && bestKeyScore - sourceKeyAlternative.score <= 0.06
      ? key[0]
      : undefined;

    return h(
      'div',
      { class: 'source-comparison stack stack--tight' },
      h('h3', { class: 'section-title', text: 'Recorded comparison' }),
      h('div', { class: 'source-comparison__grid' },
        h('span', { text: 'Recorded' }),
        h('strong', { text: [result.bpm === undefined ? undefined : `${result.bpm.toFixed(1)} BPM`, localKey].filter(Boolean).join(' · ') || 'collecting…' }),
        h('span', { text: 'Saved track' }),
        h('strong', { text: [analysis?.canonicalBpm === undefined ? undefined : `${analysis.canonicalBpm.toFixed(1)} BPM`, savedKey].filter(Boolean).join(' · ') || 'nothing saved yet' }),
        h('span', { text: 'Matching database' }),
        h('strong', { text: [bpm ? `${bpm[0]} BPM` : undefined, key?.[0]].filter(Boolean).join(' · ') || 'no usable value' }),
        h('span', { text: 'Vs saved' }),
        h('strong', {
          text: [
            savedBpmAgreement === undefined ? undefined : savedBpmAgreement ? 'BPM matches' : 'BPM differs',
            savedKeyAgreement === undefined ? undefined : savedKeyAgreement ? 'key matches' : 'key differs',
          ].filter(Boolean).join(' · ') || 'no comparable saved value',
        }),
        h('span', { text: 'Vs database' }),
        h('strong', {
          text: [
            bpmAgreement === undefined ? undefined : bpmAgreement ? 'BPM matches' : 'BPM differs',
            keyAgreement === undefined ? undefined : keyAgreement ? 'key matches' : 'key differs',
          ].filter(Boolean).join(' · ') || 'waiting for local result',
        }),
        assistedKey ? h('span', { text: 'Close alternative' }) : null,
        assistedKey ? h('strong', { text: `${assistedKey} · trusted database sources support a close alternative; the Set button still saves the recorded result` }) : null,
      ),
      h('p', {
        class: 'field__hint',
        text: sources.length
          ? `Matching database baseline: ${sources.join(', ')}. It is compared independently and never replaces the recorded value.`
          : 'No matching database source is available for this track yet.',
      }),
    );
  };

  const detailedEvidence = (): HTMLElement | null => {
    const frame = result.frames[result.frames.length - 1];
    if (!frame) return null;
    const bpm = frame.bpmDiagnostics;
    const key = frame.keyDiagnostics;
    return h(
      'div',
      { class: 'analysis-evidence stack stack--tight' },
      h('h3', { class: 'section-title', text: 'Current correlations' }),
      bpm ? h(
        'div', { class: 'analysis-evidence__block' },
        h('strong', { text: `Tempo band agreement ${Math.round(bpm.agreement * 100)}%` }),
        h('div', { class: 'analysis-evidence__grid' },
          ...bpm.bands.map((band) => h('span', {
            text: `${band.band}: ${band.bpm === undefined ? '—' : `${band.bpm.toFixed(1)} BPM`} · ${band.confidence === undefined ? '—' : Math.round(band.confidence * 100)}%`,
          })),
        ),
        bpm.candidates.length ? h('p', {
          class: 'field__hint',
          text: `Tempo hypotheses: ${bpm.candidates.map((candidate) => `${candidate.bpm.toFixed(1)} (${candidate.bands.join('+')})`).join(' · ')}`,
        }) : null,
      ) : null,
      key ? h(
        'div', { class: 'analysis-evidence__block' },
        h('strong', { text: `Key profile correlation · spread ${key.spread.toFixed(2)} · tonic margin ${key.margin.toFixed(2)}${key.modeMargin === undefined ? '' : ` · mode margin ${key.modeMargin.toFixed(2)}`}${key.windows ? ` · tonal windows ${key.windows.accepted}/${key.windows.accepted + key.windows.rejected}` : ''}${key.peakCounts ? ` · peaks kept ${key.peakCounts.accepted}, rejected ${key.peakCounts.rejected}, folded ${key.peakCounts.harmonicsFolded}` : ''}${key.transientPeaksAttenuated ? ` · percussive/transient peaks reduced ${key.transientPeaksAttenuated}` : ''}` }),
        h('div', { class: 'analysis-evidence__grid' },
          ...(key.candidates ?? []).map((candidate) => h('span', {
            text: `${candidate.name}: ${candidate.score.toFixed(3)}`,
          })),
        ),
        key.sectionVotes?.length ? h('p', {
          class: 'field__hint',
          text: `Tonal-section votes: ${key.sectionVotes.map((vote) => `${vote.key} ×${vote.windows}`).join(' · ')}${key.sectionAgreement === undefined ? '' : ` · leader ${Math.round(key.sectionAgreement * 100)}%`}`,
        }) : null,
        key.rangeEvidence ? h('p', {
          class: 'field__hint',
          text: `Register evidence: bass root ${key.rangeEvidence.bassRoot ?? '—'} · upper harmony ${key.rangeEvidence.upperKey ?? '—'}${key.rangeEvidence.agreed === undefined ? '' : key.rangeEvidence.agreed ? ' · agree' : ' · differ'}`,
        }) : null,
        key.separation ? h('p', {
          class: 'field__hint',
          text: `Harmonic/percussive split: ${Math.round(key.separation.harmonic * 100)}% / ${Math.round(key.separation.percussive * 100)}%`,
        }) : null,
        key.peaks?.length ? h(
          'details',
          { class: 'spectral-peaks' },
          h('summary', { text: `Strongest retained frequency peaks (${key.peaks.length})` }),
          h('div', { class: 'analysis-evidence__grid' },
            ...key.peaks.map((peak) => h('span', {
              text: `${peak.frequency.toFixed(1)} Hz · ${peak.note}${peak.harmonicOf ? ` · folded toward ${peak.harmonicOf}` : ''}`,
            })),
          ),
        ) : null,
      ) : null,
    );
  };

  const exportDiagnostics = (): void => {
    const analysis = store.analysisFor(track.id);
    const payload = {
      format: 'cratenav-audio-diagnostics-v1',
      exportedAt: new Date().toISOString(),
      track: { id: track.id, artist: track.artist, title: track.title, position: track.position },
      release: release ? { artist: release.artist, title: release.title, genres: release.genres, styles: release.styles } : undefined,
      profile,
      capture: {
        seconds: analyser.input().secondsCaptured,
        result,
      },
      sourceCandidates: (analysis?.candidates ?? []).map((candidate) => ({
        provider: candidate.providerName ?? candidate.source,
        matchedArtist: candidate.matchedArtist,
        matchedTitle: candidate.matchedTitle,
        bpm: candidate.canonicalBpm,
        key: candidate.canonicalKey,
        matchScore: candidate.matchScore,
        reviewStatus: candidate.reviewStatus,
        reviewComment: candidate.reviewComment,
      })),
    };
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `cratenav-analysis-${track.id}.json`;
    anchor.click();
    URL.revokeObjectURL(url);
  };

  /**
   * Input meter and waveform. Spec §34 wants the analysis workflow legible, and
   * without this a silent capture graph is indistinguishable from a detector
   * that is simply refusing to commit — which is the state that looks like a
   * hang. The bar shows level, the trace shows recent history, and the caption
   * says which of the two situations you are in.
   */
  const signalPanel = (): HTMLElement => {
    const input = analyser.input();
    // Log-ish scaling: quiet music is far more legible than on a linear meter.
    const scaled = (value: number) => Math.min(1, Math.sqrt(Math.max(0, value)));
    const level = scaled(input.rms);
    const hold = scaled(input.peakHold);
    const clipping = input.peak >= 0.99;

    // These bounds are what the detectors need, not arbitrary taste: the FFT
    // energy gate sits at an RMS of about 0.0003.
    const tooQuiet = input.receiving && input.rms < 0.004;

    const bars = h('div', { class: 'signal-wave', 'aria-hidden': 'true' });
    for (const value of input.waveform) {
      bars.append(
        h('span', {
          class: 'signal-wave__bar',
          style: { height: `${Math.max(2, scaled(value) * 100)}%` },
        }),
      );
    }

    // Chroma: which pitch classes the analyser is actually hearing. This is
    // the visualisation that distinguishes "no tonal content" from "tonal
    // content the guards will not commit to", which the level meter cannot.
    const diagnostics = input.keyDiagnostics;
    const chromaPanel = diagnostics
      ? h(
          'div',
          { class: 'stack stack--tight' },
          h(
            'div',
            { class: 'chroma', role: 'img', 'aria-label': chromaLabel(diagnostics) },
            ...diagnostics.chroma.map((value, index) =>
              h(
                'div',
                { class: 'chroma__slot' },
                h('div', {
                  class: `chroma__bar${diagnostics.candidate?.startsWith(PITCH_NAMES[index]!) ? ' chroma__bar--tonic' : ''}`,
                  style: { height: `${Math.max(2, value * 100)}%` },
                }),
                h('span', { class: 'chroma__name', text: PITCH_NAMES[index]! }),
              ),
            ),
          ),
          h('div', { class: 'signal-stats' },
            h('span', { text: `spread ${diagnostics.spread.toFixed(2)} / ${diagnostics.thresholds.spread}` }),
            h('span', { text: `match ${diagnostics.best.toFixed(2)} / ${diagnostics.thresholds.correlation}` }),
            h('span', { text: `tonic ${diagnostics.margin.toFixed(2)} / ${diagnostics.thresholds.margin}` }),
            h('span', { text: `mode ${(diagnostics.modeMargin ?? 0).toFixed(2)} / ${diagnostics.thresholds.modeMargin}` }),
          ),
          h('p', {
            class: diagnostics.rejectedBy ? 'notice notice--warning' : 'field__hint',
            text: keyReason(diagnostics),
          }),
        )
      : null;

    const caption = !input.receiving
      ? 'No audio is reaching cratenav yet. Check the input device and that the tab is not muted.'
      : clipping
        ? 'Input is clipping. Move the phone away from the speaker or lower the volume.'
        : tooQuiet
          ? 'Signal is very quiet — too quiet to analyse. Move closer to a speaker or raise the volume.'
          : input.secondsUntilFirstReading > 0
            ? `Good signal. First reading in about ${Math.ceil(input.secondsUntilFirstReading)}s.`
            : 'Good signal. Analysing.';

    liveMeterRoot = h(
      'div',
      { class: 'stack stack--tight live-signal' },
      h(
        'div',
        { class: 'signal-meter', role: 'img', 'aria-label': `Input level ${Math.round(level * 100)}%` },
        h('div', {
          'data-meter-fill': '',
          class: `signal-meter__fill${clipping ? ' signal-meter__fill--clip' : ''}${tooQuiet ? ' signal-meter__fill--low' : ''}`,
          style: { width: `${Math.round(level * 100)}%` },
        }),
        h('div', { 'data-meter-hold': '', class: 'signal-meter__hold', style: { left: `${Math.round(hold * 100)}%` } }),
      ),
      bars,
      chromaPanel,
      h(
        'div',
        { class: 'signal-stats' },
        h('span', { 'data-meter-level': '', text: `level ${(input.rms * 100).toFixed(1)}%` }),
        h('span', { 'data-meter-peak': '', text: `peak ${(input.peak * 100).toFixed(0)}%` }),
        h('span', { 'data-meter-captured': '', text: `captured ${input.secondsCaptured.toFixed(1)}s` }),
      ),
      h('p', {
        'data-meter-caption': '',
        class: tooQuiet || !input.receiving || clipping ? 'notice notice--warning' : 'field__hint',
        text: caption,
      }),
    );
    return liveMeterRoot;
  };

  const buildPanel = (notation: 'camelot' | 'musical'): HTMLElement => {
    const active = status === 'starting' || status === 'listening';
    const hasFrames = result.frames.length > 0;
    const keyLocked = result.keyBand !== 'UNSTABLE' && result.key !== undefined;
    const bpmLocked = result.bpmBand !== 'UNSTABLE' && result.bpm !== undefined;
    const keyText = keyLocked
      ? notation === 'camelot' && result.camelot
        ? formatCamelot(result.camelot)
        : formatMusicalKey(result.key!)
      : '—';
    const keySub = keyLocked && result.camelot
      ? notation === 'camelot'
        ? formatMusicalKey(result.key!)
        : formatCamelot(result.camelot)
      : result.key
        ? 'Key · collecting evidence'
        : 'Key';
    const stateText = status === 'starting'
      ? 'STARTING'
      : result.stable
        ? 'LOCKED'
        : hasFrames
          ? 'LISTENING · UNSTABLE'
          : status === 'listening'
            ? 'LISTENING'
            : status.toUpperCase();
    const completion = saving ? 100 : Math.min(100, Math.round((result.frames.length / 30) * 100));
    const visibleFrames = showDiagnostics ? result.frames : result.frames.slice(-8);
    const firstVisibleFrame = Math.max(1, result.frames.length - visibleFrames.length + 1);
    const hiddenFrames = result.frames.length - visibleFrames.length;
    const frameHistory = result.frames.length
      ? h(
          'div',
          { class: 'analysis-samples stack stack--tight' },
          h('h3', { class: 'section-title', text: `Captured samples (${result.frames.length})` }),
          h('p', {
            class: 'field__hint',
            text: hiddenFrames
              ? `Each row is one analysis window. The final result above is the rolling agreement across all ${result.frames.length}; the latest ${visibleFrames.length} are listed, and "Show all data points and correlations" lists the rest.`
              : 'Each row is one analysis window. The final result above is the rolling agreement across these samples.',
          }),
          h(
            'div',
            { class: 'analysis-samples__list' },
            ...visibleFrames.map((frame, index) =>
              h(
                'div',
                { class: 'analysis-sample' },
                h('span', { class: 'analysis-sample__number', text: `#${firstVisibleFrame + index}` }),
                h('span', { text: frame.bpm === undefined ? 'BPM —' : `${frame.bpm.toFixed(1)} BPM · ${Math.round((frame.bpmConfidence ?? 0) * 100)}%` }),
                h('span', { text: frame.key ? `${formatMusicalKey(frame.key)} · ${Math.round((frame.keyConfidence ?? 0) * 100)}%` : 'Key —' }),
              ),
            ),
          ),
        )
      : null;
    const inputPicker = h(
      'div',
      { class: 'field' },
      h('label', { for: 'analysis-audio-input', class: 'field__label', text: 'Audio input' }),
      h(
        'div',
        { class: 'row row--wrap' },
        h(
          'select',
          {
            id: 'analysis-audio-input', name: 'analysisAudioInput', class: 'select',
            disabled: active,
            onchange: (event: Event) => {
              selectedInputId = (event.target as HTMLSelectElement).value;
            },
          },
          h('option', { value: '', selected: !selectedInputId, text: 'System default input' }),
          ...inputs.map((input) => h('option', {
            value: input.id, text: input.label, selected: input.id === selectedInputId,
          })),
        ),
        !active ? h('button', {
          class: 'button button--small', type: 'button', text: 'Refresh inputs',
          onclick: () => void refreshInputs(),
        }) : null,
      ),
      h('p', {
        class: inputError ? 'notice notice--warning' : 'field__hint',
        text: inputError || (inputs.length
          ? 'Choose your USB line-in before starting. Device names appear after microphone permission is allowed.'
          : 'No named audio inputs yet. Allow microphone permission, then refresh this list.'),
      }),
    );

    return h(
      'section',
      { class: 'card stack live-analysis', 'aria-live': 'polite' },
      h(
        'div',
        { class: 'row row--wrap' },
        h('h2', { class: 'section-title', text: 'Listen & analyse', style: { flex: '1' } }),
        h(
          'div',
          {
            class: `completion-wheel${saving ? ' completion-wheel--saving' : ''}`,
            style: { background: `conic-gradient(var(--state-ready) ${completion * 3.6}deg, var(--bg-sunken) 0)` },
            role: 'progressbar',
            'aria-valuemin': '0',
            'aria-valuemax': '100',
            'aria-valuenow': String(completion),
            'aria-label': saving ? 'Saving analysis' : 'Analysis completion',
          },
          h('span', { text: saving ? 'save' : `${completion}%` }),
        ),
        h('span', { class: 'chip', text: 'ON-DEVICE · LOCAL ONLY' }),
        h('span', { class: 'chip', text: profile === 'drum-and-bass' ? 'D&B PROFILE' : 'GENERAL PROFILE' }),
        h('span', {
          class: `state ${result.stable ? 'state--READY' : 'state--ANALYSE'}`,
          text: stateText,
        }),
      ),
      h('p', {
        class: 'field__hint',
        text: 'Set the turntable pitch to 0%, play a clear 20–60 second section, and keep other music out of the room. Audio is analysed here and is never recorded or uploaded.',
      }),
      inputPicker,
      active ? signalPanel() : null,
      active || hasFrames
        ? h(
            'div',
            { class: 'live-readouts' },
            readout(result.bpm === undefined ? '—' : result.bpm.toFixed(1), 'BPM', result.bpmBand, result.bpmConfidence),
            readout(keyText, keySub, result.keyBand, result.keyConfidence),
          )
        : null,
      sourceComparison(),
      h('div', { class: 'row row--wrap' },
        h('button', {
          class: 'button button--small button--ghost',
          type: 'button',
          'aria-expanded': String(showDiagnostics),
          text: showDiagnostics ? 'Hide data points and correlations' : 'Show all data points and correlations',
          onclick: () => {
            showDiagnostics = !showDiagnostics;
            refresh();
          },
        }),
        hasFrames ? h('button', {
          class: 'button button--small button--ghost',
          type: 'button',
          text: 'Export analysis diagnostics',
          onclick: exportDiagnostics,
        }) : null,
      ),
      showDiagnostics ? detailedEvidence() : null,
      frameHistory,
      status === 'listening' && hasFrames && result.bpm === undefined && result.key === undefined
        ? h('p', {
            class: 'field__hint',
            text: 'Audio is being analysed but nothing is confident enough to report yet. cratenav would rather say nothing than show a wrong BPM or key — keep a clear section playing.',
          })
        : null,
      status === 'listening' && result.key && !keyLocked
        ? h('p', {
            class: 'field__hint',
            text: `Leading key candidate: ${formatMusicalKey(result.key)}. It stays in diagnostics until enough later windows agree, so the first few notes cannot become the saved key.`,
          })
        : null,
      result.octaveAmbiguity
        ? h('p', {
            class: 'notice notice--warning',
            text: 'Half/double-tempo ambiguity detected. Keep playing a section with a clear kick and snare pattern.',
          })
        : null,
      message ? h('p', {
        class: status === 'error' ? 'notice notice--error' : 'notice notice--success',
        text: message,
      }) : null,
      h(
        'div',
        { class: 'row row--wrap' },
        !active
          ? h('button', {
              class: 'button button--primary',
              type: 'button',
              text: hasFrames ? 'Analyse again' : 'Analyse with microphone',
              onclick: () => void start(),
            })
          : h('button', {
              class: 'button',
              type: 'button',
              text: status === 'starting' ? 'Starting…' : 'Stop listening',
              disabled: status === 'starting',
              onclick: () => void stop(),
            }),
        active && hasFrames
          ? h('button', {
              class: 'button button--small',
              type: 'button',
              text: 'Analyse longer',
              title: 'Discard the rolling vote and collect a fresh section',
              onclick: analyseLonger,
            })
          : null,
        bpmLocked
          ? h('button', {
              class: 'button button--small button--primary',
              type: 'button',
              text: saving ? 'Saving…' : `Set BPM ${result.bpm!.toFixed(1)}`,
              disabled: saving,
              onclick: () => void accept('bpm', false),
            })
          : null,
        keyLocked
          ? h('button', {
              class: 'button button--small button--primary',
              type: 'button',
              text: saving ? 'Saving…' : `Set key ${result.camelot ? formatCamelot(result.camelot) : formatMusicalKey(result.key!)}`,
              disabled: saving,
              onclick: () => void accept('key', false),
            })
          : null,
        bpmLocked && keyLocked
          ? h('button', {
              class: 'button button--small',
              type: 'button',
              text: saving ? 'Saving…' : 'Set both and finish',
              disabled: saving,
              onclick: () => void accept('both', true),
            })
          : null,
        h('button', {
          class: 'button button--ghost',
          type: 'button',
          text: 'Correct manually',
          onclick: correctManually,
        }),
      ),
    );
  };

  const panel = (notation: 'camelot' | 'musical'): HTMLElement => {
    currentNotation = notation;
    if (!panelRoot) panelRoot = buildPanel(notation);
    return panelRoot;
  };

  return {
    panel,
    destroy: () => {
      destroyed = true;
    stopMeter();
      unsubscribe();
      void analyser.detach();
    },
  };
}
