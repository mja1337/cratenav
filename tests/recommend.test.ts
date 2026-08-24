import { describe, expect, it } from 'vitest';
import { findBridge, recommend } from '@/recommend/engine';
import { findDeckProfile } from '@/pitch/deck';
import type { BagTrack } from '@/bags/coverage';
import { camelotToMusicalKey, parseCamelot } from '@/harmonic/camelot';
import type { PlayState, Release, Track, TrackAnalysis } from '@/domain/types';

let seq = 0;

const release: Release = {
  id: 'rel_1',
  createdAt: '', updatedAt: '', version: 1,
  discogsReleaseId: 1,
  artist: 'A', artistSort: 'a', title: 'T',
  formats: [], genres: [], styles: ['Drum n Bass'],
  identifiers: [], artwork: [], trackIds: [], references: [],
  hydrationState: 'hydrated',
};

function candidate(
  title: string,
  opts: { bpm?: number; key?: string; playState?: PlayState; energy?: number } = {},
): BagTrack {
  seq += 1;
  const track: Track = {
    id: `trk_${seq}`,
    createdAt: '', updatedAt: '', version: 1,
    releaseId: release.id, position: 'A', artist: 'A', title, sequence: seq,
  };
  const camelot = opts.key ? parseCamelot(opts.key)! : undefined;
  const analysis: TrackAnalysis = {
    id: `ana_${seq}`, createdAt: '', updatedAt: '', version: 1,
    trackId: track.id,
    canonicalBpm: opts.bpm,
    camelotKey: camelot,
    // The app writes both representations, so the fixture does too.
    canonicalKey: camelot ? camelotToMusicalKey(camelot) ?? undefined : undefined,
    energy: opts.energy,
    verifiedBpm: false, verifiedKey: false, candidates: [], state: 'VERIFY',
  };
  return { track, release, analysis, playState: opts.playState };
}

const now = { bpm: 174, camelot: parseCamelot('8A')! };

describe('recommendation ranking', () => {
  it('puts a same-key, same-tempo track first', () => {
    const perfect = candidate('Perfect', { bpm: 174, key: '8A' });
    const results = recommend(now, [
      candidate('Distant', { bpm: 178, key: '7A' }),
      perfect,
      candidate('Relative', { bpm: 175, key: '8B' }),
    ]);
    expect(results[0]!.entry.track.id).toBe(perfect.track.id);
    expect(results[0]!.matchPercent).toBe(100);
  });

  it('produces the kind of ranking spec §17 shows', () => {
    const results = recommend(now, [
      candidate('Track A', { bpm: 174, key: '8A' }),
      candidate('Track B', { bpm: 172, key: '9A' }),
      candidate('Track C', { bpm: 176, key: '7A' }),
    ]);
    expect(results.map((r) => r.entry.track.title)).toEqual(['Track A', 'Track B', 'Track C']);
    // Descending, and all plausible suggestions.
    const percents = results.map((r) => r.matchPercent);
    expect(percents).toEqual([...percents].sort((a, b) => b - a));
    expect(percents.every((p) => p > 50)).toBe(true);
  });

  it('excludes a harmonic clash outright', () => {
    // 2A against 8A is not a mix, so it should not be offered at all.
    const results = recommend(now, [candidate('Clash', { bpm: 174, key: '2A' })]);
    expect(results).toHaveLength(0);
  });

  it('excludes a tempo that is too far away', () => {
    const results = recommend(now, [candidate('Way off', { bpm: 128, key: '8A' })]);
    expect(results).toHaveLength(0);
  });

  it('reports the pitch adjustment and key relationship as reasons', () => {
    const results = recommend(now, [candidate('Next', { bpm: 176, key: '9A' })]);
    expect(results[0]!.reasons).toContain('+1 Camelot');
    expect(results[0]!.reasons.some((r) => r.includes('%'))).toBe(true);
  });

  it('honours the limit', () => {
    const many = Array.from({ length: 20 }, (_, i) => candidate(`T${i}`, { bpm: 174, key: '8A' }));
    expect(recommend(now, many, { limit: 3 })).toHaveLength(3);
  });
});

