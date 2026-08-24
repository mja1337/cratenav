import { describe, expect, it } from 'vitest';
import type { CollectionItem, Release, Track } from '@/domain/types';
import {
  isTrackAvailableOnAnyItem,
  isTrackAvailableOnItem,
  physicalRecordsForRelease,
  recordNumberForTrack,
} from '@/discogs/physical-records';

const timestamp = '2026-08-24T10:00:00.000Z';

function release(qty = '2'): Release {
  return {
    id: 'release-1', discogsReleaseId: 1, artist: 'Artist', artistSort: 'artist', title: 'Album',
    formats: [{ name: 'Vinyl', qty }], genres: [], styles: [], identifiers: [], artwork: [],
    trackIds: [], references: [], hydrationState: 'hydrated', version: 1,
    createdAt: timestamp, updatedAt: timestamp,
  };
}

function track(id: string, position: string, sequence: number): Track {
  return {
    id, releaseId: 'release-1', position, artist: 'Artist', title: id, sequence,
    version: 1, createdAt: timestamp, updatedAt: timestamp,
  };
}

function item(id: string, missingRecordNumbers?: number[]): CollectionItem {
  return {
    id, discogsReleaseId: 1, inCollection: true, missingRecordNumbers,
    version: 1, createdAt: timestamp, updatedAt: timestamp,
  };
}

describe('physical records in multi-disc releases', () => {
  it('pairs successive vinyl sides into physical records', () => {
    const tracks = [
      track('a1', 'A1', 0), track('b1', 'B1', 1),
      track('c1', 'C1', 2), track('d1', 'D1', 3),
    ];
    const records = physicalRecordsForRelease(release(), tracks);

    expect(records).toEqual([
      { number: 1, sides: ['A', 'B'], trackIds: ['a1', 'b1'] },
      { number: 2, sides: ['C', 'D'], trackIds: ['c1', 'd1'] },
    ]);
    expect(recordNumberForTrack('d1', records)).toBe(2);
  });

  it('treats A and AA as two sides of one record', () => {
    const records = physicalRecordsForRelease(release('1'), [
      track('a', 'A', 0), track('aa', 'AA', 1),
    ]);

    expect(records).toEqual([
      { number: 1, sides: ['A', 'AA'], trackIds: ['a', 'aa'] },
    ]);
  });

  it('respects explicit numbered-disc positions', () => {
    const records = physicalRecordsForRelease(release(), [
      track('one', '1-1', 0), track('two', '2-1', 1),
    ]);

    expect(records.map((record) => record.trackIds)).toEqual([['one'], ['two']]);
  });

  it('retains format-declared records even when Discogs has no mapped tracks for one', () => {
    const records = physicalRecordsForRelease(release('3'), [track('a', 'A1', 0)]);

    expect(records).toHaveLength(3);
    expect(records[2]).toEqual({ number: 3, sides: [], trackIds: [] });
  });

  it('excludes a missing disc per copy but keeps it when another copy has it', () => {
    const tracks = [track('a', 'A1', 0), track('c', 'C1', 1)];
    const records = physicalRecordsForRelease(release(), tracks);
    const incomplete = item('copy-1', [2]);
    const complete = item('copy-2');

    expect(isTrackAvailableOnItem('c', records, incomplete)).toBe(false);
    expect(isTrackAvailableOnItem('a', records, incomplete)).toBe(true);
    expect(isTrackAvailableOnAnyItem('c', records, [incomplete])).toBe(false);
    expect(isTrackAvailableOnAnyItem('c', records, [incomplete, complete])).toBe(true);
  });

  it('keeps unrecognised positions available rather than hiding them speculatively', () => {
    const mystery = track('mystery', 'Untitled', 0);
    const records = physicalRecordsForRelease(release(), [mystery]);

    expect(recordNumberForTrack(mystery.id, records)).toBeUndefined();
    expect(isTrackAvailableOnItem(mystery.id, records, item('copy-1', [1, 2]))).toBe(true);
  });
});
