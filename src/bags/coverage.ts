import type {
  AnalysisState,
  CamelotKey,
  PlayState,
  Release,
  Track,
  TrackAnalysis,
} from '@/domain/types';
import { allCamelotKeys, formatCamelot } from '@/harmonic/camelot';
import { compatibleKeys } from '@/harmonic/compatibility';

/**
 * Bag coverage analysis. Spec §19.
 *
 * The question this answers is "have I packed a balanced selection?", not
 * "what shall I play next". It is deliberately pure and takes resolved rows,
 * so it can be tested without a database and reused for a bag, a set shortlist
 * or the whole collection.
 */

/** A track in a bag, with everything needed to reason about it. */
export interface BagTrack {
  track: Track;
  release: Release;
  analysis?: TrackAnalysis | undefined;
  playState?: PlayState | undefined;
}

export interface BpmBucket {
  from: number;
  to: number;
  count: number;
}

export interface CamelotSlot {
  key: CamelotKey;
  count: number;
}

export interface NamedCount {
  name: string;
  count: number;
}

export type GapKind =
  | 'unknown-key'
  | 'unknown-bpm'
  | 'bpm-gap'
  | 'key-dead-end'
  | 'thin-analysis'
  | 'empty';

export interface CoverageGap {
  kind: GapKind;
  /** Ready to show in the UI, phrased the way spec §19 phrases them. */
  message: string;
  /** Rough ordering hint: 1 is most worth acting on. */
  severity: 1 | 2 | 3;
}

export interface BagCoverage {
  records: number;
  tracks: number;
  /** Tracks with a BPM or a key. */
  analysed: number;
  /** Tracks the user has confirmed. */
  verified: number;
  needsAnalysis: number;
  states: Record<AnalysisState, number>;

  bpm: { min: number; max: number; median: number; buckets: BpmBucket[] } | null;
  withBpm: number;
  withKey: number;

  /** All 24 wheel positions, so the UI can render coverage as a full wheel. */
  camelot: CamelotSlot[];
  camelotCovered: number;

  styles: NamedCount[];
  genres: NamedCount[];

  playState: Record<PlayState, number>;

  gaps: CoverageGap[];
}

const BUCKET_SIZE = 5;
/** A run of empty buckets this wide or wider inside the range is a real gap. */
const GAP_BUCKETS = 2;

function tally(values: readonly string[]): NamedCount[] {
  const counts = new Map<string, number>();
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1);
  return [...counts.entries()]
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
}

function median(sorted: readonly number[]): number {
  if (!sorted.length) return 0;
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2
    ? sorted[mid]!
    : Math.round(((sorted[mid - 1]! + sorted[mid]!) / 2) * 10) / 10;
}

export function analyseCoverage(entries: readonly BagTrack[]): BagCoverage {
  const states: Record<AnalysisState, number> = {
    READY: 0,
    VERIFY: 0,
    ANALYSE: 0,
    CONFLICT: 0,
  };
  const playState: Record<PlayState, number> = {
    packed: 0,
    unplayed: 0,
    played: 0,
    'put-aside': 0,
    favourite: 0,
  };

  const bpms: number[] = [];
  const camelotCounts = new Map<string, number>();
  const styleValues: string[] = [];
  const genreValues: string[] = [];
  const releaseIds = new Set<string>();

  let withBpm = 0;
  let withKey = 0;
  let verified = 0;

  for (const entry of entries) {
    releaseIds.add(entry.release.id);
    styleValues.push(...entry.release.styles);
    genreValues.push(...entry.release.genres);

    // No analysis row at all reads as ANALYSE, same as the badge logic.
    states[entry.analysis?.state ?? 'ANALYSE'] += 1;
    playState[entry.playState ?? 'packed'] += 1;

    const bpm = entry.analysis?.canonicalBpm;
    if (bpm !== undefined) {
      bpms.push(bpm);
      withBpm += 1;
    }

    const camelot = entry.analysis?.camelotKey;
    if (camelot) {
      withKey += 1;
      const label = formatCamelot(camelot);
      camelotCounts.set(label, (camelotCounts.get(label) ?? 0) + 1);
    }

    if (entry.analysis?.verifiedBpm || entry.analysis?.verifiedKey) verified += 1;
  }

  const analysed = entries.filter(
    (entry) =>
      entry.analysis?.canonicalBpm !== undefined || entry.analysis?.camelotKey !== undefined,
  ).length;

  // --- BPM distribution ----------------------------------------------------
  bpms.sort((a, b) => a - b);
  let bpm: BagCoverage['bpm'] = null;
  if (bpms.length) {
    const min = bpms[0]!;
    const max = bpms[bpms.length - 1]!;
    const first = Math.floor(min / BUCKET_SIZE) * BUCKET_SIZE;
    const last = Math.floor(max / BUCKET_SIZE) * BUCKET_SIZE;

    const buckets: BpmBucket[] = [];
    for (let from = first; from <= last; from += BUCKET_SIZE) {
      const to = from + BUCKET_SIZE;
      buckets.push({
        from,
        to,
        count: bpms.filter((value) => value >= from && value < to).length,
      });
    }
    // The final bucket must include its upper bound, or the fastest track falls out.
    const lastBucket = buckets[buckets.length - 1];
    if (lastBucket && !bpms.some((v) => v >= lastBucket.from && v < lastBucket.to)) {
      lastBucket.count = bpms.filter((v) => v >= lastBucket.from && v <= lastBucket.to).length;
    }

    bpm = { min, max, median: median(bpms), buckets };
  }

  // --- Camelot coverage ----------------------------------------------------
  const camelot: CamelotSlot[] = allCamelotKeys().map((key) => ({
    key,
    count: camelotCounts.get(formatCamelot(key)) ?? 0,
  }));
  const camelotCovered = camelot.filter((slot) => slot.count > 0).length;

  const coverage: BagCoverage = {
    records: releaseIds.size,
    tracks: entries.length,
    analysed,
    verified,
    needsAnalysis: entries.length - analysed,
    states,
    bpm,
    withBpm,
    withKey,
    camelot,
    camelotCovered,
    styles: tally(styleValues),
    genres: tally(genreValues),
    playState,
    gaps: [],
  };

  coverage.gaps = findGaps(coverage);
  return coverage;
}

