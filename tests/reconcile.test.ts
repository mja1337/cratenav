import { describe, expect, it } from 'vitest';
import { hasMeaningfulAnalysis, planReconciliation } from '@/data/track-reconcile';
import type { Track, TrackAnalysis } from '@/domain/types';

/**
 * These guard spec §24: a metadata refresh must be able to take Discogs'
 * improved catalogue data WITHOUT detaching the BPM/key work already done.
 * Analysis is keyed by track id, so preserving ids is the whole ballgame.
 */

let counter = 0;
function track(position: string, title: string, overrides: Partial<Track> = {}): Track {
  counter += 1;
  return {
    id: `trk_${counter}`,
    createdAt: '2020-01-01T00:00:00.000Z',
    updatedAt: '2020-01-01T00:00:00.000Z',
    version: 1,
    releaseId: 'rel_1',
    position,
    artist: 'Die & Break',
    title,
    sequence: counter,
    ...overrides,
  };
}

function analysis(trackId: string, overrides: Partial<TrackAnalysis> = {}): TrackAnalysis {
  return {
    id: `ana_${trackId}`,
    createdAt: '2020-01-01T00:00:00.000Z',
    updatedAt: '2020-01-01T00:00:00.000Z',
    version: 1,
    trackId,
    verifiedBpm: false,
    verifiedKey: false,
    candidates: [],
    state: 'ANALYSE',
    ...overrides,
  };
}

const noAnalysis = () => undefined;

describe('hasMeaningfulAnalysis', () => {
  it('treats a bare placeholder row as empty', () => {
    // Every track gets one of these at import time. If these counted as
    // analysis, nothing would ever be removable.
    expect(hasMeaningfulAnalysis(analysis('trk_1'))).toBe(false);
    expect(hasMeaningfulAnalysis(undefined)).toBe(false);
  });

  it('recognises every kind of real content', () => {
    const cases: Partial<TrackAnalysis>[] = [
      { canonicalBpm: 174 },
      { sourceBpm: 87 },
      { camelotKey: { number: 8, letter: 'A' } },
      { canonicalKey: { pitchClass: 'A', tonality: 'minor' } },
      { verifiedBpm: true },
      { verifiedKey: true },
      { energy: 7 },
      { tags: ['roller'] },
      { mixNotes: 'mix out before the vocal' },
      {
        candidates: [
          { source: 'musicbrainz', confidence: 0.8, observedAt: '2020-01-01T00:00:00.000Z' },
        ],
      },
    ];
    for (const overrides of cases) {
      expect(
        hasMeaningfulAnalysis(analysis('trk_1', overrides)),
        `should be meaningful: ${JSON.stringify(overrides)}`,
      ).toBe(true);
    }
  });
});

describe('track reconciliation', () => {
  it('preserves track ids when positions still match', () => {
    const existing = [track('A', 'Grand Funk Hustle'), track('AA', 'Tear Down')];
    const incoming = [
      track('A', 'Grand Funk Hustle (Remastered)'),
      track('AA', 'Tear Down'),
    ];

    const plan = planReconciliation(existing, incoming, noAnalysis);

    expect(plan.preserved).toBe(2);
    expect(plan.resolved.map((t) => t.id)).toEqual([existing[0]!.id, existing[1]!.id]);
    // Fresh catalogue data still came through.
    expect(plan.resolved[0]!.title).toBe('Grand Funk Hustle (Remastered)');
    expect(plan.removable).toHaveLength(0);
  });

  it('bumps version and keeps the original creation time', () => {
    const existing = [track('A', 'Tune', { version: 4, createdAt: '2019-05-05T00:00:00.000Z' })];
    const incoming = [track('A', 'Tune')];

    const plan = planReconciliation(existing, incoming, noAnalysis);

    expect(plan.resolved[0]!.version).toBe(5);
    expect(plan.resolved[0]!.createdAt).toBe('2019-05-05T00:00:00.000Z');
  });

  it('falls back to title matching when a position changes', () => {
    // Discogs corrected "A" to "A1" but it is the same track.
    const existing = [track('A', 'Deep Search')];
    const incoming = [track('A1', 'Deep Search')];

    const plan = planReconciliation(existing, incoming, noAnalysis);

    expect(plan.preserved).toBe(1);
    expect(plan.resolved[0]!.id).toBe(existing[0]!.id);
    expect(plan.resolved[0]!.position).toBe('A1');
  });

  it('matches positions case- and whitespace-insensitively', () => {
    const existing = [track(' aa ', 'Tune')];
    const incoming = [track('AA', 'Renamed Entirely')];

    const plan = planReconciliation(existing, incoming, noAnalysis);
    expect(plan.preserved).toBe(1);
  });

  it('never matches one existing track to two incoming tracks', () => {
    // Three mixes share a title, so title matching must not reuse a row.
    const existing = [track('A1', 'Re-Rewind')];
    const incoming = [track('A1', 'Re-Rewind'), track('A2', 'Re-Rewind'), track('B', 'Re-Rewind')];

    const plan = planReconciliation(existing, incoming, noAnalysis);

    expect(plan.preserved).toBe(1);
    const ids = plan.resolved.map((t) => t.id);
    expect(new Set(ids).size).toBe(3);
  });

  it('retains a vanished track that carries real analysis', () => {
    const kept = track('B', 'Bonus Beats');
    const existing = [track('A', 'Main'), kept];
    const incoming = [track('A', 'Main')];

    const plan = planReconciliation(existing, incoming, (id) =>
      id === kept.id ? analysis(id, { canonicalBpm: 174, verifiedBpm: true }) : undefined,
    );

    // Analysis must survive even though Discogs dropped the track. Spec §5.
    expect(plan.removable).toHaveLength(0);
    expect(plan.retained.map((t) => t.id)).toEqual([kept.id]);
  });

  it('removes a vanished track that carries nothing', () => {
    const junk = track('B', 'Untitled');
    const existing = [track('A', 'Main'), junk];
    const incoming = [track('A', 'Main')];

    // A placeholder row exists, as it does for every imported track.
    const plan = planReconciliation(existing, incoming, (id) => analysis(id));

    expect(plan.removable.map((t) => t.id)).toEqual([junk.id]);
    expect(plan.retained).toHaveLength(0);
  });

  it('adds genuinely new tracks with their own ids', () => {
    const existing = [track('A', 'Main')];
    const incoming = [track('A', 'Main'), track('AA', 'Newly Documented Side')];

    const plan = planReconciliation(existing, incoming, noAnalysis);

    expect(plan.preserved).toBe(1);
    expect(plan.resolved).toHaveLength(2);
    expect(plan.resolved[1]!.id).not.toBe(existing[0]!.id);
  });

  it('handles a first-time import with nothing existing', () => {
    const incoming = [track('A', 'One'), track('AA', 'Two')];
    const plan = planReconciliation([], incoming, noAnalysis);

    expect(plan.preserved).toBe(0);
    expect(plan.resolved).toEqual(incoming);
    expect(plan.removable).toHaveLength(0);
  });

  it('retains everything when Discogs returns an empty tracklist', () => {
    // A bad upstream response must not wipe analysed tracks.
    const existing = [track('A', 'One'), track('AA', 'Two')];
    const plan = planReconciliation(existing, [], (id) => analysis(id, { canonicalBpm: 140 }));

    expect(plan.resolved).toHaveLength(0);
    expect(plan.retained).toHaveLength(2);
    expect(plan.removable).toHaveLength(0);
  });
});
