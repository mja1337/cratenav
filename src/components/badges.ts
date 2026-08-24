import type { AnalysisState, TrackAnalysis } from '@/domain/types';
import { h } from '@/utils/dom';

/**
 * Analysis-state badge. Spec §9.
 *
 * Colour is carried by the CSS class, but the badge always renders its name as
 * text and a glyph too, so it survives colour blindness, greyscale and a dim
 * booth. Spec §9 and §43 both require this.
 */

const DESCRIPTIONS: Record<AnalysisState, string> = {
  READY: 'High-confidence BPM and key',
  VERIFY: 'Likely match, version uncertain',
  ANALYSE: 'No reliable BPM or key data yet',
  CONFLICT: 'Sources disagree',
};

export function stateBadge(state: AnalysisState): HTMLElement {
  return h('span', {
    class: `state state--${state}`,
    title: DESCRIPTIONS[state],
    text: state,
  });
}

export function analysisState(analysis: TrackAnalysis | undefined): AnalysisState {
  // No analysis row yet means nothing has been found or measured.
  return analysis?.state ?? 'ANALYSE';
}

export function chip(label: string, options: { mono?: boolean; title?: string } = {}): HTMLElement {
  return h('span', {
    class: `chip${options.mono ? ' chip--mono' : ''}`,
    title: options.title,
    text: label,
  });
}

export function stat(value: string | number, label: string): HTMLElement {
  return h(
    'div',
    { class: 'stat' },
    h('div', { class: 'stat__value', text: typeof value === 'number' ? value.toLocaleString('en-GB') : value }),
    h('div', { class: 'stat__label', text: label }),
  );
}
