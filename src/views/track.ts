import type {
  AnalysisCandidate,
  CamelotKey,
  PlayState,
  Track,
  TrackAnalysis,
} from '@/domain/types';
import type { Store } from '@/app/store';
import type { Router } from '@/app/router';
import type { View } from './types';
import { analysisState, chip, stateBadge } from '@/components/badges';
import { keyWheel } from '@/components/key-wheel';
import { formatBpm, formatDuration, formatKeyBoth } from '@/components/format';
import {
  allCamelotKeys,
  camelotToMusicalKey,
  formatCamelot,
  formatMusicalKey,
  musicalKeyToCamelot,
} from '@/harmonic/camelot';
import { doubleBpm, halveBpm, normaliseBpm, resolveBand } from '@/bpm/normalise';
import { recommend, type RecommendationScope } from '@/recommend/engine';
import { pitchSimulator } from '@/components/pitch-simulator';
import { asPlaybackTarget, nativeBpmOf, nativeKeyOf } from '@/pitch/native';
import { recommendationList } from '@/components/recommendations';
import { createLiveAudioAnalysis } from '@/components/live-audio-analysis';
import { onlineLookupPanel } from '@/components/online-lookup';
import { clear, h } from '@/utils/dom';

/**
 * Track detail. Spec §10, §11, §12, §13.
 *
 * This is where a track's BPM and key are established. Public enrichment can
 * propose unverified values; a DJ can inspect the retained source claim,
 * choose values, or enter their own. Verification always outranks automation
 * (spec §10), and everything is stored with provenance rather than as a bare
 * number.
 */
export function createTrackView(store: Store, router: Router, trackId: string): View {
  const track = store.getTrack(trackId);

  if (!track) {
    return {
      element: h(
        'div',
        { class: 'container empty' },
        h('h2', { text: 'Track not found' }),
        h('button', {
          class: 'button',
          type: 'button',
          text: 'Back to collection',
          onclick: () => router.navigate('library'),
        }),
      ),
    };
  }

  const release = store.getRelease(track.releaseId);
  const element = h('div', { class: 'container stack' });
  let scope: RecommendationScope = 'active-bag';
  let comparisonTrackId: string | undefined;
  let renderReady = false;
  const liveAnalysis = createLiveAudioAnalysis(store, track, release, () => {
    if (renderReady) render();
  });

  function render(): void {
    const analysis = store.analysisFor(track!.id);
    const notation = store.snapshot.settings.keyNotation;

    clear(element);
    element.append(
      header(track!, release?.title, release?.artist),
      megaPanels(analysis),
      onlineLookupPanel(store, {
        targets: () => {
          const entry = store.trackEntry(track!.id);
          return entry ? [entry] : [];
        },
        subject: 'this track',
      }),
      liveAnalysis.panel(notation),
      trackNotes(store, track!, analysis),
      playStateControls(store, track!),
      nextTrackBlock(store, router, track!, analysis, notation, scope, (next) => {
        scope = next;
        render();
      }, (next) => {
        comparisonTrackId = next;
        render();
      }, comparisonTrackId),
      bpmControls(store, track!, analysis),
      keyControls(store, track!, analysis, notation, render),
      simulatorBlock(store, analysis, notation),
      provenance(store, track!, analysis),
    );
  }

  const unsubscribe = store.subscribe(render);
  renderReady = true;
  render();

  return {
    element,
    destroy: () => {
      unsubscribe();
      liveAnalysis.destroy();
    },
  };
}

function trackNotes(store: Store, track: Track, analysis: TrackAnalysis | undefined): HTMLElement {
  const input = h('textarea', {
    id: 'track-notes', name: 'trackNotes', class: 'textarea', rows: '3',
    placeholder: 'Mix points, cue notes, crowd response…', value: analysis?.mixNotes ?? '',
  });
  const button = h('button', { class: 'button button--small button--primary', type: 'button', text: 'Save note' });
  button.onclick = async () => {
    button.setAttribute('disabled', '');
    button.textContent = 'Saving…';
    try {
      await store.updateAnalysis(track.id, {
        ...baseAnalysis(analysis, track.id),
        mixNotes: input.value.trim() || undefined,
      });
    } catch {
      button.removeAttribute('disabled');
      button.textContent = 'Try saving again';
    }
  };
  return h(
    'section', { class: 'card stack stack--tight' },
    h('h2', { class: 'section-title', text: 'Track note' }),
    h('label', { for: 'track-notes', class: 'field__label', text: 'Your note' }),
    input,
    h('div', { class: 'row' }, button),
  );
}

