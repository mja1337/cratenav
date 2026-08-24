import type { KeyNotation } from '@/domain/types';
import type { BridgeSuggestion, Recommendation } from '@/recommend/engine';
import { formatBpm, formatKeyFor } from './format';
import { COMPATIBILITY_LABELS } from '@/pitch/deck';
import { h } from '@/utils/dom';

/**
 * Next-track suggestion list. Spec §17.
 *
 * Each row states BPM, key and why it was suggested. The reason matters as much
 * as the score: a DJ needs to know whether a suggestion is a key match, a tempo
 * match, or a compromise, before committing to it mid-set.
 */
export function recommendationList(
  recommendations: readonly Recommendation[],
  notation: KeyNotation,
  onSelect: (recommendation: Recommendation) => void,
  onCompare?: (recommendation: Recommendation) => void,
  comparedTrackId?: string,
): HTMLElement {
  if (!recommendations.length) {
    return h('p', {
      class: 'field__hint',
      text: 'Nothing in scope matches closely enough. Widen the scope, or analyse more of the bag.',
    });
  }

  return h(
    'div',
    { class: 'list' },
    ...recommendations.map((recommendation) => {
      const { entry } = recommendation;
      const bpm = formatBpm(entry.analysis);
      const key = formatKeyFor(entry.analysis, notation);

      // Only surface pitch figures when a tempo was actually known.
      const pitch = recommendation.pitch?.tempoKnown ? recommendation.pitch : undefined;

      const open = h(
        'button',
        {
          class: 'suggestion',
          type: 'button',
          'aria-label': pitch
            ? `${entry.track.title}, ${recommendation.matchPercent}% match, play at ${pitch.requiredPitchPercent.toFixed(1)} percent, ${COMPATIBILITY_LABELS[pitch.classification]}`
            : `${entry.track.title}, ${recommendation.matchPercent}% match`,
          onclick: () => onSelect(recommendation),
        },
        h(
          'div',
          { class: 'suggestion__body' },
          h('div', { class: 'list-row__title', text: entry.track.title }),
          h('div', {
            class: 'list-row__sub',
            // Spec v1.1 §11 compact form: native tempo, then where it lands.
            text: pitch
              ? [
                  `${bpm ?? '?'} \u2192 ${pitch.playbackBpm ? pitch.playbackBpm.toFixed(1) : '?'} BPM`,
                  key,
                  entry.release.title,
                ]
                  .filter(Boolean)
                  .join(' / ')
              : [entry.track.position, entry.track.artist, entry.release.title]
                  .filter(Boolean)
                  .join(' / '),
          }),
          h('div', { class: 'suggestion__reasons', text: recommendation.reasons.join(' · ') }),
        ),
        h(
          'div',
          { class: 'suggestion__aside' },
          h('div', {
            class: 'suggestion__match',
            text: `${recommendation.matchPercent}%`,
          }),
          pitch
            ? h('div', {
                // The pitch to set on the deck is the single most actionable
                // number here, so it gets its own line.
                class: `pitch-badge${pitch.withinPreferred ? '' : ' pitch-badge--beyond'}`,
                text: `${pitch.requiredPitchPercent >= 0 ? '+' : ''}${pitch.requiredPitchPercent.toFixed(1)}%`,
              })
            : h('div', {
                class: 'readout__value',
                style: { fontSize: '0.8125rem' },
                text: [bpm, key].filter(Boolean).join('  ') || 'unknown',
              }),
          pitch
            ? h('span', {
                class: `compat compat--${pitch.classification}`,
                text: COMPATIBILITY_LABELS[pitch.classification],
              })
            : null,
        ),
      );
      return onCompare
        ? h(
            'div',
            { class: 'suggestion-compare' },
            open,
            h('button', {
              class: 'button button--small',
              type: 'button',
              'aria-pressed': String(comparedTrackId === entry.track.id),
              text: comparedTrackId === entry.track.id ? 'Shown on wheel' : 'Show on wheel',
              onclick: () => onCompare(recommendation),
            }),
          )
        : open;
    }),
  );
}

/** Bridge suggestions. Spec §20's "Find bridge track". */
export function bridgeList(
  suggestions: readonly BridgeSuggestion[],
  notation: KeyNotation,
  onSelect: (suggestion: BridgeSuggestion) => void,
): HTMLElement {
  if (!suggestions.length) {
    return h('p', {
      class: 'field__hint',
      text: 'Nothing in this bag works on both sides of that join.',
    });
  }

  return h(
    'div',
    { class: 'list' },
    ...suggestions.map((suggestion) => {
      const bpm = formatBpm(suggestion.entry.analysis);
      const key = formatKeyFor(suggestion.entry.analysis, notation);

      return h(
        'button',
        {
          class: 'suggestion',
          type: 'button',
          'aria-label': `${suggestion.entry.track.title}, ${suggestion.matchPercent}% bridge`,
          onclick: () => onSelect(suggestion),
        },
        h(
          'div',
          { class: 'suggestion__body' },
          h('div', { class: 'list-row__title', text: suggestion.entry.track.title }),
          h('div', {
            class: 'list-row__sub',
            text: [suggestion.entry.track.position, suggestion.entry.release.title]
              .filter(Boolean)
              .join(' / '),
          }),
          h('div', { class: 'suggestion__reasons', text: suggestion.reasons.join(' · ') }),
        ),
        h(
          'div',
          { class: 'suggestion__aside' },
          h('div', { class: 'suggestion__match', text: `${suggestion.matchPercent}%` }),
          h('div', {
            class: 'readout__value',
            style: { fontSize: '0.8125rem' },
            text: [bpm, key].filter(Boolean).join('  ') || 'unknown',
          }),
        ),
      );
    }),
  );
}
