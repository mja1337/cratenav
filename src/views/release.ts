import type { CollectionItem, Release, Track } from '@/domain/types';
import type { Store } from '@/app/store';
import type { Router } from '@/app/router';
import type { View } from './types';
import { cover } from '@/components/cover';
import { analysisState, chip, stateBadge } from '@/components/badges';
import {
  artworkUrl,
  formatBpm,
  formatDuration,
  formatKeyFor,
  formatRelativeTime,
} from '@/components/format';
import { icon } from '@/components/icons';
import { addToBag, removeFromBag, sortBags } from '@/bags/operations';
import { clear, h } from '@/utils/dom';
import { deduplicateReferences } from '@/discogs/references';
import {
  isTrackAvailableOnAnyItem,
  physicalRecordsForRelease,
  recordNumberForTrack,
} from '@/discogs/physical-records';

/**
 * Release detail. Spec §7: every release drills into its tracks, and BPM/key
 * live at track level, never on the release as a whole.
 */
export function createReleaseView(store: Store, router: Router, releaseId: string): View {
  const release = store.getRelease(releaseId);

  if (!release) {
    return {
      element: h(
        'div',
        { class: 'container empty' },
        h('h2', { text: 'Record not found' }),
        h('p', { text: 'It may have been removed from the local library.' }),
        h('button', {
          class: 'button',
          type: 'button',
          text: 'Back to collection',
          onclick: () => router.navigate('library'),
        }),
      ),
    };
  }

  const element = h('div', { class: 'container stack' });

  function render(): void {
    const current = store.getRelease(releaseId) ?? release!;
    const tracks = store.tracksFor(current.id);
    const items = store.itemsFor(current.discogsReleaseId);

    clear(element);
    element.append(
      hero(current),
      bagBlock(store, current),
      ...sleeveBlock(store, current),
      ...missingRecordsBlock(store, current, tracks),
      ...(current.hydrationState === 'stub' ? [pendingBanner()] : []),
      ...(current.hydrationState === 'failed' ? [failedBanner(current)] : []),
      detailBlock(current, items),
      tracklistBlock(store, router, current, tracks),
      ...(current.identifiers.length ? [identifiersBlock(current)] : []),
      ...(current.references.length ? [referencesBlock(current)] : []),
      ...(current.releaseNotes ? [notesBlock(current.releaseNotes)] : []),
      provenanceBlock(current),
      // Destructive collection actions belong after all useful release
      // content, where they cannot be mistaken for a primary workflow.
      ...collectionManagement(store, router, current),
    );
  }

  const unsubscribe = store.subscribe(render);
  render();

  return { element, destroy: () => unsubscribe() };
}

/** Missing discs belong to a physical copy, just like replacement sleeves. */
function missingRecordsBlock(
  store: Store,
  release: Release,
  tracks: readonly Track[],
): HTMLElement[] {
  const owned = store.itemsFor(release.discogsReleaseId).filter((item) => item.inCollection);
  const records = physicalRecordsForRelease(release, tracks);
  if (!owned.length || records.length < 2) return [];

  return [
    h(
      'div',
      { class: 'card stack stack--tight' },
      h('h2', { class: 'section-title', text: 'Records in this release' }),
      h('p', {
        class: 'field__hint',
        text: 'Mark a physical disc as missing. Its tracks stay in the catalogue, but are excluded from Analyse, bags, set plans, stickers and suggestions.',
      }),
      ...owned
        .sort((a, b) => (a.copyIndex ?? 0) - (b.copyIndex ?? 0))
        .map((item, index) =>
          h(
            'div',
            { class: 'stack stack--tight' },
            h('span', {
              class: 'field__label',
              text: owned.length > 1 ? `Copy ${index + 1}` : 'Physical records',
            }),
            h(
              'div',
              { class: 'row row--wrap' },
              ...records.map((record) => {
                const missing = (item.missingRecordNumbers ?? []).includes(record.number);
                const sides = record.sides.length ? ` · sides ${record.sides.join(' / ')}` : '';
                return h('button', {
                  class: 'chip',
                  type: 'button',
                  'aria-pressed': String(missing),
                  'aria-label': `Record ${record.number}${sides}${missing ? ', missing' : ', available'}`,
                  text: `Record ${record.number}${sides} — ${missing ? 'Missing' : 'Available'}`,
                  onclick: () => void store.setRecordMissing(item.id, record.number, !missing),
                });
              }),
            ),
          ),
        ),
    ),
  ];
}