function header(track: Track, releaseTitle?: string, releaseArtist?: string): HTMLElement {
  return h(
    'div',
    { class: 'stack stack--tight' },
    h(
      'div',
      { class: 'row' },
      h('span', { class: 'track-row__position', style: { minWidth: '46px' }, text: track.position }),
      h(
        'div',
        { style: { minWidth: '0' } },
        h('h1', { style: { margin: '0', fontSize: '1.25rem', lineHeight: '1.25' }, text: track.title }),
        track.mixVersion
          ? h('p', {
              style: { margin: '2px 0 0', color: 'var(--text-muted)', fontSize: '0.9375rem' },
              text: track.mixVersion,
            })
          : null,
      ),
    ),
    h(
      'div',
      { class: 'row row--wrap' },
      chip(track.artist),
      releaseTitle && releaseTitle !== track.title
        ? chip(releaseTitle, { title: releaseArtist })
        : null,
      track.duration ? chip(formatDuration(track.duration) ?? '', { mono: true }) : null,
    ),
  );
}

/**
 * Play state within the active bag. Spec §22.
 *
 * Only meaningful while a bag is active and actually contains this track:
 * "played" is a property of tonight's session, not of the record.
 */
function playStateControls(store: Store, track: Track): HTMLElement {
  const bag = store.activeBag;
  if (!bag) return h('div', { hidden: true });

  const inBag = store.resolveBagTracks(bag).some((entry) => entry.track.id === track.id);
  if (!inBag) return h('div', { hidden: true });

  const currentState = store.playStateFor(bag.id, track.id);
  const options: [PlayState, string][] = [
    ['packed', 'Packed'],
    ['played', 'Played'],
    ['favourite', 'Favourite'],
    ['put-aside', 'Put aside'],
  ];

  return h(
    'div',
    { class: 'card stack stack--tight' },
    h(
      'div',
      { class: 'row' },
      h('h2', { class: 'section-title', text: 'Tonight', style: { flex: '1' } }),
      h('span', { class: 'chip', text: bag.name }),
    ),
    h(
      'div',
      { class: 'row row--wrap' },
      ...options.map(([state, label]) =>
        h('button', {
          class: 'chip',
          type: 'button',
          'aria-pressed': String(currentState === state),
          text: label,
          onclick: () => void store.setTrackPlayState(bag.id, track.id, state),
        }),
      ),
    ),
  );
}

/**
 * Next-track suggestions. Spec §17, §39.
 *
 * Defaults to the active bag, because a suggestion from a record sitting at
 * home is worse than no suggestion. The whole collection is available but must
 * be chosen explicitly.
 */
