import { openDatabase } from '@/data/schema';
import { applyTheme, Store } from '@/app/store';
import { Router } from '@/app/router';
import { mountShell } from '@/app/shell';
import { createBrowserPlatform } from '@/storage/platform';
import { h } from '@/utils/dom';
import { registerServiceWorker } from '@/app/service-worker';

/**
 * Bootstrap.
 *
 * Local-first: the app opens from IndexedDB and never waits on the network.
 * Spec §25 — cloud and Discogs are synchronisation, not a runtime dependency.
 */
async function boot(): Promise<void> {
  const root = document.querySelector<HTMLElement>('#app');
  if (!root) throw new Error('Missing #app root element');

  try {
    await openDatabase();

    const platform = createBrowserPlatform();
    const store = await Store.create(platform);

    applyTheme(store.snapshot.settings.theme);

    // Follow the OS when the user has chosen "system".
    window.matchMedia('(prefers-color-scheme: light)').addEventListener('change', () => {
      if (store.snapshot.settings.theme === 'system') applyTheme('system');
    });

    const router = new Router()
      .register('library')
      .register('release/:id')
      .register('track/:id')
      .register('bag')
      .register('bag/:id')
      .register('set/:id')
      .register('analyse')
      .register('sticker')
      .register('live')
      .register('settings');

    mountShell(root, store, router);
    registerServiceWorker(store);
  } catch (error) {
    root.replaceChildren(
      h(
        'div',
        { class: 'container empty' },
        h('h2', { text: 'cratenav could not start' }),
        h('p', {
          text:
            error instanceof Error
              ? error.message
              : 'An unexpected error stopped the app from loading.',
        }),
        h('p', {
          class: 'field__hint',
          text: 'Private browsing can block local storage, which cratenav needs.',
        }),
        h('button', {
          class: 'button',
          type: 'button',
          text: 'Reload',
          onclick: () => window.location.reload(),
        }),
      ),
    );
    // Rethrow so it still lands in the console for debugging.
    throw error;
  }
}

void boot();
