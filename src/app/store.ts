import type {
  Bag,
  CollectionItem,
  EnrichmentAttempt,
  KeyNotation,
  PlayState,
  Release,
  SetPlan,
  Settings,
  ThemePreference,
  Track,
  TrackAnalysis,
} from '@/domain/types';
import type { BagTrack } from '@/bags/coverage';
import { activate, activeBag as findActiveBag } from '@/bags/operations';
import { findDeckProfile, type DeckProfile, type PitchTolerance } from '@/pitch/deck';
import {
  countPendingHydration,
  getAnalysisForTrack,
  putAnalysis,
  getAllAnalyses,
  getAllBags,
  getAllCollectionItems,
  getAllPlayStates,
  getAllReleases,
  getAllSetPlans,
  getAllTracks,
  loadSettings,
  loadSyncState,
  markCollectionItemsNotOwned,
  putBag,
  putBags,
  putCollectionItems,
  putSetPlan,
  saveSettings,
  setPlayState,
  softDeleteBag,
  softDeleteSetPlan,
  type SyncState,
} from '@/data/repositories';
import type { Platform } from '@/storage/platform';
import { newId, nowIso } from '@/utils/ids';
import { DiscogsClient } from '@/discogs/client';
import { DiscogsSync } from '@/discogs/sync';
import { isCdTrackPosition } from '@/discogs/track-position';
import {
  isTrackAvailableOnAnyItem,
  isTrackAvailableOnItem,
  physicalRecordsForRelease,
} from '@/discogs/physical-records';
import { candidateConflicts, type EnrichmentResolution } from '@/enrichment/resolution';
import { applyResolution } from '@/enrichment/resolution';
import { availableProviders, lookupOptionsForSettings } from '@/enrichment/registry';
import { attemptsForRun, runEnrichment } from '@/enrichment/runner';
import { DEFAULT_SLEEVE_COLORS, isHexColor, sleevePalette } from '@/sleeves/palette';
import type { SleeveColor } from '@/domain/types';

/**
 * Application state.
 *
 * A single observable snapshot rather than scattered module globals, so views
 * re-render from one source of truth. The whole library is held in memory: at
 * ~550 releases and a few thousand tracks that is a fraction of a megabyte,
 * and it makes search and filtering instant with no query layer.
 */

export interface LibrarySnapshot {
  releases: Release[];
  tracks: Track[];
  items: CollectionItem[];
  analyses: TrackAnalysis[];
  tracksByRelease: Map<string, Track[]>;
  analysisByTrack: Map<string, TrackAnalysis>;
  itemsByRelease: Map<number, CollectionItem[]>;
  pendingHydration: number;
  bags: Bag[];
  setPlans: SetPlan[];
  /** Keyed "bagId::trackId". */
  playStates: Map<string, PlayState>;
}

export interface AppState {
  ready: boolean;
  settings: Settings;
  library: LibrarySnapshot;
  syncState: SyncState;
  /** Non-fatal message surfaced in the UI. */
  notice?: { kind: 'info' | 'warning' | 'error'; text: string };
}

export type BulkOperationKind = 'discogs' | 'enrichment';

export interface BulkOperation {
  kind: BulkOperationKind;
  label: string;
  message: string;
  current: number;
  total: number;
  etaSeconds?: number;
  route: 'settings' | 'analyse';
  stopLabel: 'Stop' | 'Pause';
}

export type BulkOperations = Partial<Record<BulkOperationKind, BulkOperation>>;

/** Hard ceiling for one track's providers, including their own retries. */
const TRACK_WATCHDOG_MS = 60_000;

/**
 * Reject if a single track's lookup outlives the watchdog.
 *
 * A user Stop is left to propagate as an abort; only a genuine stall is turned
 * into a failure, so the batch records it and continues.
 */
function withTrackWatchdog<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      if (signal.aborted) return;
      reject(new Error('Lookup stalled for this track and was abandoned.'));
    }, TRACK_WATCHDOG_MS);
    work.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

function playStateKey(bagId: string, trackId: string): string {
  return `${bagId}::${trackId}`;
}

const EMPTY_LIBRARY: LibrarySnapshot = {
  releases: [],
  tracks: [],
  items: [],
  analyses: [],
  tracksByRelease: new Map(),
  analysisByTrack: new Map(),
  itemsByRelease: new Map(),
  pendingHydration: 0,
  bags: [],
  setPlans: [],
  playStates: new Map(),
};

