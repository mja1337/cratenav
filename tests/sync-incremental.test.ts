import 'fake-indexeddb/auto';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { DiscogsSync } from '@/discogs/sync';
import type { DiscogsClient } from '@/discogs/client';
import type { CollectionItem } from '@/domain/types';
import { db, openDatabase, STORES } from '@/data/schema';

const timestamp = '2026-08-24T10:00:00.000Z';
const PER_PAGE = 3;

/** Minimal collection instance: enough for the mapper and the reconciler. */
function instance(instanceId: number, releaseId: number, addedDaysAgo: number) {
  return {
    instance_id: instanceId,
    id: releaseId,
    folder_id: 1,
    date_added: `2026-08-${String(24 - addedDaysAgo).padStart(2, '0')}T10:00:00-00:00`,
    basic_information: { id: releaseId, title: `Release ${releaseId}`, artists: [{ name: 'Artist' }] },
  };
}

function localItem(overrides: Partial<CollectionItem> & { id: string }): CollectionItem {
  return {
    version: 1,
    createdAt: timestamp,
    updatedAt: timestamp,
    discogsReleaseId: 1000,
    collectionFolderId: 1,
    inCollection: true,
    ...overrides,
  } as CollectionItem;
}

/**
 * Serves pages newest-first, the order the real client asks for
 * (`sort=added&sort_order=desc`), and counts how many pages were read.
 */
function pagedClient(all: ReturnType<typeof instance>[]) {
  const calls: number[] = [];
  const client = {
    hasToken: false,
    async collectionPage(_user: string, options: { page?: number } = {}) {
      const page = options.page ?? 1;
      calls.push(page);
      const start = (page - 1) * PER_PAGE;
      return {
        pagination: { page, pages: Math.max(1, Math.ceil(all.length / PER_PAGE)), items: all.length },
        releases: all.slice(start, start + PER_PAGE),
      };
    },
  } as unknown as DiscogsClient;
  return { client, calls };
}

/** A previously synced state has a release row for every owned copy. */
async function storeKnown(entries: readonly ReturnType<typeof instance>[]): Promise<void> {
  for (const entry of entries) {
    await db.put(STORES.collectionItems, localItem({
      id: `item-${entry.instance_id}`,
      discogsInstanceId: entry.instance_id,
      discogsReleaseId: entry.id,
      copyIndex: 0,
    }));
    await db.put(STORES.releases, {
      id: `rel-${entry.id}`,
      version: 1,
      createdAt: timestamp,
      updatedAt: timestamp,
      discogsReleaseId: entry.id,
      title: `Release ${entry.id}`,
      artist: 'Artist',
      hydrationState: 'hydrated',
    });
  }
}

async function clearEveryStore(): Promise<void> {
  await db.transaction(Object.values(STORES), (tx) => {
    for (const store of Object.values(STORES)) tx.objectStore(store).clear();
  });
}

