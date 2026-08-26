import type { Store } from './store';
import type { BagTrack } from '@/bags/coverage';
import { availableProviders, lookupOptionsForSettings } from '@/enrichment/registry';
import { countPendingHydration, loadSyncState } from '@/data/repositories';

/**
 * The whole catch-up workflow, run for you on open. Spec §5, §25.
 *
 * Adding records to Discogs used to mean four manual steps in order: sync, wait,
 * hydrate metadata, then run online lookup. Each one is long enough to walk away
 * from, so the collection routinely sat half-populated. This chains them.
 *
 * Every stage is the SAME app-level operation the buttons drive, so the shell's
 * progress area and the global Pause/Stop keep working and navigation cannot
 * cancel any of it. Nothing here writes analysis: enrichment results stay
 * `verificationRequired`, so a DJ still confirms every BPM and key.
 */

/** Long enough that reopening the app repeatedly does not re-poll Discogs. */
const MIN_INTERVAL_MS = 15 * 60 * 1000;

/**
 * A full pass is the only thing that can see a departure, so one is forced
 * periodically even when the incremental arithmetic reconciles. Without this a
 * record removed on Discogs could stay listed as owned indefinitely.
 */
const FULL_SYNC_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

export interface AutoSyncOutcome {
  ran: boolean;
  skippedBecause?: string;
  added: number;
  hydrated: number;
  enriched: number;
  departuresPending: number;
}

/** Tracks a ready provider could still fill a gap on, and has never asked about. */
function enrichmentTargets(store: Store): BagTrack[] {
  const providers = availableProviders(lookupOptionsForSettings(store.snapshot.settings));
  if (!providers.length) return [];

  return store.snapshot.library.tracks
    .map((track) => store.trackEntry(track.id))
    .filter((entry): entry is BagTrack => entry !== undefined)
    .filter((entry) => {
      const analysis = entry.analysis;
      const relevant = providers.filter(
        (provider) =>
          (analysis?.canonicalBpm === undefined && provider.supplies.bpm) ||
          ((!analysis?.canonicalKey && !analysis?.camelotKey) && provider.supplies.key),
      );
      if (!relevant.length) return false;
      // Never re-ask a source that has already answered — that is what makes a
      // repeated auto-run cheap, and what protects the rate limit.
      return relevant.some((provider) => !(analysis?.enrichmentAttempts ?? []).some(
        (attempt) =>
          attempt.provider === provider.id &&
          (attempt.outcome === 'found' || attempt.outcome === 'none'),
      ));
    });
}

/**
 * Run the catch-up chain once.
 *
 * `force` skips the interval throttle for a user gesture; the gating on
 * credentials and on an already-running sync always applies.
 */
export async function runCatchUp(
  store: Store,
  options: { force?: boolean } = {},
): Promise<AutoSyncOutcome> {
  const idle: AutoSyncOutcome = {
    ran: false, added: 0, hydrated: 0, enriched: 0, departuresPending: 0,
  };
  const settings = store.snapshot.settings;
  const username = settings.discogsUsername?.trim();

  if (!username || !settings.discogsToken) {
    return { ...idle, skippedBecause: 'Discogs is not connected' };
  }
  if (store.sync.running || store.enrichmentRunning) {
    return { ...idle, skippedBecause: 'a sync is already running' };
  }
  if (typeof navigator !== 'undefined' && navigator.onLine === false) {
    return { ...idle, skippedBecause: 'offline' };
  }

  const syncState = await loadSyncState();
  const since = (at: string | undefined) =>
    at ? Date.now() - new Date(at).getTime() : Number.POSITIVE_INFINITY;

  if (!options.force && since(syncState.lastCollectionSyncAt) < MIN_INTERVAL_MS) {
    return { ...idle, skippedBecause: 'synced recently' };
  }

  const outcome: AutoSyncOutcome = { ...idle, ran: true };

  try {
    // 1. Collection. Incremental unless a full pass is overdue.
    const needFullPass = since(syncState.lastFullSyncAt) > FULL_SYNC_MAX_AGE_MS;
    let result = await store.sync.syncCollection(username, {
      mode: needFullPass ? 'full' : 'incremental',
      // A departure is never applied without asking, so an unattended run
      // retains it and reports that there is something to confirm.
      confirmDepartures: () => false,
    });

    // The incremental arithmetic did not add up: something we did not read has
    // changed, and only a full pass can say what.
    if (result.fullSyncRecommended) {
      result = await store.sync.syncCollection(username, {
        mode: 'full',
        confirmDepartures: () => false,
      });
    }
    outcome.added = result.added;
    outcome.departuresPending = result.departuresRetained;

    // 2. Metadata for anything new. `hydrationState === 'stub'` IS the queue,
    //    so this is resumable and a no-op when there is nothing waiting.
    if (await countPendingHydration()) {
      const hydration = await store.sync.hydrateMetadata();
      outcome.hydrated = hydration.hydrated;
      if (hydration.aborted) return outcome;
    }

    await store.reload();

    // 3. Online lookup for the tracks that gained a tracklist.
    const targets = enrichmentTargets(store);
    if (targets.length) {
      await store.startEnrichment(targets);
      outcome.enriched = targets.length;
    }
  } catch (error) {
    if ((error as Error | undefined)?.name === 'AbortError') return outcome;
    // A failed catch-up must never block startup or lose local work.
    store.notify(
      'error',
      error instanceof Error ? `Automatic sync stopped: ${error.message}` : 'Automatic sync stopped.',
    );
    return outcome;
  }

  const parts: string[] = [];
  if (outcome.added) parts.push(`${outcome.added} new record${outcome.added === 1 ? '' : 's'}`);
  if (outcome.hydrated) parts.push(`${outcome.hydrated} hydrated`);
  if (outcome.enriched) parts.push(`${outcome.enriched} checked online`);
  if (outcome.departuresPending) {
    parts.push(
      `${outcome.departuresPending} no longer on Discogs — confirm in Settings before they are removed`,
    );
  }
  if (parts.length) store.notify('info', `Caught up: ${parts.join(' · ')}.`);

  return outcome;
}

/**
 * Hook the catch-up chain to app start.
 *
 * Deliberately fire-and-forget: local-first means the app opens from IndexedDB
 * and never waits on the network, so this runs behind an already-usable UI.
 */
export function startAutomaticSync(store: Store): () => void {
  let stopped = false;
  if (store.snapshot.settings.autoSync === false) return () => undefined;

  const timer = window.setTimeout(() => {
    if (stopped) return;
    void runCatchUp(store).catch(() => undefined);
  }, 1_200);

  return () => {
    stopped = true;
    window.clearTimeout(timer);
  };
}
