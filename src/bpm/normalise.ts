/**
 * BPM canonicalisation. Spec §11.
 *
 * The problem: metadata sources routinely list drum & bass at half-time (87
 * instead of 174) and some garage at half-time too (64 instead of 128). The
 * spec is explicit that we must NOT simply double everything under 100 — that
 * would wreck legitimate 90 BPM hip-hop or 64 BPM dub.
 *
 * The approach: derive an expected tempo band from Discogs genre/style, then
 * pick whichever of {bpm, bpm×2, bpm÷2} lands in it. With no genre context we
 * make no change and say so, which is the conservative outcome the spec wants.
 */

export interface BpmBand {
  label: string;
  min: number;
  max: number;
}

/**
 * Expected canonical tempo bands, keyed by normalised Discogs genre/style
 * token. Ranges are deliberately generous — these decide whether to double,
 * not what to display. Spec §11 calls these guides, not hard limits.
 */
const STYLE_BANDS: Array<{ tokens: string[]; band: BpmBand }> = [
  {
    tokens: ['drumandbass', 'drumnbass', 'drumbass', 'jungle', 'liquidfunk', 'neurofunk', 'ragga jungle', 'raggajungle', 'halftime', 'jumpup', 'techstep'],
    band: { label: 'Jungle / D&B', min: 155, max: 190 },
  },
  {
    tokens: ['ukgarage', 'garage', 'speedgarage', '2step', 'twostep', 'bassline', 'grime'],
    band: { label: 'UK Garage', min: 125, max: 145 },
  },
  {
    tokens: ['house', 'deephouse', 'techhouse', 'progressivehouse', 'garage house', 'garagehouse', 'acidhouse', 'funkyhouse', 'disco', 'nudisco'],
    band: { label: 'House', min: 112, max: 132 },
  },
  {
    tokens: ['techno', 'minimal', 'acid', 'electro'],
    band: { label: 'Techno', min: 120, max: 145 },
  },
  {
    tokens: ['trance', 'psytrance', 'hardtrance'],
    band: { label: 'Trance', min: 130, max: 150 },
  },
  {
    tokens: ['hardcore', 'happyhardcore', 'gabber', 'breakcore'],
    band: { label: 'Hardcore', min: 160, max: 200 },
  },
  {
    tokens: ['breakbeat', 'breaks', 'bigbeat', 'nuskoolbreaks'],
    band: { label: 'Breakbeat', min: 125, max: 145 },
  },
  {
    tokens: ['dubstep', 'grimedubstep'],
    band: { label: 'Dubstep', min: 135, max: 145 },
  },
  {
    tokens: ['hiphop', 'rap', 'triphop', 'boombap'],
    band: { label: 'Hip Hop', min: 80, max: 105 },
  },
  {
    tokens: ['dub', 'reggae', 'roots', 'dancehall', 'lovers rock'],
    band: { label: 'Reggae / Dub', min: 60, max: 110 },
  },
  {
    tokens: ['downtempo', 'ambient', 'triphopdowntempo', 'chillout'],
    band: { label: 'Downtempo', min: 60, max: 110 },
  },
];

function tokenise(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/g, '');
}

/**
 * Resolve an expected tempo band from Discogs genres/styles.
 * Styles are checked before genres: Discogs styles ("Jungle") are far more
 * specific than genres ("Electronic").
 */
export function resolveBand(
  genres: readonly string[] = [],
  styles: readonly string[] = [],
  overrides?: Record<string, [number, number]>,
): BpmBand | null {
  const candidates = [...styles, ...genres];

  // User overrides win outright.
  if (overrides) {
    for (const candidate of candidates) {
      const override = overrides[candidate] ?? overrides[tokenise(candidate)];
      if (override) return { label: candidate, min: override[0], max: override[1] };
    }
  }

  // Two passes, exact before fuzzy. "Garage House" must land in the House band
  // rather than being swallowed by a substring match on "garage"; "Ragga
  // Jungle" still needs the fuzzy pass to reach the D&B band.
  for (const candidate of candidates) {
    const token = tokenise(candidate);
    if (!token) continue;
    for (const entry of STYLE_BANDS) {
      if (entry.tokens.some((t) => tokenise(t) === token)) return entry.band;
    }
  }

  for (const candidate of candidates) {
    const token = tokenise(candidate);
    if (!token) continue;
    for (const entry of STYLE_BANDS) {
      if (entry.tokens.some((t) => token.includes(tokenise(t)))) return entry.band;
    }
  }

  return null;
}

