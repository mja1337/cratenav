import { h } from '@/utils/dom';

/**
 * Cover art with lazy loading.
 *
 * Cover art is the primary way a DJ recognises a record, so the placeholder is
 * a record-label motif rather than a broken-image icon, and the real image
 * fades in only once decoded to avoid a flash of half-drawn artwork. Spec §6, §7.
 */
export function cover(url: string | null, alt: string, options: { className?: string } = {}): HTMLElement {
  const wrapper = h('div', {
    class: `cover${url ? '' : ' cover--empty'}${options.className ? ` ${options.className}` : ''}`,
  });

  const markUnavailable = (suffix: string) => {
    wrapper.classList.add('cover--empty');
    wrapper.setAttribute('role', 'img');
    wrapper.setAttribute('aria-label', `${alt} — ${suffix}`);
  };

  if (!url) {
    // Decorative: the adjacent title already names the record.
    wrapper.setAttribute('role', 'img');
    wrapper.setAttribute('aria-label', `${alt} — no artwork`);
    return wrapper;
  }

  const image = h('img', {
    src: url,
    alt,
    loading: 'lazy',
    decoding: 'async',
  });

  const reveal = () => image.classList.add('is-loaded');

  image.addEventListener('load', reveal);
  image.addEventListener('error', () => {
    // Offline with nothing cached, or a dead Discogs URL: fall back cleanly.
    image.remove();
    markUnavailable('artwork unavailable');
  });

  wrapper.append(image);

  // A cached image can finish decoding before these listeners attach, in which
  // case `load` never fires and the image would sit at opacity 0 forever. On a
  // re-render of an already-browsed grid that is every single cover, so check
  // the completed state explicitly rather than relying on the event.
  if (image.complete) {
    if (image.naturalWidth > 0) reveal();
    else markUnavailable('artwork unavailable');
  }

  return wrapper;
}
