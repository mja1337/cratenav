import { Database, type StoreSpec } from '@/storage/idb';

/**
 * Local database schema.
 *
 * Note on indexes: IndexedDB keys may only be numbers, strings, dates, binary
 * or arrays — booleans are NOT valid keys. Anything we need to query by is
 * therefore stored as a string enum or number. Boolean domain fields
 * (inCollection, verifiedBpm) are filtered in memory; at a few thousand rows
 * that is comfortably fast and avoids denormalised index columns drifting.
 */

export const STORES = {
  collectionItems: 'collectionItems',
  releases: 'releases',
  tracks: 'tracks',
  recordings: 'recordings',
  trackAnalysis: 'trackAnalysis',
  bags: 'bags',
  setPlans: 'setPlans',
  transitions: 'transitions',
  playHistory: 'playHistory',
  trackPlayState: 'trackPlayState',
  settings: 'settings',
  syncState: 'syncState',
} as const;

const SPECS: StoreSpec[] = [
  {
    name: STORES.collectionItems,
    keyPath: 'id',
    indexes: [
      { name: 'byReleaseId', keyPath: 'discogsReleaseId' },
      { name: 'byInstanceId', keyPath: 'discogsInstanceId' },
      { name: 'byUpdatedAt', keyPath: 'updatedAt' },
    ],
  },
  {
    name: STORES.releases,
    keyPath: 'id',
    indexes: [
      { name: 'byDiscogsReleaseId', keyPath: 'discogsReleaseId', unique: true },
      // Doubles as the metadata hydration queue: everything still 'stub'.
      { name: 'byHydrationState', keyPath: 'hydrationState' },
      { name: 'byArtistSort', keyPath: 'artistSort' },
      { name: 'byTitle', keyPath: 'title' },
      { name: 'byYear', keyPath: 'year' },
      { name: 'byLabel', keyPath: 'label' },
      { name: 'byGenres', keyPath: 'genres', multiEntry: true },
      { name: 'byStyles', keyPath: 'styles', multiEntry: true },
      { name: 'byUpdatedAt', keyPath: 'updatedAt' },
    ],
  },
  {
    name: STORES.tracks,
    keyPath: 'id',
    indexes: [
      { name: 'byReleaseId', keyPath: 'releaseId' },
      { name: 'byRecordingId', keyPath: 'recordingId' },
    ],
  },
  {
    name: STORES.recordings,
    keyPath: 'id',
    indexes: [{ name: 'byIsrc', keyPath: 'isrc' }],
  },
  {
    name: STORES.trackAnalysis,
    keyPath: 'id',
    indexes: [
      { name: 'byTrackId', keyPath: 'trackId', unique: true },
      { name: 'byState', keyPath: 'state' },
      { name: 'byRecordingId', keyPath: 'recordingId' },
    ],
  },
  {
    name: STORES.bags,
    keyPath: 'id',
    indexes: [{ name: 'byStatus', keyPath: 'status' }],
  },
  {
    name: STORES.setPlans,
    keyPath: 'id',
    indexes: [{ name: 'byBagId', keyPath: 'bagId' }],
  },
  {
    name: STORES.transitions,
    keyPath: 'id',
    indexes: [
      { name: 'byFromTrackId', keyPath: 'fromTrackId' },
      { name: 'byToTrackId', keyPath: 'toTrackId' },
    ],
  },
  {
    name: STORES.playHistory,
    keyPath: 'id',
    indexes: [
      { name: 'byTrackId', keyPath: 'trackId' },
      { name: 'byPlayedAt', keyPath: 'playedAt' },
      { name: 'byBagId', keyPath: 'bagId' },
    ],
  },
  {
    name: STORES.trackPlayState,
    keyPath: 'id',
    indexes: [
      { name: 'byBagId', keyPath: 'bagId' },
      { name: 'byTrackId', keyPath: 'trackId' },
    ],
  },
  { name: STORES.settings, keyPath: 'id' },
  { name: STORES.syncState, keyPath: 'id' },
];

export const DB_NAME = 'cratenav';
export const DB_VERSION = 1;

export const db = new Database(DB_NAME, DB_VERSION, SPECS);

export async function openDatabase(): Promise<void> {
  await db.open();
}
