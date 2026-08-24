import type { SetPlan, SetPlanMode } from '@/domain/types';
import type { BagTrack } from '@/bags/coverage';
import { compareBpm, compareKeys, type BpmResult, type HarmonicResult } from '@/harmonic/compatibility';
import { matchAtPitch, type PitchMatch } from '@/pitch/matching';
import type { PitchTolerance } from '@/pitch/deck';
import { asPlaybackTarget, nativeBpmOf, nativeKeyOf } from '@/pitch/native';
import { newId, nowIso } from '@/utils/ids';

/**
 * Set planning. Spec §20.
 *
 * Three modes, and crucially none of them is mandatory:
 *   freeform   records planned for the night, no order
 *   shortlist  tracks flagged as likely, still unsequenced
 *   ordered    an explicit running order, with transitions shown between tracks
 *
 * The bag remains the universe of possible choices (spec §19); a set plan is an
 * optional narrowing of it.
 */

export function createSetPlan(input: {
  name: string;
  bagId?: string;
  mode?: SetPlanMode;
  trackIds?: readonly string[];
  notes?: string;
}): SetPlan {
  const timestamp = nowIso();
  return {
    id: newId('set'),
    createdAt: timestamp,
    updatedAt: timestamp,
    version: 1,
    name: input.name.trim() || 'Untitled set',
    bagId: input.bagId,
    mode: input.mode ?? 'freeform',
    trackIds: [...(input.trackIds ?? [])],
    notes: input.notes,
  };
}

function touch(plan: SetPlan): SetPlan {
  return { ...plan, updatedAt: nowIso(), version: plan.version + 1 };
}

export function addTracks(plan: SetPlan, trackIds: readonly string[]): SetPlan {
  // Order matters in ordered mode, so append rather than merging into a set,
  // but never allow the same track twice in one plan.
  const existing = new Set(plan.trackIds);
  const additions = trackIds.filter((id) => !existing.has(id));
  if (!additions.length) return plan;
  return touch({ ...plan, trackIds: [...plan.trackIds, ...additions] });
}

export function removeTrack(plan: SetPlan, trackId: string): SetPlan {
  const remaining = plan.trackIds.filter((id) => id !== trackId);
  if (remaining.length === plan.trackIds.length) return plan;
  return touch({ ...plan, trackIds: remaining });
}

export function toggleTrack(plan: SetPlan, trackId: string): SetPlan {
  return plan.trackIds.includes(trackId) ? removeTrack(plan, trackId) : addTracks(plan, [trackId]);
}

/** Move a track to a new index. Used by the ordered-mode reorder controls. */
export function moveTrack(plan: SetPlan, trackId: string, toIndex: number): SetPlan {
  const from = plan.trackIds.indexOf(trackId);
  if (from === -1) return plan;

  const clamped = Math.max(0, Math.min(plan.trackIds.length - 1, toIndex));
  if (clamped === from) return plan;

  const next = [...plan.trackIds];
  next.splice(from, 1);
  next.splice(clamped, 0, trackId);
  return touch({ ...plan, trackIds: next });
}

export function setMode(plan: SetPlan, mode: SetPlanMode): SetPlan {
  if (plan.mode === mode) return plan;
  return touch({ ...plan, mode });
}

export function renameSetPlan(plan: SetPlan, name: string): SetPlan {
  const trimmed = name.trim();
  if (!trimmed || trimmed === plan.name) return plan;
  return touch({ ...plan, name: trimmed });
}

// ---------------------------------------------------------------------------
// Ordered-mode transitions
// ---------------------------------------------------------------------------

/**
 * The gap between two consecutive tracks in an ordered set.
 * This is what spec §20 renders as the arrow between two tracks.
 */