type Listener = (state: AppState) => void;
type OperationListener = (operations: BulkOperations) => void;

export class Store {
  private state: AppState;
  private listeners = new Set<Listener>();
  private operationState: BulkOperations = {};
  private operationListeners = new Set<OperationListener>();
  private enrichmentController?: AbortController;

  readonly client: DiscogsClient;
  readonly sync: DiscogsSync;

  constructor(
    readonly platform: Platform,
    settings: Settings,
  ) {
    this.state = {
      ready: false,
      settings,
      library: EMPTY_LIBRARY,
      syncState: { id: 'discogs' },
    };
    this.client = new DiscogsClient({ token: settings.discogsToken });
    this.sync = new DiscogsSync(this.client);
    this.sync.onProgress((progress) => {
      if (progress.phase === 'collection' || progress.phase === 'metadata') {
        this.setOperation('discogs', {
          kind: 'discogs',
          label: progress.phase === 'collection' ? 'Syncing Discogs collection' : 'Fetching Discogs metadata',
          message: progress.message,
          current: progress.current,
          total: progress.total,
          etaSeconds: progress.etaSeconds,
          route: 'settings',
          stopLabel: 'Stop',
        });
      } else {
        this.setOperation('discogs', undefined);
      }
    });
  }

  static async create(platform: Platform): Promise<Store> {
    const settings = await loadSettings(platform.device.deviceId);
    const store = new Store(platform, settings);
    await store.reload();
    return store;
  }

