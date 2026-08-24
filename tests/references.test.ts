import { describe, expect, it } from 'vitest';
import { deduplicateReferences } from '@/discogs/references';
import type { ExternalReference } from '@/domain/types';

const video = (uri: string): ExternalReference => ({ kind: 'video', uri });

describe('Discogs reference deduplication', () => {
  it('cleans duplicate links already stored in IndexedDB-era release rows', () => {
    const result = deduplicateReferences([
      video('https://www.youtube.com/watch?v=abc123'),
      video('https://youtu.be/abc123?t=30'),
      video('https://music.youtube.com/watch?v=abc123&feature=share'),
      video('https://www.youtube-nocookie.com/embed/abc123'),
    ]);
    expect(result).toHaveLength(1);
  });

  it('keeps genuinely different videos', () => {
    expect(deduplicateReferences([
      video('https://www.youtube.com/watch?v=first'),
      video('https://www.youtube.com/watch?v=second'),
    ])).toHaveLength(2);
  });

  it('ignores tracking parameters on otherwise identical non-YouTube links', () => {
    expect(deduplicateReferences([
      video('https://example.com/reference?id=1&utm_source=discogs'),
      video('https://example.com/reference?id=1'),
    ])).toHaveLength(1);
  });
});
