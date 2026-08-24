import { describe, expect, it, vi } from 'vitest';
import type { AnalysisCandidate, DataSource, Recording, Release, Track } from '@/domain/types';
import { scoreIdentity } from '@/enrichment/matching';
import { applyResolution, candidateConflicts, mergeCandidates, resolveMatches } from '@/enrichment/resolution';
import { attemptsForRun, runEnrichment } from '@/enrichment/runner';
import type {
  EnrichmentProvider,
  MatchContext,
  MatchEvidence,
  ProviderMatch,
  ProviderResult,
} from '@/enrichment/provider';

const timestamp = '2026-08-24T10:00:00.000Z';

function context(
  overrides: Partial<Track> = {},
  recordingOverrides?: Partial<Recording>,
): MatchContext {
  const track: Track = {
    id: 'track-1',
    createdAt: timestamp,
    updatedAt: timestamp,
    version: 1,
    releaseId: 'release-1',
    position: 'A1',
    artist: 'Artful Dodger',
    title: 'Re-Rewind The Crowd Say Bo Selecta',
    mixVersion: 'Bump N Flex Sweet N Low Mix',
    duration: 361,
    sequence: 0,
    ...overrides,
  };
  const release: Release = {
    id: 'release-1',
    createdAt: timestamp,
    updatedAt: timestamp,
    version: 1,
    discogsReleaseId: 22987,
    artist: 'Artful Dodger',
    artistSort: 'artful dodger',
    title: 'Re-Rewind',
    label: 'Public Demand',
    catalogueNumber: 'FESX 46',
    formats: [],
    genres: ['Electronic'],
    styles: ['UK Garage'],
    identifiers: [],
    artwork: [],
    trackIds: [track.id],
    references: [],
    hydrationState: 'hydrated',
  };
  const recording = recordingOverrides
    ? {
        id: track.recordingId ?? 'recording-1',
        createdAt: timestamp,
        updatedAt: timestamp,
        version: 1,
        canonicalArtist: track.artist,
        canonicalTitle: track.title,
        ...recordingOverrides,
      }
    : undefined;
  return { track, release, recording, siblings: [track] };
}

function candidate(
  source: DataSource,
  values: Partial<AnalysisCandidate> = {},
): AnalysisCandidate {
  return {
    source,
    confidence: 0.9,
    observedAt: timestamp,
    ...values,
  };
}

const exactEvidence: MatchEvidence = {
  artistExact: true,
  titleExact: true,
  versionExact: true,
  versionCompared: true,
  durationDelta: 2,
  catalogueMatch: true,
};

function match(
  source: DataSource,
  score: number,
  values: Partial<AnalysisCandidate>,
  evidence: MatchEvidence = exactEvidence,
): ProviderMatch {
  return {
    providerId: source,
    providerName: source,
    score,
    evidence,
    identity: {
      artist: 'Artful Dodger',
      title: 'Re-Rewind The Crowd Say Bo Selecta',
      version: 'Bump N Flex Sweet N Low Mix',
      duration: 359,
    },
    candidate: candidate(source, values),
    rationale: 'test evidence',
  };
}

function provider(
  id: string,
  results: ProviderResult[] | Error,
  available = true,
): EnrichmentProvider {
  return {
    id,
    name: id,
    available,
    supplies: { bpm: true, key: true },
    async lookup() {
      if (results instanceof Error) throw results;
      return results;
    },
  };
}

describe('provider identity matching', () => {
  it('does not treat artist and title alone as a reliable match', () => {
    const result = scoreIdentity(context({ mixVersion: undefined, duration: undefined }), {
      artist: 'Artful Dodger',
      title: 'Re-Rewind The Crowd Say Bo Selecta',
    });

    expect(result.score).toBeLessThan(0.55);
    expect(result.rationale).toContain('version not supplied');
  });

  it('scores exact version, duration and pressing evidence highly', () => {
    const result = scoreIdentity(context(), {
      artist: 'Artful Dodger',
      title: 'Re-Rewind The Crowd Say Bo Selecta',
      version: 'Bump N Flex Sweet N Low Mix',
      duration: 359,
      label: 'Public Demand',
      catalogueNumber: 'FESX-46',
      discogsReleaseId: 22987,
    });

    expect(result.score).toBeGreaterThanOrEqual(0.82);
    expect(result.evidence).toMatchObject({
      artistExact: true,
      titleExact: true,
      versionExact: true,
      catalogueMatch: true,
      releaseMatch: true,
    });
  });

  it('penalises a digital edit with the same artist and title', () => {
    const result = scoreIdentity(context(), {
      artist: 'Artful Dodger',
      title: 'Re-Rewind The Crowd Say Bo Selecta',
      version: 'Radio Edit',
      duration: 218,
      label: 'Public Demand',
      catalogueNumber: 'DIGITAL-2026',
    });

    expect(result.score).toBeLessThan(0.3);
    expect(result.evidence.versionExact).toBe(false);
    expect(result.rationale).toContain('version differs');
  });

  it('normalises punctuation, accents and catalogue formatting', () => {
    const result = scoreIdentity(context({ artist: 'Café Mambo', mixVersion: 'Original Mix' }), {
      artist: 'Cafe-Mambo',
      title: 'Re Rewind: The Crowd Say Bo Selecta',
      version: 'Original Mix',
      catalogueNumber: 'FESX46',
    });

    expect(result.evidence.artistExact).toBe(true);
    expect(result.evidence.titleExact).toBe(true);
    expect(result.evidence.catalogueMatch).toBe(true);
  });

  it('treats a mismatching ISRC as decisive negative evidence', () => {
    const result = scoreIdentity(context({ recordingId: 'recording-1' }, { isrc: 'GB-ABC-99-00001' }), {
      artist: 'Artful Dodger',
      title: 'Re-Rewind The Crowd Say Bo Selecta',
      version: 'Bump N Flex Sweet N Low Mix',
      isrc: 'GB-OTHER-00-12345',
      duration: 361,
    });

    expect(result.evidence.isrcMatch).toBe(false);
    expect(result.score).toBeLessThan(0.4);
  });
});

