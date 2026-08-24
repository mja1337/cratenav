import 'fake-indexeddb/auto';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BagTrack } from '@/bags/coverage';
import type { ProviderResult } from '@/enrichment/provider';
import type { Platform } from '@/storage/platform';
import { db, openDatabase, STORES } from '@/data/schema';

const providerState = vi.hoisted(() => ({ lookup: vi.fn(), newLookup: vi.fn() }));

vi.mock('@/enrichment/registry', () => {
  const provider = {
    id: 'background-test',
    name: 'Background test',
    available: true,
    supplies: { bpm: true, key: true },
    lookup: providerState.lookup,
  };
  const newProvider = {
    id: 'new-source',
    name: 'New source',
    available: true,
    supplies: { bpm: true, key: true },
    configured: (options: { getSongBpmApiKey?: string }) => Boolean(options.getSongBpmApiKey),
    lookup: providerState.newLookup,
  };
  return {
    providers: [provider, newProvider],
    availableProviders: (options: { getSongBpmApiKey?: string } = {}) =>
      [provider, ...(newProvider.configured(options) ? [newProvider] : [])],
    lookupOptionsForSettings: (settings: {
      metadataContact?: string;
      getSongBpmApiKey?: string;
    }) => ({
      contact: settings.metadataContact,
      getSongBpmApiKey: settings.getSongBpmApiKey,
    }),
  };
});

import { Store } from '@/app/store';

const timestamp = '2026-08-24T10:00:00.000Z';
const platform = {
  device: { deviceId: 'test-device', platform: 'web', isStandalone: false, isTouch: false },
} as Platform;

function entry(analysis?: BagTrack['analysis']): BagTrack {
  const track = {
    id: 'track-1', releaseId: 'release-1', position: 'A1', artist: 'Artist', title: 'Track',
    sequence: 0, version: 1, createdAt: timestamp, updatedAt: timestamp,
  };
  return {
    track,
    release: {
      id: 'release-1', discogsReleaseId: 1, artist: 'Artist', artistSort: 'artist', title: 'Release',
      formats: [], genres: [], styles: [], identifiers: [], artwork: [], trackIds: [track.id],
      references: [], hydrationState: 'hydrated', version: 1, createdAt: timestamp, updatedAt: timestamp,
    },
    analysis,
  };
}

function store(getSongBpmApiKey?: string): Store {
  return new Store(platform, {
    id: 'settings', theme: 'dark', keyNotation: 'camelot', deviceId: 'test-device',
    metadataContact: 'dj@example.test', updatedAt: timestamp,
    getSongBpmApiKey,
  });
}

async function clearEveryStore(): Promise<void> {
  await db.transaction(Object.values(STORES), (tx) => {
    for (const name of Object.values(STORES)) tx.objectStore(name).clear();
  });
}