function nextTrackBlock(
  store: Store,
  router: Router,
  track: Track,
  analysis: TrackAnalysis | undefined,
  notation: 'camelot' | 'musical',
  scope: RecommendationScope,
  onScopeChange: (scope: RecommendationScope) => void,
  onCompare: (trackId: string) => void,
  comparisonTrackId?: string,
): HTMLElement {
  const hasAnything = analysis?.canonicalBpm !== undefined || analysis?.camelotKey !== undefined;
  if (!hasAnything) {
    return h(
      'div',
      { class: 'card stack stack--tight' },
      h('h2', { class: 'section-title', text: 'What mixes next' }),
      h('p', {
        class: 'field__hint',
        text: 'Set a BPM or key above and compatible tracks appear here.',
      }),
    );
  }

  const bag = store.activeBag;
  const effectiveScope: RecommendationScope = scope === 'active-bag' && !bag ? 'collection' : scope;
  const candidates =
    effectiveScope === 'active-bag' && bag ? store.resolveBagTracks(bag) : store.allTrackEntries();

  // Planning a transition, so playback compatibility is the right model:
  // work out the pitch each candidate needs and judge the key it lands in.
  // Spec v1.1 §9.
  const target = asPlaybackTarget(analysis);
  const results = recommend(
    {
      bpm: target.bpm,
      camelot: analysis?.camelotKey,
      keyConfidence: analysis?.keyConfidence,
      effectivePitchClass: target.effectivePitchClass,
      tonality: target.tonality,
    },
    candidates,
    {
      excludeTrackIds: [track.id],
      limit: 8,
      scope: effectiveScope,
      mode: 'playback',
      tolerance: store.pitchTolerance,
    },
  );
  const comparison = results.find((result) => result.entry.track.id === comparisonTrackId) ?? results[0];
  const comparisonKey = comparison?.pitch?.effectiveCamelot ?? comparison?.entry.analysis?.camelotKey;

  const scopeButton = (value: RecommendationScope, label: string, disabled = false) =>
    h('button', {
      class: 'chip',
      type: 'button',
      disabled,
      'aria-pressed': String(effectiveScope === value),
      text: label,
      onclick: () => onScopeChange(value),
    });

  return h(
    'div',
    { class: 'card stack stack--tight' },
    h(
      'div',
      { class: 'row row--wrap' },
      h('h2', { class: 'section-title', text: 'What mixes next', style: { flex: '1' } }),
      scopeButton('active-bag', bag ? `Bag: ${bag.name}` : 'No active bag', !bag),
      scopeButton('collection', 'Whole collection'),
    ),
    comparison && analysis?.camelotKey && comparisonKey
      ? h(
          'div',
          { class: 'mix-wheel stack stack--tight' },
          h('h3', { class: 'section-title', text: 'Harmonic comparison' }),
          keyWheel({
            selected: analysis.camelotKey,
            comparison: comparisonKey,
            notation,
            size: 230,
            centreLabel: `${formatCamelot(analysis.camelotKey)} → ${formatCamelot(comparisonKey)}`,
          }),
          h('div', { class: 'mix-wheel__legend' },
            h('span', { class: 'mix-wheel__current', text: `Current: ${formatCamelot(analysis.camelotKey)}` }),
            h('span', { class: 'mix-wheel__next', text: `Next: ${comparison.entry.track.title} · ${formatCamelot(comparisonKey)}` }),
          ),
        )
      : null,
    recommendationList(results, notation, (recommendation) =>
      router.navigate(`track/${recommendation.entry.track.id}`),
    (recommendation) => onCompare(recommendation.entry.track.id), comparison?.entry.track.id,
    ),
    effectiveScope === 'collection'
      ? h('p', {
          class: 'field__hint',
          text: 'Searching your whole collection, including records you have not packed.',
        })
      : null,
  );
}

function megaPanels(analysis: TrackAnalysis | undefined): HTMLElement {
  const bpm = formatBpm(analysis);
  const keyText = analysis?.camelotKey ? formatCamelot(analysis.camelotKey) : null;
  const keySub = analysis?.canonicalKey ? formatMusicalKey(analysis.canonicalKey) : null;

  const panel = (
    value: string | null,
    label: string,
    note: string | null,
    verified: boolean,
  ): HTMLElement =>
    h(
      'div',
      { class: 'mega__panel' },
      h('div', {
        class: `mega__value${value ? '' : ' mega__value--empty'}`,
        text: value ?? 'not set',
      }),
      h('div', { class: 'mega__label', text: label }),
      note ? h('div', { class: 'mega__note', text: note }) : null,
      verified ? h('div', { class: 'state state--READY', text: 'verified' }) : null,
    );

  return h(
    'div',
    { class: 'mega' },
    panel(bpm, 'BPM', null, analysis?.verifiedBpm ?? false),
    panel(keyText, 'Key', keySub, analysis?.verifiedKey ?? false),
  );
}

/** Ensure an analysis row exists before mutating it. */
function baseAnalysis(analysis: TrackAnalysis | undefined, trackId: string): Partial<TrackAnalysis> {
  return analysis ? {} : { trackId };
}

