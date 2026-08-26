import type { DiscogsClient } from './client';
import { DiscogsError } from './client';
import type { CollectionItem, Release, TrackAnalysis } from '@/domain/types';
import {
  mapBasicInformationToRelease,
  mapCollectionInstance,
  mapTracklist,
  mergeFullRelease,
  resolveFieldMap,
} from './mapper';
import {
  getAllCollectionItems,
  getPendingHydration,
  getReleaseByDiscogsId,
  loadSyncState,
  putCollectionItems,
  putRelease,
  putReleases,
  reconcileTracks,
  saveSyncState,
  countPendingHydration,
  getAnalysisForTrack,
  putAnalysis,
  getAllReleases,
  getFailedHydration,
} from '@/data/repositories';
import { newId, nowIso } from '@/utils/ids';

/**
 * Discogs sync orchestration.
 *
 * Two distinct operations, matching spec §24:
 *
 *   syncCollection()    ~6 requests. Answers "what do I own?" Fast, run often.
 *   hydrateMetadata()   1 request per release. Tracklists, artwork, identifiers.
 *                       Slow (~9 min for 549 at 60/min), so it is a resumable
 *                       queue rather than a blocking operation.
 *
 * Resumability is structural rather than bolted on: the queue IS every release
 * whose hydrationState is still 'stub'. Closing the tab mid-import loses
 * nothing, and there is no separate queue table to drift out of sync.
 */

export type SyncPhase =
  | 'idle'
  | 'collection'
  | 'metadata'
  | 'complete'
  | 'aborted'
  | 'error';

export interface SyncProgress {
  phase: SyncPhase;
  message: string;
  current: number;
  total: number;
  /** Seconds remaining at the current pacing, when known. */
  etaSeconds?: number;
  error?: string;
}

export interface CollectionSyncResult {
  added: number;
  updated: number;
  departed: number;
  /** Departures detected but retained because the user declined removal. */
  departuresRetained: number;
  totalOwned: number;
  newReleases: number;
  /** Which strategy actually ran. */
  mode: CollectionSyncMode;
  /** Collection pages fetched. The point of an incremental sync is this being 1. */
  pagesRead: number;
  /**
   * True when an incremental pass cannot account for the collection.
   *
   * An incremental read only sees the newest additions, so it can never detect
   * a departure. When Discogs' own item count does not equal what we hold plus
   * what we just added, something we did not read has changed and only a full
   * pass can say what.
   */
  fullSyncRecommended: boolean;
}

/**
 * `full` reads every page; `incremental` reads from the newest until the
 * additions run out. Departures are only visible to a full pass.
 */
export type CollectionSyncMode = 'full' | 'incremental';

export interface CollectionSyncOptions {
  /** Called after a complete remote read and before any departure is applied. */
  confirmDepartures?: (items: readonly CollectionItem[]) => boolean | Promise<boolean>;
  mode?: CollectionSyncMode;
}

/**
 * An incremental read stops after the first page that contributes nothing new.
 *
 * Discogs is asked for `sort=added&sort_order=desc`, so additions are at the
 * top: once a whole page holds no copy we lack, everything older is older
 * still. A count of consecutive known copies was tried first and is the wrong
 * shape — the threshold has to be smaller than a page to ever fire, but larger
 * than any run of known copies among the additions, and those two constraints
 * conflict for a small collection or a big batch of new records.
 *
 * The trade-off this accepts: an edit to an OLD copy's rating or condition is
 * not seen, because that copy is never re-read. Only a full pass sees those.
 */

export interface HydrationResult {
  hydrated: number;
  failed: number;
  remaining: number;
  tracksCreated: number;
  aborted: boolean;
  /** Discogs returned 429; queued releases were left untouched for a later retry. */
  rateLimited: boolean;
}

type ProgressListener = (progress: SyncProgress) => void;

