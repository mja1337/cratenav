import type { KeyNotation } from '@/domain/types';
import type { BagCoverage } from '@/bags/coverage';
import { formatCamelot } from '@/harmonic/camelot';
import { keyWheel } from './key-wheel';
import { stat } from './badges';
import { h } from '@/utils/dom';

/**
 * Bag coverage display. Spec §19.
 *
 * Answers "is my bag balanced?" — counts, tempo spread, key spread, style mix,
 * and a plain-language list of what is missing.
 */
export function coveragePanel(
  coverage: BagCoverage,
  notation: KeyNotation,
): HTMLElement {
  return h(
    'div',
    { class: 'stack' },
    countsBlock(coverage),
    ...(coverage.gaps.length ? [gapsBlock(coverage)] : [balancedBlock()]),
    ...(coverage.bpm ? [tempoBlock(coverage)] : []),
    keyBlock(coverage, notation),
    ...(coverage.styles.length ? [stylesBlock(coverage)] : []),
  );
}

function countsBlock(coverage: BagCoverage): HTMLElement {
  return h(
    'div',
    { class: 'stats' },
    stat(coverage.records, 'Records'),
    stat(coverage.tracks, 'Tracks'),
    stat(coverage.analysed, 'With BPM/key'),
    stat(coverage.verified, 'Verified'),
    stat(coverage.needsAnalysis, 'Need analysis'),
    stat(`${coverage.camelotCovered}/24`, 'Keys covered'),
  );
}

function gapsBlock(coverage: BagCoverage): HTMLElement {
  return h(
    'div',
    { class: 'card stack stack--tight' },
    h('h3', { class: 'section-title', text: 'Gaps' }),
    h(
      'ul',
      { class: 'gap-list' },
      ...coverage.gaps.map((gap) =>
        h(
          'li',
          { class: `gap gap--${gap.severity}` },
          // Severity is carried by a text prefix as well as the colour. §43
          h('span', {
            class: 'gap__marker',
            text: gap.severity === 1 ? 'Fix' : gap.severity === 2 ? 'Check' : 'Note',
          }),
          h('span', { text: gap.message }),
        ),
      ),
    ),
  );
}

function balancedBlock(): HTMLElement {
  return h(
    'div',
    { class: 'banner banner--info' },
    h('div', { class: 'banner__title', text: 'Nothing obviously missing' }),
    h('div', {
      class: 'banner__body',
      text: 'Tempo and key coverage look even, and everything packed has BPM and key.',
    }),
  );
}

function tempoBlock(coverage: BagCoverage): HTMLElement {
  const { bpm } = coverage;
  if (!bpm) return h('div');

  const peak = Math.max(1, ...bpm.buckets.map((bucket) => bucket.count));

  return h(
    'div',
    { class: 'card stack stack--tight' },
    h(
      'div',
      { class: 'row' },
      h('h3', { class: 'section-title', text: 'Tempo', style: { flex: '1' } }),
      h('span', {
        class: 'chip chip--mono',
        text: `${bpm.min}-${bpm.max} BPM`,
      }),
      h('span', { class: 'chip chip--mono', text: `median ${bpm.median}` }),
    ),
    h(
      'div',
      { class: 'histogram', role: 'img', 'aria-label': tempoDescription(coverage) },
      ...bpm.buckets.map((bucket) =>
        h(
          'div',
          { class: 'histogram__col', title: `${bucket.from}-${bucket.to}: ${bucket.count}` },
          h('div', {
            class: `histogram__bar${bucket.count ? '' : ' histogram__bar--empty'}`,
            style: { height: `${bucket.count ? Math.max(6, (bucket.count / peak) * 100) : 2}%` },
          }),
          h('span', { class: 'histogram__label', text: String(bucket.from) }),
        ),
      ),
    ),
  );
}

function tempoDescription(coverage: BagCoverage): string {
  const occupied = coverage.bpm?.buckets.filter((b) => b.count > 0) ?? [];
  return `Tempo spread from ${coverage.bpm?.min} to ${coverage.bpm?.max} BPM across ${occupied.length} bands`;
}

function keyBlock(coverage: BagCoverage, notation: KeyNotation): HTMLElement {
  const counts = new Map<string, number>();
  for (const slot of coverage.camelot) {
    if (slot.count) counts.set(formatCamelot(slot.key), slot.count);
  }

  return h(
    'div',
    { class: 'card stack stack--tight' },
    h(
      'div',
      { class: 'row' },
      h('h3', { class: 'section-title', text: 'Key spread', style: { flex: '1' } }),
      h('span', { class: 'chip chip--mono', text: `${coverage.camelotCovered} of 24` }),
    ),
    counts.size
      ? keyWheel({
          notation,
          counts,
          size: 260,
          centreLabel: `${coverage.camelotCovered}/24`,
        })
      : h('p', {
          class: 'field__hint',
          text: 'No keys known yet. Set a key on any track and it will appear here.',
        }),
    counts.size
      ? h('p', {
          class: 'field__hint',
          text: 'Brighter segments hold more tracks. Empty segments are keys you have not packed.',
        })
      : null,
  );
}

function stylesBlock(coverage: BagCoverage): HTMLElement {
  return h(
    'div',
    { class: 'card stack stack--tight' },
    h('h3', { class: 'section-title', text: 'Styles' }),
    h(
      'div',
      { class: 'row row--wrap' },
      ...coverage.styles
        .slice(0, 14)
        .map((entry) => h('span', { class: 'chip', text: `${entry.name} ${entry.count}` })),
    ),
  );
}
