import { describe, expect, it } from 'vitest';
import { reviewCandidatePatch } from '@/analysis/candidate-review';
import type { AnalysisCandidate, TrackAnalysis } from '@/domain/types';

const NOW = '2026-08-24T12:00:00.000Z';

function candidate(overrides: Partial<AnalysisCandidate> = {}): AnalysisCandidate {
  return {
    source: 'acousticbrainz',
    providerId: 'open-analysis',
    providerName: 'MusicBrainz + AcousticBrainz',
    confidence: 0.7,
    matchScore: 0.8,
    observedAt: NOW,
    ...overrides,
  };
}

function analysis(overrides: Partial<TrackAnalysis> = {}): TrackAnalysis {
  return {
    id: 'ana-1',
    trackId: 'track-1',
    createdAt: NOW,
    updatedAt: NOW,
    version: 1,
    verifiedBpm: false,
    verifiedKey: false,
    candidates: [],
    state: 'ANALYSE',
    ...overrides,
  };
}

describe('candidate review', () => {
  it('records the comment against the source that was judged', () => {
    const first = candidate({ source: 'getsongbpm', canonicalBpm: 174 });
    const second = candidate({ source: 'acousticbrainz', canonicalBpm: 87 });
    const patch = reviewCandidatePatch(analysis({ candidates: [first, second] }), second, {
      status: 'rejected',
      comment: '  half time, this is the 87 BPM edit  ',
      now: NOW,
    });

    expect(patch.candidates?.[0]).toEqual(first);
    expect(patch.candidates?.[1]).toMatchObject({
      source: 'acousticbrainz',
      reviewStatus: 'rejected',
      reviewComment: 'half time, this is the 87 BPM edit',
      reviewedAt: NOW,
    });
  });

  it('keeps an empty comment absent rather than storing whitespace', () => {
    const only = candidate({ canonicalBpm: 174 });
    const patch = reviewCandidatePatch(analysis({ candidates: [only] }), only, {
      status: 'approved',
      comment: '   ',
      now: NOW,
    });
    expect(patch.candidates?.[0]?.reviewComment).toBeUndefined();
    expect(patch.analysisMethod).toBe('External candidate approved by user');
  });

  it('approving keeps the source BPM alongside the canonical one', () => {
    const only = candidate({
      sourceBpm: 87,
      canonicalBpm: 174,
      normalisationReason: 'doubled for D&B range',
    });
    const patch = reviewCandidatePatch(analysis({ candidates: [only] }), only, {
      status: 'approved',
      now: NOW,
    });
    expect(patch).toMatchObject({
      sourceBpm: 87,
      canonicalBpm: 174,
      normalisationReason: 'doubled for D&B range',
      verifiedBpm: true,
    });
  });

  it('verifies only the dimension the source actually supplied', () => {
    const tempoOnly = candidate({ canonicalBpm: 174 });
    const patch = reviewCandidatePatch(analysis({ candidates: [tempoOnly] }), tempoOnly, {
      status: 'approved',
      now: NOW,
    });
    expect(patch.verifiedBpm).toBe(true);
    // A source with no key must not silently confirm the key dimension.
    expect(patch.verifiedKey).toBeUndefined();
    expect(patch.camelotKey).toBeUndefined();
  });

  it('caps a dimension confidence at the identity confidence', () => {
    // A source can be certain of 174 BPM and still be the wrong recording.
    const shaky = candidate({ canonicalBpm: 174, bpmConfidence: 0.95, matchScore: 0.55 });
    const patch = reviewCandidatePatch(analysis({ candidates: [shaky] }), shaky, {
      status: 'approved',
      now: NOW,
    });
    expect(patch.bpmConfidence).toBe(0.55);
  });

  it('rejecting after approving withdraws the value that source supplied', () => {
    const only = candidate({ canonicalBpm: 174, camelotKey: { number: 8, letter: 'A' } });
    const approved = analysis({
      candidates: [only],
      canonicalBpm: 174,
      bpmSource: 'acousticbrainz',
      verifiedBpm: true,
      camelotKey: { number: 8, letter: 'A' },
      keySource: 'acousticbrainz',
      verifiedKey: true,
    });

    const patch = reviewCandidatePatch(approved, only, { status: 'rejected', now: NOW });

    expect(patch.canonicalBpm).toBeUndefined();
    expect(patch.verifiedBpm).toBe(false);
    expect(patch.camelotKey).toBeUndefined();
    expect(patch.verifiedKey).toBe(false);
    expect(patch.bpmSource).toBeUndefined();
  });

  it('rejecting leaves a value this source did not supply alone', () => {
    const other = candidate({ source: 'getsongbpm', canonicalBpm: 174 });
    const measured = analysis({
      candidates: [other],
      canonicalBpm: 176,
      bpmSource: 'local-analysis',
      verifiedBpm: true,
    });

    const patch = reviewCandidatePatch(measured, other, { status: 'rejected', now: NOW });

    // A hand-measured tempo survives rejecting an unrelated online claim.
    expect(patch).not.toHaveProperty('canonicalBpm');
    expect(patch).not.toHaveProperty('verifiedBpm');
  });

  it('rejecting withdraws only the dimension that came from this source', () => {
    const tempoOnly = candidate({ canonicalBpm: 174 });
    const mixed = analysis({
      candidates: [tempoOnly],
      canonicalBpm: 174,
      bpmSource: 'acousticbrainz',
      verifiedBpm: true,
      camelotKey: { number: 8, letter: 'A' },
      keySource: 'local-analysis',
      verifiedKey: true,
    });

    const patch = reviewCandidatePatch(mixed, tempoOnly, { status: 'rejected', now: NOW });

    expect(patch.canonicalBpm).toBeUndefined();
    expect(patch).not.toHaveProperty('camelotKey');
    expect(patch).not.toHaveProperty('verifiedKey');
  });
});
