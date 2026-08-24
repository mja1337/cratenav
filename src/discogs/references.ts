import type { ExternalReference } from '@/domain/types';

/** Stable identity for exact links and alternate URLs for one YouTube video. */
export function referenceIdentity(uri: string): string {
  try {
    const url = new URL(uri);
    const host = url.hostname.toLowerCase().replace(/^www\./, '').replace(/^m\./, '');
    let youtubeId: string | undefined;
    if (host === 'youtu.be') youtubeId = url.pathname.split('/').filter(Boolean)[0];
    if (host === 'youtube.com' || host.endsWith('.youtube.com') || host === 'youtube-nocookie.com') {
      youtubeId = url.searchParams.get('v') ?? undefined;
      if (!youtubeId) {
        const [kind, id] = url.pathname.split('/').filter(Boolean);
        if (['embed', 'shorts', 'live'].includes(kind ?? '')) youtubeId = id;
      }
    }
    if (youtubeId) return `youtube:${youtubeId}`;

    // Fragments and common tracking parameters do not identify a different
    // reference. Normalise these before comparing already-stored rows.
    url.hash = '';
    for (const key of [...url.searchParams.keys()]) {
      if (key.startsWith('utm_') || ['feature', 'si', 't', 'start'].includes(key)) {
        url.searchParams.delete(key);
      }
    }
    return url.toString();
  } catch {
    return uri.trim();
  }
}

export function deduplicateReferences(
  references: readonly ExternalReference[],
): ExternalReference[] {
  const seen = new Set<string>();
  return references.filter((reference) => {
    const identity = referenceIdentity(reference.uri);
    if (seen.has(identity)) return false;
    seen.add(identity);
    return true;
  });
}
