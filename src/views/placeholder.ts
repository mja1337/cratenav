import type { View } from './types';
import type { Router } from '@/app/router';
import { icon, type IconName } from '@/components/icons';
import { h } from '@/utils/dom';

/**
 * Honest placeholder for a feature that is designed but not yet built.
 *
 * Spec §50 is explicit: do not fake integrations. These screens say plainly
 * what they will do and what has to land first, rather than showing mock data
 * that looks live.
 */
export function createPlaceholderView(options: {
  router: Router;
  iconName: IconName;
  title: string;
  body: string;
  points: string[];
  phase: string;
}): View {
  const element = h(
    'div',
    { class: 'container' },
    h(
      'div',
      { class: 'empty' },
      h(
        'div',
        {
          style: {
            display: 'grid',
            placeItems: 'center',
            width: '64px',
            height: '64px',
            borderRadius: '50%',
            background: 'var(--bg-raised-2)',
            border: '1px solid var(--border)',
            color: 'var(--text-muted)',
          },
        },
        icon(options.iconName, 30),
      ),
      h('h2', { text: options.title }),
      h('p', { text: options.body }),
      h(
        'ul',
        {
          style: {
            textAlign: 'left',
            margin: '0',
            paddingLeft: '20px',
            color: 'var(--text-muted)',
            fontSize: '0.875rem',
            lineHeight: '1.7',
            maxWidth: '46ch',
          },
        },
        ...options.points.map((point) => h('li', { text: point })),
      ),
      h('span', { class: 'chip', text: options.phase }),
      h('button', {
        class: 'button',
        type: 'button',
        text: 'Back to collection',
        onclick: () => options.router.navigate('library'),
      }),
    ),
  );

  return { element };
}