describe('app-level background operations', () => {
  beforeAll(async () => openDatabase());
  beforeEach(async () => {
    providerState.lookup.mockReset();
    providerState.newLookup.mockReset();
    providerState.newLookup.mockResolvedValue([]);
    await clearEveryStore();
  });

  it('keeps enrichment progress independently of any view lifecycle', async () => {
    let finish!: (results: ProviderResult[]) => void;
    providerState.lookup.mockReturnValue(new Promise<ProviderResult[]>((resolve) => {
      finish = resolve;
    }));
    const subject = store();
    const observed: number[] = [];
    subject.subscribeOperations((operations) => {
      if (operations.enrichment) observed.push(operations.enrichment.current);
    });

    const running = subject.startEnrichment([entry()]);
    expect(subject.enrichmentRunning).toBe(true);
    expect(subject.operations.enrichment).toMatchObject({ current: 0, total: 1 });

    finish([]);
    await running;

    expect(subject.enrichmentRunning).toBe(false);
    expect(subject.operations.enrichment).toBeUndefined();
    expect(observed).toEqual([0, 1]);
  });

  it('offers a global pause action that checkpoints and clears progress', async () => {
    providerState.lookup.mockImplementation((_context, options) =>
      new Promise<ProviderResult[]>((_resolve, reject) => {
        options?.signal?.addEventListener('abort', () => {
          reject(new DOMException('Aborted', 'AbortError'));
        }, { once: true });
      }));
    const subject = store();

    const running = subject.startEnrichment([entry()]);
    subject.stopBulkOperation('enrichment');
    await running;

    expect(subject.operations.enrichment).toBeUndefined();
    expect(subject.snapshot.notice?.text).toContain('Paused after 0 tracks');
  });

  it('checks only a newly configured source when an older source already completed', async () => {
    providerState.lookup.mockResolvedValue([]);
    const subject = store('new-key');
    const analysis = {
      id: 'analysis-1', trackId: 'track-1', state: 'ANALYSE' as const,
      verifiedBpm: false, verifiedKey: false, candidates: [],
      enrichmentAttempts: [{
        provider: 'background-test', attemptedAt: timestamp, outcome: 'none' as const,
      }],
      version: 1, createdAt: timestamp, updatedAt: timestamp,
    };

    await subject.startEnrichment([entry(analysis)]);

    expect(providerState.lookup).not.toHaveBeenCalled();
    expect(providerState.newLookup).toHaveBeenCalledOnce();
  });

  it('can explicitly recheck a completed provider', async () => {
    providerState.lookup.mockResolvedValue([]);
    const subject = store();
    const analysis = {
      id: 'analysis-1', trackId: 'track-1', state: 'ANALYSE' as const,
      verifiedBpm: false, verifiedKey: false, candidates: [],
      enrichmentAttempts: [{
        provider: 'background-test', attemptedAt: timestamp, outcome: 'none' as const,
      }],
      version: 1, createdAt: timestamp, updatedAt: timestamp,
    };

    await subject.startEnrichment([entry(analysis)], {
      providerIds: ['background-test'],
      retryCompleted: true,
    });

    expect(providerState.lookup).toHaveBeenCalledOnce();
  });

  it('excludes missing-disc tracks per physical copy from collection and bag pools', async () => {
    await db.put(STORES.releases, {
      id: 'release-1', discogsReleaseId: 1, artist: 'Artist', artistSort: 'artist', title: 'Album',
      formats: [{ name: 'Vinyl', qty: '2' }], genres: [], styles: [], identifiers: [], artwork: [],
      trackIds: ['track-a', 'track-c'], references: [], hydrationState: 'hydrated',
      version: 1, createdAt: timestamp, updatedAt: timestamp,
    });
    await db.put(STORES.tracks, {
      id: 'track-a', releaseId: 'release-1', position: 'A1', artist: 'Artist', title: 'A side',
      sequence: 0, version: 1, createdAt: timestamp, updatedAt: timestamp,
    });
    await db.put(STORES.tracks, {
      id: 'track-c', releaseId: 'release-1', position: 'C1', artist: 'Artist', title: 'C side',
      sequence: 1, version: 1, createdAt: timestamp, updatedAt: timestamp,
    });
    await db.put(STORES.collectionItems, {
      id: 'incomplete', discogsReleaseId: 1, inCollection: true, missingRecordNumbers: [2],
      version: 1, createdAt: timestamp, updatedAt: timestamp,
    });
    const subject = store();
    await subject.reload();
    const incompleteBag = {
      id: 'bag-1', name: 'Bag', status: 'active' as const, collectionItemIds: ['incomplete'],
      version: 1, createdAt: timestamp, updatedAt: timestamp,
    };

    expect(subject.allTrackEntries().map((row) => row.track.id)).toEqual(['track-a']);
    expect(subject.resolveBagTracks(incompleteBag).map((row) => row.track.id)).toEqual(['track-a']);

    await db.put(STORES.collectionItems, {
      id: 'complete', discogsReleaseId: 1, inCollection: true,
      version: 1, createdAt: timestamp, updatedAt: timestamp,
    });
    await subject.reload();

    expect(subject.allTrackEntries().map((row) => row.track.id)).toEqual(['track-a', 'track-c']);
    expect(subject.resolveBagTracks(incompleteBag).map((row) => row.track.id)).toEqual(['track-a']);
    expect(subject.resolveBagTracks({
      ...incompleteBag,
      collectionItemIds: ['incomplete', 'complete'],
    }).map((row) => row.track.id)).toEqual(['track-a', 'track-c']);
  });
});