export class DiscogsSync {
  private controller: AbortController | null = null;
  private listeners = new Set<ProgressListener>();
  private lastProgress: SyncProgress = {
    phase: 'idle',
    message: 'Idle',
    current: 0,
    total: 0,
  };

  constructor(private readonly client: DiscogsClient) {}

  onProgress(listener: ProgressListener): () => void {
    this.listeners.add(listener);
    listener(this.lastProgress);
    return () => this.listeners.delete(listener);
  }

  get progress(): SyncProgress {
    return this.lastProgress;
  }

  get running(): boolean {
    return this.controller !== null;
  }

  private emit(progress: SyncProgress): void {
    this.lastProgress = progress;
    for (const listener of this.listeners) listener(progress);
  }

  /** Stop the current operation. Progress already written to the DB is kept. */
  abort(): void {
    this.controller?.abort();
  }

  private begin(): AbortSignal {
    this.controller?.abort();
    this.controller = new AbortController();
    return this.controller.signal;
  }

  private end(): void {
    this.controller = null;
  }

  // -------------------------------------------------------------------------
  // Collection sync — "what records do I own?"
  // -------------------------------------------------------------------------

  /**
   * Walk the whole collection index and reconcile it against local state.
   *
   * We always walk every page rather than stopping early at the first known
   * instance. It costs ~6 requests for this collection size, and it is the
   * only way to notice REMOVALS as well as additions. A partial walk would
   * silently leave departed records marked as owned.
   */
  async syncCollection(
    username: string,
    options: CollectionSyncOptions = {},
  ): Promise<CollectionSyncResult> {
    const signal = this.begin();
    try {
      this.emit({
        phase: 'collection',
        message: 'Reading collection from Discogs…',
        current: 0,
        total: 0,
      });

      // Custom field ids for media/sleeve condition and notes. Only readable
      // when authenticated as the collection owner, so this is best-effort.
      let fieldMap: { media?: number; sleeve?: number; notes?: number } = {};
      if (this.client.hasToken) {
        try {
          const fields = await this.client.fields(username, signal);
          fieldMap = resolveFieldMap(fields.fields);
        } catch (error) {
          if (signal.aborted) throw error;
          // Not fatal: we simply will not have conditions or notes.
        }
      }

      // Local state is read BEFORE paging so an incremental pass can recognise
      // a copy it already holds and stop as soon as the additions run out.
      const mode = options.mode ?? 'full';
      const localItems = await getAllCollectionItems();
      const localByInstance = new Map<number, CollectionItem>();
      for (const item of localItems) {
        if (item.discogsInstanceId !== undefined) {
          localByInstance.set(item.discogsInstanceId, item);
        }
      }
      const localOwned = localItems.filter(
        (item) => item.inCollection && item.discogsInstanceId !== undefined,
      ).length;

      const instances = [];
      let page = 1;
      let totalPages = 1;
      let totalItems = 0;
      let pagesRead = 0;
      // True once a page held nothing we lack, i.e. we are past the additions.
      let settled = false;

      do {
        const response = await this.client.collectionPage(username, { page, signal });
        pagesRead += 1;
        totalPages = response.pagination.pages || 1;
        totalItems = response.pagination.items || 0;
        const pageInstances = response.releases ?? [];
        instances.push(...pageInstances);

        if (mode === 'incremental') {
          settled = pageInstances.every((entry) => localByInstance.has(entry.instance_id));
        }

        this.emit({
          phase: 'collection',
          message: mode === 'incremental'
            ? `Checking for new records — ${instances.length} of ${totalItems} read`
            : `Reading collection — ${instances.length} of ${totalItems} records`,
          current: instances.length,
          total: mode === 'incremental' ? instances.length : totalItems,
        });
        page += 1;
      } while (
        page <= totalPages &&
        !signal.aborted &&
        !(mode === 'incremental' && settled)
      );

      if (signal.aborted) throw new DOMException('Aborted', 'AbortError');

      // --- reconcile ------------------------------------------------------

      const remoteInstanceIds = new Set<number>();
      const itemsToWrite: CollectionItem[] = [];
      const releasesToWrite: Release[] = [];
      let added = 0;
      let updated = 0;
      let newReleases = 0;

      /**
       * Duplicate copies of the same release get a stable copyIndex.
       *
       * A full read sees every copy, so it can number from zero. An incremental
       * read may see only the newest copy of a doubled release, so numbering
       * from zero there would renumber a copy it never read — the counters are
       * seeded from what is already stored and existing copies keep the number
       * they have.
       */
      const copyCounter = new Map<number, number>();
      if (mode === 'incremental') {
        for (const item of localItems) {
          copyCounter.set(
            item.discogsReleaseId,
            (copyCounter.get(item.discogsReleaseId) ?? 0) + 1,
          );
        }
      }

      for (const instance of instances) {
        remoteInstanceIds.add(instance.instance_id);
        const existing = localByInstance.get(instance.instance_id);
        let copyIndex: number;
        if (existing && mode === 'incremental' && existing.copyIndex !== undefined) {
          copyIndex = existing.copyIndex;
        } else {
          copyIndex = copyCounter.get(instance.id) ?? 0;
          copyCounter.set(instance.id, copyIndex + 1);
        }

        const mapped = mapCollectionInstance(instance, fieldMap, copyIndex);

        if (existing) {
          // Preserve local identity and creation time; take Discogs' view of
          // the collection-level fields.
          const merged: CollectionItem = {
            ...existing,
            discogsReleaseId: mapped.discogsReleaseId,
            collectionFolderId: mapped.collectionFolderId,
            dateAdded: mapped.dateAdded ?? existing.dateAdded,
            rating: mapped.rating ?? existing.rating,
            mediaCondition: mapped.mediaCondition ?? existing.mediaCondition,
            sleeveCondition: mapped.sleeveCondition ?? existing.sleeveCondition,
            notes: mapped.notes ?? existing.notes,
            inCollection: true,
            provisional: false,
            copyIndex,
            updatedAt: nowIso(),
            version: existing.version + 1,
          };
          if (hasChanged(existing, merged)) {
            itemsToWrite.push(merged);
            updated += 1;
          }
        } else {
          itemsToWrite.push(mapped);
          added += 1;
        }

        // Create a stub release the first time we see this release id. The
        // stub already carries artist/title/label/cover from
        // basic_information, so the collection is browsable immediately —
        // hydration only adds tracklists and deeper metadata.
        const knownRelease = await getReleaseByDiscogsId(instance.id);
        if (!knownRelease && !releasesToWrite.some((r) => r.discogsReleaseId === instance.id)) {
          releasesToWrite.push(mapBasicInformationToRelease(instance.basic_information));
          newReleases += 1;
        }
      }

      // Records that have left the collection: retain the row and every piece
      // of analysis attached to it, just flag it as no longer owned. Spec §5.
      /**
       * Only a full read can see a departure.
       *
       * An incremental pass stops once the additions run out, so a record
       * removed from deep in the collection was simply never read — treating
       * its absence as a departure would flag most of the library as gone.
       */
      const departingItems = mode === 'full'
        ? localItems.filter((item) => {
            const instanceId = item.discogsInstanceId;
            return instanceId !== undefined && !remoteInstanceIds.has(instanceId) && item.inCollection;
          })
        : [];
      const departuresConfirmed = !departingItems.length ||
        !options.confirmDepartures ||
        await options.confirmDepartures(departingItems);
      let departed = 0;
      if (departuresConfirmed) {
        for (const item of departingItems) {
          itemsToWrite.push({
            ...item,
            inCollection: false,
            updatedAt: nowIso(),
            version: item.version + 1,
          });
          departed += 1;
        }
      }
      const departuresRetained = departuresConfirmed ? 0 : departingItems.length;

      await putReleases(releasesToWrite);
      await putCollectionItems(itemsToWrite);

      /**
       * Does Discogs' own count agree with what we now hold?
       *
       * This is the only cheap way an incremental pass can tell that something
       * it did not read has changed — a removal, or a copy we had marked as no
       * longer owned reappearing. It does not say WHAT changed, only that a
       * full pass is needed to find out.
       */
      const fullSyncRecommended =
        mode === 'incremental' && totalItems > 0 && localOwned + added !== totalItems;

      const syncState = await loadSyncState();
      await saveSyncState({
        ...syncState,
        lastCollectionSyncAt: nowIso(),
        ...(mode === 'full' ? { lastFullSyncAt: nowIso() } : {}),
        lastSeenCount: totalItems || instances.length,
      });

      const pending = await countPendingHydration();
      const synced = mode === 'incremental'
        ? `${added} new, ${updated} changed`
        : `${instances.length} records synced`;
      this.emit({
        phase: 'complete',
        message: pending ? `${synced} · ${pending} need metadata` : synced,
        current: instances.length,
        total: instances.length,
      });

      return {
        added,
        updated,
        departed,
        departuresRetained,
        totalOwned: mode === 'full' ? instances.length : totalItems || instances.length,
        newReleases,
        mode,
        pagesRead,
        fullSyncRecommended,
      };
    } catch (error) {
      this.report(error);
      throw error;
    } finally {
      this.end();
    }
  }