export interface NormaliseInput {
  bpm: number;
  genres?: readonly string[];
  styles?: readonly string[];
  /** Verified BPMs from elsewhere on the same release, used as a tie-breaker. */
  siblingBpms?: readonly number[];
  overrides?: Record<string, [number, number]>;
}

export interface NormaliseResult {
  sourceBpm: number;
  canonicalBpm: number;
  /** Human-readable justification, stored as provenance. Spec §10. */
  reason: string;
  /** Multiplier applied: 0.5, 1 or 2. */
  factor: 0.5 | 1 | 2;
  band: BpmBand | null;
  /** False when we declined to decide and passed the value through. */
  confident: boolean;
}

const MULTIPLIERS: Array<0.5 | 1 | 2> = [1, 2, 0.5];

export function normaliseBpm(input: NormaliseInput): NormaliseResult {
  const { bpm } = input;

  if (!Number.isFinite(bpm) || bpm <= 0) {
    return {
      sourceBpm: bpm,
      canonicalBpm: bpm,
      reason: 'Invalid BPM; left unchanged',
      factor: 1,
      band: null,
      confident: false,
    };
  }

  const band = resolveBand(input.genres, input.styles, input.overrides);
  const round = (n: number) => Math.round(n * 10) / 10;

  if (!band) {
    // No genre context. Do NOT guess — this is the case the spec calls out.
    return {
      sourceBpm: bpm,
      canonicalBpm: round(bpm),
      reason: 'No genre context; BPM left as reported',
      factor: 1,
      band: null,
      confident: false,
    };
  }

  const inBand = (value: number) => value >= band.min && value <= band.max;
  const matches = MULTIPLIERS.filter((m) => inBand(bpm * m));

  if (matches.length === 1) {
    const factor = matches[0]!;
    const canonical = round(bpm * factor);
    return {
      sourceBpm: bpm,
      canonicalBpm: canonical,
      reason:
        factor === 1
          ? `Already within ${band.label} range (${band.min}–${band.max})`
          : `${factor === 2 ? 'Doubled' : 'Halved'} to reach ${band.label} range (${band.min}–${band.max})`,
      factor,
      band,
      confident: true,
    };
  }

  if (matches.length > 1) {
    // Ambiguous: the band is wide enough that two readings both fit.
    // Prefer a sibling-consistent reading, else the untransformed value.
    const siblings = input.siblingBpms?.filter((b) => Number.isFinite(b)) ?? [];
    if (siblings.length) {
      const target = siblings.reduce((a, b) => a + b, 0) / siblings.length;
      const best = matches.reduce((a, b) =>
        Math.abs(bpm * a - target) <= Math.abs(bpm * b - target) ? a : b,
      );
      return {
        sourceBpm: bpm,
        canonicalBpm: round(bpm * best),
        reason: `Ambiguous in ${band.label} range; matched to other tracks on the release (~${Math.round(target)} BPM)`,
        factor: best,
        band,
        confident: best === 1,
      };
    }
    return {
      sourceBpm: bpm,
      canonicalBpm: round(bpm),
      reason: `Ambiguous in ${band.label} range; kept as reported`,
      factor: 1,
      band,
      confident: false,
    };
  }

  // Nothing fits the band. Pick the reading closest to it, but flag low
  // confidence — this is a VERIFY candidate, not a silent correction.
  const centre = (band.min + band.max) / 2;
  const best = MULTIPLIERS.reduce((a, b) =>
    Math.abs(bpm * a - centre) <= Math.abs(bpm * b - centre) ? a : b,
  );
  const canonical = round(bpm * best);
  return {
    sourceBpm: bpm,
    canonicalBpm: best === 1 ? round(bpm) : canonical,
    reason:
      best === 1
        ? `Outside ${band.label} range (${band.min}–${band.max}); kept as reported`
        : `Outside ${band.label} range; ${best === 2 ? 'doubled' : 'halved'} as closest fit`,
    factor: best,
    band,
    confident: false,
  };
}

/** Explicit user actions. These always win and mark the value verified. Spec §11. */
export function halveBpm(bpm: number): number {
  return Math.round((bpm / 2) * 10) / 10;
}

export function doubleBpm(bpm: number): number {
  return Math.round(bpm * 2 * 10) / 10;
}
