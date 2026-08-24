import 'fake-indexeddb/auto';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  clearLibrary,
  exportLibrary,
  importLibrary,
  getPendingHydration,
  loadSettings,
  markCollectionItemsNotOwned,
  reconcileTracks,
  saveSettings,
} from '@/data/repositories';
import { db, openDatabase, STORES } from '@/data/schema';
import type { Settings, Track, TrackAnalysis } from '@/domain/types';

const timestamp = '2026-08-24T10:00:00.000Z';
const libraryStores = [
  STORES.releases,
  STORES.tracks,
  STORES.recordings,
  STORES.collectionItems,
  STORES.trackAnalysis,
  STORES.bags,
  STORES.setPlans,
  STORES.transitions,
  STORES.playHistory,
  STORES.trackPlayState,
  STORES.syncState,
] as const;

function row(id: string, version = 1): Record<string, unknown> {
  return { id, version, createdAt: timestamp, updatedAt: timestamp };
}

function track(id: string, releaseId = 'release-1'): Track {
  return {
    id,
    version: 1,
    createdAt: timestamp,
    updatedAt: timestamp,
    releaseId,
    position: 'A1',
    artist: 'Artist',
    title: 'Track',
    sequence: 0,
  };
}

function analysis(id: string, trackId: string, version = 1): TrackAnalysis {
  return {
    id,
    version,
    createdAt: timestamp,
    updatedAt: timestamp,
    trackId,
    verifiedBpm: false,
    verifiedKey: false,
    candidates: [],
    state: 'ANALYSE',
  };
}

async function clearEveryStore(): Promise<void> {
  const stores = Object.values(STORES);
  await db.transaction(stores, (tx) => {
    for (const store of stores) tx.objectStore(store).clear();
  });
}

