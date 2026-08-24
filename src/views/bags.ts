import type { Bag } from '@/domain/types';
import type { Store } from '@/app/store';
import type { Router } from '@/app/router';
import type { View } from './types';
import { analyseCoverage } from '@/bags/coverage';
import {
  createBag,
  duplicateBag,
  renameBag,
  setBagStatus,
  sortBags,
  toggleInBag,
} from '@/bags/operations';
import { createSetPlan } from '@/sets/operations';
import { coveragePanel } from '@/components/coverage-panel';
import { formatCount, formatRelativeTime } from '@/components/format';
import { icon } from '@/components/icons';
import { clear, h, mount } from '@/utils/dom';

/**
 * Bag list. Spec §18.
 *
 * A bag is what is physically going to a gig, so this is the screen that
 * answers "what am I taking tonight" and sets the scope everything else uses.
 */
export function createBagListView(store: Store, router: Router): View {
  const element = h('div', { class: 'container stack' });

  function bagCard(bag: Bag): HTMLElement {
    const entries = store.resolveBagTracks(bag);
    const coverage = analyseCoverage(entries);
    const isActive = bag.status === 'active';

    return h(
      'button',
      {
        class: `bag-card${isActive ? ' bag-card--active' : ''}`,
        type: 'button',
        'aria-label': `${bag.name}, ${formatCount(bag.collectionItemIds.length, 'record')}`,
        onclick: () => router.navigate(`bag/${bag.id}`),
      },
      h(
        'div',
        { class: 'row' },
        h('span', { class: 'bag-card__name', text: bag.name, style: { flex: '1' } }),
        // Status is spelled out, not just implied by the highlight. §43
        isActive
          ? h('span', { class: 'state state--READY', text: 'active' })
          : bag.status === 'archived'
            ? h('span', { class: 'chip', text: 'archived' })
            : null,
      ),
      h(
        'div',
        { class: 'bag-card__meta' },
        h('span', { text: formatCount(bag.collectionItemIds.length, 'record') }),
        h('span', { text: formatCount(coverage.tracks, 'track') }),
        coverage.bpm
          ? h('span', { text: `${coverage.bpm.min}-${coverage.bpm.max} BPM` })
          : null,
        coverage.needsAnalysis
          ? h('span', { text: `${coverage.needsAnalysis} need analysis` })
          : null,
      ),
      bag.eventDate || bag.description
        ? h('div', {
            class: 'field__hint',
            text: [bag.eventDate, bag.description].filter(Boolean).join(' / '),
          })
        : h('div', {
            class: 'field__hint',
            text: `Updated ${formatRelativeTime(bag.updatedAt) ?? 'recently'}`,
          }),
    );
  }

  const newBagButton = h(
    'button',
    {
      class: 'button button--primary',
      type: 'button',
      onclick: async () => {
        const name = window.prompt('Name this bag', suggestName());
        if (name === null) return;
        const bag = createBag({ name });
        await store.saveBag(bag);
        router.navigate(`bag/${bag.id}`);
      },
    },
    icon('bag'),
    'New bag',
  );

  function render(): void {
    const bags = sortBags(store.bags);
    clear(element);

    if (!store.ownedReleases.length) {
      mount(
        element,
        h(
          'div',
          { class: 'empty' },
          h('h2', { text: 'Import your collection first' }),
          h('p', {
            text: 'A bag is built from records you own, so bring your Discogs collection in before packing one.',
          }),
          h('button', {
            class: 'button button--primary',
            type: 'button',
            text: 'Go to Discogs import',
            onclick: () => router.navigate('settings'),
          }),
        ),
      );
      return;
    }

    if (!bags.length) {
      mount(
        element,
        h(
          'div',
          { class: 'empty' },
          h('h2', { text: 'No bags yet' }),
          h('p', {
            text: 'A bag is the stack of records you are actually taking somewhere. Build one and it becomes the scope for planning and suggestions.',
          }),
          newBagButton,
        ),
      );
      return;
    }

    mount(
      element,
      h('div', { class: 'row' }, h('div', { class: 'spacer' }), newBagButton),
      h('div', { class: 'stack' }, ...bags.map(bagCard)),
      h('p', {
        class: 'field__hint',
        text: 'The active bag is the default scope for suggestions and, later, Live mode.',
      }),
    );
  }

  const unsubscribe = store.subscribe(render);
  render();

  return { element, destroy: () => unsubscribe() };
}

/** A gig-shaped default, since most bags are named after the night. */
function suggestName(): string {
  const date = new Date();
  return date.toLocaleDateString('en-GB', { weekday: 'long' });
}

