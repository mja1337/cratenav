import { db, STORES } from './schema';
import type {
  Bag,
  CollectionItem,
  PlayState,
  SetPlan,
  TrackPlayState,
  Release,
  Settings,
  Track,
  TrackAnalysis,
} from '@/domain/types';
import { derivedId, nowIso } from '@/utils/ids';
import { planReconciliation } from './track-reconcile';

/**
 * Data access. Views and sync logic go through these functions rather than
 * touching IndexedDB, so the storage engine stays swappable. Spec §40.
 */

// --- settings ---------------------------------------------------------------

const SETTINGS_ID = 'settings' as const;

export async function loadSettings(deviceId: string): Promise<Settings> {
  const existing = await db.get<Settings>(STORES.settings, SETTINGS_ID);
  if (existing) return existing;

  const settings: Settings = {
    id: SETTINGS_ID,
    theme: 'dark',
    keyNotation: 'camelot',
    deviceId,
    updatedAt: nowIso(),
  };
  await db.put(STORES.settings, settings);
  return settings;
}

export async function saveSettings(settings: Settings): Promise<Settings> {
  const next = { ...settings, updatedAt: nowIso() };
  await db.put(STORES.settings, next);
  return next;
}

// --- sync bookkeeping -------------------------------------------------------

export interface SyncState {
  id: 'discogs';
  lastCollectionSyncAt?: string;
  lastMetadataSweepAt?: string;
  /** Instance ids seen in the most recent collection sync. */
  lastSeenCount?: number;
}

export async function loadSyncState(): Promise<SyncState> {
  return (await db.get<SyncState>(STORES.syncState, 'discogs')) ?? { id: 'discogs' };
}

export async function saveSyncState(state: SyncState): Promise<void> {
  await db.put(STORES.syncState, state);
}

// --- releases ---------------------------------------------------------------

export async function getReleaseByDiscogsId(discogsReleaseId: number): Promise<Release | undefined> {
  const matches = await db.getAllFromIndex<Release>(
    STORES.releases,
    'byDiscogsReleaseId',
    discogsReleaseId,
  );
  return matches[0];
}

export async function getRelease(id: string): Promise<Release | undefined> {
  return db.get<Release>(STORES.releases, id);
}

export async function getAllReleases(): Promise<Release[]> {
  return db.getAll<Release>(STORES.releases);
}

export async function putRelease(release: Release): Promise<void> {
  await db.put(STORES.releases, release);
}

export async function putReleases(releases: readonly Release[]): Promise<void> {
  await db.putAll(STORES.releases, releases);
}

export async function countReleases(): Promise<number> {
  return db.count(STORES.releases);
}

async function ownedDiscogsReleaseIds(): Promise<Set<number>> {
  const items = await getAllCollectionItems();
  return new Set(
    items.filter((item) => item.inCollection).map((item) => item.discogsReleaseId),
  );
}

/** The metadata hydration queue is simply every release still marked 'stub'. */
export async function getPendingHydration(limit?: number): Promise<Release[]> {
  const [releases, ownedIds] = await Promise.all([
    db.getAllFromIndex<Release>(STORES.releases, 'byHydrationState', 'stub'),
    ownedDiscogsReleaseIds(),
  ]);
  const owned = releases.filter((release) => ownedIds.has(release.discogsReleaseId));
  return limit === undefined ? owned : owned.slice(0, limit);
}

export async function countPendingHydration(): Promise<number> {
  return (await getPendingHydration()).length;
}

export async function countFailedHydration(): Promise<number> {
  return (await getFailedHydration()).length;
}

export async function getFailedHydration(): Promise<Release[]> {
  const [releases, ownedIds] = await Promise.all([
    db.getAllFromIndex<Release>(STORES.releases, 'byHydrationState', 'failed'),
    ownedDiscogsReleaseIds(),
  ]);
  return releases.filter((release) => ownedIds.has(release.discogsReleaseId));
}

// --- collection items -------------------------------------------------------

export async function getAllCollectionItems(): Promise<CollectionItem[]> {
  return db.getAll<CollectionItem>(STORES.collectionItems);
}

export async function putCollectionItems(items: readonly CollectionItem[]): Promise<void> {
  await db.putAll(STORES.collectionItems, items);
}

/** Soft-remove physical copies while retaining their catalogue and DJ knowledge. */
export async function markCollectionItemsNotOwned(itemIds: readonly string[]): Promise<number> {
  const wanted = new Set(itemIds);
  if (!wanted.size) return 0;
  const items = (await getAllCollectionItems()).filter(
    (item) => wanted.has(item.id) && item.inCollection,
  );
  const timestamp = nowIso();
  await putCollectionItems(items.map((item) => ({
    ...item,
    inCollection: false,
    updatedAt: timestamp,
    version: item.version + 1,
  })));
  return items.length;
}