function bpmControls(
  store: Store,
  track: Track,
  analysis: TrackAnalysis | undefined,
): HTMLElement {
  const release = store.getRelease(track.releaseId);
  const current = analysis?.canonicalBpm;

  const input = h('input', {
    id: 'track-bpm',
    name: 'trackBpm',
    class: 'input',
    type: 'number',
    step: '0.1',
    min: '20',
    max: '400',
    inputmode: 'decimal',
    placeholder: 'e.g. 174',
    value: current !== undefined ? String(current) : '',
    'aria-label': 'BPM',
  });

  /**
   * Record a BPM.
   *
   * `source` is the value as originally given and `canonical` the value we
   * actually use. Keeping them apart is the whole point of spec §10: accepting
   * a doubled suggestion must remember that the source said 87, not rewrite
   * history to claim it said 174.
   */
  const commit = async (
    canonical: number | undefined,
    reason: string,
    source: number | undefined = canonical,
  ) => {
    if (canonical !== undefined && (!Number.isFinite(canonical) || canonical <= 0)) return;
    await store.updateAnalysis(track.id, {
      ...baseAnalysis(analysis, track.id),
      sourceBpm: source,
      canonicalBpm: canonical,
      bpmSource: 'user',
      bpmConfidence: canonical === undefined ? undefined : 1,
      verifiedBpm: canonical !== undefined,
      normalisationReason: reason,
    });
  };

  /** What canonicalisation would do to whatever is currently typed. */
  const previewFor = (value: number) =>
    normaliseBpm({
      bpm: value,
      genres: release?.genres,
      styles: release?.styles,
      overrides: store.snapshot.settings.bpmPreferences,
    });

  const hintNode = h('p', { class: 'field__hint' });

  // The suggestion button and the hint are driven by the same update, so the
  // button can never offer a stale value that disagrees with the advice above it.
  const suggestButton = h('button', {
    class: 'button button--small',
    type: 'button',
    hidden: true,
  });

  const refreshPreview = (): void => {
    const value = Number(input.value);

    if (!input.value.trim()) {
      const band = resolveBand(release?.genres, release?.styles, store.snapshot.settings.bpmPreferences);
      hintNode.textContent = band
        ? `${band.label} usually sits ${band.min}-${band.max} BPM.`
        : 'No tempo band known for this release, so nothing is assumed.';
      suggestButton.hidden = true;
      return;
    }

    if (!Number.isFinite(value) || value <= 0) {
      hintNode.textContent = 'Enter a BPM.';
      suggestButton.hidden = true;
      return;
    }

    const result = previewFor(value);
    // Use the normaliser's own reason rather than reconstructing one. A factor
    // of 1 can mean "already in range" OR "nothing fitted, kept as reported",
    // and inferring the former from the latter tells the user the opposite of
    // what the calculation concluded.
    hintNode.textContent =
      result.factor !== 1
        ? `Suggested: ${result.canonicalBpm} BPM. ${result.reason}.`
        : `${result.reason}.`;

    if (result.factor !== 1) {
      suggestButton.hidden = false;
      suggestButton.textContent = `Use ${result.canonicalBpm}`;
      suggestButton.onclick = () => void commit(result.canonicalBpm, result.reason, result.sourceBpm);
    } else {
      suggestButton.hidden = true;
      suggestButton.onclick = null;
    }
  };

  input.addEventListener('input', refreshPreview);
  refreshPreview();

  return h(
    'div',
    { class: 'card stack', id: 'track-bpm-controls' },
    h('h2', { class: 'section-title', text: 'BPM' }),
    h(
      'div',
      { class: 'row' },
      input,
      h('button', {
        class: 'button button--primary',
        type: 'button',
        text: 'Set',
        onclick: () => {
          const value = Number(input.value);
          if (Number.isFinite(value) && value > 0) void commit(value, 'Entered by user');
        },
      }),
    ),
    hintNode,
    h(
      'div',
      { class: 'row row--wrap' },
      // Explicit halve/double, per spec §11.
      h('button', {
        class: 'button button--small',
        type: 'button',
        text: 'Halve',
        disabled: current === undefined,
        onclick: () => {
          if (current !== undefined) void commit(halveBpm(current), 'Halved by user', current);
        },
      }),
      h('button', {
        class: 'button button--small',
        type: 'button',
        text: 'Double',
        disabled: current === undefined,
        onclick: () => {
          if (current !== undefined) void commit(doubleBpm(current), 'Doubled by user', current);
        },
      }),
      suggestButton,
      current !== undefined
        ? h('button', {
            class: 'button button--small button--ghost',
            type: 'button',
            text: 'Clear',
            onclick: () => void commit(undefined, 'Cleared by user'),
          })
        : null,
    ),
  );
}

