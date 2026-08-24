import type { Store } from './store';
import { registerSW } from 'virtual:pwa-register';
import { h } from '@/utils/dom';

/**
 * Service worker registration and update prompt. Spec §28.
 *
 * The update is offered rather than forced: a silent reload mid-set would be
 * unwelcome, so a new version waits until the user accepts it.
 */
export function registerServiceWorker(store: Store): void {
  if (import.meta.env.DEV) return;

  const update = registerSW({
    immediate: true,
    onNeedRefresh() {
      showUpdatePrompt(() => update(true));
    },
    onOfflineReady() {
      store.notify('info', 'Ready to work offline.');
    },
    onRegisterError(error: unknown) {
      // Not fatal: the app runs fine without offline caching.
      console.warn('Service worker registration failed', error);
    },
  });
}

function showUpdatePrompt(accept: () => void): void {
  const banner = h(
    'div',
    {
      class: 'banner banner--info',
      role: 'status',
      style: {
        position: 'fixed',
        left: '16px',
        right: '16px',
        bottom: 'calc(var(--nav-height) + 16px)',
        zIndex: '50',
        boxShadow: 'var(--shadow-3)',
        background: 'var(--bg-raised)',
      },
    },
    h('div', { class: 'banner__title', text: 'Update available' }),
    h('div', { class: 'banner__body', text: 'A newer version of cratenav is ready.' }),
    h(
      'div',
      { class: 'row' },
      h('button', {
        class: 'button button--small button--primary',
        type: 'button',
        text: 'Reload',
        onclick: accept,
      }),
      h('button', {
        class: 'button button--small button--ghost',
        type: 'button',
        text: 'Later',
        onclick: () => banner.remove(),
      }),
    ),
  );
  document.body.append(banner);
}
