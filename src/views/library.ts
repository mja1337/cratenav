import type { Release } from '@/domain/types';
import type { Store } from '@/app/store';
import type { Router } from '@/app/router';
import type { View } from './types';
import { cover } from '@/components/cover';
import { stat } from '@/components/badges';
import { artworkUrl, formatBpm, formatCount, formatKeyFor } from '@/components/format';
import { formatCamelot } from '@/harmonic/camelot';
import { icon } from '@/components/icons';
import { clear, h } from '@/utils/dom';
import { hasUnconfirmedAnalysis } from '@/analysis/verification';

/**
 * Collection browser. Spec §7.
 *
 * Three ways to look at the same records, because browsing vinyl is a visual,
 * tactile act rather than a spreadsheet query:
 *   grid   cover-art wall, the default
 *   list   dense, for scanning catalogue numbers and BPM
 *   crate  horizontal flick-through, closest to thumbing a real crate
 */

type ViewMode = 'grid' | 'list' | 'crate';
type SortMode = 'artist' | 'title' | 'year-desc' | 'year-asc' | 'added';

const VIEW_MODE_KEY = 'cratenav.libraryView';
const SORT_KEY = 'cratenav.librarySort';

/** Spec §7's useful filters, as far as the data we hold supports them. */
interface Filters {
  query: string;
  style: string | null;
  needsMetadata: boolean;
  needsAnalysis: boolean;
  verifiedOnly: boolean;
  unconfirmedAnalysis: boolean;
  inActiveBag: boolean;
  /** Inclusive canonical-BPM window, or null for no constraint. */
  bpmBand: [number, number] | null;
  camelot: string | null;
}