export async function countCollectionItems(): Promise<number> {
  return db.count(STORES.collectionItems);
}

// --- tracks -----------------------------------------------------------------

export async function getTracksForRelease(releaseId: string): Promise<Track[]> {
  const tracks = await db.getAllFromIndex<Track>(STORES.tracks, 'byReleaseId', releaseId);
  return tracks.sort((a, b) => a.sequence - b.sequence);
}

export async function getAllTracks(): Promise<Track[]> {
  return db.getAll<Track>(STORES.tracks);
}

export async function countTracks(): Promise<number> {
  return db.count(STORES.tracks);
}

/**
 * Replace a release's tracklist while preserving track identity.
 *
 * This exists because of spec §24: when Discogs later improves an old
 * white-label entry, we must take the better titles and durations WITHOUT
 * losing the BPM/key analysis attached to those tracks. Analysis is keyed by
 * track id, so naively deleting and re-creating tracks would orphan it.
 *
 * Existing tracks are therefore matched to incoming ones (by vinyl position
 * first, then by title) and keep their ids. Leftover tracks are only removed
 * when nothing is attached to them.
 */
export async function reconcileTracks(
  releaseId: string,
  incoming: readonly Track[],
): Promise<{ tracks: Track[]; removed: number; preserved: number }> {
  const existing = await getTracksForRelease(releaseId);
  const analyses = await db.getAll<TrackAnalysis>(STORES.trackAnalysis);
  const byTrackId = new Map(analyses.map((analysis) => [analysis.trackId, analysis]));

  const plan = planReconciliation(existing, incoming, (trackId) => byTrackId.get(trackId));

  await db.transaction([STORES.tracks, STORES.trackAnalysis], (tx) => {
    const trackStore = tx.objectStore(STORES.tracks);
    const analysisStore = tx.objectStore(STORES.trackAnalysis);
    for (const track of plan.removable) {
      trackStore.delete(track.id);
      const placeholder = byTrackId.get(track.id);
      if (placeholder) analysisStore.delete(placeholder.id);
    }
    for (const track of plan.resolved) trackStore.put(track);
  });

  return {
    tracks: [...plan.resolved, ...plan.retained].sort((a, b) => a.sequence - b.sequence),
    removed: plan.removable.length,
    preserved: plan.preserved,
  };
}

// --- analysis ---------------------------------------------------------------

export async function getAnalysisForTrack(trackId: string): Promise<TrackAnalysis | undefined> {
  const matches = await db.getAllFromIndex<TrackAnalysis>(
    STORES.trackAnalysis,
    'byTrackId',
    trackId,
  );
  return matches[0];
}

export async function getAllAnalyses(): Promise<TrackAnalysis[]> {
  return db.getAll<TrackAnalysis>(STORES.trackAnalysis);
}

export async function putAnalysis(analysis: TrackAnalysis): Promise<void> {
  await db.put(STORES.trackAnalysis, analysis);
}

// --- bags -------------------------------------------------------------------

export async function getAllBags(): Promise<Bag[]> {
  return db.getAll<Bag>(STORES.bags);
}

export async function putBag(bag: Bag): Promise<void> {
  await db.put(STORES.bags, bag);
}

export async function putBags(bags: readonly Bag[]): Promise<void> {
  await db.putAll(STORES.bags, bags);
}

/** Soft delete, so a bag can still be recovered and sync can propagate it. */
export async function softDeleteBag(bag: Bag): Promise<void> {
  await db.put(STORES.bags, {
    ...bag,
    deletedAt: nowIso(),
    updatedAt: nowIso(),
    version: bag.version + 1,
  });
}

// --- set plans --------------------------------------------------------------

export async function getAllSetPlans(): Promise<SetPlan[]> {
  return db.getAll<SetPlan>(STORES.setPlans);
}

export async function putSetPlan(plan: SetPlan): Promise<void> {
  await db.put(STORES.setPlans, plan);
}

export async function softDeleteSetPlan(plan: SetPlan): Promise<void> {
  await db.put(STORES.setPlans, {
    ...plan,
    deletedAt: nowIso(),
    updatedAt: nowIso(),
    version: plan.version + 1,
  });
}

// --- play state (per bag session) -------------------------------------------

export async function getAllPlayStates(): Promise<TrackPlayState[]> {
  return db.getAll<TrackPlayState>(STORES.trackPlayState);
}

/**
 * Record a track's state within a bag.
 *
 * The row id is derived from (bagId, trackId) so repeated toggling updates one
 * row instead of accumulating history. Actual play history is a separate store.
 */