describe('play status (spec §22)', () => {
  it('deprioritises a played track without hiding it', () => {
    const fresh = candidate('Fresh', { bpm: 175, key: '9A' });
    const played = candidate('Played', { bpm: 174, key: '8A', playState: 'played' });

    const results = recommend(now, [played, fresh]);
    expect(results.map((r) => r.entry.track.title)).toEqual(['Fresh', 'Played']);
    expect(results.find((r) => r.entry.track.title === 'Played')!.reasons).toContain(
      'already played',
    );
  });

  it('drops played tracks entirely when repeats are off', () => {
    const results = recommend(
      now,
      [candidate('Played', { bpm: 174, key: '8A', playState: 'played' })],
      { excludePlayed: true },
    );
    expect(results).toHaveLength(0);
  });

  it('never suggests a track put aside', () => {
    const results = recommend(now, [
      candidate('Aside', { bpm: 174, key: '8A', playState: 'put-aside' }),
    ]);
    expect(results).toHaveLength(0);
  });

  it('nudges a favourite upward', () => {
    const plain = candidate('Plain', { bpm: 174, key: '8A' });
    const fave = candidate('Fave', { bpm: 174, key: '8A', playState: 'favourite' });
    const results = recommend(now, [plain, fave]);
    expect(results[0]!.entry.track.title).toBe('Fave');
  });

  it('excludes tracks the caller has already used', () => {
    const used = candidate('Used', { bpm: 174, key: '8A' });
    const other = candidate('Other', { bpm: 174, key: '8A' });
    const results = recommend(now, [used, other], { excludeTrackIds: [used.track.id] });
    expect(results.map((r) => r.entry.track.id)).toEqual([other.track.id]);
  });
});

describe('scope (spec §39)', () => {
  it('only ever ranks the candidates it is given', () => {
    // The engine must not reach past the pool: a record at home is not an option.
    const inBag = candidate('In bag', { bpm: 174, key: '8A' });
    const results = recommend(now, [inBag]);
    expect(results).toHaveLength(1);
    expect(results[0]!.entry.track.id).toBe(inBag.track.id);
  });

  it('returns nothing for an empty pool rather than throwing', () => {
    expect(recommend(now, [])).toEqual([]);
  });
});

describe('missing data', () => {
  it('skips candidates with neither BPM nor key by default', () => {
    expect(recommend(now, [candidate('Unknown')])).toHaveLength(0);
  });

  it('ranks on tempo alone when the candidate key is unknown', () => {
    const results = recommend(now, [candidate('No key', { bpm: 174 })]);
    expect(results).toHaveLength(1);
    expect(results[0]!.reasons).toContain('key unknown, ranked on tempo alone');
    // A tempo-only match must not be penalised into uselessness.
    expect(results[0]!.matchPercent).toBe(100);
  });

  it('ranks on key alone when the candidate BPM is unknown', () => {
    const results = recommend(now, [candidate('No bpm', { key: '8A' })]);
    expect(results[0]!.reasons).toContain('BPM unknown, ranked on key alone');
    expect(results[0]!.matchPercent).toBe(100);
  });

  it('still works when the current key is unknown', () => {
    const results = recommend({ bpm: 174 }, [candidate('Any', { bpm: 174, key: '3B' })]);
    expect(results).toHaveLength(1);
    expect(results[0]!.reasons).toContain('key unknown, ranked on tempo alone');
  });

  it('reduces the weight of harmony when key confidence is poor (spec §15)', () => {
    const shaky = { ...now, keyConfidence: 0.2 };
    // Same tempo, imperfect key. Low confidence should let tempo dominate,
    // scoring this higher than it would with a trusted key reading.
    const trusted = recommend(now, [candidate('X', { bpm: 174, key: '7A' })])[0]!.score;
    const doubted = recommend(shaky, [candidate('Y', { bpm: 174, key: '7A' })])[0]!.score;
    expect(doubted).toBeGreaterThan(trusted);
  });
});

describe('bridge finding (spec §20)', () => {
  it('finds a track that works out of one and into the other', () => {
    // 8A at 174 -> ? -> 10A at 178. 9A at 176 sits between both.
    const bridge = candidate('Bridge', { bpm: 176, key: '9A' });
    const results = findBridge(
      { bpm: 174, camelot: parseCamelot('8A')! },
      { bpm: 178, camelot: parseCamelot('10A')! },
      [bridge, candidate('Unrelated', { bpm: 174, key: '8A' })],
    );
    expect(results[0]!.entry.track.id).toBe(bridge.track.id);
  });

  it('scores a bridge by its weaker side', () => {
    const bridge = candidate('Lopsided', { bpm: 174, key: '8A' });
    const results = findBridge(
      { bpm: 174, camelot: parseCamelot('8A')! },   // perfect out of
      { bpm: 180, camelot: parseCamelot('9A')! },   // weaker into
      [bridge],
    );
    const [result] = results;
    expect(result!.score).toBe(Math.min(result!.fromScore, result!.toScore));
    expect(result!.score).toBeLessThan(result!.fromScore);
  });

  it('returns nothing when no track works on both sides', () => {
    const results = findBridge(
      { bpm: 174, camelot: parseCamelot('8A')! },
      { bpm: 128, camelot: parseCamelot('2B')! },
      [candidate('Only fits one side', { bpm: 174, key: '8A' })],
    );
    expect(results).toEqual([]);
  });
});