describe('incremental collection sync', () => {
  beforeAll(async () => openDatabase());
  beforeEach(clearEveryStore);

  it('stops after the first page when nothing was added', async () => {
    // Nine owned copies across three pages, all already held locally.
    const remote = Array.from({ length: 9 }, (_, i) => instance(100 + i, 1000 + i, i));
    await storeKnown(remote);
    const { client, calls } = pagedClient(remote);

    const result = await new DiscogsSync(client).syncCollection('dj', { mode: 'incremental' });

    // The whole point: one request instead of three.
    expect(calls).toEqual([1]);
    expect(result).toMatchObject({
      mode: 'incremental', pagesRead: 1, added: 0, departed: 0, fullSyncRecommended: false,
    });
  });

  it('picks up a new record at the top and still stops early', async () => {
    const known = Array.from({ length: 9 }, (_, i) => instance(100 + i, 1000 + i, i + 1));
    await storeKnown(known);
    // Newest first, so yesterday's addition is at the head of page 1.
    const { client, calls } = pagedClient([instance(999, 2000, 0), ...known]);

    const result = await new DiscogsSync(client).syncCollection('dj', { mode: 'incremental' });

    expect(result).toMatchObject({ added: 1, newReleases: 1, fullSyncRecommended: false });
    expect(calls.length).toBeLessThan(4);
    const written = await db.getAll<CollectionItem>(STORES.collectionItems);
    expect(written.filter((item) => item.discogsInstanceId === 999)).toHaveLength(1);
  });

  it('never reports a departure it could not have seen', async () => {
    // This copy sits deep in the collection and is not read at all. Treating
    // an unread copy as departed would flag most of the library as gone.
    const remote = Array.from({ length: 9 }, (_, i) => instance(100 + i, 1000 + i, i));
    await storeKnown(remote);
    await db.put(STORES.collectionItems, localItem({
      id: 'item-deep', discogsInstanceId: 555, discogsReleaseId: 5555, copyIndex: 0,
    }));
    const confirmDepartures = vi.fn(async () => true);
    const { client } = pagedClient(remote);

    const result = await new DiscogsSync(client).syncCollection('dj', {
      mode: 'incremental',
      confirmDepartures,
    });

    expect(confirmDepartures).not.toHaveBeenCalled();
    expect(result.departed).toBe(0);
    expect(await db.get(STORES.collectionItems, 'item-deep')).toMatchObject({ inCollection: true });
    // The count does not reconcile, which is the signal to escalate.
    expect(result.fullSyncRecommended).toBe(true);
  });

  it('does not renumber a doubled release it only partly read', async () => {
    // Two copies of the same release, numbered 0 and 1. An incremental read
    // that sees only the second must leave it as copy 1: numbering from zero
    // would collide with a copy it never read.
    const second = instance(201, 3000, 0);
    await db.put(STORES.collectionItems, localItem({
      id: 'copy-a', discogsInstanceId: 200, discogsReleaseId: 3000, copyIndex: 0,
    }));
    await db.put(STORES.collectionItems, localItem({
      id: 'copy-b', discogsInstanceId: 201, discogsReleaseId: 3000, copyIndex: 1, rating: 3,
    }));
    const { client } = pagedClient([second]);

    await new DiscogsSync(client).syncCollection('dj', { mode: 'incremental' });

    expect(await db.get(STORES.collectionItems, 'copy-b')).toMatchObject({ copyIndex: 1 });
    expect(await db.get(STORES.collectionItems, 'copy-a')).toMatchObject({ copyIndex: 0 });
  });

  it('numbers a newly bought second copy after the one already held', async () => {
    await db.put(STORES.collectionItems, localItem({
      id: 'copy-a', discogsInstanceId: 200, discogsReleaseId: 3000, copyIndex: 0,
    }));
    const { client } = pagedClient([instance(201, 3000, 0), instance(200, 3000, 5)]);

    const result = await new DiscogsSync(client).syncCollection('dj', { mode: 'incremental' });

    expect(result.added).toBe(1);
    const items = await db.getAll<CollectionItem>(STORES.collectionItems);
    const fresh = items.find((item) => item.discogsInstanceId === 201);
    expect(fresh?.copyIndex).toBe(1);
  });

  it('a full sync still reads every page and still finds departures', async () => {
    const remote = Array.from({ length: 7 }, (_, i) => instance(100 + i, 1000 + i, i));
    await db.put(STORES.collectionItems, localItem({
      id: 'item-gone', discogsInstanceId: 777, discogsReleaseId: 7777, copyIndex: 0,
    }));
    const { client, calls } = pagedClient(remote);

    const result = await new DiscogsSync(client).syncCollection('dj', {
      mode: 'full',
      confirmDepartures: async () => true,
    });

    expect(calls).toEqual([1, 2, 3]);
    expect(result).toMatchObject({ mode: 'full', departed: 1, fullSyncRecommended: false });
    expect(await db.get(STORES.collectionItems, 'item-gone')).toMatchObject({ inCollection: false });
  });

  it('defaults to a full sync when no mode is given', async () => {
    const { client, calls } = pagedClient(Array.from({ length: 7 }, (_, i) => instance(100 + i, 1000 + i, i)));
    const result = await new DiscogsSync(client).syncCollection('dj');
    expect(result.mode).toBe('full');
    expect(calls).toEqual([1, 2, 3]);
  });
});