  get snapshot(): AppState {
    return this.state;
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  get operations(): BulkOperations {
    return this.operationState;
  }

  subscribeOperations(listener: OperationListener): () => void {
    this.operationListeners.add(listener);
    listener(this.operationState);
    return () => this.operationListeners.delete(listener);
  }

  stopBulkOperation(kind: BulkOperationKind): void {
    if (kind === 'discogs') this.sync.abort();
    else this.enrichmentController?.abort();
  }

  private setOperation(kind: BulkOperationKind, operation: BulkOperation | undefined): void {
    const next = { ...this.operationState };
    if (operation) next[kind] = operation;
    else delete next[kind];
    this.operationState = next;
    for (const listener of this.operationListeners) listener(this.operationState);
  }

  private set(patch: Partial<AppState>): void {
    this.state = { ...this.state, ...patch };
    for (const listener of this.listeners) listener(this.state);
  }

  /** Re-read everything from IndexedDB and rebuild the lookup indexes. */
  async reload(): Promise<void> {
    const [releases, tracks, items, analyses, syncState, pendingHydration, bags, setPlans, playStateRows] =
      await Promise.all([
        getAllReleases(),
        getAllTracks(),
        getAllCollectionItems(),
        getAllAnalyses(),
        loadSyncState(),
        countPendingHydration(),
        getAllBags(),
        getAllSetPlans(),
        getAllPlayStates(),
      ]);

    const tracksByRelease = new Map<string, Track[]>();
    for (const track of tracks) {
      const bucket = tracksByRelease.get(track.releaseId);
      if (bucket) bucket.push(track);
      else tracksByRelease.set(track.releaseId, [track]);
    }
    for (const bucket of tracksByRelease.values()) {
      bucket.sort((a, b) => a.sequence - b.sequence);
    }

    const analysisByTrack = new Map<string, TrackAnalysis>();
    for (const analysis of analyses) analysisByTrack.set(analysis.trackId, analysis);

    const itemsByRelease = new Map<number, CollectionItem[]>();
    for (const item of items) {
      const bucket = itemsByRelease.get(item.discogsReleaseId);
      if (bucket) bucket.push(item);
      else itemsByRelease.set(item.discogsReleaseId, [item]);
    }

    releases.sort(
      (a, b) =>
        a.artistSort.localeCompare(b.artistSort) || a.title.localeCompare(b.title),
    );

    this.set({
      ready: true,
      syncState,
      library: {
        releases,
        tracks,
        items,
        analyses,
        tracksByRelease,
        analysisByTrack,
        itemsByRelease,
        pendingHydration,
        bags: bags.filter((bag) => !bag.deletedAt),
        setPlans: setPlans.filter((plan) => !plan.deletedAt),
        playStates: new Map(
          playStateRows.map((row) => [playStateKey(row.bagId, row.trackId), row.state]),
        ),
      },
    });
  }

  // --- settings -------------------------------------------------------------

  async updateSettings(patch: Partial<Settings>): Promise<void> {
    const next = await saveSettings({ ...this.state.settings, ...patch });
    if ('discogsToken' in patch) this.client.setToken(next.discogsToken);
    this.set({ settings: next });
    if ('theme' in patch) applyTheme(next.theme);
  }

  async setTheme(theme: ThemePreference): Promise<void> {
    await this.updateSettings({ theme });
  }

  async setKeyNotation(keyNotation: KeyNotation): Promise<void> {
    await this.updateSettings({ keyNotation });
  }

  /**
   * Write BPM/key knowledge for a track, creating the analysis row if needed.
   *
   * The resulting state follows spec §9: anything a human has confirmed is
   * READY, a value from an automated source that nobody has checked is VERIFY,
   * and an empty row stays ANALYSE.
   */
  async updateAnalysis(trackId: string, patch: Partial<TrackAnalysis>): Promise<void> {
    const existing = await getAnalysisForTrack(trackId);
    const timestamp = nowIso();

    const base: TrackAnalysis =
      existing ??
      {
        id: newId('ana'),
        createdAt: timestamp,
        updatedAt: timestamp,
        version: 0,
        trackId,
        verifiedBpm: false,
        verifiedKey: false,
        candidates: [],
        state: 'ANALYSE',
      };

    const next: TrackAnalysis = {
      ...base,
      ...patch,
      trackId,
      updatedAt: timestamp,
      version: base.version + 1,
      analysisDate: patch.analysisDate ?? timestamp,
    };

    const hasBpm = next.canonicalBpm !== undefined;
    const hasKey = next.camelotKey !== undefined;
    const verified = (hasBpm ? next.verifiedBpm : true) && (hasKey ? next.verifiedKey : true);

    const conflicts = candidateConflicts(next.candidates);
    const unresolvedConflict =
      (conflicts.bpm && !next.verifiedBpm) || (conflicts.key && !next.verifiedKey);
    next.state = unresolvedConflict
      ? 'CONFLICT'
      : !hasBpm && !hasKey
        ? 'ANALYSE'
        : verified
          ? 'READY'
          : 'VERIFY';

    await putAnalysis(next);
    await this.reload();
  }

  /** Apply centrally adjudicated provider results without overwriting verified work. */
  async applyEnrichment(
    trackId: string,
    resolution: EnrichmentResolution,
    options: { reload?: boolean; attempts?: readonly EnrichmentAttempt[] } = {},
  ): Promise<void> {
    const existing = await getAnalysisForTrack(trackId);
    const next = applyResolution(trackId, existing, resolution);
    if (options.attempts?.length) {
      next.enrichmentAttempts = [
        ...(existing?.enrichmentAttempts ?? []),
        ...options.attempts,
      ];
    }
    await putAnalysis(next);
    if (options.reload !== false) await this.reload();
  }

  get enrichmentRunning(): boolean {
    return Boolean(this.enrichmentController);
  }

  /**
   * Run online enrichment as an app-level operation. It deliberately outlives
   * the Analyse view, so normal navigation cannot cancel a long batch.
   */
  async startEnrichment(
    targets: readonly BagTrack[],
    options: { providerIds?: readonly string[]; retryCompleted?: boolean } = {},
  ): Promise<void> {
    if (this.enrichmentController || !targets.length) return;
    const lookupOptions = lookupOptionsForSettings(this.state.settings);
    const requestedProviderIds = options.providerIds ? new Set(options.providerIds) : undefined;
    const configuredProviders = availableProviders(lookupOptions).filter(
      (provider) => !requestedProviderIds || requestedProviderIds.has(provider.id),
    );
    if (!configuredProviders.length) {
      this.notify('error', 'Configure at least one online analysis source before searching.');
      return;
    }

    const adaptersFor = (entry: BagTrack) => configuredProviders.filter((provider) => {
      const relevant =
        (entry.analysis?.canonicalBpm === undefined && provider.supplies.bpm) ||
        ((!entry.analysis?.canonicalKey && !entry.analysis?.camelotKey) && provider.supplies.key);
      if (!relevant || options.retryCompleted) return relevant;
      return !(entry.analysis?.enrichmentAttempts ?? []).some(
        (attempt) =>
          attempt.provider === provider.id &&
          (attempt.outcome === 'found' || attempt.outcome === 'none'),
      );
    });
    const runTargets = targets.filter((entry) => adaptersFor(entry).length > 0);
    if (!runTargets.length) {
      this.notify('info', 'Those tracks have already been checked by the selected source.');
      return;
    }

    const controller = new AbortController();
    this.enrichmentController = controller;
    const progress = { current: 0, total: runTargets.length, found: 0, none: 0, errors: 0 };
    let consecutiveErrors = 0;
    let stoppedForErrors = false;
    let unexpectedFailure = false;
    let storageFailed = false;
    let lastError: string | undefined;

    const publish = () => this.setOperation('enrichment', {
      kind: 'enrichment',
      label: 'Finding BPM and key online',
      message:
        `${progress.current} of ${progress.total} tracks · ${progress.found} matches · ` +
        `${progress.none} no data · ${progress.errors} errors`,
      current: progress.current,
      total: progress.total,
      etaSeconds: Math.max(0, progress.total - progress.current) * 2,
      route: 'analyse',
      stopLabel: 'Pause',
    });
    publish();

    try {
      for (const entry of runTargets) {
        controller.signal.throwIfAborted();
        const adapters = adaptersFor(entry);
        const attemptedAt = nowIso();

        // One track must never be able to end the batch. Provider errors are
        // already handled inside runEnrichment, but resolution and the
        // IndexedDB write sit outside it, and a single failure there used to
        // escape and kill a thousand-track run with no visible reason.
        try {
          // Belt and braces over the per-request timeouts in the providers.
          // This is an unattended batch of a thousand rows, so no single track
          // may be able to wedge it: whatever stalls, the row fails and the
          // run moves on.
          const run = await withTrackWatchdog(
            runEnrichment(
              {
                track: entry.track,
                release: entry.release,
                siblings: this.tracksFor(entry.release.id),
              },
              adapters,
              { signal: controller.signal, ...lookupOptions },
            ),
            controller.signal,
          );
          const allFailed = run.failures.length === adapters.length;
          progress.errors += run.failures.length;
          if (run.failures.length) {
            lastError = run.failures
              .map((failure) => `${failure.providerName}: ${failure.message}`)
              .join(' | ');
          }
          if (allFailed) {
            consecutiveErrors += 1;
          } else if (run.resolution.candidates.length) {
            consecutiveErrors = 0;
            progress.found += 1;
          } else {
            consecutiveErrors = 0;
            progress.none += 1;
          }
          await this.applyEnrichment(entry.track.id, run.resolution, {
            reload: false,
            attempts: attemptsForRun(run, attemptedAt),
          });
        } catch (error) {
          // Abort is a user action, not a failure: let it out.
          if (controller.signal.aborted || (error as Error)?.name === 'AbortError') throw error;
          consecutiveErrors += 1;
          progress.errors += 1;
          lastError = error instanceof Error ? error.message : String(error);
          // Record the failure durably so a retry can find this row again.
          try {
            await this.applyEnrichment(
              entry.track.id,
              { state: 'ANALYSE', candidates: [], conflicts: { bpm: false, key: false }, reason: lastError },
              {
                reload: false,
                attempts: adapters.map((provider) => ({
                  provider: provider.id,
                  attemptedAt,
                  outcome: 'error' as const,
                  message: lastError,
                })),
              },
            );
          } catch {
            // If even the checkpoint cannot be written, storage itself is the
            // problem. Stop rather than spin through every remaining track.
            storageFailed = true;
            break;
          }
        }

        progress.current += 1;
        publish();

        if (consecutiveErrors >= 3) {
          stoppedForErrors = true;
          break;
        }
      }
    } catch (error) {
      if (!controller.signal.aborted && (error as Error)?.name !== 'AbortError') {
        unexpectedFailure = true;
        this.notify('error', error instanceof Error ? error.message : 'Online enrichment failed.');
      }
    } finally {
      const paused = controller.signal.aborted;
      this.enrichmentController = undefined;
      this.setOperation('enrichment', undefined);
      await this.reload();
      if (storageFailed) {
        this.notify(
          'error',
          `Stopped: this device could not save results${lastError ? ` (${lastError})` : ''}. ` +
            'Local storage may be full. Export a backup, then clear space before continuing.',
        );
      } else if (stoppedForErrors) {
        this.notify(
          'warning',
          'Online lookup stopped after three consecutive errors. Error rows remain queued for retry.' +
            (lastError ? ` Last error: ${lastError}` : ''),
        );
      } else if (paused) {
        this.notify('info', `Paused after ${progress.current} tracks. Progress has been saved.`);
      } else if (!unexpectedFailure) {
        this.notify(
          'info',
          `${progress.found} online ${progress.found === 1 ? 'match' : 'matches'} found` +
            `${progress.errors ? `, ${progress.errors} errors` : ''}. All results need verification.` +
            (progress.errors && lastError ? ` Last error: ${lastError}` : ''),
        );
      }
    }
  }

  // --- bags -----------------------------------------------------------------

  get bags(): Bag[] {
    return this.state.library.bags;
  }

  get activeBag(): Bag | undefined {
    return findActiveBag(this.state.library.bags);
  }

  getBag(id: string): Bag | undefined {
    return this.state.library.bags.find((bag) => bag.id === id);
  }

  async saveBag(bag: Bag): Promise<void> {
    await putBag(bag);
    await this.reload();
  }

  async deleteBag(bag: Bag): Promise<void> {
    await softDeleteBag(bag);
    await this.reload();
  }

  /** Promote one bag to active and demote whichever held it. */
  async activateBag(bagId: string): Promise<void> {
    const changed = activate(this.state.library.bags, bagId);
    if (changed.length) await putBags(changed);
    await this.updateSettings({ activeBagId: bagId });
    await this.reload();
  }

  // --- set plans ------------------------------------------------------------

  getSetPlan(id: string): SetPlan | undefined {
    return this.state.library.setPlans.find((plan) => plan.id === id);
  }

  setPlansForBag(bagId: string): SetPlan[] {
    return this.state.library.setPlans.filter((plan) => plan.bagId === bagId);
  }

  async saveSetPlan(plan: SetPlan): Promise<void> {
    await putSetPlan(plan);
    await this.reload();
  }

  async deleteSetPlan(plan: SetPlan): Promise<void> {
    await softDeleteSetPlan(plan);
    await this.reload();
  }

  // --- play state -----------------------------------------------------------

  playStateFor(bagId: string, trackId: string): PlayState {
    return this.state.library.playStates.get(playStateKey(bagId, trackId)) ?? 'packed';
  }

  async setTrackPlayState(bagId: string, trackId: string, state: PlayState): Promise<void> {
    await setPlayState(bagId, trackId, state);
    await this.reload();
  }

  // --- replacement sleeves -------------------------------------------------

  get sleeveColors(): SleeveColor[] {
    return sleevePalette(this.state.settings);
  }

  async addSleeveColor(name: string, hex: string): Promise<void> {
    const cleanName = name.trim();
    const cleanHex = hex.toLowerCase();
    if (!cleanName) throw new Error('Enter a sleeve colour name.');
    if (!isHexColor(cleanHex)) throw new Error('Choose a valid six-digit colour.');
    if (this.sleeveColors.some((color) => color.name.toLowerCase() === cleanName.toLowerCase())) {
      throw new Error('A sleeve colour with that name already exists.');
    }
    const custom: SleeveColor = { id: newId('slv'), name: cleanName, hex: cleanHex };
    await this.updateSettings({
      customSleeveColors: [...(this.state.settings.customSleeveColors ?? []), custom],
    });
  }

  async deleteSleeveColor(colorId: string): Promise<void> {
    if (DEFAULT_SLEEVE_COLORS.some((color) => color.id === colorId)) return;
    if (this.state.library.items.some((item) => item.sleeveColorId === colorId)) {
      throw new Error('This sleeve colour is assigned to a record. Remove those assignments first.');
    }
    await this.updateSettings({
      customSleeveColors: (this.state.settings.customSleeveColors ?? []).filter(
        (color) => color.id !== colorId,
      ),
    });
  }

  async setSleeveColor(itemId: string, colorId: string | undefined): Promise<void> {
    const item = this.state.library.items.find((candidate) => candidate.id === itemId);
    if (!item) throw new Error('Collection copy not found.');
    if (colorId && !this.sleeveColors.some((color) => color.id === colorId)) {
      throw new Error('Sleeve colour not found.');
    }
    await putCollectionItems([{
      ...item,
      sleeveColorId: colorId,
      updatedAt: nowIso(),
      version: item.version + 1,
    }]);
    await this.reload();
  }

  async setRecordMissing(itemId: string, recordNumber: number, missing: boolean): Promise<void> {
    const item = this.state.library.items.find((candidate) => candidate.id === itemId);
    if (!item) throw new Error('Collection copy not found.');
    const release = this.state.library.releases.find(
      (candidate) => candidate.discogsReleaseId === item.discogsReleaseId,
    );
    if (!release) throw new Error('Release not found.');
    const records = physicalRecordsForRelease(
      release,
      this.state.library.tracksByRelease.get(release.id) ?? [],
    );
    if (!records.some((record) => record.number === recordNumber)) {
      throw new Error('Physical record not found.');
    }
    const numbers = new Set(item.missingRecordNumbers ?? []);
    if (missing) numbers.add(recordNumber);
    else numbers.delete(recordNumber);
    await putCollectionItems([{
      ...item,
      missingRecordNumbers: [...numbers].sort((a, b) => a - b),
      updatedAt: nowIso(),
      version: item.version + 1,
    }]);
    await this.reload();
  }

  /** Hide every owned physical copy of a release without deleting its analysis. */
  async removeReleaseFromCollection(discogsReleaseId: number): Promise<number> {
    const ownedIds = this.itemsFor(discogsReleaseId)
      .filter((item) => item.inCollection)
      .map((item) => item.id);
    const removed = await markCollectionItemsNotOwned(ownedIds);
    if (removed) await this.reload();
    return removed;
  }

  sleeveColorForRelease(discogsReleaseId: number): SleeveColor | undefined {
    const colors = new Map(this.sleeveColors.map((color) => [color.id, color]));
    const items = this.itemsFor(discogsReleaseId)
      .filter((item) => item.inCollection && item.sleeveColorId)
      .sort((a, b) => (a.copyIndex ?? 0) - (b.copyIndex ?? 0));
    return items.length ? colors.get(items[0]!.sleeveColorId!) : undefined;
  }

  // --- resolution -----------------------------------------------------------

  /**
   * Expand a bag into the tracks it actually contains.
   *
   * A bag holds collection items (physical copies), but mixing decisions are
   * made per track, so this walks item -> release -> tracks and attaches the
   * analysis and per-bag play state each one carries.
   */
  resolveBagTracks(bag: Bag): BagTrack[] {
    const { library } = this.state;
    const wanted = new Set(bag.collectionItemIds);
    const entries: BagTrack[] = [];
    const seenTracks = new Set<string>();

    for (const item of library.items) {
      if (!wanted.has(item.id) || !item.inCollection) continue;

      const release = library.releases.find(
        (candidate) => candidate.discogsReleaseId === item.discogsReleaseId,
      );
      if (!release) continue;

      const releaseTracks = library.tracksByRelease.get(release.id) ?? [];
      const physicalRecords = physicalRecordsForRelease(release, releaseTracks);

      for (const track of releaseTracks) {
        if (!this.isVisibleTrack(track)) continue;
        if (!isTrackAvailableOnItem(track.id, physicalRecords, item)) continue;
        // Two copies of the same record must not double every track.
        if (seenTracks.has(track.id)) continue;
        seenTracks.add(track.id);

        entries.push({
          track,
          release,
          analysis: library.analysisByTrack.get(track.id),
          playState: this.playStateFor(bag.id, track.id),
        });
      }
    }
    return entries;
  }

  /** Which collection items are in a bag, for the picker. */
  bagItemIds(bag: Bag): Set<string> {
    return new Set(bag.collectionItemIds);
  }

  /**
   * One track as an enrichment/recommendation target.
   *
   * Views need this to run a lookup for a single row without reaching into the
   * library snapshot and rebuilding the shape themselves.
   */
  trackEntry(trackId: string): BagTrack | undefined {
    const track = this.getTrack(trackId);
    if (!track) return undefined;
    const release = this.getRelease(track.releaseId);
    if (!release) return undefined;
    return {
      track,
      release,
      analysis: this.state.library.analysisByTrack.get(track.id),
    };
  }

  /** Every track on one release, for a record-by-record lookup. */
  releaseEntries(releaseId: string): BagTrack[] {
    const release = this.getRelease(releaseId);
    if (!release) return [];
    return (this.state.library.tracksByRelease.get(release.id) ?? []).map((track) => ({
      track,
      release,
      analysis: this.state.library.analysisByTrack.get(track.id),
    }));
  }

  /** Every track in the library, for the explicit full-collection scope. */
  allTrackEntries(): BagTrack[] {
    const { library } = this.state;
    const entries: BagTrack[] = [];
    for (const release of this.ownedReleases) {
      const releaseTracks = library.tracksByRelease.get(release.id) ?? [];
      const records = physicalRecordsForRelease(release, releaseTracks);
      const items = this.itemsFor(release.discogsReleaseId).filter((item) => item.inCollection);
      for (const track of releaseTracks) {
        if (!this.isVisibleTrack(track)) continue;
        if (!isTrackAvailableOnAnyItem(track.id, records, items)) continue;
        entries.push({
          track,
          release,
          analysis: library.analysisByTrack.get(track.id),
        });
      }
    }
    return entries;
  }

  // --- pitch / deck (spec v1.1 §7, §25) -------------------------------------

  get deck(): DeckProfile {
    return findDeckProfile(this.state.settings.deckProfileId);
  }

  /**
   * Deck range plus the pitch the user is happy to use.
   *
   * Every pitch-aware calculation reads this, so changing deck in Settings
   * immediately changes what counts as reachable.
   */
  get pitchTolerance(): PitchTolerance {
    const deck = this.deck;
    const preferred = this.state.settings.preferredMaxPitchPercent;
    return {
      deck,
      // Default to half the deck's range as "comfortable", which lands on the
      // ±4% the spec suggests for a ±8% turntable.
      preferredMaxPitchPercent: preferred ?? Math.min(4, deck.pitchRangeMax),
    };
  }

  notify(kind: 'info' | 'warning' | 'error', text: string): void {
    this.set({ notice: { kind, text } });
  }

  clearNotice(): void {
    this.set({ notice: undefined });
  }

  // --- derived --------------------------------------------------------------

  getRelease(id: string): Release | undefined {
    return this.state.library.releases.find((release) => release.id === id);
  }

  getTrack(id: string): Track | undefined {
    const track = this.state.library.tracks.find((candidate) => candidate.id === id);
    return track && this.isVisibleTrack(track) ? track : undefined;
  }

  tracksFor(releaseId: string): Track[] {
    return (this.state.library.tracksByRelease.get(releaseId) ?? []).filter((track) => this.isVisibleTrack(track));
  }

  /** Tracks included in DJ-facing screens under the current library mode. */
  get visibleTracks(): Track[] {
    const ownedReleaseIds = new Set(this.ownedReleases.map((release) => release.id));
    return this.state.library.tracks.filter(
      (track) => ownedReleaseIds.has(track.releaseId) && this.isVisibleTrack(track),
    );
  }

  /** Catalogue releases with at least one physical copy currently owned. */
  get ownedReleases(): Release[] {
    const ownedIds = new Set(
      this.state.library.items
        .filter((item) => item.inCollection)
        .map((item) => item.discogsReleaseId),
    );
    return this.state.library.releases.filter((release) => ownedIds.has(release.discogsReleaseId));
  }

  private isVisibleTrack(track: Track): boolean {
    return !this.state.settings.vinylOnlyMode || !isCdTrackPosition(track.position);
  }

  analysisFor(trackId: string): TrackAnalysis | undefined {
    return this.state.library.analysisByTrack.get(trackId);
  }

  itemsFor(discogsReleaseId: number): CollectionItem[] {
    return this.state.library.itemsByRelease.get(discogsReleaseId) ?? [];
  }
}

/** Resolve the theme preference against the OS setting and apply it. */
export function applyTheme(preference: ThemePreference): void {
  const resolved =
    preference === 'system'
      ? window.matchMedia('(prefers-color-scheme: light)').matches
        ? 'light'
        : 'dark'
      : preference;

  document.documentElement.dataset['theme'] = resolved;
  document
    .querySelector('meta[name="theme-color"]')
    ?.setAttribute('content', resolved === 'light' ? '#f6f7f9' : '#0b0d10');
}