function collectionManagement(store: Store, router: Router, release: Release): HTMLElement[] {
  const owned = store.itemsFor(release.discogsReleaseId).filter((item) => item.inCollection);
  if (!owned.length) return [];
  const copies = owned.length === 1 ? 'this copy' : `all ${owned.length} copies`;

  return [
    h(
      'div',
      { class: 'card stack stack--tight' },
      h('h2', { class: 'section-title', text: 'Collection management' }),
      h('p', {
        class: 'field__hint',
        text: 'Removing a release hides it from Collection, bags and analysis queues. Its metadata, BPM and key history remain stored locally.',
      }),
      h('button', {
        class: 'button button--danger button--small',
        type: 'button',
        text: owned.length === 1 ? 'Remove from collection' : `Remove all ${owned.length} copies`,
        onclick: async () => {
          const confirmed = window.confirm(
            `Remove ${copies} of “${release.artist} — ${release.title}” from cratenav?\n\n` +
              'Analysis is kept. If the release is still present in Discogs, the next collection sync will restore it.',
          );
          if (!confirmed) return;
          const removed = await store.removeReleaseFromCollection(release.discogsReleaseId);
          if (!removed) return;
          store.notify('info', `${removed === 1 ? 'Release' : `${removed} copies`} removed from the local collection.`);
          router.navigate('library');
        },
      }),
    ),
  ];
}

/** Replacement sleeve assignment is per physical copy, not per catalogue release. */
function sleeveBlock(store: Store, release: Release): HTMLElement[] {
  const owned = store.itemsFor(release.discogsReleaseId).filter((item) => item.inCollection);
  if (!owned.length) return [];
  const palette = store.sleeveColors;

  return [
    h(
      'div',
      { class: 'card stack stack--tight' },
      h('h2', { class: 'section-title', text: 'Replacement sleeve' }),
      h('p', {
        class: 'field__hint',
        text: 'Mark the physical card sleeve so this record is easier to find on the shelf.',
      }),
      ...owned
        .sort((a, b) => (a.copyIndex ?? 0) - (b.copyIndex ?? 0))
        .map((item, index) =>
          h(
            'div',
            { class: 'stack stack--tight' },
            h('span', {
              class: 'field__label',
              text: owned.length > 1 ? `Copy ${index + 1}` : 'Sleeve colour',
            }),
            h(
              'div',
              { class: 'row row--wrap' },
              h('button', {
                class: 'chip',
                type: 'button',
                'aria-pressed': String(!item.sleeveColorId),
                text: 'Original / unset',
                onclick: () => void store.setSleeveColor(item.id, undefined),
              }),
              ...palette.map((color) =>
                h(
                  'button',
                  {
                    class: 'chip',
                    type: 'button',
                    'aria-pressed': String(item.sleeveColorId === color.id),
                    'aria-label': `${color.name} replacement sleeve`,
                    onclick: () => void store.setSleeveColor(item.id, color.id),
                  },
                  h('span', {
                    'aria-hidden': 'true',
                    style: {
                      display: 'inline-block',
                      width: '12px',
                      height: '12px',
                      marginRight: '6px',
                      borderRadius: '50%',
                      backgroundColor: color.hex,
                      border: '1px solid currentColor',
                    },
                  }),
                  color.name,
                ),
              ),
            ),
          ),
        ),
    ),
  ];
}

/**
 * Bag membership. Spec §18.
 *
 * A bag holds physical copies, so toggling here moves every owned copy of this
 * release. If you own doubles, both go in the bag — which is exactly what you
 * would carry.
 */
