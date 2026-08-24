import type { Store } from '@/app/store';
import type { Release, Track, TrackAnalysis } from '@/domain/types';
import {
  createAnalyser,
  createAudioSource,
  type Analyser,
  type RollingResult,
} from '@/analysis/audio';
import { normaliseBpm } from '@/bpm/normalise';
import { formatCamelot, formatMusicalKey } from '@/harmonic/camelot';
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
export function createLiveAudioAnalysis(
  store: Store,
  track: Track,
  release: Release | undefined,
  onChange: () => void,
): LiveAudioAnalysis {
  const analyser: Analyser = createAnalyser();
  let status: ListeningStatus = 'idle';
  let result: RollingResult = analyser.result();
  let message = '';
  let destroyed = false;

  const unsubscribe = analyser.onFrame((_frame, rolling) => {
    result = rolling;
    if (!destroyed) onChange();
  });

  const refresh = (): void => {
    if (!destroyed) onChange();
  };

  const start = async (): Promise<void> => {
    status = 'starting';
    message = '';
    analyser.reset();
    result = analyser.result();
    refresh();
    try {
      await analyser.attach(createAudioSource('microphone'));
      if (destroyed) {
        await analyser.detach();
        return;
      }
      status = 'listening';
    } catch (error) {
      status = 'error';
      message = error instanceof Error ? error.message : 'The microphone could not be started.';
    }
    refresh();
  };

  const stop = async (): Promise<void> => {
    await analyser.detach();
    if (destroyed) return;
    status = 'stopped';
    refresh();
  };

  const analyseLonger = (): void => {
    analyser.reset();
    result = analyser.result();
    message = '';
    refresh();
  };

  const accept = async (): Promise<void> => {
    if (!result.stable || (result.bpm === undefined && !result.key)) return;
    const patch: Partial<TrackAnalysis> = {
      analysisMethod: 'Microphone rolling analysis, accepted by user',
    };

    if (result.bpm !== undefined) {
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

    if (result.key) {
      Object.assign(patch, {
        sourceKey: formatMusicalKey(result.key),
        canonicalKey: result.key,
        camelotKey: result.camelot,
        nativeKey: result.key,
        nativeCamelot: result.camelot,
        nativeMode: result.key.tonality,
        keySource: 'local-analysis',
        keyConfidence: result.keyConfidence,
        verifiedKey: true,
      });
    }

    await analyser.detach();
    status = 'accepted';
    message = 'Saved as verified after your review.';
    await store.updateAnalysis(track.id, patch);
    refresh();
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

  const panel = (notation: 'camelot' | 'musical'): HTMLElement => {
    const active = status === 'starting' || status === 'listening';
    const hasFrames = result.frames.length > 0;
    const keyText = result.key
      ? notation === 'camelot' && result.camelot
        ? formatCamelot(result.camelot)
        : formatMusicalKey(result.key)
      : '—';
    const keySub = result.key && result.camelot
      ? notation === 'camelot'
        ? formatMusicalKey(result.key)
        : formatCamelot(result.camelot)
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

    return h(
      'section',
      { class: 'card stack live-analysis', 'aria-live': 'polite' },
      h(
        'div',
        { class: 'row row--wrap' },
        h('h2', { class: 'section-title', text: 'Listen & analyse', style: { flex: '1' } }),
        h('span', { class: 'chip', text: 'ON-DEVICE · LOCAL ONLY' }),
        h('span', {
          class: `state ${result.stable ? 'state--READY' : 'state--ANALYSE'}`,
          text: stateText,
        }),
      ),
      h('p', {
        class: 'field__hint',
        text: 'Set the turntable pitch to 0%, play a clear 20–60 second section, and keep other music out of the room. Audio is analysed here and is never recorded or uploaded.',
      }),
      active || hasFrames
        ? h(
            'div',
            { class: 'live-readouts' },
            readout(result.bpm === undefined ? '—' : result.bpm.toFixed(1), 'BPM', result.bpmBand, result.bpmConfidence),
            readout(keyText, keySub, result.keyBand, result.keyConfidence),
          )
        : null,
      status === 'listening' && !hasFrames
        ? h('p', {
            class: 'field__hint',
            text: 'Listening… the first estimate appears after about 6 seconds. Stability normally takes 12–20 seconds.',
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
        active && result.stable
          ? h('button', {
              class: 'button button--primary',
              type: 'button',
              text: 'Accept values',
              onclick: () => void accept(),
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

  return {
    panel,
    destroy: () => {
      destroyed = true;
      unsubscribe();
      void analyser.detach();
    },
  };
}