function keyControls(
  store: Store,
  track: Track,
  analysis: TrackAnalysis | undefined,
  notation: 'camelot' | 'musical',
  refresh: () => void,
): HTMLElement {
  const selected = analysis?.camelotKey;

  const commit = async (key: CamelotKey | undefined) => {
    const musical = key ? camelotToMusicalKey(key) : undefined;
    await store.updateAnalysis(track.id, {
      ...baseAnalysis(analysis, track.id),
      camelotKey: key,
      canonicalKey: musical ?? undefined,
      sourceKey: musical ? formatMusicalKey(musical) : undefined,
      keySource: 'user',
      keyConfidence: key ? 1 : undefined,
      verifiedKey: Boolean(key),
    });
  };

  const options = allCamelotKeys()
    .map((key) => {
      const musical = camelotToMusicalKey(key)!;
      return {
        key,
        camelot: formatCamelot(key),
        label:
          notation === 'camelot'
            ? `${formatCamelot(key)}  -  ${formatMusicalKey(musical)}`
            : `${formatMusicalKey(musical)}  -  ${formatCamelot(key)}`,
        sortKey: notation === 'camelot' ? key.number * 2 + (key.letter === 'A' ? 0 : 1) : 0,
      };
    })
    .sort((a, b) =>
      notation === 'camelot' ? a.sortKey - b.sortKey : a.label.localeCompare(b.label),
    );

  const select = h(
    'select',
    {
      id: 'track-musical-key',
      name: 'trackMusicalKey',
      class: 'select',
      'aria-label': 'Musical key',
      onchange: (event: Event) => {
        const value = (event.target as HTMLSelectElement).value;
        const match = options.find((option) => option.camelot === value);
        void commit(match?.key);
      },
    },
    h('option', { value: '', text: 'Not set', selected: !selected }),
    ...options.map((option) =>
      h('option', {
        value: option.camelot,
        text: option.label,
        selected: selected ? formatCamelot(selected) === option.camelot : false,
      }),
    ),
  );

  const notationToggle = h(
    'button',
    {
      class: 'chip',
      type: 'button',
      'aria-pressed': String(notation === 'musical'),
      text: notation === 'camelot' ? 'Camelot' : 'Musical',
      title: 'Toggle between Camelot and traditional key notation',
      onclick: async () => {
        await store.setKeyNotation(notation === 'camelot' ? 'musical' : 'camelot');
        refresh();
      },
    },
  );

  return h(
    'div',
    { class: 'card stack', id: 'track-key-controls' },
    h(
      'div',
      { class: 'row' },
      h('h2', { class: 'section-title', text: 'Key', style: { flex: '1' } }),
      notationToggle,
    ),
    select,
    // Tapping the wheel is faster than the select behind decks. Spec §13.
    keyWheel({
      selected: selected,
      notation,
      size: 300,
      onSelect: (key) => void commit(key),
    }),
    h('p', {
      class: 'field__hint',
      text: selected
        ? 'Highlighted segments are the harmonically safe moves: same key, one step either way, and the relative major/minor.'
        : 'Tap a segment to set the key. Compatible neighbours are highlighted once a key is set.',
    }),
    selected
      ? h('button', {
          class: 'button button--small button--ghost',
          type: 'button',
          text: 'Clear key',
          onclick: () => void commit(undefined),
        })
      : null,
  );
}

/**
 * Pitch simulator for this track. Spec v1.1 §16.
 *
 * Kept below the BPM and key controls: the collection UI should stay plain
 * (spec v1.1 §31), and this is the surface where pitch maths is genuinely
 * wanted.
 */
function simulatorBlock(
  store: Store,
  analysis: TrackAnalysis | undefined,
  notation: 'camelot' | 'musical',
): HTMLElement {
  const nativeBpm = nativeBpmOf(analysis);
  const nativeKey = nativeKeyOf(analysis);

  if (nativeBpm === undefined && !nativeKey) {
    return h('div', { hidden: true });
  }

  return pitchSimulator({
    nativeBpm,
    nativeKey,
    deck: store.deck,
    notation,
    showWheel: Boolean(nativeKey),
  });
}

/**
 * Provenance panel. Spec §10 forbids storing a bare `bpm = 174`, so the UI
 * shows the whole chain: what the source said, what we normalised it to, why,
 * how confident we are, and whether a human has confirmed it.
 */