function bagBlock(store: Store, release: Release): HTMLElement {
  const bags = sortBags(store.bags).filter((bag) => bag.status !== 'archived');
  const owned = store.itemsFor(release.discogsReleaseId).filter((item) => item.inCollection);

  if (!owned.length) {
    return h('p', {
      class: 'field__hint',
      text: 'Not currently in your Discogs collection, so it cannot be packed into a bag.',
    });
  }

  if (!bags.length) {
    return h('p', {
      class: 'field__hint',
      text: 'No bags yet. Create one on the Bag tab to start packing.',
    });
  }

  const ownedIds = owned.map((item) => item.id);

  return h(
    'div',
    { class: 'row row--wrap' },
    h('span', { class: 'section-title', text: 'Bags' }),
    ...bags.map((bag) => {
      const packed = ownedIds.some((id) => bag.collectionItemIds.includes(id));
      return h('button', {
        class: 'chip',
        type: 'button',
        'aria-pressed': String(packed),
        'aria-label': `${packed ? 'Remove from' : 'Add to'} ${bag.name}`,
        text: bag.status === 'active' ? `${bag.name} (active)` : bag.name,
        onclick: () =>
          void store.saveBag(
            packed ? removeFromBag(bag, ownedIds) : addToBag(bag, ownedIds),
          ),
      });
    }),
  );
}

function hero(release: Release): HTMLElement {
  return h(
    'div',
    { class: 'release-hero' },
    cover(
      artworkUrl(release.artwork, 'full'),
      `${release.artist} - ${release.title}`,
      { className: 'release-hero__cover' },
    ),
    h(
      'div',
      { class: 'stack stack--tight' },
      h('h1', { text: release.title }),
      h('p', { class: 'release-hero__artist', text: release.artist }),
      h(
        'div',
        { class: 'row row--wrap', style: { marginTop: '8px' } },
        ...release.styles.map((style) => chip(style)),
        ...release.genres
          .filter((genre) => !release.styles.includes(genre))
          .map((genre) => chip(genre)),
      ),
    ),
  );
}

function pendingBanner(): HTMLElement {
  return h(
    'div',
    { class: 'banner banner--info' },
    h('div', { class: 'banner__title', text: 'Tracklist not imported yet' }),
    h('div', {
      class: 'banner__body',
      text: 'The collection sync brings in sleeve art and catalogue details. Run "Fetch metadata" in Settings to pull tracklists, durations and pressing identifiers.',
    }),
  );
}

function failedBanner(release: Release): HTMLElement {
  return h(
    'div',
    { class: 'banner banner--error' },
    h('div', { class: 'banner__title', text: 'Metadata import failed' }),
    h('div', {
      class: 'banner__body',
      text: release.hydrationError ?? 'Discogs did not return this release.',
    }),
  );
}