  // -------------------------------------------------------------------------
  // Metadata hydration — tracklists, artwork, identifiers
  // -------------------------------------------------------------------------

  /**
   * Fetch full metadata for every release still marked 'stub'.
   *
   * Safe to call repeatedly and safe to interrupt: each release is committed
   * individually, so an abort at record 340 of 549 leaves 340 hydrated and 209
   * still queued.
   */
  async hydrateMetadata(options: { limit?: number } = {}): Promise<HydrationResult> {
    const signal = this.begin();
    let hydrated = 0;
    let failed = 0;
    let tracksCreated = 0;
    let rateLimited = false;

    try {
      const pending = await getPendingHydration(options.limit);
      const total = pending.length;

      if (!total) {
        this.emit({
          phase: 'complete',
          message: 'All metadata up to date',
          current: 0,
          total: 0,
        });
        return {
          hydrated: 0,
          failed: 0,
          remaining: 0,
          tracksCreated: 0,
          aborted: false,
          rateLimited: false,
        };
      }

      this.emit({
        phase: 'metadata',
        message: `Fetching metadata for ${total} releases…`,
        current: 0,
        total,
        etaSeconds: this.client.estimateSeconds(total),
      });

      for (const [index, release] of pending.entries()) {
        if (signal.aborted) break;

        try {
          const full = await this.client.release(release.discogsReleaseId, signal);
          const merged = mergeFullRelease(release, full);
          const incoming = mapTracklist(merged, full.tracklist);

          // Preserves track ids, and therefore any attached analysis. Spec §24.
          const { tracks } = await reconcileTracks(merged.id, incoming);
          merged.trackIds = tracks.map((track) => track.id);

          await putRelease(merged);
          await this.ensureAnalysisRows(tracks.map((track) => track.id));

          tracksCreated += tracks.length;
          hydrated += 1;
        } catch (error) {
          if (signal.aborted || (error as Error).name === 'AbortError') break;

          // A quota response applies to the whole account/IP, not this one
          // release. Leave this and every later release queued: marking them
          // all failed would turn a temporary wait into a manual repair job.
          if (error instanceof DiscogsError && error.status === 429) {
            rateLimited = true;
            break;
          }

          const message = error instanceof DiscogsError ? error.message : String(error);
          // Record the failure on the release itself so the UI can offer a
          // retry for just the ones that broke.
          await putRelease({
            ...release,
            hydrationState: 'failed',
            hydrationError: message,
            updatedAt: nowIso(),
            version: release.version + 1,
          });
          failed += 1;
        }

        const done = index + 1;
        this.emit({
          phase: 'metadata',
          message: `${hydrated} of ${total} releases · ${tracksCreated} tracks`,
          current: done,
          total,
          etaSeconds: this.client.estimateSeconds(total - done),
        });
      }

      const remaining = await countPendingHydration();
      const aborted = signal.aborted;

      const syncState = await loadSyncState();
      await saveSyncState({ ...syncState, lastMetadataSweepAt: nowIso() });

      this.emit({
        phase: aborted ? 'aborted' : 'complete',
        message: aborted
          ? `Paused — ${hydrated} done, ${remaining} still queued`
          : rateLimited
            ? `Discogs rate limit reached — ${hydrated} done, ${remaining} still queued`
          : `Metadata complete — ${hydrated} releases, ${tracksCreated} tracks${failed ? `, ${failed} failed` : ''}`,
        current: hydrated,
        total,
      });

      return { hydrated, failed, remaining, tracksCreated, aborted, rateLimited };
    } catch (error) {
      this.report(error);
      throw error;
    } finally {
      this.end();
    }
  }

