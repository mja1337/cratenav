import type { Store } from '@/app/store';
import type { BagTrack } from '@/bags/coverage';
import {
  availableProviders,
  lookupOptionsForSettings,
  providers as providerRegistry,
} from '@/enrichment/registry';
import { formatCount, formatRelativeTime } from './format';
import { h } from '@/utils/dom';

/**
 * Run an online lookup for one track or one record.
 *
 * The Analyse screen sweeps the whole library; this is the record-by-record
 * counterpart, so a DJ can pull a sleeve off the shelf, fetch what the online
 * sources claim, then listen to the record and compare the two before
 * verifying either. Both paths go through the same app-level operation, so a
 * per-track run still survives navigation and still appears in the shell's
 * progress area.
 */

export interface OnlineLookupOptions {
  /** Resolved fresh on every render: analysis state changes under us. */
  targets: () => BagTrack[];
  /** "this track" / "this record" — used in the button and hints. */
  subject: string;
  onDone?: () => void;
}

interface ProviderOutcome {
  id: string;
  name: string;
  found: number;
  none: number;
  error: number;
  unchecked: number;
  /** Distinct failure messages, so a repeated fault is stated once. */
  errors: string[];
  lastAttemptedAt?: string;
}

/**
 * What each source actually said, per record or per track.
 *
 * Running a lookup used to leave no visible trace: a track that came back with
 * nothing looked identical to one never checked, and an error was invisible
 * unless you happened to be watching the notice bar when it scrolled past.
 * Outcomes are stored durably per provider, so they can simply be read back.
 */
function summariseOutcomes(targets: readonly BagTrack[]): ProviderOutcome[] {
  const byProvider = new Map<string, ProviderOutcome>();

  const ensure = (id: string): ProviderOutcome => {
    const existing = byProvider.get(id);
    if (existing) return existing;
    const known = providerRegistry.find((provider) => provider.id === id);
    const created: ProviderOutcome = {
      id,
      name: known?.name ?? id,
      found: 0,
      none: 0,
      error: 0,
      unchecked: 0,
      errors: [],
    };
    byProvider.set(id, created);
    return created;
  };

  // Seed with every registered provider so "never checked" is representable.
  for (const provider of providerRegistry) ensure(provider.id);

  for (const entry of targets) {
    const attempts = entry.analysis?.enrichmentAttempts ?? [];
    for (const provider of providerRegistry) {
      // Only the latest attempt per provider matters for the current picture.
      const relevant = attempts
        .filter((attempt) => attempt.provider === provider.id)
        .sort((a, b) => a.attemptedAt.localeCompare(b.attemptedAt));
      const latest = relevant[relevant.length - 1];
      const outcome = ensure(provider.id);

      if (!latest) {
        outcome.unchecked += 1;
        continue;
      }
      if (!outcome.lastAttemptedAt || latest.attemptedAt > outcome.lastAttemptedAt) {
        outcome.lastAttemptedAt = latest.attemptedAt;
      }
      if (latest.outcome === 'found') outcome.found += 1;
      else if (latest.outcome === 'none') outcome.none += 1;
      else {
        outcome.error += 1;
        const message = latest.message?.trim();
        if (message && !outcome.errors.includes(message)) outcome.errors.push(message);
      }
    }
  }

  return [...byProvider.values()].filter(
    (outcome) => outcome.found || outcome.none || outcome.error,
  );
}

function outcomeRow(outcome: ProviderOutcome, total: number): HTMLElement {
  const parts: string[] = [];
  if (outcome.found) parts.push(`${outcome.found} found`);
  if (outcome.none) parts.push(`${outcome.none} no data`);
  if (outcome.error) parts.push(`${outcome.error} error${outcome.error === 1 ? '' : 's'}`);
  if (outcome.unchecked) parts.push(`${outcome.unchecked} not checked`);

  // Worst outcome wins the badge: an error is what needs acting on.
  const state = outcome.error ? 'CONFLICT' : outcome.found ? 'READY' : 'ANALYSE';
  const label = outcome.error ? 'error' : outcome.found ? 'found' : 'no data';

  return h(
    'div',
    { class: 'source-outcome' },
    h(
      'div',
      { class: 'row' },
      h('span', { class: 'source-outcome__name', text: outcome.name, style: { flex: '1' } }),
      h('span', { class: `state state--${state}`, text: label }),
    ),
    h('div', {
      class: 'source-outcome__counts',
      text: `${parts.join(' · ')}${total > 1 ? ` of ${total} tracks` : ''}`,
    }),
    ...outcome.errors.slice(0, 3).map((message) =>
      h('div', { class: 'source-outcome__error', text: message }),
    ),
    outcome.lastAttemptedAt
      ? h('div', {
          class: 'source-outcome__when',
          text: `last checked ${formatRelativeTime(outcome.lastAttemptedAt) ?? 'recently'}`,
        })
      : null,
  );
}