export async function setPlayState(
  bagId: string,
  trackId: string,
  state: PlayState,
): Promise<TrackPlayState> {
  const id = derivedId('pls', bagId, trackId);
  const existing = await db.get<TrackPlayState>(STORES.trackPlayState, id);
  const timestamp = nowIso();

  const row: TrackPlayState = existing
    ? { ...existing, state, updatedAt: timestamp, version: existing.version + 1 }
    : {
        id,
        createdAt: timestamp,
        updatedAt: timestamp,
        version: 1,
        trackId,
        bagId,
        state,
      };

  await db.put(STORES.trackPlayState, row);
  return row;
}

/** Reset every track in a bag back to packed, e.g. before the next gig. */
export async function resetPlayStates(bagId: string): Promise<number> {
  const rows = await db.getAllFromIndex<TrackPlayState>(
    STORES.trackPlayState,
    'byBagId',
    bagId,
  );
  await db.putAll(
    STORES.trackPlayState,
    rows.map((row) => ({
      ...row,
      state: 'packed' as PlayState,
      updatedAt: nowIso(),
      version: row.version + 1,
    })),
  );
  return rows.length;
}

// --- wholesale operations ---------------------------------------------------

/** Full local export. The user must never be locked in. Spec §27. */
export async function exportLibrary(): Promise<string> {
  const [
    releases,
    tracks,
    recordings,
    collectionItems,
    analyses,
    bags,
    setPlans,
    transitions,
    playHistory,
    playStates,
    settings,
  ] =
    await Promise.all([
      db.getAll(STORES.releases),
      db.getAll(STORES.tracks),
      db.getAll(STORES.recordings),
      db.getAll(STORES.collectionItems),
      db.getAll(STORES.trackAnalysis),
      db.getAll(STORES.bags),
      db.getAll(STORES.setPlans),
      db.getAll(STORES.transitions),
      db.getAll(STORES.playHistory),
      db.getAll(STORES.trackPlayState),
      db.get<Settings>(STORES.settings, SETTINGS_ID),
    ]);

  // Credentials/contact details are device-local and deliberately excluded from exports.
  const safeSettings = settings
    ? {
        ...settings,
        discogsToken: undefined,
        metadataContact: undefined,
        getSongBpmApiKey: undefined,
      }
    : undefined;

  return JSON.stringify(
    {
      format: 'cratenav-library',
      formatVersion: 1,
      exportedAt: nowIso(),
      counts: {
        releases: releases.length,
        tracks: tracks.length,
        recordings: recordings.length,
        collectionItems: collectionItems.length,
        analyses: analyses.length,
        bags: bags.length,
        setPlans: setPlans.length,
        transitions: transitions.length,
        playHistory: playHistory.length,
        playStates: playStates.length,
      },
      data: {
        releases,
        tracks,
        recordings,
        collectionItems,
        analyses,
        bags,
        setPlans,
        transitions,
        playHistory,
        playStates,
        settings: safeSettings,
      },
    },
    null,
    2,
  );
}

export async function clearLibrary(): Promise<void> {
  const stores = [
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
  ];
  await db.transaction(stores, (tx) => {
    for (const store of stores) tx.objectStore(store).clear();
  });
}

// --- library import (spec §27) ----------------------------------------------

export interface ImportReport {
  added: number;
  updated: number;
  skipped: number;
  byStore: Record<string, number>;
  warnings: string[];
}

/** Stores an export may restore, mapped to the key each row is identified by. */
const IMPORTABLE = [
  ['releases', STORES.releases],
  ['tracks', STORES.tracks],
  ['recordings', STORES.recordings],
  ['collectionItems', STORES.collectionItems],
  ['analyses', STORES.trackAnalysis],
  ['bags', STORES.bags],
  ['setPlans', STORES.setPlans],
  ['transitions', STORES.transitions],
  ['playHistory', STORES.playHistory],
  ['playStates', STORES.trackPlayState],
] as const;

