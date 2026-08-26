import { describe, expect, it } from 'vitest';
import { guardDetail } from '@/components/live-audio-analysis';
import type { KeyDiagnostics } from '@/analysis/audio';

/**
 * "no result · margin" told nobody anything: not whether the statistic missed by
 * a hair or by a mile, and not what the engine would have answered. A guard
 * missed by 0.002 is a calibration question; one missed by half is the material.
 */
const thresholds = {
  spread: 0.14, correlation: 0.32, margin: 0.03, modeMargin: 0.015, sectionAgreement: 0.45,
};

const diagnostics = (overrides: Partial<KeyDiagnostics>): KeyDiagnostics =>
  ({ chroma: Array<number>(12).fill(0.1), spread: 1, best: 0.6, margin: 0.1, thresholds, ...overrides } as KeyDiagnostics);

describe('guard detail', () => {
  it('names the statistic and the bar it missed', () => {
    expect(guardDetail(diagnostics({ rejectedBy: 'margin', margin: 0.021 })))
      .toBe('two keys too close · margin 0.021 of 0.03');
    expect(guardDetail(diagnostics({ rejectedBy: 'spread', spread: 0.09 })))
      .toBe('chroma too flat · spread 0.090 of 0.14');
    expect(guardDetail(diagnostics({ rejectedBy: 'correlation', best: 0.28 })))
      .toBe('no key fits · match 0.280 of 0.32');
    expect(guardDetail(diagnostics({ rejectedBy: 'mode', modeMargin: 0.004 })))
      .toBe('major or minor unclear · mode 0.004 of 0.015');
  });

  it('distinguishes the two ways the section guard fires', () => {
    // Windows disagreeing with each other.
    expect(guardDetail(diagnostics({ rejectedBy: 'section', sectionAgreement: 0.3 })))
      .toMatch(/sections disagree · agreement 0.300 of 0.45/);
    // Windows unanimous, but on a key the aggregate does not support.
    expect(guardDetail(diagnostics({ rejectedBy: 'section', sectionAgreement: 1 })))
      .toMatch(/does not support/);
  });

  it('reads thresholds from the diagnostics rather than hardcoding them', () => {
    // Or the panel silently drifts out of step with KEY_THRESHOLDS.
    const detail = guardDetail(diagnostics({
      rejectedBy: 'margin',
      margin: 0.04,
      thresholds: { ...thresholds, margin: 0.09 },
    }));
    expect(detail).toBe('two keys too close · margin 0.040 of 0.09');
  });

  it('says nothing when nothing was rejected', () => {
    expect(guardDetail(diagnostics({}))).toBeUndefined();
    expect(guardDetail(undefined)).toBeUndefined();
  });
});
