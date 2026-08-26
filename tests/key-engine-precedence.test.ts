import { describe, expect, it } from 'vitest';
import { combineKeyEngines } from '@/analysis/essentia-key';
import type { Detection, KeyDiagnostics, KeyEngineReading } from '@/analysis/audio';
import { pitchClassIndex } from '@/analysis/key-agreement';
import type { MusicalKey, PitchClass } from '@/domain/types';

/**
 * Which engine's answer gets reported, and why.
 *
 * Essentia used to win whenever it returned anything at all. On a real
 * recording that meant B major was reported on every window while the custom
 * engine said G# minor at HIGHER confidence — and those are relative keys, so
 * the engines agreed about the notes and the precedence rule was quietly
 * deciding the tonic by itself.
 */
function diagnostics(options: {
  bassRoot?: string;
  notes?: readonly PitchClass[];
} = {}): KeyDiagnostics {
  const chroma = Array<number>(12).fill(0.05);
  for (const note of options.notes ?? []) chroma[pitchClassIndex(note)] = 1;
  return {
    chroma,
    spread: 1,
    best: 0.6,
    margin: 0.1,
    thresholds: { spread: 0.14, correlation: 0.32, margin: 0.03, modeMargin: 0.015, sectionAgreement: 0.45 },
    ...(options.bassRoot ? { rangeEvidence: { bassRoot: options.bassRoot } } : {}),
  } as KeyDiagnostics;
}

const reading = (key: MusicalKey, confidence: number): KeyEngineReading =>
  ({ engine: 'essentia', key, confidence, status: 'result' });

const detection = (key: MusicalKey, confidence: number, keyDiagnostics?: KeyDiagnostics): Detection =>
  ({ key, keyConfidence: confidence, ...(keyDiagnostics ? { keyDiagnostics } : {}) });