export function onlineLookupPanel(store: Store, options: OnlineLookupOptions): HTMLElement {
  const lookupOptions = lookupOptionsForSettings(store.snapshot.settings);
  const ready = availableProviders(lookupOptions);
  const transportReady = providerRegistry.filter((provider) => provider.available);

  const targets = options.targets();
  const running = store.enrichmentRunning;

  // Which of these tracks still has a gap a ready provider could fill.
  const relevant = (entry: BagTrack) =>
    ready.filter(
      (provider) =>
        (entry.analysis?.canonicalBpm === undefined && provider.supplies.bpm) ||
        ((!entry.analysis?.canonicalKey && !entry.analysis?.camelotKey) && provider.supplies.key),
    );
  const completedBy = (entry: BagTrack, providerId: string) =>
    (entry.analysis?.enrichmentAttempts ?? []).some(
      (attempt) =>
        attempt.provider === providerId &&
        (attempt.outcome === 'found' || attempt.outcome === 'none'),
    );

  const withGaps = targets.filter((entry) => relevant(entry).length > 0);
  const unchecked = withGaps.filter((entry) =>
    relevant(entry).some((provider) => !completedBy(entry, provider.id)),
  );

  const run = async (retryCompleted: boolean) => {
    const pool = retryCompleted ? (withGaps.length ? withGaps : targets) : unchecked;
    if (!pool.length) return;
    await store.startEnrichment(pool, retryCompleted ? { retryCompleted: true } : {});
    options.onDone?.();
  };

  const body: HTMLElement[] = [];

  if (!ready.length) {
    body.push(
      h('p', {
        class: 'field__hint',
        text: transportReady.length
          ? 'No online source is configured yet. Add a MusicBrainz contact or a GetSongBPM API key under Analyse.'
          : 'This build has no metadata proxy, so online lookup is unavailable. Manual entry and microphone analysis still work.',
      }),
    );
  } else {
    body.push(
      h('p', {
        class: 'field__hint',
        text:
          `Ready sources: ${ready.map((provider) => provider.name).join(', ')}. ` +
          'Anything found stays unverified until you confirm it, so you can compare it against a live listen first.',
      }),
    );
  }

  const actions: HTMLElement[] = [];

  if (ready.length) {
    actions.push(
      h('button', {
        class: 'button button--small button--primary',
        type: 'button',
        disabled: running || !unchecked.length,
        text: running
          ? 'Searching…'
          : unchecked.length
            ? targets.length === 1
              ? `Find online for ${options.subject}`
              : `Find online for ${formatCount(unchecked.length, 'track')}`
            : 'Already checked',
        onclick: () => void run(false),
      }),
    );

    // A deliberate re-query, for when a source has already answered but the
    // user wants to look again. Kept separate so a normal run never spends
    // rate limit on questions already answered.
    if (!unchecked.length && (withGaps.length || targets.length)) {
      actions.push(
        h('button', {
          class: 'button button--small',
          type: 'button',
          disabled: running,
          text: 'Recheck sources',
          title: 'Query the sources again, even the ones that have already answered',
          onclick: () => void run(true),
        }),
      );
    }
  }

  if (running) {
    actions.push(
      h('button', {
        class: 'button button--small button--danger',
        type: 'button',
        text: 'Stop',
        onclick: () => store.stopBulkOperation('enrichment'),
      }),
    );
  }

  return h(
    'section',
    { class: 'card stack stack--tight', 'aria-label': 'Online lookup' },
    h(
      'div',
      { class: 'row' },
      h('h2', { class: 'section-title', text: 'Find BPM and key online', style: { flex: '1' } }),
      targets.length > 1
        ? h('span', { class: 'chip', text: formatCount(targets.length, 'track') })
        : null,
    ),
    ...body,
    actions.length ? h('div', { class: 'row row--wrap' }, ...actions) : null,
    ready.length && !withGaps.length
      ? h('p', {
          class: 'field__hint',
          text: `Nothing missing on ${options.subject}: BPM and key are already set.`,
        })
      : null,
    ...(() => {
      const outcomes = summariseOutcomes(targets);
      if (!outcomes.length) return [];
      return [
        h('h3', { class: 'section-title', text: 'What the sources said' }),
        h('div', { class: 'stack stack--tight' }, ...outcomes.map((outcome) => outcomeRow(outcome, targets.length))),
      ];
    })(),
  );
}
