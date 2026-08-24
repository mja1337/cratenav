import type { SetPlan, SetPlanMode } from '@/domain/types';
import type { Store } from '@/app/store';
import type { Router } from '@/app/router';
import type { View } from './types';
import type { BagTrack } from '@/bags/coverage';
import {
  addTracks,
  describeTransitions,
  moveTrack,
  orderEntries,
  removeTrack,
  renameSetPlan,
  setMode,
  toggleTrack,
} from '@/sets/operations';
import { findBridge } from '@/recommend/engine';
import { COMPATIBILITY_LABELS } from '@/pitch/deck';
import { asPlaybackTarget } from '@/pitch/native';
import { bridgeList } from '@/components/recommendations';
import { formatBpm, formatCount, formatKeyFor } from '@/components/format';
import { stateBadge } from '@/components/badges';
import { clear, h, mount } from '@/utils/dom';

/**
 * Set plan editor. Spec §20.
 *
 * Freeform and shortlist deliberately impose no order — the spec is explicit
 * that an ordered set must not be forced. Ordered mode adds a running order and
 * shows the transition between each pair.
 */
export function createSetPlanView(store: Store, router: Router, planId: string): View {
  const element = h('div', { class: 'container stack' });
  /** Which join, if any, is currently having a bridge track searched for. */
  let bridgeAt: number | null = null;
  let picking = false;

  function render(): void {
    const plan = store.getSetPlan(planId);
    clear(element);

    if (!plan) {
      mount(
        element,
        h(
          'div',
          { class: 'empty' },
          h('h2', { text: 'Set plan not found' }),
          h('button', {
            class: 'button',
            type: 'button',
            text: 'Back to bags',
            onclick: () => router.navigate('bag'),
          }),
        ),
      );
      return;
    }

    const bag = plan.bagId ? store.getBag(plan.bagId) : undefined;
    // The bag is the universe of possible choices. Spec §19.
    const pool = bag ? store.resolveBagTracks(bag) : [];
    const inPlan = new Set(plan.trackIds);
    const chosen = pool.filter((entry) => inPlan.has(entry.track.id));

    mount(
      element,
      header(plan, bag?.name),
      modeSwitch(plan),
      picking
        ? picker(pool, inPlan)
        : plan.mode === 'ordered'
          ? orderedBody(plan, pool)
          : flatBody(plan, chosen),
      h(
        'div',
        { class: 'row row--wrap' },
        h('button', {
          class: `button button--small${picking ? '' : ' button--primary'}`,
          type: 'button',
          text: picking ? 'Done adding' : 'Add tracks',
          onclick: () => {
            picking = !picking;
            render();
          },
        }),
        bag
          ? h('button', {
              class: 'button button--small button--ghost',
              type: 'button',
              text: 'Open bag',
              onclick: () => router.navigate(`bag/${bag.id}`),
            })
          : null,
        h('div', { class: 'spacer' }),
        h('button', {
          class: 'button button--small button--danger',
          type: 'button',
          text: 'Delete set',
          onclick: async () => {
            if (!window.confirm(`Delete "${plan.name}"?`)) return;
            await store.deleteSetPlan(plan);
            router.navigate(bag ? `bag/${bag.id}` : 'bag');
          },
        }),
      ),
    );
  }

  function header(plan: SetPlan, bagName?: string): HTMLElement {
    return h(
      'div',
      { class: 'stack stack--tight' },
      h(
        'div',
        { class: 'row' },
        h('h1', { style: { margin: '0', fontSize: '1.25rem' }, text: plan.name, class: 'spacer' }),
        h('button', {
          class: 'button button--small button--ghost',
          type: 'button',
          text: 'Rename',
          onclick: async () => {
            const name = window.prompt('Rename set', plan.name);
            if (!name) return;
            await store.saveSetPlan(renameSetPlan(plan, name));
          },
        }),
      ),
      h('p', {
        class: 'field__hint',
        text: [
          bagName ? `From bag: ${bagName}` : 'No bag linked',
          formatCount(plan.trackIds.length, 'track'),
        ].join(' / '),
      }),
    );
  }

  function modeSwitch(plan: SetPlan): HTMLElement {
    const option = (mode: SetPlanMode, label: string, hint: string) =>
      h('button', {
        type: 'button',
        'aria-pressed': String(plan.mode === mode),
        title: hint,
        text: label,
        onclick: async () => {
          bridgeAt = null;
          await store.saveSetPlan(setMode(plan, mode));
        },
      });

    return h(
      'div',
      { class: 'stack stack--tight' },
      h(
        'div',
        { class: 'mode-switch', role: 'group', 'aria-label': 'Planning mode' },
        option('freeform', 'Freeform', 'Records planned for the night, no order'),
        option('shortlist', 'Shortlist', 'Tracks you probably want, still unsequenced'),
        option('ordered', 'Ordered', 'An explicit running order with transitions'),
      ),
      h('p', {
        class: 'field__hint',
        text:
          plan.mode === 'freeform'
            ? 'No order implied. Just what you are thinking of playing.'
            : plan.mode === 'shortlist'
              ? 'Flagged as likely, still unsequenced.'
              : 'Sequenced, with the transition shown between each pair.',
      }),
    );
  }

  /** Freeform and shortlist: a flat list, no order implied. */
  function flatBody(plan: SetPlan, chosen: readonly BagTrack[]): HTMLElement {
    if (!chosen.length) {
      return h(
        'div',
        { class: 'empty' },
        h('h2', { text: 'Nothing in this set yet' }),
        h('p', { text: 'Add tracks from the bag below.' }),
      );
    }

    const notation = store.snapshot.settings.keyNotation;
    return h(
      'div',
      { class: 'tracklist' },
      ...chosen.map((entry) => trackRow(plan, entry, notation, { ordered: false })),
    );
  }

  /** Ordered mode: running order plus the join between each pair. Spec §20. */
  function orderedBody(plan: SetPlan, pool: readonly BagTrack[]): HTMLElement {
    const ordered = orderEntries(plan, pool);
    if (!ordered.length) {
      return h(
        'div',
        { class: 'empty' },
        h('h2', { text: 'Nothing sequenced yet' }),
        h('p', { text: 'Add tracks, then order them here.' }),
      );
    }

    const notation = store.snapshot.settings.keyNotation;
    // Pitch-aware joins: what the incoming record must be pitched to.
    const transitions = describeTransitions(ordered, { tolerance: store.pitchTolerance });
    const container = h('div', { class: 'stack stack--tight' });

    ordered.forEach((entry, index) => {
      container.append(trackRow(plan, entry, notation, { ordered: true, index, total: ordered.length }));

      const transition = transitions[index];
      if (!transition) return;

      const { pitch } = transition;
      // Spec v1.1 §15, §26: state the pitch to set, where it lands, how far
      // the musical pitch moves, and the resulting compatibility.
      const pitchLabels: HTMLElement[] = [];
      // Never print a pitch we could not actually compute.
      if (pitch && pitch.tempoKnown) {
        if (pitch.classification === 'OUT_OF_RANGE') {
          pitchLabels.push(
            h('span', {
              text: `needs ${pitch.requiredPitchPercent.toFixed(1)}% — beyond ${store.deck.name}`,
            }),
          );
        } else {
          pitchLabels.push(
            h('span', {
              class: `pitch-badge${pitch.withinPreferred ? '' : ' pitch-badge--beyond'}`,
              text: `play at ${pitch.requiredPitchPercent >= 0 ? '+' : ''}${pitch.requiredPitchPercent.toFixed(1)}%`,
            }),
          );
          if (pitch.playbackBpm !== undefined) {
            pitchLabels.push(h('span', { text: `${pitch.playbackBpm.toFixed(1)} BPM` }));
          }
          if (pitch.pitchShiftSemitones && Math.abs(pitch.pitchShiftSemitones) >= 0.01) {
            pitchLabels.push(
              h('span', {
                text: `${pitch.pitchShiftSemitones > 0 ? '+' : ''}${pitch.pitchShiftSemitones.toFixed(2)} semitone`,
              }),
            );
          }
          pitchLabels.push(
            h('span', {
              class: `compat compat--${pitch.classification}`,
              text: COMPATIBILITY_LABELS[pitch.classification],
            }),
          );
        }
      }

      container.append(
        h(
          'div',
          {
            class: `set-join${transition.warning ? ' set-join--warning' : ''}`,
          },
          h('div', { class: 'set-join__rule' }),
          h(
            'div',
            { class: 'set-join__labels' },
            ...transition.labels.map((label) => h('span', { text: label })),
            ...pitchLabels,
            h('button', {
              class: 'button button--small button--ghost',
              type: 'button',
              text: bridgeAt === index ? 'Hide bridge' : 'Find bridge',
              onclick: () => {
                bridgeAt = bridgeAt === index ? null : index;
                render();
              },
            }),
          ),
        ),
      );

      if (bridgeAt === index) {
        container.append(bridgePanel(plan, pool, ordered, index));
      }
    });

    return container;
  }

  /** Bridge search for one join. Searches the bag first. Spec §20. */
  function bridgePanel(
    plan: SetPlan,
    pool: readonly BagTrack[],
    ordered: readonly BagTrack[],
    index: number,
  ): HTMLElement {
    const from = ordered[index]!;
    const to = ordered[index + 1]!;
    const used = new Set(plan.trackIds);

    const fromTarget = asPlaybackTarget(from.analysis);
    const toTarget = asPlaybackTarget(to.analysis);

    const suggestions = findBridge(
      {
        bpm: fromTarget.bpm,
        camelot: from.analysis?.camelotKey,
        effectivePitchClass: fromTarget.effectivePitchClass,
        tonality: fromTarget.tonality,
      },
      {
        bpm: toTarget.bpm,
        camelot: to.analysis?.camelotKey,
        effectivePitchClass: toTarget.effectivePitchClass,
        tonality: toTarget.tonality,
      },
      pool,
      {
        excludeTrackIds: [...used],
        limit: 5,
        mode: 'playback',
        tolerance: store.pitchTolerance,
      },
    );

    return h(
      'div',
      { class: 'card stack stack--tight' },
      h('h3', {
        class: 'section-title',
        text: `Bridge from ${from.track.title} into ${to.track.title}`,
      }),
      bridgeList(suggestions, store.snapshot.settings.keyNotation, async (suggestion) => {
        // Insert the bridge between the two tracks.
        let next = addTracks(plan, [suggestion.entry.track.id]);
        next = moveTrack(next, suggestion.entry.track.id, index + 1);
        bridgeAt = null;
        await store.saveSetPlan(next);
      }),
    );
  }

  function trackRow(
    plan: SetPlan,
    entry: BagTrack,
    notation: 'camelot' | 'musical',
    layout: { ordered: boolean; index?: number; total?: number },
  ): HTMLElement {
    const bpm = formatBpm(entry.analysis);
    const key = formatKeyFor(entry.analysis, notation);

    return h(
      'div',
      { class: 'track-row', style: { cursor: 'default' } },
      h('span', {
        class: 'track-row__position',
        text: layout.ordered ? String((layout.index ?? 0) + 1) : entry.track.position,
      }),
      h(
        'div',
        { class: 'track-row__body' },
        h('div', { class: 'track-row__title', text: entry.track.title }),
        h('div', {
          class: 'track-row__sub',
          text: [entry.track.position, entry.release.artist, entry.release.title]
            .filter(Boolean)
            .join(' / '),
        }),
      ),
      h(
        'div',
        { class: 'track-row__aside' },
        bpm || key
          ? h(
              'div',
              { class: 'readout' },
              h('div', { class: 'readout__value', text: [bpm, key].filter(Boolean).join('  ') }),
            )
          : stateBadge(entry.analysis?.state ?? 'ANALYSE'),
        layout.ordered
          ? h(
              'div',
              { class: 'row', style: { gap: '4px' } },
              h('button', {
                class: 'button button--small button--ghost',
                type: 'button',
                'aria-label': `Move ${entry.track.title} earlier`,
                text: 'Up',
                disabled: layout.index === 0,
                onclick: () =>
                  void store.saveSetPlan(
                    moveTrack(plan, entry.track.id, (layout.index ?? 0) - 1),
                  ),
              }),
              h('button', {
                class: 'button button--small button--ghost',
                type: 'button',
                'aria-label': `Move ${entry.track.title} later`,
                text: 'Down',
                disabled: layout.index === (layout.total ?? 0) - 1,
                onclick: () =>
                  void store.saveSetPlan(
                    moveTrack(plan, entry.track.id, (layout.index ?? 0) + 1),
                  ),
              }),
            )
          : null,
        h('button', {
          class: 'button button--small button--ghost',
          type: 'button',
          'aria-label': `Remove ${entry.track.title} from set`,
          text: 'Remove',
          onclick: () => void store.saveSetPlan(removeTrack(plan, entry.track.id)),
        }),
      ),
    );
  }

  /**
   * Pick tracks from the bag into the plan.
   *
   * Rows are updated in place rather than re-rendered. Adding a set is a rapid
   * series of taps through a long list, and rebuilding every row on each tap
   * throws away the scroll position — which on a phone makes the list unusable.
   */
  function picker(pool: readonly BagTrack[], inPlan: Set<string>): HTMLElement {
    if (!pool.length) {
      return h(
        'div',
        { class: 'empty' },
        h('h2', { text: 'The bag is empty' }),
        h('p', { text: 'Pack some records into the bag first.' }),
      );
    }

    const notation = store.snapshot.settings.keyNotation;
    const chips = new Map<string, HTMLElement>();
    const rows = new Map<string, HTMLElement>();
    const chosen = new Set(inPlan);

    const summary = h('p', { class: 'field__hint' });
    const updateSummary = () => {
      summary.textContent = `${formatCount(pool.length, 'track')} in the bag, ${chosen.size} in the set. Tap to include.`;
    };

    const syncRow = (trackId: string) => {
      const included = chosen.has(trackId);
      const chip = chips.get(trackId);
      const row = rows.get(trackId);
      if (chip) chip.textContent = included ? 'In set' : 'Add';
      if (row) row.setAttribute('aria-pressed', String(included));
    };

    const list = h(
      'div',
      { class: 'list' },
      ...pool.map((entry) => {
        const trackId = entry.track.id;
        const bpm = formatBpm(entry.analysis);
        const key = formatKeyFor(entry.analysis, notation);
        const chip = h('span', { class: 'chip', text: chosen.has(trackId) ? 'In set' : 'Add' });
        chips.set(trackId, chip);

        const row = h(
          'button',
          {
            class: 'list-row',
            type: 'button',
            'aria-pressed': String(chosen.has(trackId)),
            'aria-label': `Toggle ${entry.track.title} in set`,
            onclick: async () => {
              // Update the UI first so the tap feels instant, then persist.
              if (chosen.has(trackId)) chosen.delete(trackId);
              else chosen.add(trackId);
              syncRow(trackId);
              updateSummary();

              const latest = store.getSetPlan(planId);
              if (latest) await store.saveSetPlan(toggleTrack(latest, trackId));
            },
          },
          chip,
          h(
            'div',
            { class: 'list-row__body' },
            h('div', { class: 'list-row__title', text: entry.track.title }),
            h('div', {
              class: 'list-row__sub',
              text: [entry.track.position, entry.release.title].filter(Boolean).join(' / '),
            }),
          ),
          h(
            'div',
            { class: 'list-row__aside' },
            h('span', { text: [bpm, key].filter(Boolean).join('  ') || 'no data' }),
          ),
        );
        rows.set(trackId, row);
        return row;
      }),
    );

    updateSummary();
    return h('div', { class: 'stack stack--tight' }, summary, list);
  }

  // The picker manages its own rows, so skip the global rebuild while it is
  // open; otherwise every tap would discard the list and its scroll position.
  const unsubscribe = store.subscribe(() => {
    if (!picking) render();
  });
  render();

  return { element, destroy: () => unsubscribe() };
}
