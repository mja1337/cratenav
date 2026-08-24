import { svg } from '@/utils/dom';

/**
 * Icon set, hand-rolled so the app ships with no icon dependency.
 * Every icon is decorative: the label beside it carries the meaning. §43
 */

const PATHS = {
  library: [
    'M4 4h4v16H4z',
    'M10 4h4v16h-4z',
    'M17.5 4.3l3 15.4',
  ],
  bag: [
    'M4 8h16l-1.2 11a2 2 0 0 1-2 1.8H7.2a2 2 0 0 1-2-1.8z',
    'M9 8V6a3 3 0 0 1 6 0v2',
  ],
  analyse: [
    'M3 12h3l2.5-7 3 14 2.5-7h3',
    'M18.5 12H21',
  ],
  live: [
    'M12 3a9 9 0 0 0-9 9v5a2 2 0 0 0 2 2h2v-7H5',
    'M21 19a2 2 0 0 1-2 2h-2v-7h2V12a9 9 0 0 0-7-8.8',
  ],
  more: ['M5 12h.01', 'M12 12h.01', 'M19 12h.01'],
  settings: [
    'M12 15.5a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7z',
    'M19.4 15a1.7 1.7 0 0 0 .3 1.9l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-2.9 1.2V21a2 2 0 1 1-4 0v-.1A1.7 1.7 0 0 0 7 19.4a1.7 1.7 0 0 0-1.9.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1A1.7 1.7 0 0 0 3 15a1.7 1.7 0 0 0-1.7-1H1a2 2 0 1 1 0-4h.2A1.7 1.7 0 0 0 3 9a1.7 1.7 0 0 0-.3-1.9l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1A1.7 1.7 0 0 0 9 3.6V3a2 2 0 1 1 4 0v.2A1.7 1.7 0 0 0 15 4.6a1.7 1.7 0 0 0 1.9-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1A1.7 1.7 0 0 0 20.4 9v.2h.6a2 2 0 1 1 0 4h-.2z',
  ],
  grid: ['M4 4h7v7H4z', 'M13 4h7v7h-7z', 'M4 13h7v7H4z', 'M13 13h7v7h-7z'],
  list: ['M4 6h16', 'M4 12h16', 'M4 18h16'],
  crate: ['M3 7h18v12H3z', 'M3 7l2-3h14l2 3', 'M9 11v4', 'M15 11v4'],
  back: ['M15 19l-7-7 7-7'],
  search: ['M11 18a7 7 0 1 0 0-14 7 7 0 0 0 0 14z', 'M20 20l-4-4'],
  sync: ['M21 12a9 9 0 1 1-3.2-6.9', 'M21 4v5h-5'],
  stop: ['M6 6h12v12H6z'],
  sun: [
    'M12 17a5 5 0 1 0 0-10 5 5 0 0 0 0 10z',
    'M12 1v3', 'M12 20v3', 'M4.2 4.2l2.1 2.1', 'M17.7 17.7l2.1 2.1',
    'M1 12h3', 'M20 12h3', 'M4.2 19.8l2.1-2.1', 'M17.7 6.3l2.1-2.1',
  ],
  moon: ['M20 14.5A8.5 8.5 0 0 1 9.5 4a8.5 8.5 0 1 0 10.5 10.5z'],
  download: ['M12 3v12', 'M7 11l5 5 5-5', 'M4 20h16'],
  disc: [
    'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18z',
    'M12 14.5a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5z',
  ],
  wheel: [
    'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18z',
    'M12 3v18', 'M3 12h18', 'M5.6 5.6l12.8 12.8', 'M18.4 5.6L5.6 18.4',
  ],
  external: ['M14 4h6v6', 'M20 4l-9 9', 'M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5'],
} satisfies Record<string, string[]>;

export type IconName = keyof typeof PATHS;

export function icon(name: IconName, size?: number): SVGSVGElement {
  return svg(PATHS[name], size);
}
