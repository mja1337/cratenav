import type { Store } from './store';
import type { Router } from './router';
import type { View } from '@/views/types';
import { createLibraryView } from '@/views/library';
import { createReleaseView } from '@/views/release';
import { createTrackView } from '@/views/track';
import { createSettingsView } from '@/views/settings';
import { createBagDetailView, createBagListView } from '@/views/bags';
import { createSetPlanView } from '@/views/setplan';
import { createAnalyseView } from '@/views/analyse';
import { createStickerView } from '@/views/sticker';
import { createPlaceholderView } from '@/views/placeholder';
import { icon, type IconName } from '@/components/icons';
import { formatCount } from '@/components/format';
import { progressBar } from '@/components/progress';
import { clear, h } from '@/utils/dom';
import { APP_VERSION } from './version';

/**
 * Application shell: header, navigation and the view outlet.
 *
 * Navigation follows the mobile option in spec §30 — Library / Bag / Analyse /
 * Live / More — as a bottom bar on phones and a sidebar on desktop, which
 * keeps every destination inside thumb reach without a hamburger menu.
 */

interface NavItem {
  route: string;
  label: string;
  iconName: IconName;
}

const NAV_ITEMS: NavItem[] = [
  { route: 'library', label: 'Library', iconName: 'library' },
  { route: 'bag', label: 'Bag', iconName: 'bag' },
  { route: 'analyse', label: 'Analyse', iconName: 'analyse' },
  { route: 'live', label: 'Live', iconName: 'live' },
  { route: 'settings', label: 'More', iconName: 'more' },
];

/** Which nav entry should light up for a given route. */
const NAV_FOR_ROUTE: Record<string, string> = {
  library: 'library',
  release: 'library',
  track: 'library',
  bag: 'bag',
  set: 'bag',
  analyse: 'analyse',
  sticker: 'analyse',
  live: 'live',
  settings: 'settings',
};

