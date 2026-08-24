import 'fake-indexeddb/auto';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { DiscogsSync } from '@/discogs/sync';
import type { DiscogsClient } from '@/discogs/client';
import type { CollectionItem } from '@/domain/types';
import { db, openDatabase, STORES } from '@/data/schema';

const timestamp = '2026-08-24T10:00:00.000Z';

function localCopy(): CollectionItem {
  return {
    id: 'item-1',
    version: 1,
    createdAt: timestamp,
    updatedAt: timestamp,
    discogsInstanceId: 99,
    discogsReleaseId: 1234,
    inCollection: true,
  };
}

function emptyRemoteClient(): DiscogsClient {
  return {
    hasToken: false,
    async collectionPage() {
      return { pagination: { page: 1, pages: 1, items: 0 }, releases: [] };
    },
  } as unknown as DiscogsClient;
}

async function clearEveryStore(): Promise<void> {
  await db.transaction(Object.values(STORES), (tx) => {
    for (const store of Object.values(STORES)) tx.objectStore(store).clear();
  });
}

describe('Discogs collection departure confirmation', () => {
  beforeAll(async () => openDatabase());
  beforeEach(clearEveryStore);

  it('retains a missing copy when removal is declined', async () => {
    await db.put(STORES.collectionItems, localCopy());
    const confirmDepartures = vi.fn(async () => false);

    const result = await new DiscogsSync(emptyRemoteClient()).syncCollection('dj', {
      confirmDepartures,
    });

    expect(confirmDepartures).toHaveBeenCalledWith([
      expect.objectContaining({ id: 'item-1', discogsInstanceId: 99 }),
    ]);
    expect(result).toMatchObject({ departed: 0, departuresRetained: 1 });
    expect(await db.get(STORES.collectionItems, 'item-1')).toMatchObject({
      inCollection: true,
      version: 1,
    });
  });

  it('soft-removes a missing copy after confirmation', async () => {
    await db.put(STORES.collectionItems, localCopy());

    const result = await new DiscogsSync(emptyRemoteClient()).syncCollection('dj', {
      confirmDepartures: async () => true,
    });

    expect(result).toMatchObject({ departed: 1, departuresRetained: 0 });
    expect(await db.get(STORES.collectionItems, 'item-1')).toMatchObject({
      inCollection: false,
      version: 2,
    });
  });
});
