import type { CamelotKey } from '@/domain/types';
import { formatCamelot } from './camelot';

/**
 * Harmonic compatibility scoring. Spec §38.
 *
 * All key-relationship logic lives here — deliberately not scattered across
 * views. Returns a graded score rather than a boolean so recommendation
 * ranking can weight it alongside BPM, energy and transition history later.
 */

export type HarmonicRelation =
  | 'same'
  | 'fifth-up'
  | 'fifth-down'
  | 'relative'
  | 'energy-shift'
  | 'incompatible';

export interface HarmonicResult {
  score: number; // 0..1
  relation: HarmonicRelation;
  /** Short human-readable label, e.g. "+1 Camelot". Spec §20. */
  label: string;
  /** True for the four "safe" relationships in spec §38. */
  safe: boolean;
}

const INCOMPATIBLE: HarmonicResult = {
  score: 0,
  relation: 'incompatible',
  label: 'Clash',
  safe: false,
};

/** Wrap into 1..12. */
function wrap(n: number): number {
  return ((n - 1 + 12) % 12) + 1;
}

export function compareKeys(
  from: CamelotKey | undefined,
  to: CamelotKey | undefined,
): HarmonicResult {
  // Unknown key is not the same as a clash: it is simply no information.
  // Callers must down-weight rather than exclude. Spec §15.
  if (!from || !to) {
    return { score: 0, relation: 'incompatible', label: 'Key unknown', safe: false };
  }

  const sameLetter = from.letter === to.letter;
  const delta = to.number - from.number;
  const wrapped = ((delta + 18) % 12) - 6; // shortest signed distance, -5..6

  if (sameLetter && delta === 0) {
    return { score: 1, relation: 'same', label: 'Same key', safe: true };
  }
  if (sameLetter && wrapped === 1) {
    return { score: 0.9, relation: 'fifth-up', label: '+1 Camelot', safe: true };
  }
  if (sameLetter && wrapped === -1) {
    return { score: 0.9, relation: 'fifth-down', label: '−1 Camelot', safe: true };
  }
  if (!sameLetter && delta === 0) {
    return {
      score: 0.85,
      relation: 'relative',
      label: from.letter === 'A' ? 'Relative major' : 'Relative minor',
      safe: true,
    };
  }

  // Beyond the safe set. Kept as low-scoring rather than excluded so the
  // engine can be opened up later (energy shifts, creative key changes).
  if (sameLetter && Math.abs(wrapped) === 2) {
    return {
      score: 0.45,
      relation: 'energy-shift',
      label: wrapped > 0 ? '+2 Camelot' : '−2 Camelot',
      safe: false,
    };
  }
  return INCOMPATIBLE;
}

/** The four safe neighbours of a key. Drives key-wheel highlighting. Spec §13. */
export function compatibleKeys(key: CamelotKey): CamelotKey[] {
  return [
    { number: key.number, letter: key.letter },
    { number: wrap(key.number + 1), letter: key.letter },
    { number: wrap(key.number - 1), letter: key.letter },
    { number: key.number, letter: key.letter === 'A' ? 'B' : 'A' },
  ];
}

export function describeTransition(from: CamelotKey | undefined, to: CamelotKey | undefined): string {
  const result = compareKeys(from, to);
  if (!from || !to) return result.label;
  return `${formatCamelot(from)} → ${formatCamelot(to)} · ${result.label}`;
}

// ---------------------------------------------------------------------------
// BPM compatibility
// ---------------------------------------------------------------------------

/**
 * Vinyl pitch control realistically gives about ±8% on a 1210, and most DJs
 * stay well inside that. Score falls off with required pitch adjustment.
 */
export interface BpmResult {
  score: number;
  /** Percentage pitch change needed to match, signed. */
  pitchPercent: number;
  label: string;
  /** True when the match needs a half/double-time read. */
  viaOctave: boolean;
}

export function compareBpm(from: number | undefined, to: number | undefined): BpmResult {
  if (!from || !to) {
    return { score: 0, pitchPercent: 0, label: 'BPM unknown', viaOctave: false };
  }

  const direct = evaluate(from, to, false);
  // A 87 vs 174 pairing is mixable in practice (half-time roll), so consider it,
  // but rank it below a direct tempo match.
  const octave = [
    evaluate(from, to * 2, true),
    evaluate(from, to / 2, true),
  ].sort((a, b) => b.score - a.score)[0]!;

  return direct.score >= octave.score ? direct : octave;
}

function evaluate(from: number, to: number, viaOctave: boolean): BpmResult {
  const pitchPercent = ((to - from) / from) * 100;
  const magnitude = Math.abs(pitchPercent);

  let score: number;
  if (magnitude <= 1) score = 1;
  else if (magnitude <= 3) score = 0.92;
  else if (magnitude <= 6) score = 0.75;
  else if (magnitude <= 8) score = 0.5;
  else if (magnitude <= 12) score = 0.2;
  else score = 0;

  if (viaOctave) score *= 0.6;

  const rounded = Math.round(pitchPercent * 10) / 10;
  const label =
    score === 0
      ? 'Too far'
      : `${rounded > 0 ? '+' : ''}${rounded}%${viaOctave ? ' (half/double)' : ''}`;

  return { score, pitchPercent: rounded, label, viaOctave };
}
