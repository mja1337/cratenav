import type { Store } from '@/app/store';
import type { View } from './types';
import type { SyncProgress } from '@/discogs/sync';
import { stat } from '@/components/badges';
import { progressBar } from '@/components/progress';
import { formatCount, formatRelativeTime } from '@/components/format';
import { icon } from '@/components/icons';
import { clearLibrary, countFailedHydration, exportLibrary, importLibrary } from '@/data/repositories';
import { DECK_PROFILES } from '@/pitch/deck';
import { clear, h, mount } from '@/utils/dom';

/**
 * Settings, and the Discogs import control panel.
 *
 * The two Discogs operations are deliberately presented as separate actions,
 * because they cost very different amounts of time (spec §24):
 *
 *   Sync collection    ~6 requests, seconds. What records do I own?
 *   Fetch metadata     1 request per release, minutes. Tracklists and detail.
 */
export function createSettingsView(store: Store): View {
  const element = h('div', { class: 'container stack' });

  const progressSlot = h('div', { class: 'stack stack--tight' });
  const statsSlot = h('div', { class: 'stack stack--tight' });

  let failedCount = 0;
  let busy = store.sync.running;
  let connectionBusy = false;
  let connectionStatus: string | undefined;
  const backup = store.platform.backup;
  const googleDrive = store.platform.googleDriveBackup;
  const googleDriveSlot = h('div', { class: 'stack stack--tight' });
  const backupSlot = h('div', { class: 'stack stack--tight' });

  function renderGoogleDriveBackup(): void {
    clear(googleDriveSlot);
    if (!googleDrive?.status.available) {
      googleDriveSlot.append(
        h('div', { class: 'stack stack--tight' },
          h('h3', { class: 'section-title', text: 'Google Drive backup' }),
          h('p', {
            class: 'notice notice--warning',
            text:
              'Google Drive backup is not configured in this build. Add VITE_GOOGLE_DRIVE_CLIENT_ID when building CrateNav; manual export remains available.',
          }),
        ),
      );
      return;
    }

    const status = googleDrive.status;
    const saved = formatRelativeTime(status.lastSavedAt);
    googleDriveSlot.append(
      h('div', { class: 'stack stack--tight' },
        h('h3', { class: 'section-title', text: 'Google Drive backup' }),
        h('p', {
          class: 'field__hint',
          text:
            'Works in supported Mac, Android and mobile browsers. Connect once per app session; CrateNav then maintains one visible JSON backup in My Drive while local IndexedDB remains the live database.',
        }),
        h('p', {
          class: status.error ? 'notice notice--warning' : 'field__hint',
          text: status.error
            ? `Drive backup: ${status.error}`
            : status.connected
              ? status.hasBackup
                ? `${status.fileName} · ${status.saving ? 'saving…' : saved ? `last saved ${saved}` : 'backup found'} · ${status.automatic ? 'automatic updates on' : 'choose restore or back up'}`
                : 'Connected · no existing CrateNav backup found'
              : 'Not connected for this session.',
        }),
        h('div', { class: 'row row--wrap' },
          !status.connected
            ? h('button', {
                class: 'button button--primary',
                type: 'button',
                text: 'Connect Google Drive',
                onclick: async () => {
                  if (await googleDrive.connect()) {
                    store.notify(
                      'info',
                      googleDrive.status.hasBackup
                        ? 'Google Drive connected. An existing backup was found; restore it or keep this device’s local library.'
                        : 'Google Drive connected. No existing CrateNav backup was found.',
                    );
                  }
                },
              })
            : h('button', {
                class: 'button',
                type: 'button',
                text: status.saving ? 'Saving…' : 'Back up to Drive now',
                disabled: status.saving,
                onclick: async () => {
                  const ok = await googleDrive.write(await exportLibrary());
                  store.notify(ok ? 'info' : 'warning', ok ? 'Google Drive backup updated.' : 'Google Drive backup failed.');
                },
              }),
          status.connected
            ? h('button', {
                class: 'button button--small',
                type: 'button',
                text: 'Restore from Drive',
                disabled: status.saving,
                onclick: async () => {
                  const json = await googleDrive.read();
                  if (!json) {
                    store.notify('warning', 'No CrateNav backup was found in this Google Drive.');
                    return;
                  }
                  try {
                    const report = await importLibrary(json);
                    await store.reload();
                    await refreshStats();
                    renderActions();
                    const backedUp = await googleDrive.write(await exportLibrary());
                    store.notify(
                      report.warnings.length || !backedUp ? 'warning' : 'info',
                      `Drive restore merged ${report.added} added, ${report.updated} updated and ${report.skipped} already-current records.` +
                        (report.warnings.length ? ` ${report.warnings.join(' ')}` : '') +
                        (!backedUp ? ' The merged library could not be written back to Drive.' : ' Automatic updates are now on.'),
                    );
                  } catch (error) {
                    store.notify('error', error instanceof Error ? error.message : 'Drive restore failed.');
                  }
                },
              })
            : null,
          status.connected
            ? h('button', {
                class: 'button button--small button--ghost',
                type: 'button',
                text: 'Disconnect Drive session',
                onclick: () => googleDrive.disconnect(),
              })
            : null,
        ),
      ),
    );
  }

  function renderBackup(): void {
    clear(backupSlot);
    if (!backup?.status.supported) {
      if (!googleDrive?.status.available) {
        backupSlot.append(h('p', {
          class: 'notice notice--warning',
          text:
            'Automatic file backup is not supported by this browser. Manual JSON export still works; Chrome or Edge can maintain a selected backup file.',
        }));
      }
      return;
    }

    const status = backup.status;
    const saved = formatRelativeTime(status.lastSavedAt);
    const permissionNote = status.configured && status.permission !== 'granted'
      ? ' Browser permission needs renewing; use Back up now.'
      : '';
    backupSlot.append(
      h('div', { class: 'stack stack--tight' },
        h('h3', { class: 'section-title', text: 'Mac synced-folder backup' }),
        h('p', {
          class: 'field__hint',
          text:
            'Choose cratenav-library-backup.json inside a Google Drive for desktop folder. CrateNav keeps that copy updated after local changes; the live database remains in this browser and no Google API is used.',
        }),
        h('p', {
          class: status.error ? 'notice notice--warning' : 'field__hint',
          text: status.error
            ? `Backup problem: ${status.error}`
            : status.configured
              ? `${status.fileName ?? 'Backup file'} · ${status.saving ? 'saving…' : saved ? `last saved ${saved}` : 'ready'}${permissionNote}`
              : 'No automatic backup file selected.',
        }),
        h('div', { class: 'row row--wrap' },
          h('button', {
            class: 'button',
            type: 'button',
            text: status.configured ? 'Change backup file' : 'Choose backup file',
            disabled: status.saving,
            onclick: async () => {
              const ok = await backup.choose(await exportLibrary());
              if (ok) store.notify('info', 'Backup file connected and saved.');
            },
          }),
          status.configured
            ? h('button', {
                class: 'button button--small',
                type: 'button',
                text: status.saving ? 'Saving…' : 'Back up now',
                disabled: status.saving,
                onclick: async () => {
                  const ok = await backup.write(await exportLibrary(), true);
                  store.notify(
                    ok ? 'info' : 'warning',
                    ok ? 'Backup file updated.' : 'Backup permission was not granted.',
                  );
                },
              })
            : null,
          status.configured
            ? h('button', {
                class: 'button button--small button--ghost',
                type: 'button',
                text: 'Disconnect backup',
                disabled: status.saving,
                onclick: async () => {
                  await backup.disconnect();
                  store.notify('info', 'Automatic backup disconnected. The existing JSON file was not deleted.');
                },
              })
            : null,
        ),
      ),
    );
  }

  // --- Discogs account ------------------------------------------------------

  const usernameInput = h('input', {
    id: 'discogs-username',
    name: 'discogsUsername',
    class: 'input',
    type: 'text',
    autocapitalize: 'none',
    autocomplete: 'username',
    spellcheck: 'false',
    placeholder: 'your Discogs username',
    value: store.snapshot.settings.discogsUsername ?? '',
    'aria-label': 'Discogs username',
  });

  const tokenInput = h('input', {
    id: 'discogs-token',
    name: 'discogsToken',
    class: 'input',
    type: 'password',
    autocomplete: 'off',
    spellcheck: 'false',
    placeholder: 'optional personal access token',
    value: store.snapshot.settings.discogsToken ?? '',
    'aria-label': 'Discogs personal access token',
  });

  const saveAccount = async () => {
    await store.updateSettings({
      discogsUsername: usernameInput.value.trim() || undefined,
      discogsToken: tokenInput.value.trim() || undefined,
    });
    store.notify('info', 'Discogs details saved.');
  };

  const testConnection = async () => {
    const username = usernameInput.value.trim();
    if (!username) {
      store.notify('error', 'Enter your Discogs username first.');
      return;
    }
    connectionBusy = true;
    renderAccountActions();
    await saveAccount();
    try {
      // /users/:username is public, so a successful profile response says
      // nothing about whether the personal token was accepted. Identity is
      // authenticated and therefore gives the user a real verification.
      const identity = store.client.hasToken ? await store.client.identity() : undefined;
      const profile = await store.client.profile(username);
      const rate = store.client.rateLimit;
      connectionStatus = identity
        ? `Token verified for ${identity.username}. Discogs reports ${rate.limit}/min.`
        : `Connected without a token. Discogs reports ${rate.limit}/min.`;
      store.notify(
        'info',
        `${connectionStatus} ${formatCount(profile.num_collection ?? 0, 'record')} in the collection.`,
      );
    } catch (error) {
      connectionStatus = undefined;
      store.notify('error', error instanceof Error ? error.message : 'Could not reach Discogs.');
    } finally {
      connectionBusy = false;
      renderAccountActions();
    }
  };

  const accountActionsSlot = h('div');

  function renderAccountActions(): void {
    clear(accountActionsSlot);
    mount(
      accountActionsSlot,
      h(
        'div',
        { class: 'row row--wrap' },
        h('button', {
          class: 'button',
          type: 'button',
          disabled: connectionBusy,
          text: 'Save',
          onclick: () => void saveAccount(),
        }),
        h('button', {
          class: 'button',
          type: 'button',
          disabled: connectionBusy,
          text: connectionBusy ? 'Testing…' : 'Test connection',
          onclick: () => void testConnection(),
        }),
      ),
      connectionStatus ? h('p', { class: 'field__hint', text: connectionStatus }) : null,
    );
  }

  // --- sync actions ---------------------------------------------------------

  const runSync = async () => {
    const username = usernameInput.value.trim();
    if (!username) {
      store.notify('error', 'Enter your Discogs username first.');
      return;
    }
    await saveAccount();
    busy = true;
    renderActions();
    try {
      const result = await store.sync.syncCollection(username, {
        confirmDepartures: (items) => {
          const releases = new Map(
            store.snapshot.library.releases.map((release) => [release.discogsReleaseId, release]),
          );
          const names = [...new Set(items.map((item) => {
            const release = releases.get(item.discogsReleaseId);
            return release ? `${release.artist} — ${release.title}` : `Discogs release ${item.discogsReleaseId}`;
          }))];
          const preview = names.slice(0, 5).map((name) => `• ${name}`).join('\n');
          const more = names.length > 5 ? `\n…and ${names.length - 5} more` : '';
          return window.confirm(
            `Discogs no longer lists ${formatCount(items.length, 'owned copy')}:\n\n` +
              `${preview}${more}\n\nRemove ${items.length === 1 ? 'it' : 'them'} from cratenav? ` +
              'BPM, key and metadata will be kept, but the record will disappear from Collection and bags.',
          );
        },
      });
      await store.reload();
      store.notify(
        'info',
        `Synced ${formatCount(result.totalOwned, 'record')}: ` +
          `${result.added} new, ${result.updated} updated` +
          (result.departed ? `, ${result.departed} no longer owned` : '') +
          (result.departuresRetained ? `, ${result.departuresRetained} removal declined` : '') +
          '.',
      );
    } catch (error) {
      if ((error as Error).name !== 'AbortError') {
        store.notify('error', error instanceof Error ? error.message : 'Sync failed.');
      }
    } finally {
      busy = false;
      await refreshStats();
      renderActions();
    }
  };

  const runHydration = async () => {
    busy = true;
    renderActions();
    try {
      const result = await store.sync.hydrateMetadata();
      await store.reload();
      if (result.aborted) {
        store.notify('info', `Paused. ${formatCount(result.remaining, 'release')} still queued.`);
      } else if (result.rateLimited) {
        store.notify(
          'info',
          `Discogs has temporarily rate-limited this connection. ` +
            `${formatCount(result.remaining, 'release')} remain safely queued — try again in a minute.`,
        );
      } else {
        store.notify(
          'info',
          `Imported ${formatCount(result.hydrated, 'release')} and ${formatCount(result.tracksCreated, 'track')}` +
            (result.failed ? `, ${result.failed} failed.` : '.'),
        );
      }
    } catch (error) {
      if ((error as Error).name !== 'AbortError') {
        store.notify('error', error instanceof Error ? error.message : 'Metadata import failed.');
      }
    } finally {
      busy = false;
      await refreshStats();
      renderActions();
    }
  };

  const actionsSlot = h('div', { class: 'stack stack--tight' });

  function renderActions(): void {
    const { pendingHydration } = store.snapshot.library;
    const hasLibrary = store.ownedReleases.length > 0;
    const estimate = store.client.estimateSeconds(pendingHydration);
    const minutes = Math.max(1, Math.round(estimate / 60));

    clear(actionsSlot);
    mount(
      actionsSlot,
      h(
        'div',
        { class: 'row row--wrap' },
        h(
          'button',
          {
            class: 'button button--primary',
            type: 'button',
            disabled: busy,
            onclick: () => void runSync(),
          },
          icon('sync'),
          hasLibrary ? 'Sync collection' : 'Import collection',
        ),
        pendingHydration
          ? h(
              'button',
              {
                class: 'button',
                type: 'button',
                disabled: busy,
                onclick: () => void runHydration(),
              },
              icon('download'),
              `Fetch metadata (${pendingHydration})`,
            )
          : null,
        busy
          ? h(
              'button',
              {
                class: 'button button--danger',
                type: 'button',
                onclick: () => store.sync.abort(),
              },
              icon('stop'),
              'Stop',
            )
          : null,
      ),
      pendingHydration && !busy
        ? h('p', {
            class: 'field__hint',
            text:
              `${formatCount(pendingHydration, 'release')} need tracklists. ` +
              `That is about ${minutes} ${minutes === 1 ? 'minute' : 'minutes'} at ` +
              `${store.client.rateLimit.limit} requests/min` +
              (store.client.hasToken ? '' : ' — adding a token roughly halves it') +
              '. You can stop and resume at any point.',
          })
        : null,
      failedCount
        ? h(
            'div',
            { class: 'row row--wrap' },
            h('button', {
              class: 'button button--small',
              type: 'button',
              disabled: busy,
              text: `Retry ${failedCount} failed`,
              onclick: async () => {
                await store.sync.retryFailed();
                await store.reload();
                await refreshStats();
                renderActions();
              },
            }),
          )
        : null,
      hasLibrary
        ? h('button', {
            class: 'button button--small button--ghost',
            type: 'button',
            disabled: busy,
            text: 'Refresh all metadata',
            title:
              'Re-fetch every release from Discogs. Your BPM, key and analysis are preserved.',
            onclick: async () => {
              const count = await store.sync.requeueAll();
              await store.reload();
              await refreshStats();
              renderActions();
              store.notify('info', `${formatCount(count, 'release')} queued for a metadata refresh.`);
            },
          })
        : null,
    );
  }

  // --- stats ---------------------------------------------------------------

  async function refreshStats(): Promise<void> {
    failedCount = await countFailedHydration();
    const { items, pendingHydration } = store.snapshot.library;
    const releases = store.ownedReleases;
    const tracks = store.visibleTracks;
    const visibleTrackIds = new Set(tracks.map((track) => track.id));
    const analyses = store.snapshot.library.analyses.filter((analysis) => visibleTrackIds.has(analysis.trackId));
    const owned = items.filter((item) => item.inCollection).length;
    const verified = analyses.filter(
      (analysis) => analysis.verifiedBpm || analysis.verifiedKey,
    ).length;
    const needsAnalysis = tracks.length - analyses.filter((a) => a.state === 'READY').length;
    const lastSync = formatRelativeTime(store.snapshot.syncState.lastCollectionSyncAt);

    clear(statsSlot);
    mount(
      statsSlot,
      h('h2', { class: 'section-title', text: 'Library' }),
      h(
        'div',
        { class: 'stats' },
        stat(releases.length, 'Releases'),
        stat(owned, 'Owned copies'),
        stat(tracks.length, 'Tracks'),
        stat(verified, 'Verified'),
        stat(needsAnalysis < 0 ? 0 : needsAnalysis, 'Need analysis'),
        stat(pendingHydration, 'No tracklist'),
      ),
      lastSync
        ? h('p', { class: 'field__hint', text: `Collection last synced ${lastSync}.` })
        : null,
    );
  }

  // --- progress ------------------------------------------------------------

  // The metadata pass runs for minutes. Reloading the store every so often
  // means the collection visibly fills in with tracklists as it goes, rather
  // than everything appearing at the very end.
  let lastReloadAt = 0;
  let reloading = false;
  const RELOAD_EVERY = 25;

  const unsubscribeProgress = store.sync.onProgress((progress: SyncProgress) => {
    busy = progress.phase === 'collection' || progress.phase === 'metadata';
    if (
      progress.phase === 'metadata' &&
      progress.current - lastReloadAt >= RELOAD_EVERY &&
      !reloading
    ) {
      lastReloadAt = progress.current;
      reloading = true;
      void store.reload().finally(() => {
        reloading = false;
      });
    }

    clear(progressSlot);
    if (progress.phase === 'collection' || progress.phase === 'metadata') {
      progressSlot.append(progressBar(progress));
    } else if (progress.error) {
      progressSlot.append(
        h(
          'div',
          { class: 'banner banner--error' },
          h('div', { class: 'banner__title', text: 'Sync problem' }),
          h('div', { class: 'banner__body', text: progress.error }),
        ),
      );
    }
    renderActions();
  });

  const unsubscribeStore = store.subscribe(() => {
    // Notices are rendered globally by the shell; nothing to do here.
    void refreshStats();
    renderActions();
  });

  // --- static sections -----------------------------------------------------

  const discogsCard = h(
    'div',
    { class: 'card stack' },
    h('h2', { class: 'section-title', text: 'Discogs' }),
    h(
      'div',
      { class: 'field' },
      h('label', { class: 'field__label', for: 'discogs-username', text: 'Username' }),
      usernameInput,
    ),
    h(
      'div',
      { class: 'field' },
      h('label', { class: 'field__label', for: 'discogs-token', text: 'Personal access token' }),
      tokenInput,
      h('p', {
        class: 'field__hint',
        text:
          'Optional. A public collection can be read without one, at 25 requests a minute. ' +
          'A token raises that to 60 and unlocks media/sleeve condition and your collection notes, ' +
          'which Discogs keeps private otherwise.',
      }),
      h('p', {
        class: 'field__hint',
        text:
          'Generate one under Discogs Settings > Developers. It is stored only on this device, ' +
          'is never included in exports, and cratenav only ever issues read requests.',
      }),
      h(
        'p',
        { class: 'field__hint' },
        h('a', {
          href: 'https://www.discogs.com/settings/developers',
          target: '_blank',
          rel: 'noopener noreferrer',
          text: 'Open Discogs developer settings',
        }),
      ),
    ),
    accountActionsSlot,
    actionsSlot,
    progressSlot,
  );

  /**
   * Deck and pitch preferences. Spec v1.1 §7, §25.
   *
   * These drive every pitch calculation, so they are real settings rather than
   * constants: ±8% is a turntable, not a universal truth.
   */
  const deckCard = h('div', { class: 'card stack' });

  function renderDeckCard(): void {
    const deck = store.deck;
    const tolerance = store.pitchTolerance;

    clear(deckCard);
    mount(
      deckCard,
      h('h2', { class: 'section-title', text: 'Decks and pitch' }),
      h(
        'div',
        { class: 'field' },
        h('span', { class: 'field__label', text: 'Deck' }),
        h(
          'div',
          { class: 'row row--wrap' },
          ...DECK_PROFILES.map((profile) =>
            h('button', {
              class: 'chip',
              type: 'button',
              'aria-pressed': String(deck.id === profile.id),
              text: profile.name,
              onclick: async () => {
                await store.updateSettings({ deckProfileId: profile.id });
                renderDeckCard();
              },
            }),
          ),
        ),
        h('p', {
          class: 'field__hint',
          text: `Range ${deck.pitchRangeMin}% to +${deck.pitchRangeMax}%. ${
            deck.keyLockAvailable
              ? 'Key lock available, so tempo changes need not move the musical pitch.'
              : 'No key lock, so pitching a record moves its musical pitch too.'
          }`,
        }),
      ),
      h(
        'div',
        { class: 'field' },
        h('span', {
          class: 'field__label',
          text: `Preferred maximum pitch: ${tolerance.preferredMaxPitchPercent}%`,
        }),
        h('input', {
          id: 'preferred-max-pitch',
          name: 'preferredMaxPitchPercent',
          class: 'pitch-slider',
          type: 'range',
          min: '1',
          max: String(deck.pitchRangeMax),
          step: '0.5',
          value: String(tolerance.preferredMaxPitchPercent),
          'aria-label': 'Preferred maximum pitch percentage',
          oninput: async (event: Event) => {
            const value = Number((event.target as HTMLInputElement).value);
            await store.updateSettings({ preferredMaxPitchPercent: value });
            renderDeckCard();
          },
        }),
        h('p', {
          class: 'field__hint',
          text: `Suggestions inside ±${tolerance.preferredMaxPitchPercent}% are treated as normal. Beyond that they are ranked lower but still offered. Past ±${deck.pitchRangeMax}% they are out of range.`,
        }),
      ),
    );
  }

  const appearanceCard = h(
    'div',
    { class: 'card stack' },
    h('h2', { class: 'section-title', text: 'Appearance' }),
    h(
      'div',
      { class: 'field' },
      h('span', { class: 'field__label', text: 'Theme' }),
      h(
        'div',
        { class: 'row row--wrap' },
        ...(
          [
            ['dark', 'Dark'],
            ['light', 'Light'],
            ['system', 'System'],
          ] as const
        ).map(([value, label]) =>
          h('button', {
            class: 'chip',
            type: 'button',
            'aria-pressed': String(store.snapshot.settings.theme === value),
            text: label,
            onclick: async () => {
              await store.setTheme(value);
              rerenderAppearance();
            },
          }),
        ),
      ),
      h('p', { class: 'field__hint', text: 'Dark is the default: this gets used in booths.' }),
    ),
    h(
      'div',
      { class: 'field' },
      h('span', { class: 'field__label', text: 'Key notation' }),
      h(
        'div',
        { class: 'row row--wrap' },
        ...(
          [
            ['camelot', 'Camelot (8A)'],
            ['musical', 'Musical (A minor)'],
          ] as const
        ).map(([value, label]) =>
          h('button', {
            class: 'chip',
            type: 'button',
            'aria-pressed': String(store.snapshot.settings.keyNotation === value),
            text: label,
            onclick: async () => {
              await store.setKeyNotation(value);
              rerenderAppearance();
            },
          }),
        ),
      ),
    ),
  );

  const libraryModeCard = h(
    'div',
    { class: 'card stack' },
    h('h2', { class: 'section-title', text: 'Library mode' }),
    h('p', {
      class: 'field__hint',
      text: 'Choose which media appears in DJ-facing screens. This never deletes Discogs data.',
    }),
    h(
      'div',
      { class: 'row row--wrap' },
      h('button', {
        class: 'chip',
        type: 'button',
        'aria-pressed': String(!store.snapshot.settings.vinylOnlyMode),
        text: 'All media',
        onclick: async () => {
          await store.updateSettings({ vinylOnlyMode: false });
          rerenderLibraryMode();
        },
      }),
      h('button', {
        class: 'chip',
        type: 'button',
        'aria-pressed': String(Boolean(store.snapshot.settings.vinylOnlyMode)),
        text: 'Vinyl only',
        onclick: async () => {
          await store.updateSettings({ vinylOnlyMode: true });
          rerenderLibraryMode();
        },
      }),
    ),
    h('p', {
      class: 'field__hint',
      text: 'Vinyl only hides Discogs track positions such as CD1 and CD-1 from releases, bags, analysis, stickers and set planning. Default: All media.',
    }),
  );

  function rerenderLibraryMode(): void {
    const vinylOnly = Boolean(store.snapshot.settings.vinylOnlyMode);
    for (const node of libraryModeCard.querySelectorAll<HTMLElement>('button.chip')) {
      if (node.textContent === 'All media') node.setAttribute('aria-pressed', String(!vinylOnly));
      if (node.textContent === 'Vinyl only') node.setAttribute('aria-pressed', String(vinylOnly));
    }
  }

  const sleevePaletteCard = h('div', { class: 'card stack' });

  function renderSleevePalette(): void {
    const customIds = new Set((store.snapshot.settings.customSleeveColors ?? []).map((color) => color.id));
    const nameInput = h('input', {
      id: 'sleeve-colour-name',
      name: 'sleeveColorName',
      class: 'input',
      type: 'text',
      maxlength: '32',
      placeholder: 'e.g. Orange card',
      'aria-label': 'New sleeve colour name',
    });
    const colorInput = h('input', {
      id: 'sleeve-colour-value',
      name: 'sleeveColorValue',
      type: 'color',
      value: '#d97706',
      'aria-label': 'New sleeve colour',
      title: 'Choose sleeve colour',
      style: { width: '48px', height: '40px' },
    });

    clear(sleevePaletteCard);
    mount(
      sleevePaletteCard,
      h('h2', { class: 'section-title', text: 'Replacement sleeves' }),
      h('p', {
        class: 'field__hint',
        text: 'Create the card-sleeve colours you use. Assign one to a physical copy from its release page.',
      }),
      h(
        'div',
        { class: 'stack stack--tight' },
        ...store.sleeveColors.map((color) =>
          h(
            'div',
            { class: 'row row--wrap' },
            h('span', {
              'aria-hidden': 'true',
              style: {
                width: '24px',
                height: '24px',
                borderRadius: '50%',
                backgroundColor: color.hex,
                border: '1px solid var(--border-strong)',
                flex: '0 0 auto',
              },
            }),
            h('span', { text: color.name }),
            customIds.has(color.id)
              ? h('button', {
                  class: 'button button--small button--ghost',
                  type: 'button',
                  text: 'Delete',
                  'aria-label': `Delete ${color.name} sleeve colour`,
                  onclick: async () => {
                    try {
                      await store.deleteSleeveColor(color.id);
                      renderSleevePalette();
                    } catch (error) {
                      store.notify('error', error instanceof Error ? error.message : 'Could not delete colour.');
                    }
                  },
                })
              : h('span', { class: 'field__hint', text: 'Built in' }),
          ),
        ),
      ),
      h(
        'div',
        { class: 'row row--wrap' },
        nameInput,
        colorInput,
        h('button', {
          class: 'button',
          type: 'button',
          text: 'Add colour',
          onclick: async () => {
            try {
              await store.addSleeveColor(nameInput.value, colorInput.value);
              renderSleevePalette();
              store.notify('info', 'Sleeve colour added.');
            } catch (error) {
              store.notify('error', error instanceof Error ? error.message : 'Could not add colour.');
            }
          },
        }),
      ),
    );
  }

  function rerenderAppearance(): void {
    const chips = appearanceCard.querySelectorAll<HTMLElement>('button.chip');
    const { theme, keyNotation } = store.snapshot.settings;
    for (const node of chips) {
      const label = node.textContent ?? '';
      if (label === 'Dark') node.setAttribute('aria-pressed', String(theme === 'dark'));
      if (label === 'Light') node.setAttribute('aria-pressed', String(theme === 'light'));
      if (label === 'System') node.setAttribute('aria-pressed', String(theme === 'system'));
      if (label.startsWith('Camelot')) node.setAttribute('aria-pressed', String(keyNotation === 'camelot'));
      if (label.startsWith('Musical')) node.setAttribute('aria-pressed', String(keyNotation === 'musical'));
    }
  }

  const dataCard = h(
    'div',
    { class: 'card stack' },
    h('h2', { class: 'section-title', text: 'Your data' }),
    h('p', {
      class: 'field__hint',
      // Spec §27: the user must never be locked in.
      text:
        'Everything lives in this browser. Export a full JSON backup at any time, and import one to restore. ' +
        'An import merges by version, so it never overwrites newer local work.',
    }),
    googleDriveSlot,
    backupSlot,
    h(
      'div',
      { class: 'row row--wrap' },
      h(
        'button',
        {
          class: 'button',
          type: 'button',
          onclick: async () => {
            const json = await exportLibrary();
            const stamp = new Date().toISOString().slice(0, 10);
            await store.platform.files.save(`cratenav-library-${stamp}.json`, json);
          },
        },
        icon('download'),
        'Export library (JSON)',
      ),
      h(
        'button',
        {
          class: 'button',
          type: 'button',
          onclick: async () => {
            const picked = await store.platform.files.openText('application/json,.json');
            if (!picked) return;
            try {
              const report = await importLibrary(picked.text);
              await store.reload();
              await refreshStats();
              renderActions();
              store.notify(
                report.warnings.length ? 'warning' : 'info',
                `Imported ${picked.name}: ${report.added} added, ${report.updated} updated, ` +
                  `${report.skipped} skipped as already current.` +
                  (report.warnings.length ? ` ${report.warnings.join(' ')}` : ''),
              );
            } catch (error) {
              store.notify('error', error instanceof Error ? error.message : 'Import failed.');
            }
          },
        },
        icon('sync'),
        'Import library backup',
      ),
      h('button', {
        class: 'button button--danger button--small',
        type: 'button',
        text: 'Clear local library',
        onclick: async () => {
          const confirmed = window.confirm(
            'Delete the local collection, analysis, bags, set plans and play history from this device? ' +
              'Your Discogs account and app preferences are kept, but any BPM and key entered here will be lost.',
          );
          if (!confirmed) return;
          await clearLibrary();
          await store.reload();
          await refreshStats();
          renderActions();
          store.notify('info', 'Local library cleared.');
        },
      }),
    ),
  );

  const aboutCard = h(
    'div',
    { class: 'card stack stack--tight' },
    h('h2', { class: 'section-title', text: 'About' }),
    h('p', {
      class: 'field__hint',
      text:
        'cratenav is local-first: the collection lives in this browser and works offline once synced. ' +
        'Collection import, online enrichment, microphone analysis, crates, set plans and pitch-aware planning are ready. ' +
        'Google Drive and synced-folder backups are available; Live mode is not wired in yet.',
    }),
    h('p', {
      class: 'field__hint',
      text:
        'The public GitHub Pages build is static and cannot contact metadata services until a compatible proxy is configured. ' +
        'For full Discogs and BPM/key metadata work today, run cratenav locally with the production preview server.',
    }),
    h(
      'p',
      { class: 'field__hint' },
      'Online BPM and key enrichment can use ',
      h('a', {
        href: 'https://getsongbpm.com/',
        target: '_blank',
        rel: 'noopener',
        text: 'GetSongBPM',
      }),
      '. Huge thanks to their team for making their awesome music-data service available to projects like cratenav. ',
      h('a', {
        href: 'https://getsongbpm.com/api',
        target: '_blank',
        rel: 'noopener',
        text: 'Request GetSongBPM API access',
      }),
      '.',
    ),
    h('p', {
      class: 'field__hint',
      text: `Device ${store.platform.device.deviceId.slice(0, 8)} / ${store.platform.device.platform}`,
    }),
  );

  element.append(
    statsSlot,
    discogsCard,
    deckCard,
    appearanceCard,
    libraryModeCard,
    sleevePaletteCard,
    dataCard,
    aboutCard,
  );
  renderAccountActions();
  renderSleevePalette();
  renderDeckCard();

  void refreshStats();
  renderActions();
  const unsubscribeGoogleDrive = googleDrive?.subscribe(renderGoogleDriveBackup) ?? (() => undefined);
  const unsubscribeBackup = backup?.subscribe(renderBackup) ?? (() => undefined);

  return {
    element,
    destroy: () => {
      unsubscribeProgress();
      unsubscribeStore();
      unsubscribeGoogleDrive();
      unsubscribeBackup();
    },
  };
}
