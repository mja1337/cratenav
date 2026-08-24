import { describe, expect, it } from 'vitest';
import { hasUnconfirmedAnalysis } from '@/analysis/verification';
import type { TrackAnalysis } from '@/domain/types';

function analysis(overrides: Partial<TrackAnalysis> = {}): TrackAnalysis {
  return {
    id: 'analysis-1',
    trackId: 'track-1',
    createdAt: '2026-08-24T10:00:00.000Z',
    updatedAt: '2026-08-24T10:00:00.000Z',
    version: 1,
    verifiedBpm: false,
    verifiedKey: false,
    candidates: [],
    state: 'ANALYSE',
    ...overrides,
  };
}

describe('unconfirmed analysis filter', () => {
  it('ignores empty placeholder rows', () => {
    expect(hasUnconfirmedAnalysis(analysis())).toBe(false);
  });

  it('includes a retained online candidate even before it is selected', () => {
    expect(hasUnconfirmedAnalysis(analysis({
      candidates: [{ source: 'acousticbrainz', confidence: 0.6, observedAt: 'now', canonicalBpm: 130 }],
    }))).toBe(true);
  });

  it('includes selected values that have not been confirmed', () => {
    expect(hasUnconfirmedAnalysis(analysis({ canonicalBpm: 130, state: 'VERIFY' }))).toBe(true);
  });

  it('excludes evidence once every supplied dimension is confirmed', () => {
    expect(hasUnconfirmedAnalysis(analysis({
      canonicalBpm: 130,
      verifiedBpm: true,
      candidates: [{ source: 'acousticbrainz', confidence: 0.6, observedAt: 'now', canonicalBpm: 130 }],
      state: 'READY',
    }))).toBe(false);
  });
});
