import { describe, expect, it } from 'vitest';
import { buildQueue, queueSummary } from '@/analysis/queue';
import type { BagTrack } from '@/bags/coverage';
import { camelotToMusicalKey, parseCamelot } from '@/harmonic/camelot';
import type { AnalysisState, PlayState, Release, Track, TrackAnalysis } from '@/domain/types';

let seq = 0;

function release(id: string, year?: number, artistSort = 'a'): Release {
  return {
    id, createdAt: '', updatedAt: '', version: 1,
    discogsReleaseId: seq++, artist: 'A', artistSort, title: 'T',
    formats: [], genres: [], styles: [], identifiers: [], artwork: [],
    trackIds: [], references: [], hydrationState: 'hydrated', year,
  };
}

function entry(opts: {
  release: Release;
  bpm?: number;
  key?: string;
  state?: AnalysisState;
  playState?: PlayState;
}): BagTrack {
  seq += 1;
  const track: Track = {
    id: `trk_${seq}`, createdAt: '', updatedAt: '', version: 1,
    releaseId: opts.release.id, position: 'A', artist: 'A', title: `Track ${seq}`, sequence: seq,
  };
  const camelot = opts.key ? parseCamelot(opts.key)! : undefined;
  const analysis: TrackAnalysis = {
    id: `ana_${seq}`, createdAt: '', updatedAt: '', version: 1,
    trackId: track.id,
    canonicalBpm: opts.bpm,
    camelotKey: camelot,
    canonicalKey: camelot ? camelotToMusicalKey(camelot) ?? undefined : undefined,
    verifiedBpm: false, verifiedKey: false, candidates: [],
    state: opts.state ?? 'ANALYSE',
  };
  return { track, release: opts.release, analysis, playState: opts.playState };
}

describe('analysis queue (spec §32)', () => {
  it('excludes tracks that already have both values', () => {
    const r = release('r1');
    const queue = buildQueue([
      entry({ release: r, bpm: 174, key: '8A', state: 'READY' }),
      entry({ release: r }),
    ]);
    expect(queue).toHaveLength(1);
  });

  it('keeps a CONFLICT even when both values are present', () => {
    // Disagreeing sources are worse than missing ones: the number on screen
    // is actively wrong rather than merely absent.
    const r = release('r1');
    const queue = buildQueue([entry({ release: r, bpm: 174, key: '8A', state: 'CONFLICT' })]);
    expect(queue).toHaveLength(1);
    expect(queue[0]!.reasons).toContain('sources disagree');
  });

  it('puts active-bag tracks first', () => {
    const home = release('home');
    const packed = release('packed');
    const inBag = entry({ release: packed });
    const atHome = entry({ release: home });

    const queue = buildQueue([atHome, inBag], {
      activeBagTrackIds: new Set([inBag.track.id]),
    });
    expect(queue[0]!.entry.track.id).toBe(inBag.track.id);
    expect(queue[0]!.reasons).toContain('in your active bag');
  });

  it('ranks a record with several gaps above one with a single gap', () => {
    // Worth more per trip to the shelf. Spec §32.
    const many = release('many');
    const one = release('one');
    const queue = buildQueue([
      entry({ release: one }),
      entry({ release: many }),
      entry({ release: many }),
      entry({ release: many }),
    ]);
    expect(queue[0]!.entry.release.id).toBe('many');
    expect(queue[0]!.siblingGaps).toBe(2);
    expect(queue[0]!.reasons.some((r) => r.includes('3 tracks on this record'))).toBe(true);
  });

  it('keeps a release together so it is only pulled out once', () => {
    const a = release('a', undefined, 'aaa');
    const b = release('b', undefined, 'bbb');
    const queue = buildQueue([
      entry({ release: a }), entry({ release: b }),
      entry({ release: a }), entry({ release: b }),
    ]);
    const ids = queue.map((item) => item.entry.release.id);
    // No interleaving: aa then bb, or bb then aa.
    expect(ids.join('')).toMatch(/^(aabb|bbaa)$/);
  });

  it('boosts a favourite', () => {
    const r = release('r1');
    const plain = entry({ release: r });
    const fave = entry({ release: r, playState: 'favourite' });
    const queue = buildQueue([plain, fave]);
    expect(queue[0]!.entry.track.id).toBe(fave.track.id);
  });

  it('filters by what is missing', () => {
    const r = release('r1');
    const noBpm = entry({ release: r, key: '8A' });
    const noKey = entry({ release: r, bpm: 174 });
    const neither = entry({ release: r });
    const all = [noBpm, noKey, neither];

    expect(buildQueue(all, { filter: 'bpm-missing' }).map((i) => i.entry.track.id).sort())
      .toEqual([noBpm.track.id, neither.track.id].sort());
    expect(buildQueue(all, { filter: 'key-missing' }).map((i) => i.entry.track.id).sort())
      .toEqual([noKey.track.id, neither.track.id].sort());
    expect(buildQueue(all, { filter: 'both-missing' }).map((i) => i.entry.track.id))
      .toEqual([neither.track.id]);
  });

  it('filters to conflicts only', () => {
    const r = release('r1');
    const queue = buildQueue(
      [entry({ release: r }), entry({ release: r, bpm: 174, key: '8A', state: 'CONFLICT' })],
      { filter: 'conflict' },
    );
    expect(queue).toHaveLength(1);
    expect(queue[0]!.state).toBe('CONFLICT');
  });

  it('sorts by release age when asked', () => {
    const old = release('old', 1997);
    const recent = release('recent', 2019);
    const queue = buildQueue([entry({ release: recent }), entry({ release: old })], {
      sort: 'oldest',
    });
    expect(queue[0]!.entry.release.year).toBe(1997);
    expect(buildQueue([entry({ release: old }), entry({ release: recent })], { sort: 'newest' })[0]!
      .entry.release.year).toBe(2019);
  });

  it('honours a limit', () => {
    const r = release('r1');
    const many = Array.from({ length: 10 }, () => entry({ release: r }));
    expect(buildQueue(many, { limit: 3 })).toHaveLength(3);
  });

  it('copes with an empty library', () => {
    expect(buildQueue([])).toEqual([]);
  });
});

describe('queue summary', () => {
  it('counts what is outstanding', () => {
    const r = release('r1');
    const summary = queueSummary([
      entry({ release: r, bpm: 174, key: '8A', state: 'READY' }),
      entry({ release: r, bpm: 174 }),
      entry({ release: r, key: '8A' }),
      entry({ release: r }),
      entry({ release: r, bpm: 174, key: '8A', state: 'CONFLICT' }),
    ]);
    expect(summary.total).toBe(5);
    expect(summary.ready).toBe(1);
    expect(summary.needsKey).toBe(2);   // bpm-only, and the empty one
    expect(summary.needsBpm).toBe(2);   // key-only, and the empty one
    expect(summary.needsBoth).toBe(1);
    expect(summary.conflict).toBe(1);
  });
});