export function createLibraryView(store: Store, router: Router): View {
  const element = h('div', { class: 'container stack' });

  let mode = (localStorage.getItem(VIEW_MODE_KEY) as ViewMode | null) ?? 'grid';
  let sort = (localStorage.getItem(SORT_KEY) as SortMode | null) ?? 'artist';
  const filters: Filters = {
    query: '',
    style: null,
    needsMetadata: false,
    needsAnalysis: false,
    verifiedOnly: false,
    unconfirmedAnalysis: false,
    inActiveBag: false,
    bpmBand: null,
    camelot: null,
  };

  const results = h('div', { class: 'stack' });
  const summary = h('p', { class: 'field__hint', role: 'status', 'aria-live': 'polite' });

  // --- search + controls ---------------------------------------------------

  const search = h('input', {
    id: 'collection-search',
    name: 'collectionSearch',
    class: 'input',
    type: 'search',
    placeholder: 'Search artist, title, label, cat no',
    'aria-label': 'Search collection',
    autocomplete: 'off',
    oninput: (event: Event) => {
      filters.query = (event.target as HTMLInputElement).value;
      render();
    },
  });

  const modeButton = (target: ViewMode, label: string, iconName: 'grid' | 'list' | 'crate') =>
    h(
      'button',
      {
        class: 'icon-button',
        type: 'button',
        'aria-pressed': String(mode === target),
        'aria-label': `${label} view`,
        title: `${label} view`,
        onclick: () => {
          mode = target;
          localStorage.setItem(VIEW_MODE_KEY, target);
          render();
        },
      },
      icon(iconName),
    );

  const sortSelect = h(
    'select',
    {
      id: 'collection-sort',
      name: 'collectionSort',
      class: 'select',
      'aria-label': 'Sort collection',
      style: { maxWidth: '150px' },
      onchange: (event: Event) => {
        sort = (event.target as HTMLSelectElement).value as SortMode;
        localStorage.setItem(SORT_KEY, sort);
        render();
      },
    },
    ...(
      [
        ['artist', 'Artist'],
        ['title', 'Title'],
        ['year-desc', 'Newest'],
        ['year-asc', 'Oldest'],
        ['added', 'Recently added'],
      ] as [SortMode, string][]
    ).map(([value, label]) => h('option', { value, text: label, selected: sort === value })),
  );

  const filterRow = h('div', { class: 'toolbar__filters' });

  const toolbar = h(
    'div',
    { class: 'toolbar' },
    h(
      'div',
      { class: 'toolbar__controls' },
      search,
      sortSelect,
      modeButton('grid', 'Grid', 'grid'),
      modeButton('list', 'List', 'list'),
      modeButton('crate', 'Crate', 'crate'),
    ),
    filterRow,
  );

  // --- rendering -----------------------------------------------------------

  /** Release ids with at least one copy in the active bag. */
  function packedReleaseIds(): Set<string> {
    const bag = store.activeBag;
    if (!bag) return new Set();
    const packed = new Set(bag.collectionItemIds);
    const ids = new Set<string>();
    for (const item of store.snapshot.library.items) {
      if (!packed.has(item.id) || !item.inCollection) continue;
      const release = store.snapshot.library.releases.find(
        (candidate) => candidate.discogsReleaseId === item.discogsReleaseId,
      );
      if (release) ids.add(release.id);
    }
    return ids;
  }

  function topStyles(releases: readonly Release[]): string[] {
    const counts = new Map<string, number>();
    for (const release of releases) {
      for (const style of release.styles) {
        counts.set(style, (counts.get(style) ?? 0) + 1);
      }
    }
    return [...counts.entries()]
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .slice(0, 12)
      .map(([style]) => style);
  }

  function matches(release: Release): boolean {
    if (filters.style && !release.styles.includes(filters.style)) return false;
    if (filters.needsMetadata && release.hydrationState === 'hydrated') return false;

    // Track-level filters pass if ANY track on the record qualifies: you pull
    // out the whole record, so one matching side is enough reason to show it.
    const tracks = store.tracksFor(release.id);
    const analyses = tracks.map((track) => store.analysisFor(track.id));

    if (filters.needsAnalysis) {
      const anyGap =
        !tracks.length ||
        analyses.some((a) => a?.canonicalBpm === undefined || a?.camelotKey === undefined);
      if (!anyGap) return false;
    }
    if (filters.verifiedOnly && !analyses.some((a) => a?.verifiedBpm || a?.verifiedKey)) {
      return false;
    }
    if (filters.unconfirmedAnalysis && !analyses.some(hasUnconfirmedAnalysis)) return false;
    if (filters.bpmBand) {
      const [min, max] = filters.bpmBand;
      if (!analyses.some((a) => a?.canonicalBpm !== undefined && a.canonicalBpm >= min && a.canonicalBpm <= max)) {
        return false;
      }
    }
    if (filters.camelot) {
      if (!analyses.some((a) => a?.camelotKey && formatCamelot(a.camelotKey) === filters.camelot)) {
        return false;
      }
    }
    if (filters.inActiveBag && !packedReleaseIds().has(release.id)) return false;

    const query = filters.query.trim().toLowerCase();
    if (!query) return true;

    // Search covers the fields a DJ actually looks a record up by, including
    // track titles: you often remember the tune, not the sleeve.
    const haystack = [
      release.artist,
      release.title,
      release.label ?? '',
      release.catalogueNumber ?? '',
      release.year ? String(release.year) : '',
      ...release.styles,
      ...store.tracksFor(release.id).flatMap((track) => [track.title, track.mixVersion ?? '']),
    ]
      .join('  ')
      .toLowerCase();

    // Every whitespace-separated term must appear somewhere.
    return query.split(/\s+/).every((term) => haystack.includes(term));
  }

  function sorted(releases: Release[]): Release[] {
    const copy = [...releases];
    switch (sort) {
      case 'title':
        return copy.sort((a, b) => a.title.localeCompare(b.title));
      case 'year-desc':
        return copy.sort(
          (a, b) => (b.year ?? 0) - (a.year ?? 0) || a.artistSort.localeCompare(b.artistSort),
        );
      case 'year-asc':
        return copy.sort(
          (a, b) => (a.year ?? 9999) - (b.year ?? 9999) || a.artistSort.localeCompare(b.artistSort),
        );
      case 'added': {
        const addedFor = (release: Release) =>
          store.itemsFor(release.discogsReleaseId)[0]?.dateAdded ?? '';
        return copy.sort((a, b) => addedFor(b).localeCompare(addedFor(a)));
      }
      default:
        return copy.sort(
          (a, b) => a.artistSort.localeCompare(b.artistSort) || a.title.localeCompare(b.title),
        );
    }
  }

  function releaseCard(release: Release): HTMLElement {
    const tracks = store.tracksFor(release.id);
    const sleeve = store.sleeveColorForRelease(release.discogsReleaseId);
    const artwork = cover(
      artworkUrl(release.artwork, 'thumb'),
      `${release.artist} - ${release.title}`,
      { className: sleeve ? 'cover--replacement-sleeve' : undefined },
    );
    if (sleeve) artwork.style.borderColor = sleeve.hex;
    const meta = [release.year ? String(release.year) : null, release.catalogueNumber]
      .filter(Boolean)
      .join(' / ');

    return h(
      'button',
      {
        class: 'release-card',
        title: sleeve ? `${sleeve.name} replacement sleeve` : undefined,
        type: 'button',
        'aria-label': `${release.artist} - ${release.title}${release.year ? `, ${release.year}` : ''}`,
        onclick: () => router.navigate(`release/${release.id}`),
      },
      artwork,
      h('div', { class: 'release-card__title', text: release.title }),
      h('div', { class: 'release-card__artist', text: release.artist }),
      h(
        'div',
        { class: 'release-card__meta' },
        meta ? h('span', { text: meta }) : null,
        tracks.length
          ? h('span', { text: `${tracks.length}tk` })
          : release.hydrationState === 'stub'
            ? h('span', { text: 'no tracklist', title: 'Tracklist not imported yet' })
            : null,
        sleeve ? h('span', { text: `${sleeve.name} sleeve` }) : null,
      ),
    );
  }

  function releaseRow(release: Release): HTMLElement {
    const tracks = store.tracksFor(release.id);
    const sleeve = store.sleeveColorForRelease(release.discogsReleaseId);
    const artwork = cover(
      artworkUrl(release.artwork, 'thumb'),
      `${release.artist} - ${release.title}`,
      { className: sleeve ? 'cover--replacement-sleeve' : undefined },
    );
    if (sleeve) artwork.style.borderColor = sleeve.hex;
    const notation = store.snapshot.settings.keyNotation;

    // Show the first analysed track's readout as a hint of the record's range.
    const analysed = tracks
      .map((track) => store.analysisFor(track.id))
      .find((analysis) => analysis?.canonicalBpm !== undefined);

    const bpm = formatBpm(analysed);
    const key = formatKeyFor(analysed, notation);

    return h(
      'button',
      {
        class: 'list-row',
        title: sleeve ? `${sleeve.name} replacement sleeve` : undefined,
        type: 'button',
        'aria-label': `${release.artist} - ${release.title}${release.year ? `, ${release.year}` : ''}`,
        onclick: () => router.navigate(`release/${release.id}`),
      },
      artwork,
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
        h('span', { text: bpm ? `${bpm} BPM` : `${tracks.length || 0} tk` }),
        key ? h('span', { text: key }) : null,
        sleeve ? h('span', { text: `${sleeve.name} sleeve` }) : null,
      ),
    );
  }

  function render(): void {
    const releases = store.ownedReleases;

    // Filter chips are rebuilt from what is actually in the library.
    clear(filterRow);
    const styles = topStyles(releases);
    const toggle = (label: string, active: boolean, apply: () => void, title?: string) =>
      h('button', {
        class: 'chip',
        type: 'button',
        'aria-pressed': String(active),
        title,
        text: label,
        onclick: () => {
          apply();
          render();
        },
      });

    const bag = store.activeBag;
    filterRow.append(
      toggle('Needs metadata', filters.needsMetadata, () => {
        filters.needsMetadata = !filters.needsMetadata;
      }),
      toggle('Needs analysis', filters.needsAnalysis, () => {
        filters.needsAnalysis = !filters.needsAnalysis;
      }),
      toggle('Verified', filters.verifiedOnly, () => {
        filters.verifiedOnly = !filters.verifiedOnly;
      }),
      toggle('Unconfirmed analysis', filters.unconfirmedAnalysis, () => {
        filters.unconfirmedAnalysis = !filters.unconfirmedAnalysis;
      }, 'Records with online or analysed BPM/key evidence that still needs confirmation'),
      ...(bag
        ? [
            toggle(
              `In ${bag.name}`,
              filters.inActiveBag,
              () => {
                filters.inActiveBag = !filters.inActiveBag;
              },
              'Only records packed in the active bag',
            ),
          ]
        : []),
      // Tempo bands drawn from the styles this collection actually contains.
      ...(
        [
          ['110-132', [110, 132]],
          ['133-150', [133, 150]],
          ['155-190', [155, 190]],
        ] as [string, [number, number]][]
      ).map(([label, band]) =>
        toggle(
          `${label} BPM`,
          filters.bpmBand?.[0] === band[0],
          () => {
            filters.bpmBand = filters.bpmBand?.[0] === band[0] ? null : band;
          },
        ),
      ),
    );

    if (styles.length) {
      filterRow.append(
        ...styles.map((style) =>
          h('button', {
            class: 'chip',
            type: 'button',
            'aria-pressed': String(filters.style === style),
            onclick: () => {
              filters.style = filters.style === style ? null : style;
              render();
            },
            text: style,
          }),
        ),
      );
    }

    const visible = sorted(releases.filter(matches));

    clear(results);

    if (!releases.length) {
      results.append(emptyLibrary(router));
      summary.textContent = '';
      return;
    }

    // The dashboard is the resting state of the library: it appears only when
    // nothing is filtered, so it never competes with search results. Spec §31.
    const resting =
      !filters.query.trim() &&
      !filters.style &&
      !filters.needsMetadata &&
      !filters.needsAnalysis &&
      !filters.verifiedOnly &&
      !filters.unconfirmedAnalysis &&
      !filters.inActiveBag &&
      !filters.bpmBand;
    if (resting) results.append(dashboard(store, router));

    summary.textContent =
      visible.length === releases.length
        ? formatCount(releases.length, 'record')
        : `${formatCount(visible.length, 'record')} of ${releases.length}`;

    if (!visible.length) {
      results.append(
        h(
          'div',
          { class: 'empty' },
          h('h2', { text: 'Nothing matches' }),
          h('p', { text: 'Try a different search, or clear the filters.' }),
          h('button', {
            class: 'button',
            type: 'button',
            text: 'Clear filters',
            onclick: () => {
              filters.query = '';
              filters.style = null;
              filters.needsMetadata = false;
              filters.needsAnalysis = false;
              filters.verifiedOnly = false;
              filters.unconfirmedAnalysis = false;
              filters.inActiveBag = false;
              filters.bpmBand = null;
              filters.camelot = null;
              search.value = '';
              render();
            },
          }),
        ),
      );
      return;
    }

    if (mode === 'list') {
      results.append(h('div', { class: 'list' }, ...visible.map(releaseRow)));
    } else {
      results.append(
        h('div', { class: mode === 'crate' ? 'crate' : 'grid' }, ...visible.map(releaseCard)),
      );
    }
  }

  element.append(toolbar, summary, results);

  const unsubscribe = store.subscribe(() => render());
  render();

  return {
    element,
    destroy: () => unsubscribe(),
  };
}

