import type { Store } from '@/app/store';
import type { Router } from '@/app/router';
import type { View } from './types';
import type { BagTrack } from '@/bags/coverage';
import { formatCamelot, formatMusicalKey } from '@/harmonic/camelot';
import { nativeBpmOf, nativeKeyOf } from '@/pitch/native';
import { formatCount } from '@/components/format';
import { clear, h, mount } from '@/utils/dom';

/**
 * Sticker Run. Spec §23.
 *
 * A dedicated mode for physically labelling records: pick up the record, read
 * one enormous number off the screen, write it on the label, mark it done, next.
 *
 * Values shown are always NATIVE (spec v1.1 §18): a sticker describes the
 * record at nominal speed, so a pitch-adjusted key must never be printed on it.
 */
export function createStickerView(store: Store, router: Router): View {
  const element = h('div', { class: 'container stack' });
  let scope: 'active-bag' | 'collection' = 'active-bag';
  let index = 0;

  /** Only tracks we actually know something about are worth stickering. */
  function candidates(): BagTrack[] {
    const bag = store.activeBag;
    const entries =
      scope === 'active-bag' && bag ? store.resolveBagTracks(bag) : store.allTrackEntries();

    return entries.filter((entry) => {
      const bpm = nativeBpmOf(entry.analysis);
      const key = nativeKeyOf(entry.analysis);
      // Nothing to write without at least one value, and nothing to do if the
      // label is already on the sleeve.
      if (bpm === undefined && !key) return false;
      return !entry.analysis?.stickerDoneAt;
    });
  }

  function render(): void {
    const queue = candidates();
    const bag = store.activeBag;
    if (index >= queue.length) index = 0;
    const current = queue[index];

    clear(element);

    mount(
      element,
      h(
        'div',
        { class: 'toolbar__filters' },
        h('button', {
          class: 'chip',
          type: 'button',
          disabled: !bag,
          'aria-pressed': String(scope === 'active-bag' && Boolean(bag)),
          text: bag ? `Bag: ${bag.name}` : 'No active bag',
          onclick: () => {
            scope = 'active-bag';
            index = 0;
            render();
          },
        }),
        h('button', {
          class: 'chip',
          type: 'button',
          'aria-pressed': String(scope === 'collection' || !bag),
          text: 'Whole collection',
          onclick: () => {
            scope = 'collection';
            index = 0;
            render();
          },
        }),
      ),
    );

    if (!current) {
      mount(
        element,
        h(
          'div',
          { class: 'empty' },
          h('h2', { text: 'Nothing to sticker' }),
          h('p', {
            text: 'Tracks appear here once they have a BPM or key. Analyse a few first, or widen the scope.',
          }),
          h('button', {
            class: 'button',
            type: 'button',
            text: 'Open the analysis queue',
            onclick: () => router.navigate('analyse'),
          }),
        ),
      );
      return;
    }

    const bpm = nativeBpmOf(current.analysis);
    const key = nativeKeyOf(current.analysis);
    const camelot = current.analysis?.camelotKey;

    mount(
      element,
      h('p', {
        class: 'field__hint',
        role: 'status',
        'aria-live': 'polite',
        text: `${index + 1} of ${formatCount(queue.length, 'track')} left to label.`,
      }),
      h(
        'div',
        { class: 'sticker' },
        camelot
          ? h('div', {
              class: 'sticker__swatch',
              // Hue from the Camelot number, the intended physical convention.
              // The number is inside the swatch, so colour is never the only cue.
              style: { background: camelotColour(camelot.number) },
              title: `Colour convention for Camelot ${camelot.number}`,
              text: String(camelot.number),
            })
          : null,
        h('div', { class: 'sticker__key', text: camelot ? formatCamelot(camelot) : '—' }),
        key ? h('div', { class: 'sticker__musical', text: formatMusicalKey(key) }) : null,
        h('div', { class: 'sticker__bpm', text: bpm !== undefined ? String(bpm) : 'no BPM' }),
        h('div', {
          class: 'sticker__meta',
          text: [current.track.position, current.track.title].filter(Boolean).join(' · '),
        }),
        h('div', {
          class: 'sticker__meta',
          text: [current.release.artist, current.release.catalogueNumber]
            .filter(Boolean)
            .join(' · '),
        }),
      ),
      h(
        'div',
        { class: 'sticker__actions' },
        h('button', {
          class: 'button button--primary',
          type: 'button',
          text: 'Sticker done',
          onclick: async () => {
            await store.updateAnalysis(current.track.id, {
              stickerDoneAt: new Date().toISOString(),
            });
            // The queue shrinks under us, so stay on the same index.
            render();
          },
        }),
        h('button', {
          class: 'button',
          type: 'button',
          text: 'Skip',
          disabled: queue.length < 2,
          onclick: () => {
            index = (index + 1) % queue.length;
            render();
          },
        }),
        h('button', {
          class: 'button button--ghost',
          type: 'button',
          text: 'Open track',
          onclick: () => router.navigate(`track/${current.track.id}`),
        }),
      ),
      h('p', {
        class: 'field__hint',
        text: 'These are the values at nominal speed. A sticker describes the record itself, never a pitched playback.',
      }),
    );
  }

  const unsubscribe = store.subscribe(render);
  render();

  return { element, destroy: () => unsubscribe() };
}

/**
 * Colour for a Camelot number, 1-12. Spec §23 suggests colour maps to the
 * number while the text carries A/B and BPM. Evenly spaced hues, light enough
 * to take dark text.
 */
export function camelotColour(number: number): string {
  const hue = ((number - 1) * 30) % 360;
  return `hsl(${hue} 72% 68%)`;
}