export function mountShell(root: HTMLElement, store: Store, router: Router): void {
  const title = h('h1', { class: 'header__title' });
  const appMark = h(
    'span',
    { class: 'header__brand', 'aria-label': `cratenav version ${APP_VERSION}` },
    h('span', { text: 'cratenav' }),
    h('small', { class: 'app-version', text: `v${APP_VERSION}` }),
  );
  const backButton = h(
    'button',
    {
      class: 'icon-button',
      type: 'button',
      'aria-label': 'Back',
      onclick: () => router.back(),
    },
    icon('back'),
  );

  const themeButton = h('button', {
    class: 'icon-button',
    type: 'button',
    'aria-label': 'Toggle theme',
  });
  themeButton.addEventListener('click', () => {
    const current = store.snapshot.settings.theme;
    void store.setTheme(current === 'dark' ? 'light' : 'dark');
  });

  const notationButton = h('button', {
    class: 'icon-button',
    type: 'button',
    'aria-label': 'Toggle key notation',
  });
  notationButton.addEventListener('click', () => {
    const current = store.snapshot.settings.keyNotation;
    void store.setKeyNotation(current === 'camelot' ? 'musical' : 'camelot');
  });

  const header = h(
    'header',
    { class: 'header' },
    backButton,
    appMark,
    title,
    h('div', { class: 'header__actions' }, notationButton, themeButton),
  );

  // Notices are rendered here rather than per-view: an error raised by a
  // background operation must be visible wherever the user happens to be
  // standing, not only on the screen that started it.
  const noticeRegion = h('div', { class: 'notice-region', role: 'status', 'aria-live': 'polite' });

  function renderNotice(): void {
    const { notice } = store.snapshot;
    clear(noticeRegion);
    if (!notice) return;
    noticeRegion.append(
      h(
        'div',
        { class: `banner banner--${notice.kind}` },
        h('div', { class: 'banner__body', text: notice.text }),
        h('button', {
          class: 'button button--small button--ghost',
          type: 'button',
          text: 'Dismiss',
          onclick: () => store.clearNotice(),
        }),
      ),
    );
  }

  const outlet = h('main', { class: 'shell__main', id: 'main', tabindex: '-1' });
  const activity = h('aside', {
    class: 'activity',
    'aria-label': 'Background activity',
    'aria-live': 'polite',
    hidden: true,
  });

  const nav = h('nav', { class: 'nav', 'aria-label': 'Main' });
  const navLinks = new Map<string, HTMLAnchorElement>();
  nav.append(
    h(
      'span',
      { class: 'nav__brand' },
      'cratenav',
      h('small', { class: 'app-version', text: `v${APP_VERSION}` }),
    ),
  );
  for (const item of NAV_ITEMS) {
    const link = h(
      'a',
      { class: 'nav__item', href: `#/${item.route}` },
      icon(item.iconName),
      h('span', { text: item.label }),
    );
    navLinks.set(item.route, link);
    nav.append(link);
  }

  const shell = h('div', { class: 'shell' }, header, activity, noticeRegion, outlet, nav);
  clear(root);
  root.removeAttribute('aria-busy');
  root.append(shell);

  let current: View | null = null;

  function refreshHeaderChrome(): void {
    const { theme, keyNotation } = store.snapshot.settings;
    clear(themeButton);
    themeButton.append(icon(theme === 'light' ? 'moon' : 'sun'));
    themeButton.title = theme === 'light' ? 'Switch to dark' : 'Switch to light';

    clear(notationButton);
    notationButton.append(icon('wheel'));
    notationButton.title =
      keyNotation === 'camelot' ? 'Showing Camelot keys' : 'Showing musical keys';
    notationButton.setAttribute('aria-pressed', String(keyNotation === 'musical'));
  }

  function setTitle(main: string, sub?: string): void {
    clear(title);
    title.append(document.createTextNode(main));
    if (sub) title.append(h('span', { class: 'header__sub', text: sub }));
  }

  function renderActivity(): void {
    const operations = Object.values(store.operations);
    clear(activity);
    activity.hidden = operations.length === 0;
    if (!operations.length) return;

    activity.append(
      ...operations.map((operation) =>
        h(
          'div',
          { class: 'activity__item' },
          h(
            'div',
            { class: 'activity__head' },
            h('strong', { text: operation.label }),
            h(
              'div',
              { class: 'row' },
              h('button', {
                class: 'button button--small button--ghost',
                type: 'button',
                text: 'View',
                onclick: () => router.navigate(operation.route),
              }),
              h('button', {
                class: 'button button--small button--danger',
                type: 'button',
                text: operation.stopLabel,
                onclick: () => store.stopBulkOperation(operation.kind),
              }),
            ),
          ),
          progressBar({
            phase: 'metadata',
            message: operation.message,
            current: operation.current,
            total: operation.total,
            etaSeconds: operation.etaSeconds,
          }),
        ),
      ),
    );
  }

  function render(route: { name: string; params: Record<string, string> }): void {
    current?.destroy?.();

    const isDetail =
      route.name === 'release' ||
      route.name === 'track' ||
      route.name === 'set' ||
      (route.name === 'bag' && Boolean(route.params['id']));
    backButton.style.display = isDetail ? '' : 'none';

    const active = NAV_FOR_ROUTE[route.name] ?? 'library';
    for (const [key, link] of navLinks) {
      if (key === active) link.setAttribute('aria-current', 'page');
      else link.removeAttribute('aria-current');
    }

    const releases = store.ownedReleases;
    const tracks = store.visibleTracks;

    switch (route.name) {
      case 'release': {
        const release = store.getRelease(route.params['id'] ?? '');
        setTitle(release?.title ?? 'Record', release?.artist);
        current = createReleaseView(store, router, route.params['id'] ?? '');
        break;
      }
      case 'track': {
        const track = store.getTrack(route.params['id'] ?? '');
        setTitle(track?.title ?? 'Track', track ? `Position ${track.position}` : undefined);
        current = createTrackView(store, router, route.params['id'] ?? '');
        break;
      }
      case 'settings':
        setTitle('Settings');
        current = createSettingsView(store);
        break;
      case 'bag': {
        const bagId = route.params['id'];
        if (bagId) {
          const bag = store.getBag(bagId);
          setTitle(bag?.name ?? 'Bag', bag ? `${bag.collectionItemIds.length} records` : undefined);
          current = createBagDetailView(store, router, bagId);
        } else {
          const active = store.activeBag;
          setTitle('Bags', active ? `Active: ${active.name}` : undefined);
          current = createBagListView(store, router);
        }
        break;
      }
      case 'set': {
        const plan = store.getSetPlan(route.params['id'] ?? '');
        setTitle(plan?.name ?? 'Set plan', plan?.mode);
        current = createSetPlanView(store, router, route.params['id'] ?? '');
        break;
      }
      case 'sticker':
        setTitle('Sticker run');
        current = createStickerView(store, router);
        break;
      case 'analyse': {
        const bag = store.activeBag;
        setTitle('Analyse', bag ? `Bag: ${bag.name}` : undefined);
        current = createAnalyseView(store, router);
        break;
      }
      case 'live':
        setTitle('Live');
        current = createPlaceholderView({
          router,
          iconName: 'live',
          title: 'Live mode is not built yet',
          body:
            'Live mode will listen to whatever is playing and suggest the next record from the bag you actually brought.',
          points: [
            'Giant BPM and key readout, readable at arm’s length',
            'Mix-in-progress detection, holding suggestions while two tracks overlap',
            'Tap tempo, halve/double, manual key override',
            'Suggestions scoped to the active bag, not your whole collection',
          ],
          phase: 'Phase 5',
        });
        break;
      default:
        setTitle(
          'Collection',
          releases.length
            ? `${formatCount(releases.length, 'record')} / ${formatCount(tracks.length, 'track')}`
            : undefined,
        );
        current = createLibraryView(store, router);
        break;
    }

    clear(outlet);
    outlet.append(current.element);
    outlet.scrollTo?.({ top: 0 });
    window.scrollTo({ top: 0 });
  }

  refreshHeaderChrome();
  renderNotice();
  store.subscribeOperations(renderActivity);
  store.subscribe(() => {
    refreshHeaderChrome();
    renderNotice();
    // Keep the header count fresh after a sync without a full re-render.
    if (router.route.name === 'library') {
      const releases = store.ownedReleases;
      const tracks = store.visibleTracks;
      setTitle(
        'Collection',
        releases.length
          ? `${formatCount(releases.length, 'record')} / ${formatCount(tracks.length, 'track')}`
          : undefined,
      );
    }
  });

  router.start(render);
}