describe('playback mode (spec v1.1 §9, §10, §23)', () => {
  const aMinorCentre = 9; // pitch class of A

  it('reports the pitch each candidate needs', () => {
    const results = recommend(
      { bpm: 176, effectivePitchClass: aMinorCentre, tonality: 'minor' },
      [candidate('Needs a nudge', { bpm: 172, key: '8A' })],
      { mode: 'playback' },
    );
    expect(results).toHaveLength(1);
    expect(results[0]!.pitch?.requiredPitchPercent).toBeCloseTo(2.3256, 3);
    expect(results[0]!.pitch?.playbackBpm).toBeCloseTo(176, 6);
    expect(results[0]!.pitch?.pitchShiftSemitones).toBeCloseTo(0.4, 2);
    expect(results[0]!.reasons.some((r) => r.includes('+2.3%'))).toBe(true);
  });

  it('drops records the deck cannot reach', () => {
    // 170 to 186 needs +9.4%, past a Technics ±8%.
    const results = recommend(
      { bpm: 186, effectivePitchClass: aMinorCentre, tonality: 'minor' },
      [candidate('Too slow', { bpm: 170, key: '8A' })],
      { mode: 'playback' },
    );
    expect(results).toHaveLength(0);
  });

  it('keeps that record when the deck range allows it', () => {
    const wide = { preferredMaxPitchPercent: 8, deck: findDeckProfile('wide-vinyl') };
    const results = recommend(
      { bpm: 186, effectivePitchClass: aMinorCentre, tonality: 'minor' },
      [candidate('Reachable', { bpm: 170, key: '8A' })],
      { mode: 'playback', tolerance: wide },
    );
    expect(results).toHaveLength(1);
    expect(results[0]!.pitch?.reachable).toBe(true);
  });

  it('prefers the smaller pitch adjustment between two equal keys', () => {
    // Spec v1.1 §24: +0.8% should rank above +7.8%.
    const results = recommend(
      { bpm: 174, effectivePitchClass: aMinorCentre, tonality: 'minor' },
      [
        candidate('Far', { bpm: 161.4, key: '8A' }),
        candidate('Near', { bpm: 172.6, key: '8A' }),
      ],
      { mode: 'playback' },
    );
    expect(results[0]!.entry.track.title).toBe('Near');
  });

  it('scores the pitched key, not the sleeve key', () => {
    // Both are 8A on the label. Reaching the target needs a full semitone of
    // pitch, which moves the candidate out of 8A and into a clash.
    const target = 174 * 1.05946;
    const results = recommend(
      { bpm: target, effectivePitchClass: aMinorCentre, tonality: 'minor' },
      [candidate('Label says 8A', { bpm: 174, key: '8A' })],
      { mode: 'playback' },
    );
    // Still reachable on tempo, but must not be presented as a clean match.
    if (results.length) {
      expect(results[0]!.pitch?.effectiveKey?.pitchClass).toBe('A#');
      expect(results[0]!.pitch?.classification).not.toBe('EXCELLENT');
      expect(results[0]!.matchPercent).toBeLessThan(70);
    }
  });

  it('still applies the played penalty', () => {
    const results = recommend(
      { bpm: 174, effectivePitchClass: aMinorCentre, tonality: 'minor' },
      [
        candidate('Played', { bpm: 174, key: '8A', playState: 'played' }),
        candidate('Fresh', { bpm: 173, key: '8A' }),
      ],
      { mode: 'playback' },
    );
    expect(results[0]!.entry.track.title).toBe('Fresh');
  });

  it('never suggests a record put aside', () => {
    const results = recommend(
      { bpm: 174, effectivePitchClass: aMinorCentre, tonality: 'minor' },
      [candidate('Aside', { bpm: 174, key: '8A', playState: 'put-aside' })],
      { mode: 'playback' },
    );
    expect(results).toHaveLength(0);
  });

  it('classifies a reachable tempo with no key as tempo only', () => {
    const results = recommend(
      { bpm: 174, effectivePitchClass: aMinorCentre, tonality: 'minor' },
      [candidate('No key', { bpm: 172 })],
      { mode: 'playback' },
    );
    expect(results[0]!.pitch?.classification).toBe('TEMPO_ONLY');
  });

  it('leaves native mode untouched', () => {
    // The default path must not have acquired pitch fields.
    const results = recommend(
      { bpm: 174, camelot: parseCamelot('8A')! },
      [candidate('Plain', { bpm: 174, key: '8A' })],
    );
    expect(results[0]!.pitch).toBeUndefined();
    expect(results[0]!.matchPercent).toBe(100);
  });
});