describe('key engine precedence', () => {
  it('calls a relative pair the same notes rather than a disagreement', () => {
    const combined = combineKeyEngines(
      detection({ pitchClass: 'G#', tonality: 'minor' }, 0.85, diagnostics({ bassRoot: 'G#' })),
      reading({ pitchClass: 'B', tonality: 'major' }, 0.8),
    );
    expect(combined.keyComparison).toMatchObject({ relation: 'relative', sharedNotes: 7 });
  });

  it('lets the bass settle the tonic of a relative pair', () => {
    // The real recording: Essentia B major, custom G# minor, bass on G#.
    const combined = combineKeyEngines(
      detection({ pitchClass: 'G#', tonality: 'minor' }, 0.85, diagnostics({ bassRoot: 'G#' })),
      reading({ pitchClass: 'B', tonality: 'major' }, 0.8),
    );
    expect(combined.key).toEqual({ pitchClass: 'G#', tonality: 'minor' });
    expect(combined.keyComparison?.selected).toBe('custom');
    expect(combined.keyComparison?.selectedBecause).toMatch(/bass on G# names the tonic/);
  });

  it('lets the bass pick Essentia just as readily', () => {
    const combined = combineKeyEngines(
      detection({ pitchClass: 'G#', tonality: 'minor' }, 0.85, diagnostics({ bassRoot: 'B' })),
      reading({ pitchClass: 'B', tonality: 'major' }, 0.8),
    );
    expect(combined.key).toEqual({ pitchClass: 'B', tonality: 'major' });
    expect(combined.keyComparison?.selected).toBe('essentia');
  });

  it('falls back to confidence when the bass names neither', () => {
    // A bass sitting on the fifth resolves nothing; it must not be read as
    // evidence for either candidate.
    const combined = combineKeyEngines(
      detection({ pitchClass: 'G#', tonality: 'minor' }, 0.85, diagnostics({ bassRoot: 'D#' })),
      reading({ pitchClass: 'B', tonality: 'major' }, 0.8),
    );
    expect(combined.keyComparison?.selected).toBe('custom');
    expect(combined.keyComparison?.selectedBecause).toMatch(/bass inconclusive/);
  });

  it('no longer overrides a more confident custom reading', () => {
    const combined = combineKeyEngines(
      detection({ pitchClass: 'A', tonality: 'minor' }, 0.9),
      reading({ pitchClass: 'A', tonality: 'minor' }, 0.5),
    );
    expect(combined.keyComparison).toMatchObject({ relation: 'same', selected: 'custom' });
    expect(combined.keyConfidence).toBe(0.9);
  });

  it('flags a genuine note-set disagreement as unresolved', () => {
    const combined = combineKeyEngines(
      detection({ pitchClass: 'E', tonality: 'major' }, 0.7),
      reading({ pitchClass: 'B', tonality: 'major' }, 0.8),
    );
    expect(combined.keyComparison).toMatchObject({
      relation: 'different', sharedNotes: 6, unresolved: true, selected: 'essentia',
    });
  });

  it('reports the note that separates two adjacent keys, with its energy', () => {
    // B major against E major turns entirely on A# versus A natural. A chroma
    // holding A# and not A is the measurement that settles it.
    const combined = combineKeyEngines(
      detection({ pitchClass: 'E', tonality: 'major' }, 0.7,
        diagnostics({ notes: ['B', 'C#', 'D#', 'E', 'F#', 'G#', 'A#'] })),
      reading({ pitchClass: 'B', tonality: 'major' }, 0.8),
    );
    const separating = combined.keyComparison?.discriminating ?? [];
    expect(separating[0]).toMatchObject({ note: 'A#', supports: 'essentia' });
    expect(separating[0]!.strength).toBeGreaterThan(0.9);
    expect(separating[1]).toMatchObject({ note: 'A', supports: 'custom' });
    expect(separating[1]!.strength).toBeLessThan(0.2);
  });

  it('has no separating notes to offer for a relative pair', () => {
    const combined = combineKeyEngines(
      detection({ pitchClass: 'G#', tonality: 'minor' }, 0.85, diagnostics({ bassRoot: 'G#' })),
      reading({ pitchClass: 'B', tonality: 'major' }, 0.8),
    );
    expect(combined.keyComparison?.discriminating).toEqual([]);
  });

  it('lets a clearly present separating note decide, over confidence', () => {
    // A# is in B major and not in E major. The chroma holds A# and not A, so
    // the note evidence settles it even though the other engine is no less
    // confident — the note the record actually contains names the key.
    const combined = combineKeyEngines(
      detection({ pitchClass: 'E', tonality: 'major' }, 0.95,
        diagnostics({ notes: ['B', 'C#', 'D#', 'E', 'F#', 'G#', 'A#'] })),
      reading({ pitchClass: 'B', tonality: 'major' }, 0.4),
    );
    expect(combined.keyComparison?.selected).toBe('essentia');
    expect(combined.keyComparison?.selectedBecause).toMatch(/A# clearly present/);
    expect(combined.keyComparison?.unresolved).toBe(false);
  });

  it('falls to the bass when the separating notes are tied', () => {
    /*
     * The real capture: Essentia B minor, custom E minor, separating notes C
     * against C# at 44% and 43% — the chroma cannot tell. The dominant bass
     * note was C#, which B minor contains and E minor does not, so the bass
     * decides what the confidence figures cannot.
     */
    const chroma = Array<number>(12).fill(0.05);
    chroma[pitchClassIndex('C')] = 0.44;
    chroma[pitchClassIndex('C#')] = 0.43;
    const combined = combineKeyEngines(
      detection({ pitchClass: 'E', tonality: 'minor' }, 0.89, {
        chroma, spread: 1, best: 0.6, margin: 0.1,
        rangeEvidence: { bassRoot: 'C#' },
        thresholds: { spread: 0.14, correlation: 0.32, margin: 0.03, modeMargin: 0.015, sectionAgreement: 0.45 },
      } as KeyDiagnostics),
      reading({ pitchClass: 'B', tonality: 'minor' }, 0.69),
    );
    expect(combined.key).toEqual({ pitchClass: 'B', tonality: 'minor' });
    expect(combined.keyComparison?.selected).toBe('essentia');
    expect(combined.keyComparison?.selectedBecause).toMatch(/bass C# is only in this scale/);
  });

  it('admits when nothing separates them', () => {
    // Bass note in both scales, separating notes tied: no evidence at all.
    const chroma = Array<number>(12).fill(0.05);
    chroma[pitchClassIndex('C')] = 0.44;
    chroma[pitchClassIndex('C#')] = 0.43;
    const combined = combineKeyEngines(
      detection({ pitchClass: 'E', tonality: 'minor' }, 0.89, {
        chroma, spread: 1, best: 0.6, margin: 0.1,
        rangeEvidence: { bassRoot: 'E' },
        thresholds: { spread: 0.14, correlation: 0.32, margin: 0.03, modeMargin: 0.015, sectionAgreement: 0.45 },
      } as KeyDiagnostics),
      reading({ pitchClass: 'B', tonality: 'minor' }, 0.69),
    );
    expect(combined.keyComparison?.unresolved).toBe(true);
    expect(combined.keyComparison?.selectedBecause).toMatch(/no evidence separates them/);
  });

  it('still uses whichever engine answered when only one did', () => {
    const combined = combineKeyEngines(
      { key: undefined, keyConfidence: undefined },
      reading({ pitchClass: 'B', tonality: 'major' }, 0.8),
    );
    expect(combined.keyComparison?.selected).toBe('essentia');
    expect(combined.keyComparison?.selectedBecause).toMatch(/only Essentia/);
  });
});