describe('library persistence', () => {
  beforeAll(async () => {
    await openDatabase();
  });

  beforeEach(async () => {
    await clearEveryStore();
  });

  it('exports every user-owned store while excluding device-local secrets and contact', async () => {
    const keyedRows: Array<[string, Record<string, unknown>]> = [
      [STORES.releases, { ...row('release-1'), discogsReleaseId: 1, hydrationState: 'hydrated' }],
      [STORES.tracks, { ...row('track-1'), releaseId: 'release-1' }],
      [STORES.recordings, row('recording-1')],
      [STORES.collectionItems, {
        ...row('item-1'), discogsReleaseId: 1, sleeveColorId: 'default-teal',
        missingRecordNumbers: [2],
      }],
      [STORES.trackAnalysis, { ...row('analysis-1'), trackId: 'track-1', state: 'READY' }],
      [STORES.bags, { ...row('bag-1'), status: 'active' }],
      [STORES.setPlans, { ...row('set-1'), bagId: 'bag-1' }],
      [STORES.transitions, { ...row('transition-1'), fromTrackId: 'track-1', toTrackId: 'track-2' }],
      [STORES.playHistory, { ...row('history-1'), trackId: 'track-1', playedAt: timestamp }],
      [STORES.trackPlayState, { ...row('state-1'), trackId: 'track-1', bagId: 'bag-1' }],
    ];
    for (const [store, value] of keyedRows) await db.put(store, value);

    await db.put<Settings>(STORES.settings, {
      id: 'settings',
      theme: 'light',
      keyNotation: 'musical',
      deviceId: 'device-local',
      discogsToken: 'secret-token',
      metadataContact: 'dj@example.test',
      getSongBpmApiKey: 'getsong-secret',
      updatedAt: timestamp,
    });

    const exported = JSON.parse(await exportLibrary()) as {
      counts: Record<string, number>;
      data: Record<string, unknown>;
    };

    expect(exported.counts).toMatchObject({
      recordings: 1,
      transitions: 1,
      playHistory: 1,
      playStates: 1,
    });
    expect(exported.data['recordings']).toHaveLength(1);
    expect(exported.data['transitions']).toHaveLength(1);
    expect(exported.data['playHistory']).toHaveLength(1);
    expect(exported.data['playStates']).toHaveLength(1);
    expect(exported.data['collectionItems']).toEqual([
      expect.objectContaining({ sleeveColorId: 'default-teal', missingRecordNumbers: [2] }),
    ]);
    expect(exported.data['settings']).toMatchObject({ theme: 'light', keyNotation: 'musical' });
    expect(exported.data['settings']).not.toHaveProperty('discogsToken');
    expect(exported.data['settings']).not.toHaveProperty('metadataContact');
    expect(exported.data['settings']).not.toHaveProperty('getSongBpmApiKey');
  });

  it('soft-removes copies and excludes departed releases from metadata work', async () => {
    await db.put(STORES.releases, {
      ...row('release-1'), discogsReleaseId: 1, hydrationState: 'stub',
    });
    await db.put(STORES.collectionItems, {
      ...row('item-1'), discogsReleaseId: 1, discogsInstanceId: 11, inCollection: true,
    });

    expect(await getPendingHydration()).toHaveLength(1);
    expect(await markCollectionItemsNotOwned(['item-1'])).toBe(1);
    expect(await getPendingHydration()).toEqual([]);
    expect(await db.get(STORES.collectionItems, 'item-1')).toMatchObject({
      inCollection: false,
      version: 2,
    });
  });

  it('merges versioned rows and restores portable settings only', async () => {
    await db.put(STORES.trackAnalysis, {
      ...analysis('analysis-local', 'track-a', 2),
      canonicalBpm: 174,
    });
    await saveSettings({
      id: 'settings',
      theme: 'dark',
      keyNotation: 'camelot',
      deviceId: 'device-local',
      discogsToken: 'keep-this-token',
      getSongBpmApiKey: 'keep-this-getsong-key',
      updatedAt: timestamp,
    });

    const backup = JSON.stringify({
      format: 'cratenav-library',
      formatVersion: 1,
      data: {
        analyses: [
          { ...analysis('analysis-local', 'track-a', 1), canonicalBpm: 120 },
          analysis('analysis-new', 'track-b', 1),
        ],
        transitions: [
          {
            ...row('transition-1'),
            fromTrackId: 'track-a',
            toTrackId: 'track-b',
            rating: 'great',
          },
        ],
        settings: {
          id: 'settings',
          theme: 'light',
          keyNotation: 'musical',
          deviceId: 'source-device',
          discogsToken: 'must-not-import',
          getSongBpmApiKey: 'must-not-import-either',
          deckProfileId: 'wide-vinyl',
          preferredMaxPitchPercent: 6,
          customSleeveColors: [{ id: 'slv-orange', name: 'Orange', hex: '#dd7711' }],
          updatedAt: timestamp,
        },
      },
    });

    const report = await importLibrary(backup);
    const local = await db.get<TrackAnalysis>(STORES.trackAnalysis, 'analysis-local');
    const restored = await loadSettings('wrong-fallback');

    expect(local?.canonicalBpm).toBe(174);
    expect(await db.get(STORES.trackAnalysis, 'analysis-new')).toBeDefined();
    expect(await db.get(STORES.transitions, 'transition-1')).toBeDefined();
    expect(restored).toMatchObject({
      theme: 'light',
      keyNotation: 'musical',
      deviceId: 'device-local',
      discogsToken: 'keep-this-token',
      getSongBpmApiKey: 'keep-this-getsong-key',
      deckProfileId: 'wide-vinyl',
      preferredMaxPitchPercent: 6,
      customSleeveColors: [{ id: 'slv-orange', name: 'Orange', hex: '#dd7711' }],
    });
    expect(report).toMatchObject({ added: 2, updated: 1, skipped: 1 });
  });

  it('rejects unsupported backup versions without writing data', async () => {
    const backup = JSON.stringify({
      format: 'cratenav-library',
      formatVersion: 99,
      data: { transitions: [row('transition-1')] },
    });

    await expect(importLibrary(backup)).rejects.toThrow('unsupported cratenav format version');
    expect(await db.count(STORES.transitions)).toBe(0);
  });

  it('clears all library-owned stores but retains local settings', async () => {
    for (const store of libraryStores) {
      const value =
        store === STORES.releases
          ? { ...row('release-1'), discogsReleaseId: 1 }
          : store === STORES.tracks
            ? { ...row('track-1'), releaseId: 'release-1' }
            : store === STORES.trackAnalysis
              ? { ...row('analysis-1'), trackId: 'track-1' }
              : store === STORES.bags
                ? { ...row('bag-1'), status: 'planning' }
                : store === STORES.setPlans
                  ? { ...row('set-1'), bagId: 'bag-1' }
                  : store === STORES.transitions
                    ? { ...row('transition-1'), fromTrackId: 'track-1', toTrackId: 'track-2' }
                    : store === STORES.playHistory
                      ? { ...row('history-1'), trackId: 'track-1', playedAt: timestamp }
                      : store === STORES.trackPlayState
                        ? { ...row('state-1'), trackId: 'track-1', bagId: 'bag-1' }
                        : store === STORES.collectionItems
                          ? { ...row('item-1'), discogsReleaseId: 1 }
                          : store === STORES.syncState
                            ? { id: 'discogs' }
                            : row(`${store}-1`);
      await db.put(store, value);
    }
    await db.put<Settings>(STORES.settings, {
      id: 'settings',
      theme: 'dark',
      keyNotation: 'camelot',
      deviceId: 'device-local',
      discogsToken: 'keep-this-token',
      updatedAt: timestamp,
    });

    await clearLibrary();

    for (const store of libraryStores) expect(await db.count(store)).toBe(0);
    expect(await db.get<Settings>(STORES.settings, 'settings')).toMatchObject({
      deviceId: 'device-local',
      discogsToken: 'keep-this-token',
    });
  });

  it('removes an obsolete track and its empty placeholder analysis atomically', async () => {
    await db.put(STORES.tracks, track('track-old'));
    await db.put(STORES.trackAnalysis, analysis('analysis-old', 'track-old'));

    const result = await reconcileTracks('release-1', []);

    expect(result.removed).toBe(1);
    expect(await db.get(STORES.tracks, 'track-old')).toBeUndefined();
    expect(await db.get(STORES.trackAnalysis, 'analysis-old')).toBeUndefined();
  });

  it('retains an obsolete track when it carries meaningful analysis', async () => {
    await db.put(STORES.tracks, track('track-old'));
    await db.put(STORES.trackAnalysis, {
      ...analysis('analysis-old', 'track-old'),
      canonicalBpm: 174,
    });

    const result = await reconcileTracks('release-1', []);

    expect(result).toMatchObject({ removed: 0, tracks: [expect.objectContaining({ id: 'track-old' })] });
    expect(await db.get(STORES.tracks, 'track-old')).toBeDefined();
    expect(await db.get(STORES.trackAnalysis, 'analysis-old')).toBeDefined();
  });
});
