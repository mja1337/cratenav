import 'fake-indexeddb/auto';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { runCatchUp } from '@/app/automatic-sync';
import type { Store } from '@/app/store';
import { db, openDatabase, STORES } from '@/data/schema';
import { saveSyncState } from '@/data/repositories';

/**
 * The catch-up chain runs unattended on open, so its refusals matter more than
 * its successes: it must not poll Discogs on every reopen, must not fight a
 * sync the user started, and must never remove a record without being asked.
 */
function fakeStore(overrides: {
  settings?: Record<string, unknown>;
  syncRunning?: boolean;
  enrichmentRunning?: boolean;
  syncCollection?: ReturnType<typeof vi.fn>;
} = {}): { store: Store; syncCollection: ReturnType<typeof vi.fn>; notices: string[] } {
  const notices: string[] = [];
  const syncCollection = overrides.syncCollection ?? vi.fn(async () => ({
    added: 0, updated: 0, departed: 0, departuresRetained: 0,
    totalOwned: 10, newReleases: 0, mode: 'incremental' as const,
    pagesRead: 1, fullSyncRecommended: false,
  }));

  const store = {
    snapshot: {
      settings: {
        discogsUsername: 'dj',
        discogsToken: 'tok',
        ...overrides.settings,
      },
      library: { tracks: [] },
    },
    sync: { running: overrides.syncRunning ?? false, syncCollection, hydrateMetadata: vi.fn() },
    enrichmentRunning: overrides.enrichmentRunning ?? false,
    startEnrichment: vi.fn(),
    trackEntry: () => undefined,
    reload: vi.fn(async () => undefined),
    notify: (_level: string, message: string) => notices.push(message),
  } as unknown as Store;

  return { store, syncCollection, notices };
}

async function clearEveryStore(): Promise<void> {
  await db.transaction(Object.values(STORES), (tx) => {
    for (const store of Object.values(STORES)) tx.objectStore(store).clear();
  });
}

describe('automatic catch-up gating', () => {
  beforeAll(async () => openDatabase());
  beforeEach(clearEveryStore);

  it('does nothing without Discogs credentials', async () => {
    const { store, syncCollection } = fakeStore({ settings: { discogsToken: undefined } });
    const outcome = await runCatchUp(store);
    expect(outcome.ran).toBe(false);
    expect(outcome.skippedBecause).toMatch(/not connected/);
    expect(syncCollection).not.toHaveBeenCalled();
  });

  it('stands aside for a sync the user started', async () => {
    const { store, syncCollection } = fakeStore({ syncRunning: true });
    const outcome = await runCatchUp(store);
    expect(outcome.ran).toBe(false);
    expect(syncCollection).not.toHaveBeenCalled();
  });

  it('stands aside for a running enrichment batch', async () => {
    const { store, syncCollection } = fakeStore({ enrichmentRunning: true });
    expect((await runCatchUp(store)).ran).toBe(false);
    expect(syncCollection).not.toHaveBeenCalled();
  });

  it('does not re-poll Discogs when it synced moments ago', async () => {
    await saveSyncState({ id: 'discogs', lastCollectionSyncAt: new Date().toISOString() });
    const { store, syncCollection } = fakeStore();
    const outcome = await runCatchUp(store);
    expect(outcome.ran).toBe(false);
    expect(outcome.skippedBecause).toMatch(/recently/);
    expect(syncCollection).not.toHaveBeenCalled();
  });

  it('runs anyway when a user asks for it explicitly', async () => {
    await saveSyncState({ id: 'discogs', lastCollectionSyncAt: new Date().toISOString() });
    const { store, syncCollection } = fakeStore();
    expect((await runCatchUp(store, { force: true })).ran).toBe(true);
    expect(syncCollection).toHaveBeenCalledOnce();
  });

  it('reads everything the first time, having nothing to compare against', async () => {
    const { store, syncCollection } = fakeStore();
    await runCatchUp(store, { force: true });
    expect(syncCollection.mock.calls[0]![1].mode).toBe('full');
  });

  it('reads incrementally once a full pass is on record, and never applies a departure', async () => {
    await saveSyncState({
      id: 'discogs',
      lastFullSyncAt: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
    });
    const { store, syncCollection } = fakeStore();
    await runCatchUp(store, { force: true });
    const [, options] = syncCollection.mock.calls[0]!;
    expect(options.mode).toBe('incremental');
    // An unattended pass must not remove a record on the user's behalf.
    expect(options.confirmDepartures()).toBe(false);
  });

  it('escalates to a full read when the incremental count does not reconcile', async () => {
    const syncCollection = vi.fn()
      .mockResolvedValueOnce({
        added: 1, updated: 0, departed: 0, departuresRetained: 0, totalOwned: 12,
        newReleases: 1, mode: 'incremental', pagesRead: 1, fullSyncRecommended: true,
      })
      .mockResolvedValueOnce({
        added: 1, updated: 0, departed: 0, departuresRetained: 2, totalOwned: 12,
        newReleases: 1, mode: 'full', pagesRead: 6, fullSyncRecommended: false,
      });
    const { store, notices } = fakeStore({ syncCollection });

    const outcome = await runCatchUp(store, { force: true });

    expect(syncCollection).toHaveBeenCalledTimes(2);
    expect(syncCollection.mock.calls[1]![1].mode).toBe('full');
    // Retained departures have to be surfaced, or a silent retention reads as
    // "nothing changed" while the collection is actually out of date.
    expect(outcome.departuresPending).toBe(2);
    expect(notices.join(' ')).toMatch(/confirm in Settings/i);
  });

  it('forces a full read when the last one is over a week old', async () => {
    const old = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000).toISOString();
    await saveSyncState({ id: 'discogs', lastCollectionSyncAt: old, lastFullSyncAt: old });
    const { store, syncCollection } = fakeStore();
    await runCatchUp(store);
    expect(syncCollection.mock.calls[0]![1].mode).toBe('full');
  });
});
