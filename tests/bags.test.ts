import { describe, expect, it } from 'vitest';
import {
  activate,
  activeBag,
  addToBag,
  createBag,
  duplicateBag,
  removeFromBag,
  renameBag,
  setBagStatus,
  sortBags,
  toggleInBag,
} from '@/bags/operations';
import {
  addTracks,
  createSetPlan,
  describeTransitions,
  moveTrack,
  orderEntries,
  removeTrack,
  setMode,
  toggleTrack,
} from '@/sets/operations';
import type { BagTrack } from '@/bags/coverage';
import { camelotToMusicalKey, parseCamelot } from '@/harmonic/camelot';
import { TECHNICS_VINYL } from '@/pitch/deck';
import type { Release, Track, TrackAnalysis } from '@/domain/types';

describe('bag lifecycle (spec §18)', () => {
  it('creates a bag in planning state', () => {
    const bag = createBag({ name: 'Saturday B2B' });
    expect(bag.name).toBe('Saturday B2B');
    expect(bag.status).toBe('planning');
    expect(bag.collectionItemIds).toEqual([]);
    expect(bag.version).toBe(1);
  });

  it('falls back to a usable name', () => {
    expect(createBag({ name: '   ' }).name).toBe('Untitled bag');
  });

  it('adds and removes records', () => {
    let bag = createBag({ name: 'Bag' });
    bag = addToBag(bag, ['col_1', 'col_2']);
    expect(bag.collectionItemIds).toEqual(['col_1', 'col_2']);

    bag = removeFromBag(bag, ['col_1']);
    expect(bag.collectionItemIds).toEqual(['col_2']);
  });

  it('does not add the same record twice', () => {
    let bag = addToBag(createBag({ name: 'Bag' }), ['col_1']);
    const before = bag.version;
    bag = addToBag(bag, ['col_1']);
    expect(bag.collectionItemIds).toEqual(['col_1']);
    // A no-op must not bump the version, or sync would see phantom changes.
    expect(bag.version).toBe(before);
  });

  it('treats two physical copies as separate records', () => {
    // Doubles: same release, two collection items.
    const bag = addToBag(createBag({ name: 'Bag' }), ['col_copy1', 'col_copy2']);
    expect(bag.collectionItemIds).toHaveLength(2);
  });

  it('toggles membership', () => {
    let bag = createBag({ name: 'Bag' });
    bag = toggleInBag(bag, 'col_1');
    expect(bag.collectionItemIds).toEqual(['col_1']);
    bag = toggleInBag(bag, 'col_1');
    expect(bag.collectionItemIds).toEqual([]);
  });

  it('bumps the version on a real change only', () => {
    const bag = createBag({ name: 'Bag' });
    expect(renameBag(bag, 'Bag').version).toBe(bag.version);
    expect(renameBag(bag, 'New').version).toBe(bag.version + 1);
    expect(removeFromBag(bag, ['nope']).version).toBe(bag.version);
  });

  it('duplicates a bag for reuse without carrying active status', () => {
    const source = setBagStatus(addToBag(createBag({ name: 'Old Skool' }), ['a', 'b']), 'active');
    const copy = duplicateBag(source);

    expect(copy.id).not.toBe(source.id);
    expect(copy.name).toBe('Old Skool (copy)');
    expect(copy.collectionItemIds).toEqual(['a', 'b']);
    expect(copy.status).toBe('planning');
  });
});

describe('active bag', () => {
  it('promotes one bag and demotes the previous holder', () => {
    const first = setBagStatus(createBag({ name: 'First' }), 'active');
    const second = createBag({ name: 'Second' });

    const changed = activate([first, second], second.id);
    const byId = new Map(changed.map((bag) => [bag.id, bag]));

    expect(byId.get(second.id)?.status).toBe('active');
    // Demoted, not archived: last week's bag is still a real bag.
    expect(byId.get(first.id)?.status).toBe('planning');
  });

  it('is a no-op when the bag is already active', () => {
    const bag = setBagStatus(createBag({ name: 'Bag' }), 'active');
    expect(activate([bag], bag.id)).toEqual([]);
  });

  it('finds the active bag and ignores deleted ones', () => {
    const live = setBagStatus(createBag({ name: 'Live' }), 'active');
    const dead = { ...setBagStatus(createBag({ name: 'Dead' }), 'active'), deletedAt: '2020-01-01' };
    expect(activeBag([dead, live])?.id).toBe(live.id);
  });

  it('sorts active first, archived last', () => {
    const planning = createBag({ name: 'Planning' });
    const archived = setBagStatus(createBag({ name: 'Archived' }), 'archived');
    const active = setBagStatus(createBag({ name: 'Active' }), 'active');

    expect(sortBags([archived, planning, active]).map((b) => b.name)).toEqual([
      'Active',
      'Planning',
      'Archived',
    ]);
  });

  it('hides soft-deleted bags from the list', () => {
    const bag = createBag({ name: 'Gone' });
    expect(sortBags([{ ...bag, deletedAt: '2020-01-01' }])).toEqual([]);
  });
});