/**
 * Bag detail: coverage, contents and set plans. Spec §18, §19, §20.
 */
export function createBagDetailView(store: Store, router: Router, bagId: string): View {
  const element = h('div', { class: 'container stack' });
  let tab: 'coverage' | 'records' | 'sets' = 'coverage';

  function render(): void {
    const bag = store.getBag(bagId);
    clear(element);

    if (!bag) {
      mount(
        element,
        h(
          'div',
          { class: 'empty' },
          h('h2', { text: 'Bag not found' }),
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

    mount(element, actionsBar(store, router, bag), tabs(), body(bag));
  }

  function tabs(): HTMLElement {
    const button = (id: typeof tab, label: string) =>
      h('button', {
        type: 'button',
        role: 'tab',
        'aria-selected': String(tab === id),
        text: label,
        onclick: () => {
          tab = id;
          render();
        },
      });

    return h(
      'div',
      { class: 'tabs', role: 'tablist' },
      button('coverage', 'Coverage'),
      button('records', 'Records'),
      button('sets', 'Sets'),
    );
  }

  function body(bag: Bag): HTMLElement {
    switch (tab) {
      case 'records':
        return recordsTab(store, router, bag, render);
      case 'sets':
        return setsTab(store, router, bag);
      default:
        return coverageTab(store, bag);
    }
  }

  const unsubscribe = store.subscribe(render);
  render();

  return { element, destroy: () => unsubscribe() };
}

function actionsBar(store: Store, router: Router, bag: Bag): HTMLElement {
  const isActive = bag.status === 'active';

  return h(
    'div',
    { class: 'row row--wrap' },
    isActive
      ? h('span', { class: 'state state--READY', text: 'active bag' })
      : h(
          'button',
          {
            class: 'button button--primary button--small',
            type: 'button',
            onclick: () => void store.activateBag(bag.id),
          },
          'Make active',
        ),
    h('button', {
      class: 'button button--small',
      type: 'button',
      text: 'Rename',
      onclick: async () => {
        const name = window.prompt('Rename bag', bag.name);
        if (!name) return;
        await store.saveBag(renameBag(bag, name));
      },
    }),
    h('button', {
      class: 'button button--small',
      type: 'button',
      text: 'Duplicate',
      title: 'Copy this bag to reuse the selection',
      onclick: async () => {
        const copy = duplicateBag(bag);
        await store.saveBag(copy);
        router.navigate(`bag/${copy.id}`);
      },
    }),
    h('button', {
      class: 'button button--small',
      type: 'button',
      text: bag.status === 'archived' ? 'Unarchive' : 'Archive',
      onclick: async () => {
        await store.saveBag(setBagStatus(bag, bag.status === 'archived' ? 'planning' : 'archived'));
      },
    }),
    h('div', { class: 'spacer' }),
    h('button', {
      class: 'button button--small button--danger',
      type: 'button',
      text: 'Delete',
      onclick: async () => {
        if (!window.confirm(`Delete "${bag.name}"? The records and their analysis are untouched.`)) {
          return;
        }
        await store.deleteBag(bag);
        router.navigate('bag');
      },
    }),
  );
}

function coverageTab(store: Store, bag: Bag): HTMLElement {
  const entries = store.resolveBagTracks(bag);

  if (!entries.length) {
    return h(
      'div',
      { class: 'empty' },
      h('h2', { text: 'Nothing packed yet' }),
      h('p', { text: 'Add records on the Records tab and the coverage picture appears here.' }),
    );
  }

  return coveragePanel(analyseCoverage(entries), store.snapshot.settings.keyNotation);
}

/**
 * Records tab: what is in the bag, plus a picker to add more.
 * The picker searches the whole collection; the bag is the subset.
 */
function recordsTab(store: Store, router: Router, bag: Bag, refresh: () => void): HTMLElement {
  const inBag = store.bagItemIds(bag);
  const container = h('div', { class: 'stack' });
  let query = '';
  let showAll = false;

  const search = h('input', {
    id: `bag-${bag.id}-collection-search`,
    name: 'bagCollectionSearch',
    class: 'input',
    type: 'search',
    placeholder: 'Search your collection to add records',
    'aria-label': 'Search collection',
    oninput: (event: Event) => {
      query = (event.target as HTMLInputElement).value;
      showAll = query.trim().length > 0;
      renderList();
    },
  });

  const list = h('div', { class: 'list' });

  function renderList(): void {
    const { items, releases } = store.snapshot.library;
    const releaseByDiscogsId = new Map(releases.map((r) => [r.discogsReleaseId, r]));
    const needle = query.trim().toLowerCase();

    const candidates = items
      .filter((item) => item.inCollection)
      .map((item) => ({ item, release: releaseByDiscogsId.get(item.discogsReleaseId) }))
      .filter((row): row is { item: typeof row.item; release: NonNullable<typeof row.release> } =>
        Boolean(row.release),
      )
      .filter(({ item, release }) => {
        if (!showAll && !inBag.has(item.id)) return false;
        if (!needle) return true;
        return `${release.artist} ${release.title} ${release.catalogueNumber ?? ''} ${release.label ?? ''}`
          .toLowerCase()
          .includes(needle);
      })
      .sort((a, b) => a.release.artistSort.localeCompare(b.release.artistSort))
      .slice(0, 200);

    clear(list);

    if (!candidates.length) {
      list.append(
        h('p', {
          class: 'field__hint',
          text: needle
            ? 'No records match that search.'
            : 'Nothing packed yet. Search above to add records.',
        }),
      );
      return;
    }

    for (const { item, release } of candidates) {
      const packed = inBag.has(item.id);
      const trackCount = store.tracksFor(release.id).length;

      list.append(
        h(
          'div',
          { class: 'list-row', style: { cursor: 'default' } },
          h('button', {
            class: `button button--small${packed ? '' : ' button--ghost'}`,
            type: 'button',
            'aria-pressed': String(packed),
            'aria-label': packed ? `Remove ${release.title} from bag` : `Add ${release.title} to bag`,
            text: packed ? 'In bag' : 'Add',
            onclick: async () => {
              const next = toggleInBag(bag, item.id);
              // Keep the local set in step so the list does not flicker.
              if (packed) inBag.delete(item.id);
              else inBag.add(item.id);
              await store.saveBag(next);
              refresh();
            },
          }),
          h(
            'div',
            { class: 'list-row__body' },
            h('div', { class: 'list-row__title', text: release.title }),
            h('div', {
              class: 'list-row__sub',
              text: [release.artist, release.catalogueNumber, release.year].filter(Boolean).join(' / '),
            }),
          ),
          h(
            'div',
            { class: 'list-row__aside' },
            h('span', { text: `${trackCount} tk` }),
            h('button', {
              class: 'button button--small button--ghost',
              type: 'button',
              text: 'Open',
              onclick: () => router.navigate(`release/${release.id}`),
            }),
          ),
        ),
      );
    }
  }

  container.append(
    search,
    h('p', {
      class: 'field__hint',
      text: showAll
        ? 'Showing collection matches. Tap Add to pack a record.'
        : `${formatCount(inBag.size, 'record')} packed. Search to add more.`,
    }),
    list,
  );
  renderList();
  return container;
}

function setsTab(store: Store, router: Router, bag: Bag): HTMLElement {
  const plans = store.setPlansForBag(bag.id);

  const newPlan = h(
    'button',
    {
      class: 'button button--primary',
      type: 'button',
      onclick: async () => {
        const name = window.prompt('Name this set', `${bag.name} set`);
        if (name === null) return;
        const plan = createSetPlan({ name, bagId: bag.id });
        await store.saveSetPlan(plan);
        router.navigate(`set/${plan.id}`);
      },
    },
    'New set plan',
  );

  if (!plans.length) {
    return h(
      'div',
      { class: 'empty' },
      h('h2', { text: 'No set plans' }),
      h('p', {
        text: 'A set plan is optional. The bag itself is already the universe of what you can play tonight.',
      }),
      newPlan,
    );
  }

  return h(
    'div',
    { class: 'stack' },
    h('div', { class: 'row' }, h('div', { class: 'spacer' }), newPlan),
    h(
      'div',
      { class: 'list' },
      ...plans.map((plan) =>
        h(
          'button',
          {
            class: 'list-row',
            type: 'button',
            'aria-label': `${plan.name}, ${plan.mode}`,
            onclick: () => router.navigate(`set/${plan.id}`),
          },
          h('span', { class: 'chip', text: plan.mode }),
          h(
            'div',
            { class: 'list-row__body' },
            h('div', { class: 'list-row__title', text: plan.name }),
            h('div', {
              class: 'list-row__sub',
              text: formatCount(plan.trackIds.length, 'track'),
            }),
          ),
          h('div', { class: 'list-row__aside' }, h('span', { text: 'Open' })),
        ),
      ),
    ),
  );
}
