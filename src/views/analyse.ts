import type { Store } from '@/app/store';
import type { Router } from '@/app/router';
import type { View } from './types';
import { buildQueue, queueSummary, type QueueFilter, type QueueSort } from '@/analysis/queue';
import { stateBadge, stat } from '@/components/badges';
import { formatCount } from '@/components/format';
import { progressBar } from '@/components/progress';
import {
  availableProviders,
  lookupOptionsForSettings,
  providers as providerRegistry,
} from '@/enrichment/registry';
import type { Settings } from '@/domain/types';
import { clear, h, mount } from '@/utils/dom';

/**
 * Analysis queue. Spec §32.
 *
 * Not just a list of everything unanalysed — it answers "what should I do
 * next?". Active-bag records come first because they are the ones you are
 * actually taking out, and a release with several gaps outranks one with a
 * single gap because it is one trip to the shelf either way.
 */
export function createAnalyseView(store: Store, router: Router): View {
  const element = h('div', { class: 'container stack' });

  let scope: 'active-bag' | 'collection' = 'active-bag';
  let filter: QueueFilter = 'all';
  let sort: QueueSort = 'priority';

  function render(): void {
    const bag = store.activeBag;
    // Fall back to the whole collection when there is no bag to scope to.
    const effectiveScope = scope === 'active-bag' && !bag ? 'collection' : scope;

    const entries =
      effectiveScope === 'active-bag' && bag
        ? store.resolveBagTracks(bag)
        : store.allTrackEntries();

    const activeBagTrackIds = bag
      ? new Set(store.resolveBagTracks(bag).map((entry) => entry.track.id))
      : new Set<string>();

    const summary = queueSummary(entries);
    // Count everything, then show a capped page: a 900-row list is neither
    // fast nor useful, but the count must not pretend the rest do not exist.
    const outstanding = buildQueue(entries, { activeBagTrackIds, filter, sort });
    const LIST_CAP = 200;
    const queue = outstanding.slice(0, LIST_CAP);

    clear(element);

    if (!store.allTrackEntries().length) {
      mount(
        element,
        h(
          'div',
          { class: 'empty' },
          h('h2', { text: 'Nothing to analyse yet' }),
          h('p', {
            text: 'Import your collection and fetch tracklists, then this queue shows what is worth doing next.',
          }),
          h('button', {
            class: 'button button--primary',
            type: 'button',
            text: 'Go to Discogs import',
            onclick: () => router.navigate('settings'),
          }),
        ),
      );
      return;
    }

    mount(
      element,
      h(
        'div',
        { class: 'stats' },
        stat(summary.total, 'In scope'),
        stat(summary.ready, 'Done'),
        stat(summary.needsBoth, 'Need both'),
        stat(summary.needsBpm, 'Need BPM'),
        stat(summary.needsKey, 'Need key'),
        stat(summary.conflict, 'Conflicts'),
      ),
      onlineEnrichment(entries),
      controls(bag?.name, effectiveScope),
      h(
        'div',
        { class: 'row row--wrap' },
        h('button', {
          class: 'button button--small',
          type: 'button',
          text: 'Sticker run',
          title: 'Label the records whose values you already know',
          onclick: () => router.navigate('sticker'),
        }),
      ),
      h('p', {
        class: 'field__hint',
        role: 'status',
        'aria-live': 'polite',
        text: outstanding.length
          ? outstanding.length > LIST_CAP
            ? `${formatCount(outstanding.length, 'track')} to work through. Showing the top ${LIST_CAP}${sort === 'priority' ? ', most useful first' : ''}.`
            : `${formatCount(outstanding.length, 'track')} to work through${sort === 'priority' ? ', most useful first' : ''}.`
          : 'Nothing matches that filter.',
      }),
      outstanding.length ? list() : done(),
    );

    function onlineEnrichment(currentEntries: typeof entries): HTMLElement {
      const lookupOptions = lookupOptionsForSettings(store.snapshot.settings);
      const providers = availableProviders(lookupOptions);
      const transportProviders = providerRegistry.filter((provider) => provider.available);
      const configurationFields = transportProviders
        .map((provider) => provider.configuration)
        .filter((field, index, fields) =>
          Boolean(field) && fields.findIndex((candidate) => candidate?.setting === field?.setting) === index,
        );
      const missing = currentEntries.filter(({ analysis }) =>
        analysis?.canonicalBpm === undefined ||
        (!analysis?.canonicalKey && !analysis?.camelotKey),
      );
      const relevantProviders = (entry: (typeof currentEntries)[number]) => providers.filter(
        (provider) =>
          (entry.analysis?.canonicalBpm === undefined && provider.supplies.bpm) ||
          ((!entry.analysis?.canonicalKey && !entry.analysis?.camelotKey) && provider.supplies.key),
      );
      const completedBy = (entry: (typeof currentEntries)[number], providerId: string) =>
        (entry.analysis?.enrichmentAttempts ?? []).some(
          (attempt) =>
            attempt.provider === providerId &&
            (attempt.outcome === 'found' || attempt.outcome === 'none'),
        );
      const alreadyChecked = (entry: (typeof currentEntries)[number]) => {
        return relevantProviders(entry).every((provider) => completedBy(entry, provider.id));
      };
      const unchecked = providers.length
        ? missing.filter((entry) => !alreadyChecked(entry))
        : [];
      const running = store.enrichmentRunning;
      const enrichmentProgress = store.operations.enrichment;
      const targets = unchecked.length ? unchecked : providers.length ? missing : [];
      const providerNames = providers.map((provider) => provider.name).join(', ');
      const catchUpActions = providers.flatMap((provider) => {
        const providerTargets = missing.filter((entry) => {
          if (!relevantProviders(entry).some((candidate) => candidate.id === provider.id)) return false;
          if (completedBy(entry, provider.id)) return false;
          return (entry.analysis?.enrichmentAttempts ?? []).some(
            (attempt) =>
              attempt.provider !== provider.id &&
              (attempt.outcome === 'found' || attempt.outcome === 'none'),
          );
        });
        return providerTargets.length ? [{ provider, targets: providerTargets }] : [];
      });
      const buttonLabel = running
        ? 'Searching…'
        : !providers.length
          ? 'Configure a source to start'
        : unchecked.length
          ? `Find online data for ${formatCount(unchecked.length, 'track')}`
          : missing.length
            ? `Recheck ${formatCount(missing.length, 'track')}`
            : providers.length
              ? 'Online lookup complete'
              : 'Online lookup unavailable';

      return h(
        'section',
        { class: 'card stack stack--tight', 'aria-labelledby': 'online-enrichment-title' },
        h('div', { class: 'card__title', id: 'online-enrichment-title', text: 'Find BPM and key online' }),
        h('p', {
          class: 'field__hint',
          text: providers.length
            ? `Ready sources: ${providerNames}. Matches remain unverified until you confirm them or later audio analysis agrees.`
            : transportProviders.length
              ? 'No online source is configured yet. Add either credential below; they are independent.'
              : providerRegistry.find((provider) => provider.unavailableReason)?.unavailableReason ??
                'No online enrichment provider is configured for this deployment.',
        }),
        transportProviders.length
          ? h(
              'div',
              { class: 'stack stack--tight' },
              ...configurationFields.map((configuration) => {
                if (!configuration) return null;
                const inputId = `provider-setting-${configuration.setting}`;
                return h(
                    'div',
                    { class: 'field' },
                    h('label', {
                      class: 'field__label',
                      for: inputId,
                      text: configuration.label,
                    }),
                    h(
                      'div',
                      { class: 'row row--wrap' },
                      h('input', {
                        id: inputId,
                        name: configuration.setting,
                        class: 'input',
                        type: configuration.inputType,
                        autocomplete: 'off',
                        autocapitalize: 'none',
                        spellcheck: 'false',
                        placeholder: configuration.placeholder,
                        value: configuration.value(store.snapshot.settings),
                      }),
                      h('button', {
                        class: 'button button--small',
                        type: 'button',
                        disabled: running,
                        text: configuration.saveLabel,
                        onclick: async () => {
                          const input = element.querySelector<HTMLInputElement>(`#${inputId}`);
                          const value = configuration.sanitize(input?.value ?? '');
                          await store.updateSettings({
                            [configuration.setting]: value || undefined,
                          } as Partial<Settings>);
                          store.notify(
                            'info',
                            value ? configuration.savedMessage : configuration.clearedMessage,
                          );
                          render();
                        },
                      }),
                    ),
                    h(
                      'p',
                      { class: 'field__hint' },
                      configuration.helpText,
                      configuration.helpUrl
                        ? h(
                            'span',
                            {},
                            ' ',
                            h('a', {
                              class: 'text-link',
                              href: configuration.helpUrl,
                              target: '_blank',
                              rel: 'noopener noreferrer',
                              text: configuration.helpLinkText ?? 'Learn more',
                            }),
                          )
                        : null,
                    ),
                  );
              }),
            )
          : null,
        enrichmentProgress
          ? progressBar({
              phase: 'metadata',
              current: enrichmentProgress.current,
              total: enrichmentProgress.total,
              etaSeconds: enrichmentProgress.etaSeconds,
              message: enrichmentProgress.message,
            })
          : null,
        h(
          'div',
          { class: 'row row--wrap' },
          h('button', {
            class: 'button button--primary button--small',
            type: 'button',
            disabled: running || targets.length === 0 || providers.length === 0,
            text: buttonLabel,
            onclick: () => void store.startEnrichment(targets, {
              retryCompleted: unchecked.length === 0 && missing.length > 0,
            }),
          }),
          ...catchUpActions.map(({ provider, targets: providerTargets }) =>
            h('button', {
              class: 'button button--small',
              type: 'button',
              disabled: running,
              text: `Try ${provider.name} for ${formatCount(providerTargets.length, 'previously checked track')}`,
              onclick: () => void store.startEnrichment(providerTargets, {
                providerIds: [provider.id],
              }),
            }),
          ),
          running
            ? h('button', {
                class: 'button button--danger button--small',
                type: 'button',
                text: 'Pause',
                onclick: () => store.stopBulkOperation('enrichment'),
              })
            : null,
        ),
        h('p', {
          class: 'field__hint',
          text: !transportProviders.length
            ? 'Run the local preview server or configure a read-only metadata proxy. Manual analysis remains available offline.'
            : !providers.length
              ? 'Save a MusicBrainz contact, a GetSongBPM key, or both. Each source is optional and checked independently.'
            : unchecked.length
            ? 'Progress is checkpointed after every track, so you can pause and resume safely.'
            : missing.length
              ? 'Every missing track in this scope has been checked. Recheck only if the public catalogue may have changed.'
              : 'Every track in this scope already has BPM and key data.',
        }),
      );
    }

    function controls(bagName: string | undefined, current: string): HTMLElement {
      const chip = (label: string, active: boolean, onclick: () => void, disabled = false) =>
        h('button', {
          class: 'chip',
          type: 'button',
          disabled,
          'aria-pressed': String(active),
          text: label,
          onclick,
        });

      return h(
        'div',
        { class: 'stack stack--tight' },
        h(
          'div',
          { class: 'toolbar__filters' },
          chip(
            bagName ? `Bag: ${bagName}` : 'No active bag',
            current === 'active-bag',
            () => {
              scope = 'active-bag';
              render();
            },
            !bagName,
          ),
          chip('Whole collection', current === 'collection', () => {
            scope = 'collection';
            render();
          }),
        ),
        h(
          'div',
          { class: 'toolbar__filters' },
          ...(
            [
              ['all', 'Everything'],
              ['both-missing', 'Both missing'],
              ['bpm-missing', 'BPM missing'],
              ['key-missing', 'Key missing'],
              ['conflict', 'Conflicts'],
            ] as [QueueFilter, string][]
          ).map(([value, label]) =>
            chip(label, filter === value, () => {
              filter = value;
              render();
            }),
          ),
        ),
        h(
          'select',
          {
            id: 'analysis-queue-sort',
            name: 'analysisQueueSort',
            class: 'select',
            'aria-label': 'Sort queue',
            style: { maxWidth: '210px' },
            onchange: (event: Event) => {
              sort = (event.target as HTMLSelectElement).value as QueueSort;
              render();
            },
          },
          ...(
            [
              ['priority', 'Most useful first'],
              ['oldest', 'Oldest releases'],
              ['newest', 'Newest releases'],
              ['artist', 'Artist'],
            ] as [QueueSort, string][]
          ).map(([value, label]) =>
            h('option', { value, text: label, selected: sort === value }),
          ),
        ),
      );
    }

    function list(): HTMLElement {
      return h(
        'div',
        { class: 'list' },
        ...queue.map((item) =>
          h(
            'button',
            {
              class: 'list-row',
              type: 'button',
              'aria-label': `${item.entry.track.title}, ${
                item.missingBpm && item.missingKey
                  ? 'needs BPM and key'
                  : item.missingBpm
                    ? 'needs BPM'
                    : 'needs key'
              }`,
              onclick: () => router.navigate(`track/${item.entry.track.id}`),
            },
            h('span', { class: 'track-row__position', text: item.entry.track.position }),
            h(
              'div',
              { class: 'list-row__body' },
              h('div', { class: 'list-row__title', text: item.entry.track.title }),
              h('div', {
                class: 'list-row__sub',
                text: [item.entry.release.artist, item.entry.release.title]
                  .filter(Boolean)
                  .join(' / '),
              }),
              item.reasons.length
                ? h('div', { class: 'suggestion__reasons', text: item.reasons.join(' · ') })
                : null,
            ),
            h(
              'div',
              { class: 'list-row__aside' },
              stateBadge(item.state),
              // Say precisely what is missing; the badge alone does not.
              h('span', {
                text:
                  item.missingBpm && item.missingKey
                    ? 'BPM + key'
                    : item.missingBpm
                      ? 'BPM'
                      : 'key',
              }),
            ),
          ),
        ),
      );
    }

    function done(): HTMLElement {
      return h(
        'div',
        { class: 'banner banner--info' },
        h('div', { class: 'banner__title', text: 'Nothing outstanding here' }),
        h('div', {
          class: 'banner__body',
          text:
            filter === 'all'
              ? 'Everything in scope has a BPM and a key.'
              : 'Try a different filter, or widen the scope.',
        }),
      );
    }
  }

  const unsubscribe = store.subscribe(render);
  const unsubscribeOperations = store.subscribeOperations(render);
  render();

  return {
    element,
    destroy: () => {
      unsubscribe();
      unsubscribeOperations();
    },
  };
}