interface VersionedRow {
  id: string;
  version?: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function validBpmPreferences(value: unknown): value is Record<string, [number, number]> {
  if (!isRecord(value)) return false;
  return Object.values(value).every(
    (band) =>
      Array.isArray(band) &&
      band.length === 2 &&
      band.every((number) => typeof number === 'number' && Number.isFinite(number)),
  );
}

function validSleeveColors(value: unknown): boolean {
  return Array.isArray(value) && value.every((color) =>
    isRecord(color) &&
    typeof color['id'] === 'string' &&
    typeof color['name'] === 'string' &&
    typeof color['hex'] === 'string' &&
    /^#[0-9a-f]{6}$/i.test(color['hex']),
  );
}

/** Restore portable preferences while keeping credentials and device identity local. */
function portableSettings(value: unknown, local: Settings): Settings | undefined {
  if (!isRecord(value) || value['id'] !== SETTINGS_ID) return undefined;
  if (!['dark', 'light', 'system'].includes(String(value['theme']))) return undefined;
  if (!['camelot', 'musical'].includes(String(value['keyNotation']))) return undefined;
  if (value['bpmPreferences'] !== undefined && !validBpmPreferences(value['bpmPreferences'])) {
    return undefined;
  }
  if (value['customSleeveColors'] !== undefined && !validSleeveColors(value['customSleeveColors'])) {
    return undefined;
  }

  const optionalString = (key: string): string | undefined =>
    typeof value[key] === 'string' ? value[key] : undefined;
  const preferredPitch = value['preferredMaxPitchPercent'];
  const vinylOnlyMode = value['vinylOnlyMode'];

  return {
    id: SETTINGS_ID,
    theme: value['theme'] as Settings['theme'],
    keyNotation: value['keyNotation'] as Settings['keyNotation'],
    deviceId: local.deviceId,
    discogsToken: local.discogsToken,
    metadataContact: local.metadataContact,
    getSongBpmApiKey: local.getSongBpmApiKey,
    discogsUsername: optionalString('discogsUsername'),
    activeBagId: optionalString('activeBagId'),
    deckProfileId: optionalString('deckProfileId'),
    bpmPreferences: value['bpmPreferences'] as Settings['bpmPreferences'],
    preferredMaxPitchPercent:
      typeof preferredPitch === 'number' && Number.isFinite(preferredPitch)
        ? preferredPitch
        : undefined,
    vinylOnlyMode: typeof vinylOnlyMode === 'boolean' ? vinylOnlyMode : undefined,
    customSleeveColors: value['customSleeveColors'] as Settings['customSleeveColors'],
    updatedAt: nowIso(),
  };
}

/**
 * Restore a library export. Spec §27.
 *
 * Merges rather than replaces, and resolves collisions by `version` so a
 * restore can never silently overwrite newer local work — which for this app
 * means someone's hand-entered BPM and key. Rows the local database has a newer
 * copy of are skipped and counted.
 *
 * The Discogs token is never present in an export and is never written here.
 */
export async function importLibrary(json: string): Promise<ImportReport> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    throw new Error('That file is not valid JSON.');
  }

  const envelope = parsed as {
    format?: string;
    formatVersion?: number;
    data?: Record<string, unknown>;
  };
  if (envelope.format !== 'cratenav-library' || !envelope.data) {
    throw new Error('That does not look like a cratenav library export.');
  }
  if (envelope.formatVersion !== 1) {
    throw new Error('That backup uses an unsupported cratenav format version.');
  }

  const report: ImportReport = { added: 0, updated: 0, skipped: 0, byStore: {}, warnings: [] };
  const planned = new Map<string, unknown[]>();

  for (const [key, store] of IMPORTABLE) {
    const rows = envelope.data[key];
    if (!Array.isArray(rows)) continue;

    const existing = await db.getAll<VersionedRow>(store);
    const byId = new Map(existing.map((row) => [row.id, row]));
    const toWrite: unknown[] = [];

    for (const row of rows as VersionedRow[]) {
      if (!row || typeof row.id !== 'string') {
        report.warnings.push(`Skipped a row in ${key} with no id.`);
        continue;
      }
      const local = byId.get(row.id);
      if (!local) {
        toWrite.push(row);
        report.added += 1;
      } else if ((row.version ?? 0) > (local.version ?? 0)) {
        toWrite.push(row);
        report.updated += 1;
      } else {
        // Local copy is the same or newer: keep it.
        report.skipped += 1;
      }
    }

    if (toWrite.length) planned.set(store, toWrite);
    report.byStore[key] = toWrite.length;
  }

  const localSettings = await loadSettings('unknown-device');
  const restoredSettings = portableSettings(envelope.data['settings'], localSettings);
  if (envelope.data['settings'] !== undefined && !restoredSettings) {
    report.warnings.push('Skipped invalid settings.');
  }

  const stores = [...planned.keys()];
  if (restoredSettings) stores.push(STORES.settings);
  if (stores.length) {
    await db.transaction(stores, (tx) => {
      for (const [store, rows] of planned) {
        const objectStore = tx.objectStore(store);
        for (const row of rows) objectStore.put(row);
      }
      if (restoredSettings) tx.objectStore(STORES.settings).put(restoredSettings);
    });
  }

  if (restoredSettings) {
    report.updated += 1;
    report.byStore['settings'] = 1;
  }

  return report;
}
