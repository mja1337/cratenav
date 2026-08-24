import { describe, expect, it, vi } from 'vitest';
import type { MatchContext } from '@/enrichment/provider';
import { OpenAnalysisProvider } from '@/enrichment/open-analysis-provider';
import type { Release, Track } from '@/domain/types';

const timestamp = '2026-08-24T10:00:00.000Z';

function context(): MatchContext {
  const track: Track = {
    id: 'track-1',
    createdAt: timestamp,
    updatedAt: timestamp,
    version: 1,
    releaseId: 'release-1',
    position: 'A1',
    artist: 'Nookie',
    title: 'Shining In Da Darkness',
    mixVersion: 'Original Mix',
    duration: 360,
    sequence: 0,
  };
  const release: Release = {
    id: 'release-1',
    createdAt: timestamp,
    updatedAt: timestamp,
    version: 1,
    discogsReleaseId: 1234,
    artist: 'Nookie',
    artistSort: 'nookie',
    title: 'The Sound Of Music',
    formats: [],
    genres: ['Electronic'],
    styles: ['Jungle'],
    identifiers: [],
    artwork: [],
    trackIds: [track.id],
    references: [],
    hydrationState: 'hydrated',
  };
  return { track, release, siblings: [track] };
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('zero-key public analysis provider', () => {
  it('resolves MusicBrainz identity and maps AcousticBrainz BPM/key as unverified', async () => {
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, _init?: RequestInit) => {
      const url = String(input);
      if (url.includes('/ws/2/recording/')) {
        return json({
          recordings: [{
            id: 'mbid-1',
            score: '100',
            title: 'Shining In Da Darkness (Original Mix)',
            length: 359_000,
            'artist-credit': [{ name: 'Nookie' }],
          }],
        });
      }
      return json({
        'mbid-1': {
          0: {
            rhythm: { bpm: 87, bpm_confidence: 0.72 },
            tonal: { key_key: 'A', key_scale: 'minor', key_strength: 0.64 },
          },
        },
      });
    });
    const provider = new OpenAnalysisProvider({
      fetchImpl: fetchImpl as unknown as typeof fetch,
      sleepImpl: async () => undefined,
      musicBrainzBaseUrl: 'https://musicbrainz.test',
      acousticBrainzBaseUrl: 'https://acousticbrainz.test',
    });

    const results = await provider.lookup(context(), { contact: 'dj@example.test' });

    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({
      externalId: 'mbid-1',
      externalUrl: 'https://musicbrainz.org/recording/mbid-1',
      verificationRequired: true,
      identity: {
        artist: 'Nookie',
        title: 'Shining In Da Darkness',
        version: 'Original Mix',
        duration: 359,
      },
      candidate: {
        source: 'acousticbrainz',
        sourceBpm: 87,
        canonicalBpm: 174,
        sourceKey: 'A minor',
        canonicalKey: { pitchClass: 'A', tonality: 'minor' },
        camelotKey: { number: 8, letter: 'A' },
        nativePitchClass: 9,
        bpmConfidence: 0.72,
        keyConfidence: 0.64,
      },
    });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    const bulkUrl = new URL(String(fetchImpl.mock.calls[1]?.[0]));
    expect(`${bulkUrl.origin}${bulkUrl.pathname}`).toBe(
      'https://acousticbrainz.test/api/v1/low-level',
    );
    expect(bulkUrl.searchParams.get('recording_ids')).toBe('mbid-1');
    expect(fetchImpl.mock.calls[0]?.[1]).toMatchObject({
      headers: expect.objectContaining({ 'X-Cratenav-Contact': 'dj@example.test' }),
    });
  });

  it('returns no claim when AcousticBrainz has no historic submission', async () => {
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) =>
      String(input).includes('/ws/2/recording/')
        ? json({ recordings: [{ id: 'missing', score: 100, title: 'Shining In Da Darkness' }] })
        : json({}));
    const provider = new OpenAnalysisProvider({
      fetchImpl: fetchImpl as unknown as typeof fetch,
      sleepImpl: async () => undefined,
      musicBrainzBaseUrl: 'https://musicbrainz.test',
      acousticBrainzBaseUrl: 'https://acousticbrainz.test',
    });

    await expect(provider.lookup(context(), { contact: 'dj@example.test' })).resolves.toEqual([]);
  });

  it('does not query AcousticBrainz for a weak MusicBrainz search result', async () => {
    const fetchImpl = vi.fn(async () =>
      json({ recordings: [{ id: 'weak', score: 60, title: 'A different tune' }] }));
    const provider = new OpenAnalysisProvider({
      fetchImpl: fetchImpl as unknown as typeof fetch,
      sleepImpl: async () => undefined,
      musicBrainzBaseUrl: 'https://musicbrainz.test',
      acousticBrainzBaseUrl: 'https://acousticbrainz.test',
    });

    await expect(provider.lookup(context(), { contact: 'dj@example.test' })).resolves.toEqual([]);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('requires MusicBrainz request identification before making a network call', async () => {
    const fetchImpl = vi.fn(async () => json({ recordings: [] }));
    const provider = new OpenAnalysisProvider({
      fetchImpl: fetchImpl as unknown as typeof fetch,
      musicBrainzBaseUrl: 'https://musicbrainz.test',
      acousticBrainzBaseUrl: 'https://acousticbrainz.test',
    });

    await expect(provider.lookup(context())).rejects.toThrow('Add a contact');
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
