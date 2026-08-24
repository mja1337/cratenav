import type { SyncProgress } from '@/discogs/sync';
import { formatEta } from './format';
import { h } from '@/utils/dom';

/**
 * Sync progress bar.
 *
 * The metadata import takes ~9 minutes, so it must communicate that it is
 * working, how far along it is, and roughly how long is left. An unexplained
 * ten-minute spinner reads as a hang.
 */
export function progressBar(progress: SyncProgress): HTMLElement {
  const indeterminate = progress.total === 0;
  const pct = indeterminate ? 0 : Math.min(100, Math.round((progress.current / progress.total) * 100));
  const eta = formatEta(progress.etaSeconds);

  const fill = h('div', {
    class: `progress__fill${indeterminate ? ' progress__fill--indeterminate' : ''}`,
    style: { width: `${pct}%` },
  });

  return h(
    'div',
    {
      class: 'progress',
      role: 'progressbar',
      'aria-valuemin': '0',
      'aria-valuemax': indeterminate ? undefined : String(progress.total),
      'aria-valuenow': indeterminate ? undefined : String(progress.current),
      'aria-valuetext': progress.message,
    },
    h('div', { class: 'progress__track' }, fill),
    h(
      'div',
      { class: 'progress__meta' },
      h('span', { text: progress.message }),
      h('span', { text: eta ?? (indeterminate ? '' : `${pct}%`) }),
    ),
  );
}
