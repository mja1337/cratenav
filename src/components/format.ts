import type { Artwork, CamelotKey, KeyNotation, MusicalKey, Track, TrackAnalysis } from '@/domain/types';
import { formatCamelot, formatMusicalKey, musicalKeyToCamelot, parseKey } from '@/harmonic/camelot';

/** Presentation helpers shared across views. */

/** Format a key for display, honouring the Camelot/musical toggle. Spec §12. */
export function formatKeyFor(analysis: TrackAnalysis | undefined, notation: KeyNotation): string | null {
  if (!analysis) return null;
  if (notation === 'camelot') {
    return analysis.camelotKey ? formatCamelot(analysis.camelotKey) : null;
  }
  return analysis.canonicalKey ? formatMusicalKey(analysis.canonicalKey) : null;
}

/** Both notations, for detail surfaces where there is room. */
export function formatKeyBoth(analysis: TrackAnalysis | undefined): string | null {
  if (!analysis?.canonicalKey) return null;
  const camelot = analysis.camelotKey ? formatCamelot(analysis.camelotKey) : null;
  const musical = formatMusicalKey(analysis.canonicalKey);
  return camelot ? `${camelot} · ${musical}` : musical;
}

export function formatBpm(analysis: TrackAnalysis | undefined): string | null {
  const bpm = analysis?.canonicalBpm;
  if (bpm === undefined || bpm === null) return null;
  // One decimal only when it carries information.
  return Number.isInteger(bpm) ? String(bpm) : bpm.toFixed(1);
}

export function formatDuration(seconds: number | undefined): string | null {
  if (!seconds || !Number.isFinite(seconds)) return null;
  const total = Math.round(seconds);
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const secs = total % 60;
  return hours
    ? `${hours}:${String(minutes).padStart(2, '0')}:${String(secs).padStart(2, '0')}`
    : `${minutes}:${String(secs).padStart(2, '0')}`;
}

/** Track title including its version qualifier. */
export function trackTitle(track: Track): string {
  return track.mixVersion ? `${track.title} (${track.mixVersion})` : track.title;
}

/**
 * Choose an artwork URL.
 * Thumbnails are preferred in lists: they are what the service worker caches,
 * so a grid stays instant and works offline. Spec §6.
 */
export function artworkUrl(artwork: readonly Artwork[], size: 'thumb' | 'full'): string | null {
  const primary = artwork.find((a) => a.type === 'primary') ?? artwork[0];
  if (!primary) return null;
  return size === 'thumb'
    ? (primary.uri150 ?? primary.uri ?? null)
    : (primary.uri ?? primary.uri150 ?? null);
}

export function formatCount(value: number, singular: string, plural = `${singular}s`): string {
  return `${value.toLocaleString('en-GB')} ${value === 1 ? singular : plural}`;
}

export function formatRelativeTime(iso: string | undefined): string | null {
  if (!iso) return null;
  const then = new Date(iso).getTime();
  if (!Number.isFinite(then)) return null;

  const seconds = Math.round((Date.now() - then) / 1000);
  if (seconds < 60) return 'just now';
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} ${hours === 1 ? 'hour' : 'hours'} ago`;
  const days = Math.round(hours / 24);
  if (days < 30) return `${days} ${days === 1 ? 'day' : 'days'} ago`;
  return new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
}

export function formatEta(seconds: number | undefined): string | null {
  if (!seconds || seconds <= 0) return null;
  if (seconds < 60) return `${Math.round(seconds)}s remaining`;
  const minutes = Math.round(seconds / 60);
  return `about ${minutes} ${minutes === 1 ? 'minute' : 'minutes'} remaining`;
}


/**
 * A key in BOTH notations, the reader's preferred one leading.
 *
 * Camelot is what a DJ reads off a sticker and off the wheel; the musical name
 * is what every source database reports. Showing only one forces a conversion
 * in the middle of a mix, and since a semitone is SEVEN Camelot steps that is
 * exactly the conversion people get wrong. The spec §12 toggle decides which
 * notation leads, not whether the other one is available.
 */
export function formatKeyPair(
  key: MusicalKey | undefined,
  camelot: CamelotKey | undefined,
  notation: KeyNotation,
): string | undefined {
  const wheelKey = camelot ?? (key ? musicalKeyToCamelot(key) ?? undefined : undefined);
  const musical = key ? formatMusicalKey(key) : undefined;
  const wheel = wheelKey ? formatCamelot(wheelKey) : undefined;
  if (!musical) return wheel;
  if (!wheel) return musical;
  return notation === 'camelot' ? `${wheel} · ${musical}` : `${musical} · ${wheel}`;
}

/**
 * Same, for a key the detector has already rendered as a name ("A minor").
 *
 * Diagnostics and section votes carry key names as strings rather than typed
 * keys. Falls back to the original text if it will not parse, so an unexpected
 * label degrades to being unannotated rather than disappearing.
 */
export function formatKeyNamePair(
  name: string | undefined,
  notation: KeyNotation,
): string | undefined {
  if (!name) return undefined;
  const parsed = parseKey(name);
  return parsed ? formatKeyPair(parsed, undefined, notation) : name;
}