// ---------------------------------------------------------------------------

let seq = 0;
const release: Release = {
  id: 'rel_1', createdAt: '', updatedAt: '', version: 1,
  discogsReleaseId: 1, artist: 'A', artistSort: 'a', title: 'T',
  formats: [], genres: [], styles: [], identifiers: [], artwork: [],
  trackIds: [], references: [], hydrationState: 'hydrated',
};

function entry(title: string, bpm?: number, key?: string): BagTrack {
  seq += 1;
  const track: Track = {
    id: `trk_${seq}`, createdAt: '', updatedAt: '', version: 1,
    releaseId: release.id, position: 'A', artist: 'A', title, sequence: seq,
  };
  const camelot = key ? parseCamelot(key)! : undefined;
  const analysis: TrackAnalysis = {
    id: `ana_${seq}`, createdAt: '', updatedAt: '', version: 1,
    trackId: track.id,
    canonicalBpm: bpm,
    camelotKey: camelot,
    canonicalKey: camelot ? camelotToMusicalKey(camelot) ?? undefined : undefined,
    verifiedBpm: false, verifiedKey: false, candidates: [], state: 'VERIFY',
  };
  return { track, release, analysis };
}

describe('set plans (spec §20)', () => {
  it('defaults to freeform, the mode that demands nothing', () => {
    expect(createSetPlan({ name: 'Night' }).mode).toBe('freeform');
  });

  it('supports all three modes', () => {
    let plan = createSetPlan({ name: 'Night' });
    for (const mode of ['shortlist', 'ordered', 'freeform'] as const) {
      plan = setMode(plan, mode);
      expect(plan.mode).toBe(mode);
    }
  });

  it('appends tracks in order and refuses duplicates', () => {
    let plan = createSetPlan({ name: 'Night', mode: 'ordered' });
    plan = addTracks(plan, ['t1', 't2']);
    plan = addTracks(plan, ['t2', 't3']);
    expect(plan.trackIds).toEqual(['t1', 't2', 't3']);
  });

  it('removes and toggles tracks', () => {
    let plan = addTracks(createSetPlan({ name: 'N' }), ['t1', 't2']);
    plan = removeTrack(plan, 't1');
    expect(plan.trackIds).toEqual(['t2']);
    plan = toggleTrack(plan, 't3');
    expect(plan.trackIds).toEqual(['t2', 't3']);
  });

  it('reorders tracks', () => {
    let plan = addTracks(createSetPlan({ name: 'N', mode: 'ordered' }), ['a', 'b', 'c']);
    plan = moveTrack(plan, 'c', 0);
    expect(plan.trackIds).toEqual(['c', 'a', 'b']);
    plan = moveTrack(plan, 'c', 2);
    expect(plan.trackIds).toEqual(['a', 'b', 'c']);
  });

  it('clamps a reorder to the ends of the list', () => {
    const plan = addTracks(createSetPlan({ name: 'N' }), ['a', 'b']);
    expect(moveTrack(plan, 'a', 99).trackIds).toEqual(['b', 'a']);
    expect(moveTrack(plan, 'b', -5).trackIds).toEqual(['b', 'a']);
  });

  it('ignores a reorder of a track that is not in the plan', () => {
    const plan = addTracks(createSetPlan({ name: 'N' }), ['a']);
    expect(moveTrack(plan, 'zzz', 0)).toBe(plan);
  });

  it('orders resolved entries to match the plan, skipping missing ones', () => {
    const a = entry('A', 174, '8A');
    const b = entry('B', 175, '9A');
    const plan = addTracks(createSetPlan({ name: 'N', mode: 'ordered' }), [
      b.track.id,
      'not-in-library',
      a.track.id,
    ]);
    expect(orderEntries(plan, [a, b]).map((e) => e.track.title)).toEqual(['B', 'A']);
  });
});