function detailBlock(release: Release, items: readonly CollectionItem[]): HTMLElement {
  const format = release.formats
    .map((f) => [f.name, ...(f.descriptions ?? [])].filter(Boolean).join(', '))
    .filter(Boolean)
    .join(' / ');

  const owned = items.filter((item) => item.inCollection);
  const departed = items.filter((item) => !item.inCollection);

  const entries: [string, string | null][] = [
    ['Label', release.label ?? null],
    ['Catalogue no', release.catalogueNumber ?? null],
    ['Year', release.year ? String(release.year) : null],
    ['Country', release.country ?? null],
    ['Format', format || null],
    ['Copies owned', owned.length ? String(owned.length) : departed.length ? 'none (was owned)' : null],
    ['Media', owned[0]?.mediaCondition ?? null],
    ['Sleeve', owned[0]?.sleeveCondition ?? null],
    ['Rating', owned[0]?.rating ? `${owned[0].rating} / 5` : null],
    [
      'Added',
      owned[0]?.dateAdded
        ? new Date(owned[0].dateAdded).toLocaleDateString('en-GB', {
            day: 'numeric',
            month: 'short',
            year: 'numeric',
          })
        : null,
    ],
  ];

  const present = entries.filter((entry): entry is [string, string] => Boolean(entry[1]));

  return h(
    'div',
    { class: 'card stack' },
    h('h2', { class: 'section-title', text: 'Pressing' }),
    h(
      'div',
      { class: 'detail-grid' },
      ...present.map(([label, value]) =>
        h(
          'div',
          { class: 'detail-item' },
          h('div', { class: 'detail-item__label', text: label }),
          h('div', { class: 'detail-item__value', text: value }),
        ),
      ),
    ),
    ...(owned[0]?.notes
      ? [
          h(
            'div',
            { class: 'detail-item' },
            h('div', { class: 'detail-item__label', text: 'Your notes' }),
            h('div', { class: 'detail-item__value', text: owned[0].notes }),
          ),
        ]
      : []),
    ...(departed.length && !owned.length
      ? [
          h('p', {
            class: 'field__hint',
            text: 'No longer in your Discogs collection. Kept here along with any analysis.',
          }),
        ]
      : []),
  );
}

function tracklistBlock(
  store: Store,
  router: Router,
  release: Release,
  tracks: readonly Track[],
): HTMLElement {
  const notation = store.snapshot.settings.keyNotation;
  const owned = store.itemsFor(release.discogsReleaseId).filter((item) => item.inCollection);
  const physicalRecords = physicalRecordsForRelease(release, tracks);

  if (!tracks.length) {
    return h(
      'div',
      { class: 'card stack' },
      h('h2', { class: 'section-title', text: 'Tracks' }),
      h('p', {
        class: 'field__hint',
        text:
          release.hydrationState === 'hydrated'
            ? 'Discogs lists no tracks for this release.'
            : 'Not imported yet.',
      }),
    );
  }

  const rows = tracks.map((track) => {
    const analysis = store.analysisFor(track.id);
    const bpm = formatBpm(analysis);
    const key = formatKeyFor(analysis, notation);
    const duration = formatDuration(track.duration);
    const recordNumber = recordNumberForTrack(track.id, physicalRecords);
    const unavailable = owned.length > 0 &&
      !isTrackAvailableOnAnyItem(track.id, physicalRecords, owned);

    const sub = [
      track.artist !== release.artist ? track.artist : null,
      duration,
      unavailable
        ? `Unavailable — Record ${recordNumber ?? '?'} is missing`
        : null,
    ]
      .filter(Boolean)
      .join(' / ');

    return h(
      'button',
      {
        class: 'track-row',
        type: 'button',
        'aria-label': `${track.position}. ${track.title}${track.mixVersion ? ` (${track.mixVersion})` : ''}`,
        onclick: () => router.navigate(`track/${track.id}`),
      },
      // Position is how a DJ finds the track on the record. Spec §48.
      h('span', { class: 'track-row__position', text: track.position }),
      h(
        'div',
        { class: 'track-row__body' },
        h(
          'div',
          { class: 'track-row__title' },
          track.title,
          track.mixVersion
            ? h('span', { class: 'track-row__version', text: ` (${track.mixVersion})` })
            : null,
        ),
        sub ? h('div', { class: 'track-row__sub', text: sub }) : null,
      ),
      h(
        'div',
        { class: 'track-row__aside' },
        bpm || key
          ? h(
              'div',
              { class: 'readout' },
              h('div', { class: 'readout__value', text: [bpm, key].filter(Boolean).join('  ') }),
              h('div', { class: 'readout__label', text: bpm && key ? 'BPM / KEY' : bpm ? 'BPM' : 'KEY' }),
            )
          : stateBadge(analysisState(analysis)),
      ),
    );
  });

  return h(
    'div',
    { class: 'stack stack--tight' },
    h('h2', { class: 'section-title', text: `Tracks (${tracks.length})` }),
    h('div', { class: 'tracklist' }, ...rows),
  );
}