/**
 * Compact dashboard. Spec §31.
 *
 * Folded into the top of the library rather than given its own nav tab: the
 * spec's nav options are already five wide, and a sixth would cost more in
 * thumb reach than the summary is worth.
 */
function dashboard(store: Store, router: Router): HTMLElement {
  const releases = store.ownedReleases;
  const tracks = store.visibleTracks;
  const trackIds = new Set(tracks.map((track) => track.id));
  const analyses = store.snapshot.library.analyses.filter((analysis) => trackIds.has(analysis.trackId));
  const verified = analyses.filter((a) => a.verifiedBpm || a.verifiedKey).length;
  const analysed = analyses.filter(
    (a) => a.canonicalBpm !== undefined || a.camelotKey !== undefined,
  ).length;
  const bag = store.activeBag;
  const bagTracks = bag ? store.resolveBagTracks(bag).length : 0;

  const action = (label: string, route: string, primary = false) =>
    h('button', {
      class: `button button--small${primary ? ' button--primary' : ''}`,
      type: 'button',
      text: label,
      onclick: () => router.navigate(route),
    });

  return h(
    'div',
    { class: 'dash' },
    h(
      'div',
      { class: 'stats' },
      stat(releases.length, 'Records'),
      stat(tracks.length, 'Tracks'),
      stat(analysed, 'Analysed'),
      stat(verified, 'Verified'),
      stat(Math.max(0, tracks.length - analysed), 'Needs analysis'),
      ...(bag ? [stat(bagTracks, 'In the bag')] : []),
    ),
    h('p', {
      class: 'field__hint',
      text: bag
        ? `Active bag: ${bag.name} — ${formatCount(bag.collectionItemIds.length, 'record')}.`
        : 'No active bag. Build one on the Bag tab to scope planning and suggestions.',
    }),
    h(
      'div',
      { class: 'dash__actions' },
      action('Sync Discogs', 'settings'),
      bag ? action('Open active bag', `bag/${bag.id}`, true) : action('Build a bag', 'bag', true),
      action('Analyse next', 'analyse'),
      action('Sticker run', 'sticker'),
    ),
  );
}

function emptyLibrary(router: Router): HTMLElement {
  return h(
    'div',
    { class: 'empty' },
    h('div', { class: 'cover cover--empty', style: { width: '96px', borderRadius: '50%' } }),
    h('h2', { text: 'No records yet' }),
    h('p', {
      text: 'Connect your Discogs collection to pull in your records, sleeve art and tracklists.',
    }),
    h(
      'button',
      {
        class: 'button button--primary',
        type: 'button',
        onclick: () => router.navigate('settings'),
      },
      icon('sync'),
      'Import from Discogs',
    ),
  );
}