describe('enrichment resolution', () => {
  it('marks a well-corroborated leading match READY', () => {
    const result = resolveMatches([
      match('beatport', 0.92, { sourceBpm: 87, canonicalBpm: 174 }),
    ]);

    expect(result.state).toBe('READY');
    expect(result.selected?.candidate.canonicalBpm).toBe(174);
    expect(result.candidates[0]?.matchScore).toBe(0.92);
  });

  it('marks a likely but version-uncertain match VERIFY', () => {
    const result = resolveMatches([
      match(
        'traxsource',
        0.7,
        { canonicalBpm: 130 },
        { ...exactEvidence, versionExact: false, versionCompared: true },
      ),
    ]);

    expect(result.state).toBe('VERIFY');
    expect(result.selected).toBeDefined();
  });

  it('keeps public historic audio analysis in VERIFY even with strong identity evidence', () => {
    const result = resolveMatches([
      {
        ...match('acousticbrainz', 0.95, { canonicalBpm: 174 }),
        verificationRequired: true,
      },
    ]);

    expect(result.state).toBe('VERIFY');
    expect(result.selected).toBeDefined();
    expect(result.candidates[0]).toMatchObject({
      providerId: 'acousticbrainz',
      verificationRequired: true,
      matchedArtist: 'Artful Dodger',
      matchedVersion: 'Bump N Flex Sweet N Low Mix',
    });
  });

  it('keeps weak artist/title-only results in ANALYSE', () => {
    const result = resolveMatches([
      match(
        'musicbrainz',
        0.46,
        { canonicalBpm: 174 },
        {
          artistExact: true,
          titleExact: true,
          versionExact: true,
          versionCompared: false,
        },
      ),
    ]);

    expect(result.state).toBe('ANALYSE');
    expect(result.selected).toBeUndefined();
    expect(result.candidates).toHaveLength(1);
  });

  it('reports a BPM disagreement between credible sources as CONFLICT', () => {
    const result = resolveMatches([
      match('beatport', 0.9, { canonicalBpm: 174 }),
      match('traxsource', 0.86, { canonicalBpm: 128 }),
    ]);

    expect(result.state).toBe('CONFLICT');
    expect(result.selected).toBeUndefined();
    expect(result.reason).toContain('disagree');
  });

  it('does not confuse half-time source notation with a canonical BPM conflict', () => {
    const result = resolveMatches([
      match('beatport', 0.9, { sourceBpm: 87, canonicalBpm: 174 }),
      match('traxsource', 0.86, { sourceBpm: 174, canonicalBpm: 174 }),
    ]);

    expect(result.state).toBe('READY');
  });

  it('reports incompatible keys as CONFLICT', () => {
    const result = resolveMatches([
      match('beatport', 0.9, {
        canonicalKey: { pitchClass: 'A', tonality: 'minor' },
        camelotKey: { number: 8, letter: 'A' },
      }),
      match('traxsource', 0.86, {
        canonicalKey: { pitchClass: 'D#', tonality: 'minor' },
        camelotKey: { number: 2, letter: 'A' },
      }),
    ]);

    expect(result.state).toBe('CONFLICT');
  });

  it('ignores provider rows that contain no usable BPM or key', () => {
    const result = resolveMatches([match('musicbrainz', 0.95, {})]);

    expect(result).toMatchObject({ state: 'ANALYSE', candidates: [] });
  });

  it('applies selected values with native fields and separate signal confidence', () => {
    const resolution = resolveMatches([
      match('beatport', 0.92, {
        sourceBpm: 87,
        canonicalBpm: 174,
        sourceKey: 'A minor',
        canonicalKey: { pitchClass: 'A', tonality: 'minor' },
        camelotKey: { number: 8, letter: 'A' },
        bpmConfidence: 0.61,
        keyConfidence: 0.74,
      }),
    ]);

    const applied = applyResolution('track-1', undefined, resolution);

    expect(applied).toMatchObject({
      sourceBpm: 87,
      canonicalBpm: 174,
      nativeBpm: 174,
      bpmSource: 'beatport',
      bpmConfidence: 0.61,
      nativeKey: { pitchClass: 'A', tonality: 'minor' },
      nativeCamelot: { number: 8, letter: 'A' },
      keyConfidence: 0.74,
      state: 'READY',
      analysisMethod: 'external-metadata',
    });
  });

  it('never overwrites a verified BPM but may fill an unverified key', () => {
    const existing = {
      id: 'analysis-1',
      trackId: 'track-1',
      createdAt: timestamp,
      updatedAt: timestamp,
      version: 4,
      sourceBpm: 173.8,
      canonicalBpm: 173.8,
      bpmSource: 'user' as const,
      verifiedBpm: true,
      verifiedKey: false,
      candidates: [],
      state: 'READY' as const,
    };
    const resolution = resolveMatches([
      match('beatport', 0.92, {
        canonicalBpm: 128,
        canonicalKey: { pitchClass: 'A', tonality: 'minor' },
        camelotKey: { number: 8, letter: 'A' },
      }),
    ]);

    const applied = applyResolution('track-1', existing, resolution);

    expect(applied.canonicalBpm).toBe(173.8);
    expect(applied.bpmSource).toBe('user');
    expect(applied.camelotKey).toEqual({ number: 8, letter: 'A' });
    expect(applied.keySource).toBe('beatport');
    expect(applied.version).toBe(5);
  });

  it('does not let a READY BPM candidate bless an unrelated uncertain key', () => {
    const existing = {
      id: 'analysis-1',
      trackId: 'track-1',
      createdAt: timestamp,
      updatedAt: timestamp,
      version: 1,
      canonicalKey: { pitchClass: 'D' as const, tonality: 'minor' as const },
      camelotKey: { number: 7, letter: 'A' as const },
      verifiedBpm: false,
      verifiedKey: false,
      candidates: [],
      state: 'VERIFY' as const,
    };
    const resolution = resolveMatches([
      match('beatport', 0.92, { canonicalBpm: 174 }),
    ]);

    const applied = applyResolution('track-1', existing, resolution);

    expect(applied.canonicalBpm).toBe(174);
    expect(applied.camelotKey).toEqual({ number: 7, letter: 'A' });
    expect(applied.state).toBe('VERIFY');
  });

  it('lets user verification resolve only the conflicting dimension it covers', () => {
    const bpmConflict = resolveMatches([
      match('beatport', 0.9, { canonicalBpm: 174 }),
      match('traxsource', 0.86, { canonicalBpm: 128 }),
    ]);
    const keyConflict = resolveMatches([
      match('beatport', 0.9, {
        canonicalKey: { pitchClass: 'A', tonality: 'minor' },
      }),
      match('traxsource', 0.86, {
        canonicalKey: { pitchClass: 'D#', tonality: 'minor' },
      }),
    ]);
    const verifiedBpm = {
      id: 'analysis-1',
      trackId: 'track-1',
      createdAt: timestamp,
      updatedAt: timestamp,
      version: 1,
      canonicalBpm: 174,
      verifiedBpm: true,
      verifiedKey: false,
      candidates: [],
      state: 'READY' as const,
    };

    expect(applyResolution('track-1', verifiedBpm, bpmConflict).state).toBe('READY');
    expect(applyResolution('track-1', verifiedBpm, keyConflict).state).toBe('CONFLICT');
  });

  it('reconstructs conflict dimensions from stored credible candidates', () => {
    const resolution = resolveMatches([
      match('beatport', 0.9, { canonicalBpm: 174 }),
      match('traxsource', 0.86, { canonicalBpm: 128 }),
    ]);

    expect(candidateConflicts(resolution.candidates)).toEqual({ bpm: true, key: false });
  });

  it('merges evidence from later runs and exposes cross-run conflicts', () => {
    const first = applyResolution('track-1', undefined, resolveMatches([
      { ...match('beatport', 0.9, { canonicalBpm: 130 }), externalId: 'bp-1' },
    ]));
    const second = applyResolution('track-1', first, resolveMatches([
      {
        ...match('acousticbrainz', 0.86, { canonicalBpm: 128 }),
        externalId: 'mbid-1',
        verificationRequired: true,
      },
    ]));

    expect(second.candidates).toHaveLength(2);
    expect(second.state).toBe('CONFLICT');
    expect(second.canonicalBpm).toBe(130);
  });

  it('replaces a refreshed claim for the same provider recording', () => {
    const older = candidate('acousticbrainz', {
      providerId: 'open', externalId: 'mbid-1', canonicalBpm: 172, matchScore: 0.8,
    });
    const newer = candidate('acousticbrainz', {
      providerId: 'open', externalId: 'mbid-1', canonicalBpm: 174, matchScore: 0.9,
    });

    expect(mergeCandidates([older], [newer])).toEqual([newer]);
  });

  it('raises signal confidence when an independent provider agrees', () => {
    const first = applyResolution('track-1', undefined, resolveMatches([
      match('beatport', 0.9, { canonicalBpm: 130, bpmConfidence: 0.6 }),
    ]));
    const second = applyResolution('track-1', first, resolveMatches([
      match('traxsource', 0.88, { canonicalBpm: 130, bpmConfidence: 0.6 }),
    ]));

    expect(first.bpmConfidence).toBe(0.6);
    expect(second.bpmConfidence).toBeCloseTo(0.65);
  });
});

