import { describe, expect, it } from 'vitest';
import { analyseCoverage, type BagTrack } from '@/bags/coverage';
import { parseCamelot } from '@/harmonic/camelot';
import type { Release, Track, TrackAnalysis, PlayState } from '@/domain/types';

/** Test-data builders. Only the fields coverage actually reads are populated. */

let seq = 0;

function release(id: string, styles: string[] = ['Drum n Bass'], genres = ['Electronic']): Release {
  return {
    id,
    createdAt: '', updatedAt: '', version: 1,
    discogsReleaseId: seq++,
    artist: 'A', artistSort: 'a', title: 'T',
    formats: [], genres, styles, identifiers: [], artwork: [], trackIds: [], references: [],
    hydrationState: 'hydrated',
  };
}

function entry(
  opts: { release: Release; bpm?: number; key?: string; verified?: boolean; playState?: PlayState },
): BagTrack {
  seq += 1;
  const track: Track = {
    id: `trk_${seq}`,
    createdAt: '', updatedAt: '', version: 1,
    releaseId: opts.release.id,
    position: 'A', artist: 'A', title: `Track ${seq}`, sequence: seq,
  };

  const camelot = opts.key ? parseCamelot(opts.key)! : undefined;
  const hasAny = opts.bpm !== undefined || camelot !== undefined;

  const analysis: TrackAnalysis | undefined = hasAny
    ? {
        id: `ana_${seq}`, createdAt: '', updatedAt: '', version: 1,
        trackId: track.id,
        canonicalBpm: opts.bpm,
        camelotKey: camelot,
        verifiedBpm: Boolean(opts.verified && opts.bpm !== undefined),
        verifiedKey: Boolean(opts.verified && camelot !== undefined),
        candidates: [],
        state: opts.verified ? 'READY' : 'VERIFY',
      }
    : undefined;

  return { track, release: opts.release, analysis, playState: opts.playState };
}

describe('bag coverage — counts', () => {
  it('reports an empty bag rather than dividing by zero', () => {
    const coverage = analyseCoverage([]);
    expect(coverage.tracks).toBe(0);
    expect(coverage.records).toBe(0);
    expect(coverage.bpm).toBeNull();
    expect(coverage.gaps.map((g) => g.kind)).toEqual(['empty']);
  });

  it('counts distinct records, not tracks', () => {
    const r1 = release('rel_1');
    const r2 = release('rel_2');
    const coverage = analyseCoverage([
      entry({ release: r1, bpm: 174 }),
      entry({ release: r1, bpm: 175 }),
      entry({ release: r2, bpm: 173 }),
    ]);
    expect(coverage.records).toBe(2);
    expect(coverage.tracks).toBe(3);
  });

  it('separates analysed, verified and needs-analysis', () => {
    const r = release('rel_1');
    const coverage = analyseCoverage([
      entry({ release: r, bpm: 174, key: '8A', verified: true }),
      entry({ release: r, bpm: 172 }),
      entry({ release: r }), // nothing known
    ]);
    expect(coverage.analysed).toBe(2);
    expect(coverage.verified).toBe(1);
    expect(coverage.needsAnalysis).toBe(1);
    expect(coverage.withBpm).toBe(2);
    expect(coverage.withKey).toBe(1);
  });

  it('treats a missing analysis row as ANALYSE', () => {
    const coverage = analyseCoverage([entry({ release: release('rel_1') })]);
    expect(coverage.states.ANALYSE).toBe(1);
  });

  it('defaults play state to packed', () => {
    const r = release('rel_1');
    const coverage = analyseCoverage([
      entry({ release: r, bpm: 174 }),
      entry({ release: r, bpm: 174, playState: 'played' }),
      entry({ release: r, bpm: 174, playState: 'favourite' }),
    ]);
    expect(coverage.playState.packed).toBe(1);
    expect(coverage.playState.played).toBe(1);
    expect(coverage.playState.favourite).toBe(1);
  });
});

describe('bag coverage — BPM distribution', () => {
  it('reports range and median', () => {
    const r = release('rel_1');
    const coverage = analyseCoverage([
      entry({ release: r, bpm: 170 }),
      entry({ release: r, bpm: 174 }),
      entry({ release: r, bpm: 178 }),
    ]);
    expect(coverage.bpm?.min).toBe(170);
    expect(coverage.bpm?.max).toBe(178);
    expect(coverage.bpm?.median).toBe(174);
  });

  it('includes the fastest track in a bucket', () => {
    // The top of the range must not fall out of the final bucket.
    const r = release('rel_1');
    const coverage = analyseCoverage([
      entry({ release: r, bpm: 170 }),
      entry({ release: r, bpm: 175 }),
    ]);
    const total = coverage.bpm!.buckets.reduce((sum, b) => sum + b.count, 0);
    expect(total).toBe(2);
  });

  it('ignores tracks with no BPM when computing the range', () => {
    const r = release('rel_1');
    const coverage = analyseCoverage([
      entry({ release: r, bpm: 174 }),
      entry({ release: r, key: '8A' }),
    ]);
    expect(coverage.bpm?.min).toBe(174);
    expect(coverage.bpm?.max).toBe(174);
  });
});