describe('ordered-set transitions (spec §20)', () => {
  it('returns one transition per join', () => {
    const entries = [entry('1', 174, '8A'), entry('2', 176, '9A'), entry('3', 178, '10A')];
    expect(describeTransitions(entries)).toHaveLength(2);
  });

  it('labels the key move and the tempo change', () => {
    // The example from spec §20: 174/8A into 176/9A.
    const [transition] = describeTransitions([entry('1', 174, '8A'), entry('2', 176, '9A')]);
    expect(transition!.labels).toContain('+1 Camelot');
    expect(transition!.labels).toContain('+2 BPM');
    expect(transition!.warning).toBe(false);
  });

  it('signs the tempo change downwards too', () => {
    const [transition] = describeTransitions([entry('1', 176, '8A'), entry('2', 174, '8A')]);
    expect(transition!.labels).toContain('-2 BPM');
  });

  it('warns about a rough join', () => {
    const [transition] = describeTransitions([entry('1', 174, '8A'), entry('2', 174, '2A')]);
    expect(transition!.warning).toBe(true);
  });

  it('reports unknowns as unknown rather than as a bad mix', () => {
    const [transition] = describeTransitions([entry('1', 174), entry('2', 176)]);
    expect(transition!.labels).toContain('key unknown');
    // Tempo is fine, so this must not be flagged as a problem.
    expect(transition!.warning).toBe(false);
  });

  it('holds no opinion when nothing is known', () => {
    const [transition] = describeTransitions([entry('1'), entry('2')]);
    expect(transition!.score).toBe(0);
    expect(transition!.warning).toBe(false);
    expect(transition!.labels).toEqual(['key unknown', 'BPM unknown']);
  });

  it('returns nothing for a set of one', () => {
    expect(describeTransitions([entry('1', 174, '8A')])).toEqual([]);
    expect(describeTransitions([])).toEqual([]);
  });
});

describe('pitch-aware transitions (spec v1.1 §15, §26)', () => {
  const tolerance = { preferredMaxPitchPercent: 4, deck: TECHNICS_VINYL };

  it('states the pitch the incoming record needs', () => {
    // The worked example from spec v1.1 §15: 174 into a 172 record.
    const [transition] = describeTransitions(
      [entry('A', 174, '8A'), entry('B', 172, '8A')],
      { tolerance },
    );
    expect(transition!.pitch).toBeDefined();
    expect(transition!.pitch!.tempoKnown).toBe(true);
    expect(transition!.pitch!.requiredPitchPercent).toBeCloseTo(1.1628, 3);
    expect(transition!.pitch!.playbackBpm).toBeCloseTo(174, 6);
    expect(transition!.pitch!.pitchShiftSemitones).toBeCloseTo(0.2, 2);
    expect(transition!.pitch!.classification).toBe('EXCELLENT');
  });

  it('flags a join the deck cannot reach', () => {
    // 150 into 174 needs +16%, past a Technics.
    const [transition] = describeTransitions(
      [entry('A', 174, '8A'), entry('B', 150, '8A')],
      { tolerance },
    );
    expect(transition!.pitch!.reachable).toBe(false);
    expect(transition!.pitch!.classification).toBe('OUT_OF_RANGE');
    expect(transition!.warning).toBe(true);
  });

  it('marks tempo as unknown rather than reporting a zero pitch', () => {
    // Without a tempo, "+0.0%" would read as "no pitch needed", which is a lie.
    const [transition] = describeTransitions(
      [entry('A', undefined, '8A'), entry('B', undefined, '8A')],
      { tolerance },
    );
    expect(transition!.pitch!.tempoKnown).toBe(false);
  });

  it('omits pitch data entirely when no deck is supplied', () => {
    const [transition] = describeTransitions([entry('A', 174, '8A'), entry('B', 172, '8A')]);
    expect(transition!.pitch).toBeUndefined();
    // The native-key verdict still stands on its own.
    expect(transition!.labels).toContain('Same key');
  });

  it('downgrades a join whose pitched key stops working', () => {
    // Same sleeve key, but reaching the tempo needs a full semitone of pitch,
    // which moves the incoming record out of that key.
    const target = 174;
    const native = target / 1.05946; // needs ~+5.95% to reach 174
    const [transition] = describeTransitions(
      [entry('A', target, '8A'), entry('B', Math.round(native * 10) / 10, '8A')],
      { tolerance },
    );
    expect(transition!.pitch!.reachable).toBe(true);
    // The naive view says "Same key"; the pitched view knows better.
    expect(transition!.labels).toContain('Same key');
    expect(transition!.pitch!.classification).not.toBe('EXCELLENT');
    expect(transition!.warning).toBe(true);
  });
});