function candidateValues(candidate: AnalysisCandidate): string {
  const values: string[] = [];
  if (candidate.canonicalBpm !== undefined) {
    values.push(
      candidate.sourceBpm !== undefined && candidate.sourceBpm !== candidate.canonicalBpm
        ? `${candidate.sourceBpm} → ${candidate.canonicalBpm} BPM`
        : `${candidate.canonicalBpm} BPM`,
    );
  }
  const camelot = candidate.camelotKey ??
    (candidate.canonicalKey ? musicalKeyToCamelot(candidate.canonicalKey) ?? undefined : undefined);
  if (camelot && candidate.canonicalKey) {
    values.push(`${formatCamelot(camelot)} · ${formatMusicalKey(candidate.canonicalKey)}`);
  } else if (camelot) values.push(formatCamelot(camelot));
  else if (candidate.canonicalKey) values.push(formatMusicalKey(candidate.canonicalKey));
  return values.join(' / ');
}

function candidateList(
  store: Store,
  track: Track,
  analysis: TrackAnalysis,
): HTMLElement {
  const titleKey = (value: string | undefined) => (value ?? '').normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  const matching = analysis.candidates.filter(
    (candidate) => titleKey(candidate.matchedTitle) === titleKey(track.title),
  );
  if (!matching.length) return h('p', {
    class: 'field__hint',
    text: 'No source result matches this track title. Results for other tracks on the release are hidden.',
  });

  return h(
    'div',
    { class: 'stack stack--tight' },
    h('h3', { class: 'section-title', text: 'Source candidates' }),
    ...matching.map((candidate, index) => {
      const identityConfidence = candidate.matchScore ?? candidate.confidence;
      const bpmConfidence = Math.min(
        candidate.bpmConfidence ?? candidate.confidence,
        identityConfidence,
      );
      const keyConfidence = Math.min(
        candidate.keyConfidence ?? candidate.confidence,
        identityConfidence,
      );
      const camelot = candidate.camelotKey ??
        (candidate.canonicalKey ? musicalKeyToCamelot(candidate.canonicalKey) ?? undefined : undefined);
      const matchedTitle = candidate.matchedTitle
        ? `${candidate.matchedArtist ? `${candidate.matchedArtist} — ` : ''}${candidate.matchedTitle}${
            candidate.matchedVersion ? ` (${candidate.matchedVersion})` : ''
          }`
        : undefined;
      const confidenceText = [
        `identity ${Math.round(identityConfidence * 100)}%`,
        candidate.canonicalBpm !== undefined ? `BPM ${Math.round(bpmConfidence * 100)}%` : undefined,
        (candidate.canonicalKey || camelot) ? `key ${Math.round(keyConfidence * 100)}%` : undefined,
      ].filter(Boolean).join(' · ');
      const commentId = `source-review-${candidate.providerId ?? candidate.source}-${index}`;
      const comment = h('textarea', {
        id: commentId, name: commentId, class: 'textarea candidate-row__comment', rows: '2',
        placeholder: 'Why is this source right or wrong?', value: candidate.reviewComment ?? '',
      });
      const review = async (reviewStatus: 'approved' | 'rejected') => {
        const candidates = analysis.candidates.map((item) => item === candidate ? {
          ...item,
          reviewStatus,
          reviewComment: comment.value.trim() || undefined,
          reviewedAt: new Date().toISOString(),
        } : item);
        const patch: Partial<TrackAnalysis> = { candidates };
        if (reviewStatus === 'approved') {
          patch.analysisMethod = `External candidate approved by user${comment.value.trim() ? `: ${comment.value.trim()}` : ''}`;
          if (candidate.canonicalBpm !== undefined) Object.assign(patch, {
            sourceBpm: candidate.sourceBpm ?? candidate.canonicalBpm,
            canonicalBpm: candidate.canonicalBpm,
            nativeBpm: candidate.nativeBpm ?? candidate.canonicalBpm,
            bpmSource: candidate.source, bpmConfidence, verifiedBpm: true,
            normalisationReason: candidate.normalisationReason,
          });
          if (candidate.canonicalKey || camelot) Object.assign(patch, {
            sourceKey: candidate.sourceKey, canonicalKey: candidate.canonicalKey, camelotKey: camelot,
            nativeKey: candidate.nativeKey ?? candidate.canonicalKey,
            nativeCamelot: candidate.nativeCamelot ?? camelot,
            nativePitchClass: candidate.nativePitchClass,
            nativeMode: candidate.nativeMode ?? candidate.canonicalKey?.tonality,
            keySource: candidate.source, keyConfidence, verifiedKey: true,
          });
        }
        await store.updateAnalysis(track.id, patch);
      };
      return h(
        'div',
        { class: 'candidate-row' },
        h(
          'div',
          { class: 'candidate-row__source' },
          h('span', { class: 'chip', text: candidate.providerName ?? candidate.source }),
        ),
        h(
          'div',
          { class: 'candidate-row__body' },
          h('div', { class: 'list-row__title', text: candidateValues(candidate) || 'No usable value' }),
          matchedTitle
            ? h('div', {
                class: 'list-row__sub',
                text: `Matched recording: ${matchedTitle}${
                  candidate.matchedDuration ? ` · ${formatDuration(candidate.matchedDuration)}` : ''
                }`,
              })
            : null,
          h('div', {
            class: 'list-row__sub',
            text: [
              confidenceText,
              candidate.normalisationReason,
              candidate.matchRationale,
            ].filter(Boolean).join(' / '),
          }),
          candidate.externalUrl
            ? h('a', {
                class: 'text-link',
                href: candidate.externalUrl,
                target: '_blank',
                rel: 'noopener noreferrer',
                text: 'Review source match',
              })
            : null,
          candidate.reviewStatus
            ? h('div', { class: `state state--${candidate.reviewStatus === 'approved' ? 'READY' : 'CONFLICT'}`, text: candidate.reviewStatus })
            : null,
          h('label', { for: commentId, class: 'field__label', text: 'Validation comment' }),
          comment,
        ),
        h('div', { class: 'candidate-row__actions' },
          h('button', { class: 'button button--small button--primary', type: 'button', text: 'Approve', onclick: () => void review('approved') }),
          h('button', { class: 'button button--small button--danger', type: 'button', text: 'Reject', onclick: () => void review('rejected') }),
        ),
      );
    }),
  );
}