  /** Requeue everything that previously failed. */
  async retryFailed(): Promise<number> {
    const failures = await getFailedHydration();
    for (const release of failures) {
      await putRelease({
        ...release,
        hydrationState: 'stub',
        hydrationError: undefined,
        updatedAt: nowIso(),
        version: release.version + 1,
      });
    }
    return failures.length;
  }

  /**
   * Force a full metadata refresh. Distinct from a collection sync: this is the
   * heavier "Discogs may have improved these entries" pass from spec §24.
   */
  async requeueAll(): Promise<number> {
    const [releases, items] = await Promise.all([getAllReleases(), getAllCollectionItems()]);
    const ownedIds = new Set(
      items.filter((item) => item.inCollection).map((item) => item.discogsReleaseId),
    );
    const ownedReleases = releases.filter((release) => ownedIds.has(release.discogsReleaseId));
    for (const release of ownedReleases) {
      await putRelease({
        ...release,
        hydrationState: 'stub',
        hydrationError: undefined,
        updatedAt: nowIso(),
        version: release.version + 1,
      });
    }
    return ownedReleases.length;
  }

  /**
   * Every track gets an analysis row immediately, in state ANALYSE.
   *
   * Discogs exposes no BPM or key data at all, so ANALYSE — "no reliable
   * external data found" — is the honest starting state for every track. The
   * row exists from the outset so the provenance and confidence fields are
   * real rather than retrofitted later. Spec §45.12.
   */
  private async ensureAnalysisRows(trackIds: readonly string[]): Promise<void> {
    for (const trackId of trackIds) {
      const existing = await getAnalysisForTrack(trackId);
      if (existing) continue;

      const timestamp = nowIso();
      const analysis: TrackAnalysis = {
        id: newId('ana'),
        createdAt: timestamp,
        updatedAt: timestamp,
        version: 1,
        trackId,
        verifiedBpm: false,
        verifiedKey: false,
        candidates: [],
        state: 'ANALYSE',
      };
      await putAnalysis(analysis);
    }
  }

  private report(error: unknown): void {
    const aborted = (error as Error)?.name === 'AbortError';
    this.emit({
      phase: aborted ? 'aborted' : 'error',
      message: aborted ? 'Stopped' : 'Sync failed',
      current: this.lastProgress.current,
      total: this.lastProgress.total,
      error: aborted ? undefined : error instanceof Error ? error.message : String(error),
    });
  }
}

function hasChanged(before: CollectionItem, after: CollectionItem): boolean {
  return (
    before.rating !== after.rating ||
    before.mediaCondition !== after.mediaCondition ||
    before.sleeveCondition !== after.sleeveCondition ||
    before.notes !== after.notes ||
    before.collectionFolderId !== after.collectionFolderId ||
    before.inCollection !== after.inCollection ||
    before.copyIndex !== after.copyIndex
  );
}