describe('bag coverage — Camelot', () => {
  it('always returns all 24 wheel positions', () => {
    const coverage = analyseCoverage([entry({ release: release('rel_1'), key: '8A' })]);
    expect(coverage.camelot).toHaveLength(24);
    expect(coverage.camelotCovered).toBe(1);
  });

  it('counts multiple tracks in the same key', () => {
    const r = release('rel_1');
    const coverage = analyseCoverage([
      entry({ release: r, key: '8A' }),
      entry({ release: r, key: '8A' }),
      entry({ release: r, key: '9A' }),
    ]);
    const slot = (label: string) =>
      coverage.camelot.find(
        (s) => s.key.number === parseCamelot(label)!.number && s.key.letter === parseCamelot(label)!.letter,
      )!;
    expect(slot('8A').count).toBe(2);
    expect(slot('9A').count).toBe(1);
    expect(slot('3B').count).toBe(0);
    expect(coverage.camelotCovered).toBe(2);
  });
});

describe('bag coverage — style distribution', () => {
  it('tallies styles across the bag, most common first', () => {
    const coverage = analyseCoverage([
      entry({ release: release('rel_1', ['Dubstep']), bpm: 140 }),
      entry({ release: release('rel_2', ['Dubstep']), bpm: 140 }),
      entry({ release: release('rel_3', ['UK Garage']), bpm: 138 }),
    ]);
    expect(coverage.styles[0]).toEqual({ name: 'Dubstep', count: 2 });
    expect(coverage.styles[1]).toEqual({ name: 'UK Garage', count: 1 });
  });
});

describe('bag coverage — gap detection (spec §19)', () => {
  it('flags unknown keys with a count', () => {
    const r = release('rel_1');
    const coverage = analyseCoverage([
      entry({ release: r, bpm: 174, key: '8A' }),
      entry({ release: r, bpm: 174 }),
      entry({ release: r, bpm: 174 }),
    ]);
    const gap = coverage.gaps.find((g) => g.kind === 'unknown-key');
    expect(gap?.message).toBe('2 of 3 tracks have unknown key');
  });

  it('flags unknown BPMs with a count', () => {
    const r = release('rel_1');
    const coverage = analyseCoverage([
      entry({ release: r, key: '8A' }),
      entry({ release: r, bpm: 174, key: '9A' }),
    ]);
    expect(coverage.gaps.find((g) => g.kind === 'unknown-bpm')?.message).toBe(
      '1 of 2 tracks have unknown BPM',
    );
  });

  it('finds a tempo hole inside the packed range', () => {
    // Garage around 138 and D&B around 174, nothing between.
    const r = release('rel_1');
    const coverage = analyseCoverage([
      entry({ release: r, bpm: 138, key: '8A' }),
      entry({ release: r, bpm: 140, key: '9A' }),
      entry({ release: r, bpm: 172, key: '8A' }),
      entry({ release: r, bpm: 174, key: '9A' }),
    ]);
    const gap = coverage.gaps.find((g) => g.kind === 'bpm-gap');
    expect(gap).toBeDefined();
    expect(gap!.message).toMatch(/Few tracks between 1\d\d-1\d\d BPM/);
  });

  it('does not invent a tempo hole at the edges of the range', () => {
    // A tight cluster has no interior gap, only boundaries.
    const r = release('rel_1');
    const coverage = analyseCoverage([
      entry({ release: r, bpm: 172, key: '8A' }),
      entry({ release: r, bpm: 174, key: '9A' }),
      entry({ release: r, bpm: 176, key: '7A' }),
    ]);
    expect(coverage.gaps.find((g) => g.kind === 'bpm-gap')).toBeUndefined();
  });

  it('flags a key with nowhere harmonic to go', () => {
    const r = release('rel_1');
    // 8A and 2A are unrelated, so both are dead ends.
    const coverage = analyseCoverage([
      entry({ release: r, bpm: 174, key: '8A' }),
      entry({ release: r, bpm: 174, key: '2A' }),
    ]);
    const deadEnds = coverage.gaps.filter((g) => g.kind === 'key-dead-end');
    expect(deadEnds).toHaveLength(2);
    expect(deadEnds[0]!.message).toMatch(/No strong \d+[AB] to \d+[AB] options/);
  });

  it('does not flag a dead end when a compatible key is packed', () => {
    const r = release('rel_1');
    const coverage = analyseCoverage([
      entry({ release: r, bpm: 174, key: '8A' }),
      entry({ release: r, bpm: 174, key: '9A' }), // +1, compatible
    ]);
    expect(coverage.gaps.filter((g) => g.kind === 'key-dead-end')).toHaveLength(0);
  });

  it('flags a bag that is mostly unanalysed', () => {
    const r = release('rel_1');
    const coverage = analyseCoverage([
      entry({ release: r, bpm: 174, key: '8A' }),
      entry({ release: r }),
      entry({ release: r }),
      entry({ release: r }),
    ]);
    expect(coverage.gaps.find((g) => g.kind === 'thin-analysis')?.message).toBe(
      'Only 1 of 4 tracks have any BPM or key yet',
    );
  });

  it('sorts the most actionable gaps first', () => {
    const r = release('rel_1');
    const coverage = analyseCoverage([
      entry({ release: r, bpm: 174, key: '8A' }),
      entry({ release: r }),
      entry({ release: r }),
    ]);
    const severities = coverage.gaps.map((g) => g.severity);
    expect(severities).toEqual([...severities].sort((a, b) => a - b));
  });

  it('reports no gaps for a well-packed bag', () => {
    const r = release('rel_1');
    const coverage = analyseCoverage([
      entry({ release: r, bpm: 172, key: '8A', verified: true }),
      entry({ release: r, bpm: 174, key: '9A', verified: true }),
      entry({ release: r, bpm: 175, key: '8B', verified: true }),
      entry({ release: r, bpm: 176, key: '7A', verified: true }),
    ]);
    expect(coverage.gaps).toEqual([]);
  });
});