/**
 * Turn the distribution into advice.
 *
 * Only things worth acting on before a gig: missing analysis, tempo holes, and
 * keys with nowhere harmonic to go next.
 */
export function findGaps(coverage: BagCoverage): CoverageGap[] {
  const gaps: CoverageGap[] = [];

  if (!coverage.tracks) {
    return [{ kind: 'empty', message: 'Nothing packed yet.', severity: 1 }];
  }

  const missingKey = coverage.tracks - coverage.withKey;
  const missingBpm = coverage.tracks - coverage.withBpm;

  if (missingKey > 0) {
    gaps.push({
      kind: 'unknown-key',
      message: `${missingKey} of ${coverage.tracks} tracks have unknown key`,
      severity: missingKey > coverage.tracks / 2 ? 1 : 2,
    });
  }

  if (missingBpm > 0) {
    gaps.push({
      kind: 'unknown-bpm',
      message: `${missingBpm} of ${coverage.tracks} tracks have unknown BPM`,
      severity: missingBpm > coverage.tracks / 2 ? 1 : 2,
    });
  }

  // Tempo holes: a run of empty buckets between occupied ones. A gap at the
  // edges is not a gap, it is just where the bag stops.
  if (coverage.bpm) {
    const { buckets } = coverage.bpm;
    let runStart = -1;
    for (let index = 0; index < buckets.length; index += 1) {
      const empty = buckets[index]!.count === 0;
      if (empty && runStart === -1) runStart = index;
      if (!empty && runStart !== -1) {
        const length = index - runStart;
        if (length >= GAP_BUCKETS) {
          gaps.push({
            kind: 'bpm-gap',
            message: `Few tracks between ${buckets[runStart]!.from}-${buckets[index - 1]!.to} BPM`,
            severity: 2,
          });
        }
        runStart = -1;
      }
    }
  }

  // Harmonic dead ends: a key you have but with nothing compatible to go to.
  const present = new Set(
    coverage.camelot.filter((slot) => slot.count > 0).map((slot) => formatCamelot(slot.key)),
  );
  for (const slot of coverage.camelot) {
    if (!slot.count) continue;
    const onward = compatibleKeys(slot.key)
      .filter((key) => formatCamelot(key) !== formatCamelot(slot.key))
      .filter((key) => present.has(formatCamelot(key)));

    if (!onward.length) {
      // Name the move a DJ would look for, e.g. "4A -> 5A".
      const preferred = compatibleKeys(slot.key)[1]!;
      gaps.push({
        kind: 'key-dead-end',
        message: `No strong ${formatCamelot(slot.key)} to ${formatCamelot(preferred)} options`,
        severity: 3,
      });
    }
  }

  if (coverage.analysed < coverage.tracks / 2) {
    gaps.push({
      kind: 'thin-analysis',
      message: `Only ${coverage.analysed} of ${coverage.tracks} tracks have any BPM or key yet`,
      severity: 1,
    });
  }

  return gaps.sort((a, b) => a.severity - b.severity);
}
