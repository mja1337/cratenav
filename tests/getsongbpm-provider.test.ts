import { describe, expect, it, vi } from 'vitest';
import type { Release, Track } from '@/domain/types';
import { GetSongBpmProvider } from '@/enrichment/getsongbpm-provider';
import type { MatchContext } from '@/enrichment/provider';
import { scoreIdentity } from '@/enrichment/matching';

const timestamp = '2026-08-24T10:00:00.000Z';

function context(overrides: Partial<Track> = {}): MatchContext {
  const track: Track = {
    id: 'track-1',
    createdAt: timestamp,
    updatedAt: timestamp,
    version: 1,
    releaseId: 'release-1',
    position: 'A1',
    artist: 'Nookie',
    title: 'Shining In Da Darkness',
    duration: 360,
    sequence: 0,
    ...overrides,
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

describe('GetSongBPM provider', () => {
  it('maps BPM/key, keeps the claim unverified and sends the key only as a header', async () => {
    const fetchImpl = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => json({
      search: [{
        id: 'song-1',
        title: 'Shining In Da Darkness',
        uri: 'https://getsongbpm.com/song/shining-in-da-darkness/song-1',
        tempo: '87',
        key_of: 'Am',
        open_key: '1m',
        artist: { name: 'Nookie', mbid: 'artist-mbid' },
        album: { title: 'The Sound Of Music', year: 1995 },
      }],
    }));
    const provider = new GetSongBpmProvider({
      fetchImpl: fetchImpl as unknown as typeof fetch,
      baseUrl: 'https://getsong.test',
    });

    const results = await provider.lookup(context(), { getSongBpmApiKey: 'private-key' });

    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({
      externalId: 'song-1',
      externalUrl: 'https://getsongbpm.com/song/shining-in-da-darkness/song-1',
      verificationRequired: true,
      identity: {
        artist: 'Nookie',
        title: 'Shining In Da Darkness',
        releaseTitle: 'The Sound Of Music',
      },
      candidate: {
        source: 'getsongbpm',
        sourceBpm: 87,
        canonicalBpm: 174,
        sourceKey: 'Am',
        canonicalKey: { pitchClass: 'A', tonality: 'minor' },
        camelotKey: { number: 8, letter: 'A' },
        nativePitchClass: 9,
        bpmConfidence: 0.65,
        keyConfidence: 0.65,
      },
    });
    const [requestUrl, requestInit] = fetchImpl.mock.calls[0]!;
    const url = new URL(String(requestUrl));
    expect(url.pathname).toBe('/search/');
    expect(url.searchParams.get('type')).toBe('both');
    expect(url.searchParams.get('lookup')).toBe(
      'song:Shining In Da Darkness artist:Nookie',
    );
    expect(url.search).not.toContain('private-key');
    expect(requestInit).toMatchObject({
      headers: expect.objectContaining({ 'X-API-KEY': 'private-key' }),
    });
  });

  it('uses an exact release title as enough extra evidence to reach VERIFY', async () => {
    const identity = {
      artist: 'Nookie',
      title: 'Shining In Da Darkness',
      releaseTitle: 'The Sound Of Music',
    };
    const scored = scoreIdentity(context({ duration: undefined }), identity);

    expect(scored.score).toBeGreaterThanOrEqual(0.55);
    expect(scored.evidence.releaseTitleMatch).toBe(true);
    expect(scored.rationale).toContain('release title matches');
  });

  it('does not make a network request until a key is configured', async () => {
    const fetchImpl = vi.fn(async () => json({ search: [] }));
    const provider = new GetSongBpmProvider({
      fetchImpl: fetchImpl as unknown as typeof fetch,
      baseUrl: 'https://getsong.test',
    });

    expect(provider.configured({})).toBe(false);
    expect(provider.configured({ getSongBpmApiKey: 'key' })).toBe(true);
    await expect(provider.lookup(context())).rejects.toThrow('Add a GetSongBPM API key');
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('reports a rejected credential distinctly and ignores rows with no usable data', async () => {
    const rejected = new GetSongBpmProvider({
      fetchImpl: vi.fn(async () => json({ error: 'Unauthorized' }, 401)) as unknown as typeof fetch,
      baseUrl: 'https://getsong.test',
    });
    await expect(
      rejected.lookup(context(), { getSongBpmApiKey: 'bad-key' }),
    ).rejects.toThrow('rejected the API key');

    const empty = new GetSongBpmProvider({
      fetchImpl: vi.fn(async () => json({
        search: [{
          id: 'song-1',
          title: 'Shining In Da Darkness',
          artist: [{ name: 'Nookie' }],
          album: [{ title: 'The Sound Of Music' }],
        }],
      })) as unknown as typeof fetch,
      baseUrl: 'https://getsong.test',
    });
    await expect(
      empty.lookup(context(), { getSongBpmApiKey: 'key' }),
    ).resolves.toEqual([]);
  });

  it('paces consecutive lookups below the published hourly limit', async () => {
    const fetchImpl = vi.fn(async () => json({ search: [] }));
    const sleepImpl = vi.fn(async (_ms: number, _signal?: AbortSignal) => undefined);
    const provider = new GetSongBpmProvider({
      fetchImpl: fetchImpl as unknown as typeof fetch,
      sleepImpl,
      baseUrl: 'https://getsong.test',
    });

    await provider.lookup(context(), { getSongBpmApiKey: 'key' });
    await provider.lookup(context(), { getSongBpmApiKey: 'key' });

    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(sleepImpl).toHaveBeenCalledOnce();
    expect(sleepImpl.mock.calls[0]?.[0]).toBeGreaterThan(1_000);
  });
});

describe('malformed search envelope', () => {
  /**
   * Regression: GetSongBPM answers a miss with `{"search": {"error": "no
   * result"}}`, not an empty array. The typed cast asserted an array, `?? []`
   * did not fire on a non-nullish object, and the following `.map` threw —
   * which stopped the entire enrichment batch.
   */
  const respondWith = (body: unknown) =>
    new GetSongBpmProvider({
      baseUrl: 'https://example.invalid',
      sleepImpl: async () => undefined,
      fetchImpl: (async () =>
        new Response(JSON.stringify(body), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })) as unknown as typeof fetch,
    });

  it('treats a "no result" error object as no matches, not a failure', async () => {
    const provider = respondWith({ search: { error: 'no result' } });
    await expect(
      provider.lookup(context(), { getSongBpmApiKey: 'k' }),
    ).resolves.toEqual([]);
  });

  it('tolerates any other non-array shape', async () => {
    for (const shape of [{ search: 'nonsense' }, { search: 0 }, { search: {} }, {}]) {
      const provider = respondWith(shape);
      await expect(
        provider.lookup(context(), { getSongBpmApiKey: 'k' }),
      ).resolves.toEqual([]);
    }
  });

  it('still surfaces a genuine service error message', async () => {
    const provider = respondWith({ search: { error: 'api key exceeded' } });
    await expect(
      provider.lookup(context(), { getSongBpmApiKey: 'k' }),
    ).rejects.toThrow(/api key exceeded/i);
  });
});