function provenance(
  store: Store,
  track: Track,
  analysis: TrackAnalysis | undefined,
): HTMLElement {
  const state = analysisState(analysis);

  const rows: [string, string][] = [];
  if (analysis?.bpmSource) rows.push(['BPM source', analysis.bpmSource]);
  if (analysis?.sourceBpm !== undefined) rows.push(['Source BPM', String(analysis.sourceBpm)]);
  if (analysis?.canonicalBpm !== undefined) rows.push(['Canonical BPM', String(analysis.canonicalBpm)]);
  if (analysis?.normalisationReason) rows.push(['Normalisation', analysis.normalisationReason]);
  if (analysis?.keySource) rows.push(['Key source', analysis.keySource]);
  if (analysis?.sourceKey) rows.push(['Source key', analysis.sourceKey]);
  const both = formatKeyBoth(analysis);
  if (both) rows.push(['Canonical key', both]);
  if (analysis?.bpmConfidence !== undefined) {
    rows.push(['BPM confidence', `${Math.round(analysis.bpmConfidence * 100)}%`]);
  }
  if (analysis?.keyConfidence !== undefined) {
    rows.push(['Key confidence', `${Math.round(analysis.keyConfidence * 100)}%`]);
  }
  rows.push(['Verified BPM', analysis?.verifiedBpm ? 'yes' : 'no']);
  rows.push(['Verified key', analysis?.verifiedKey ? 'yes' : 'no']);
  if (analysis?.analysisMethod) rows.push(['Method', analysis.analysisMethod]);

  return h(
    'div',
    { class: 'card stack stack--tight' },
    h(
      'div',
      { class: 'row' },
      h('h2', { class: 'section-title', text: 'Provenance', style: { flex: '1' } }),
      stateBadge(state),
    ),
    h(
      'div',
      { class: 'detail-grid' },
      ...rows.map(([label, value]) =>
        h(
          'div',
          { class: 'detail-item' },
          h('div', { class: 'detail-item__label', text: label }),
          h('div', { class: 'detail-item__value', text: value }),
        ),
      ),
    ),
    analysis?.candidates.length
      ? candidateList(store, track, analysis)
      : h('p', {
          class: 'field__hint',
          text: 'No external sources consulted yet. Discogs carries no BPM or key data, so every track starts at ANALYSE.',
        }),
  );
}