export interface SetTransition {
  fromTrackId: string;
  toTrackId: string;
  key: HarmonicResult;
  bpm: BpmResult;
  /** Combined 0..1 view, for a single at-a-glance indicator. */
  score: number;
  /** Short labels, e.g. ["+1 Camelot", "+2 BPM"]. */
  labels: string[];
  /** True when this join needs attention before the gig. */
  warning: boolean;
  /**
   * Pitch-aware view of the join: what the incoming record has to be pitched
   * to, and the key it will then be in. Spec v1.1 §15, §26.
   */
  pitch?: PitchMatch | undefined;
}

/**
 * Describe each join in an ordered set.
 *
 * Returns n-1 transitions for n tracks, in order. A missing key or BPM is
 * reported as unknown rather than as a problem: it means "go and analyse this",
 * not "this mix will fail".
 */
export function describeTransitions(
  entries: readonly BagTrack[],
  options: { tolerance?: PitchTolerance } = {},
): SetTransition[] {
  const transitions: SetTransition[] = [];

  for (let index = 0; index < entries.length - 1; index += 1) {
    const from = entries[index]!;
    const to = entries[index + 1]!;

    const fromBpm = from.analysis?.canonicalBpm;
    const toBpm = to.analysis?.canonicalBpm;
    const key = compareKeys(from.analysis?.camelotKey, to.analysis?.camelotKey);
    const bpm = compareBpm(fromBpm, toBpm);

    const labels: string[] = [];
    const haveKeys = Boolean(from.analysis?.camelotKey && to.analysis?.camelotKey);
    const haveBpms = fromBpm !== undefined && toBpm !== undefined;

    if (haveKeys) labels.push(key.label);
    if (haveBpms) {
      const delta = Math.round((toBpm - fromBpm) * 10) / 10;
      labels.push(`${delta > 0 ? '+' : ''}${delta} BPM`);
    }
    if (!haveKeys) labels.push('key unknown');
    if (!haveBpms) labels.push('BPM unknown');

    // Score only over what we know, so an unanalysed track does not read as a
    // bad mix. Nothing known at all means no opinion, not zero.
    const parts: number[] = [];
    if (haveKeys) parts.push(key.score);
    if (haveBpms) parts.push(bpm.score);
    const score = parts.length ? parts.reduce((a, b) => a + b, 0) / parts.length : 0;

    // Warn on the WEAKEST known dimension, not the average. A key clash at a
    // matching tempo averages out to a respectable-looking 0.5, which would
    // hide exactly the problem a DJ needs to see before the gig.
    const weakest = parts.length ? Math.min(...parts) : null;

    // Pitch-aware layer: hold the outgoing tempo and work out what the
    // incoming record needs. This is the transition a vinyl DJ actually plays.
    let pitch: PitchMatch | undefined;
    if (options.tolerance) {
      const target = asPlaybackTarget(from.analysis);
      pitch = matchAtPitch({
        target,
        nativeBpm: nativeBpmOf(to.analysis),
        nativeKey: nativeKeyOf(to.analysis),
        tolerance: options.tolerance,
      });
    }

    transitions.push({
      fromTrackId: from.track.id,
      toTrackId: to.track.id,
      key,
      bpm,
      score,
      labels,
      // With pitch data the classification is the better signal, because it
      // accounts for the key the record will actually be in.
      warning: pitch
        ? pitch.classification === 'OUT_OF_RANGE' ||
          pitch.classification === 'RISKY' ||
          (pitch.classification === 'TEMPO_ONLY' && haveKeys)
        : weakest !== null && weakest < 0.5,
      pitch,
    });
  }

  return transitions;
}

/** Order resolved entries to match the plan's track order. */
export function orderEntries(
  plan: SetPlan,
  entries: readonly BagTrack[],
): BagTrack[] {
  const byId = new Map(entries.map((entry) => [entry.track.id, entry]));
  const ordered: BagTrack[] = [];
  for (const trackId of plan.trackIds) {
    const entry = byId.get(trackId);
    if (entry) ordered.push(entry);
  }
  return ordered;
}