describe('provider runner', () => {
  it('scores identities centrally, skips unavailable adapters and isolates failures', async () => {
    const result: ProviderResult = {
      identity: {
        artist: 'Artful Dodger',
        title: 'Re-Rewind The Crowd Say Bo Selecta',
        version: 'Bump N Flex Sweet N Low Mix',
        duration: 360,
        label: 'Public Demand',
        catalogueNumber: 'FESX46',
        discogsReleaseId: 22987,
      },
      externalId: 'provider-recording-1',
      externalUrl: 'https://provider.test/recording-1',
      candidate: candidate('beatport', { canonicalBpm: 130 }),
    };

    const run = await runEnrichment(context(), [
      provider('working', [result]),
      provider('offline', new Error('service unavailable')),
      provider('disabled', [result], false),
    ]);

    expect(run.consulted).toEqual(['working', 'offline']);
    expect(run.matches).toHaveLength(1);
    expect(run.matches[0]).toMatchObject({
      providerId: 'working',
      providerName: 'working',
      identity: { artist: 'Artful Dodger' },
    });
    expect(run.matches[0]!.score).toBeGreaterThanOrEqual(0.82);
    expect(run.failures).toEqual([
      { providerId: 'offline', providerName: 'offline', message: 'service unavailable' },
    ]);
    expect(run.resolution.state).toBe('READY');
    expect(run.resolution.candidates[0]).toMatchObject({
      providerId: 'working',
      providerName: 'working',
      matchedArtist: 'Artful Dodger',
      matchedTitle: 'Re-Rewind The Crowd Say Bo Selecta',
      externalId: 'provider-recording-1',
      externalUrl: 'https://provider.test/recording-1',
      matchRationale: expect.stringContaining('artist matches'),
    });
    expect(attemptsForRun(run, timestamp)).toEqual([
      { provider: 'working', attemptedAt: timestamp, outcome: 'found' },
      {
        provider: 'offline',
        attemptedAt: timestamp,
        outcome: 'error',
        message: 'service unavailable',
      },
    ]);
  });

  it('cannot promote artist/title-only results because adapters do not control scores', async () => {
    const run = await runEnrichment(context({ mixVersion: undefined, duration: undefined }), [
      provider('metadata', [
        {
          identity: {
            artist: 'Artful Dodger',
            title: 'Re-Rewind The Crowd Say Bo Selecta',
          },
          candidate: candidate('musicbrainz', { canonicalBpm: 174 }),
        },
      ]),
    ]);

    expect(run.matches[0]!.score).toBeLessThan(0.55);
    expect(run.resolution.state).toBe('ANALYSE');
  });

  it('does not consult or checkpoint a provider whose credential is not configured', async () => {
    const lookup = vi.fn(async () => []);
    const gated: EnrichmentProvider = {
      id: 'gated',
      name: 'gated',
      available: true,
      supplies: { bpm: true, key: true },
      configured: (options) => Boolean(options.getSongBpmApiKey),
      lookup,
    };

    const run = await runEnrichment(context(), [gated], {});

    expect(run.consulted).toEqual([]);
    expect(attemptsForRun(run, timestamp)).toEqual([]);
    expect(lookup).not.toHaveBeenCalled();
  });

  it('propagates cancellation instead of recording it as a provider failure', async () => {
    const controller = new AbortController();
    const cancelling: EnrichmentProvider = {
      id: 'cancel',
      name: 'cancel',
      available: true,
      supplies: { bpm: true, key: true },
      async lookup(_context, options) {
        controller.abort();
        options?.signal?.throwIfAborted();
        return [];
      },
    };

    await expect(runEnrichment(context(), [cancelling], { signal: controller.signal })).rejects.toMatchObject({
      name: 'AbortError',
    });
  });
});