function identifiersBlock(release: Release): HTMLElement {
  return h(
    'div',
    { class: 'card stack stack--tight' },
    h('h2', { class: 'section-title', text: 'Pressing identifiers' }),
    h('p', {
      class: 'field__hint',
      text: 'Runout etchings and barcodes are how you tell white-label and promo pressings apart.',
    }),
    h(
      'div',
      { class: 'stack stack--tight' },
      ...release.identifiers.map((identifier) =>
        h(
          'div',
          { class: 'detail-item' },
          h('div', {
            class: 'detail-item__label',
            text: [identifier.type, identifier.description].filter(Boolean).join(' - '),
          }),
          h('div', {
            class: 'detail-item__value',
            style: { fontFamily: 'var(--font-mono)', fontSize: '0.8125rem' },
            text: identifier.value ?? '',
          }),
        ),
      ),
    ),
  );
}

function referencesBlock(release: Release): HTMLElement {
  // Older IndexedDB rows may predate import-time deduplication. Applying the
  // same identity rule at render time fixes those immediately without making
  // the user refresh every release from Discogs.
  const references = deduplicateReferences(release.references);
  return h(
    'div',
    { class: 'card stack stack--tight' },
    h('h2', { class: 'section-title', text: 'Reference links' }),
    h('p', {
      class: 'field__hint',
      // Spec §33 is explicit that these are identification aids, not audio.
      text: 'For confirming you have the right version. Not an audio source.',
    }),
    h(
      'div',
      { class: 'stack stack--tight' },
      ...references.slice(0, 8).map((reference) =>
        h(
          'a',
          {
            class: 'row',
            href: reference.uri,
            target: '_blank',
            rel: 'noopener noreferrer',
            style: { color: 'var(--accent)', textDecoration: 'none', fontSize: '0.875rem' },
          },
          icon('external', 16),
          h('span', { text: reference.title ?? reference.uri }),
        ),
      ),
    ),
  );
}

function notesBlock(notes: string): HTMLElement {
  return h(
    'div',
    { class: 'card stack stack--tight' },
    h('h2', { class: 'section-title', text: 'Release notes' }),
    h('p', {
      style: { margin: '0', fontSize: '0.875rem', lineHeight: '1.55', whiteSpace: 'pre-wrap' },
      text: notes,
    }),
  );
}

function provenanceBlock(release: Release): HTMLElement {
  const synced = formatRelativeTime(release.metadataLastSyncedAt ?? undefined);
  const changed = formatRelativeTime(release.discogsDateChanged);

  return h(
    'div',
    { class: 'card stack stack--tight' },
    h('h2', { class: 'section-title', text: 'Source' }),
    h(
      'div',
      { class: 'detail-grid' },
      h(
        'div',
        { class: 'detail-item' },
        h('div', { class: 'detail-item__label', text: 'Discogs release' }),
        h(
          'div',
          { class: 'detail-item__value' },
          h('a', {
            href: `https://www.discogs.com/release/${release.discogsReleaseId}`,
            target: '_blank',
            rel: 'noopener noreferrer',
            text: String(release.discogsReleaseId),
          }),
        ),
      ),
      ...(release.discogsMasterId
        ? [
            h(
              'div',
              { class: 'detail-item' },
              h('div', { class: 'detail-item__label', text: 'Master' }),
              h('div', { class: 'detail-item__value', text: String(release.discogsMasterId) }),
            ),
          ]
        : []),
      ...(synced
        ? [
            h(
              'div',
              { class: 'detail-item' },
              h('div', { class: 'detail-item__label', text: 'Metadata synced' }),
              h('div', { class: 'detail-item__value', text: synced }),
            ),
          ]
        : []),
      ...(changed
        ? [
            h(
              'div',
              { class: 'detail-item' },
              h('div', { class: 'detail-item__label', text: 'Changed on Discogs' }),
              h('div', { class: 'detail-item__value', text: changed }),
            ),
          ]
        : []),
    ),
  );
}
