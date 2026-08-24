/**
 * cratenav domain model.
 *
 * These types are the AUTHORITATIVE internal representation. External shapes
 * (Discogs JSON, CSV rows, enrichment providers) are mapped into these by
 * adapters and must never leak into views. See docs in /src/discogs.
 */

// ---------------------------------------------------------------------------
// Shared primitives
// ---------------------------------------------------------------------------

/** Every syncable record carries this envelope. Drives incremental cloud sync. */
export interface Syncable {
  id: string;
  createdAt: string;
  updatedAt: string;
  /** Monotonic per-record counter, bumped on every local mutation. */
  version: number;
  /** Which device last wrote this. Used for conflict attribution. */
  updatedByDevice?: string;
  /** Soft deletion. Never hard-delete syncable rows. */
  deletedAt?: string | null;
}

/** Where a piece of BPM/key knowledge came from. */
export type DataSource =
  | 'discogs'
  | 'csv'
  | 'musicbrainz'
  | 'acousticbrainz'
  | 'getsongbpm'
  | 'spotify'
  | 'beatport'
  | 'traxsource'
  | 'local-analysis'
  | 'user'
  | 'unknown';

/** Enrichment state for a track. Spec §9. */
export type AnalysisState = 'READY' | 'VERIFY' | 'ANALYSE' | 'CONFLICT';

/** Live/analysis confidence bands. Spec §15. */
export type ConfidenceBand =
  | 'VERIFIED'
  | 'HIGH'
  | 'MEDIUM'
  | 'LOW'
  | 'UNSTABLE';

// ---------------------------------------------------------------------------
// Musical key
// ---------------------------------------------------------------------------

export type Tonality = 'major' | 'minor';

/** Canonical pitch class, always the sharp spelling internally. */
export type PitchClass =
  | 'C' | 'C#' | 'D' | 'D#' | 'E' | 'F'
  | 'F#' | 'G' | 'G#' | 'A' | 'A#' | 'B';

/** Canonical internal key representation. Spec §12. */
export interface MusicalKey {
  pitchClass: PitchClass;
  tonality: Tonality;
}

/** Camelot wheel position: 1-12 plus A (minor) / B (major). Spec §12. */
export interface CamelotKey {
  number: number; // 1..12
  letter: 'A' | 'B';
}

// ---------------------------------------------------------------------------
// Collection / catalogue entities
// ---------------------------------------------------------------------------

/** A physical owned copy. Spec §4. */
export interface CollectionItem extends Syncable {
  /** Discogs collection instance id. Absent for CSV-bootstrapped items. */
  discogsInstanceId?: number;
  discogsReleaseId: number;
  collectionFolderId?: number;
  dateAdded?: string;
  rating?: number;
  notes?: string;
  mediaCondition?: string;
  sleeveCondition?: string;
  /** User-assigned replacement sleeve colour; references Settings palette. */
  sleeveColorId?: string;
  /**
   * One-based physical records missing from this copy of a multi-record release.
   * Catalogue/analysis rows remain intact; DJ-facing pools exclude their tracks.
   */
  missingRecordNumbers?: number[];
  /**
   * False when the record has left the Discogs collection. We retain the row
   * and all analysis regardless. Spec §5.
   */
  inCollection: boolean;
  /**
   * True while this item came from CSV and has no real instance id yet.
   * An API sync adopts the instance id and clears the flag.
   */
  provisional?: boolean;
  /** Disambiguates duplicate copies of the same release within one import. */
  copyIndex?: number;
}

export interface ReleaseFormat {
  name?: string;
  qty?: string;
  text?: string;
  descriptions?: string[];
}

export interface ReleaseIdentifier {
  type?: string;
  value?: string;
  description?: string;
}

export interface Artwork {
  /** Full-size remote URL. Never bulk-downloaded. Spec §6. */
  uri?: string;
  /** 150px remote thumbnail; the one we cache locally. */
  uri150?: string;
  type?: 'primary' | 'secondary' | string;
  width?: number;
  height?: number;
}

/** Reference link (e.g. a Discogs video). Reference only — never an audio source. Spec §33. */
export interface ExternalReference {
  kind: 'video' | 'link';
  uri: string;
  title?: string;
  duration?: number;
}

/** The exact Discogs release owned. Spec §4. */
export interface Release extends Syncable {
  discogsReleaseId: number;
  discogsMasterId?: number;
  artist: string;
  /** Lower-cased, article-stripped artist for browsing order. */
  artistSort: string;
  title: string;
  label?: string;
  catalogueNumber?: string;
  year?: number;
  country?: string;
  formats: ReleaseFormat[];
  genres: string[];
  styles: string[];
  identifiers: ReleaseIdentifier[];
  artwork: Artwork[];
  trackIds: string[];
  references: ExternalReference[];
  /** Free-text release notes from Discogs. */
  releaseNotes?: string;
  /** Credits, kept loosely typed until we have a use for them. */
  credits?: unknown[];

  // --- hydration bookkeeping -------------------------------------------------
  /** Null until a full /releases/{id} fetch has landed. */
  metadataLastSyncedAt?: string | null;
  /** Bumped when our mapping logic changes, to force re-hydration. */
  metadataVersion?: number;
  /** Discogs' own `date_changed`; lets us detect upstream improvements. Spec §24. */
  discogsDateChanged?: string;
  /** How complete this release's metadata is. */
  hydrationState: 'stub' | 'hydrated' | 'failed';
  hydrationError?: string;
}

/** A track/side/version on a release. Spec §4. */
export interface Track extends Syncable {
  releaseId: string;
  /** Vinyl position, e.g. "A1", "B2", "AA". Spec §48. */
  position: string;
  artist: string;
  title: string;
  /** Remix/version qualifier parsed out of the title where possible. Spec §8. */
  mixVersion?: string;
  /** Duration in seconds, or undefined when Discogs has none. */
  duration?: number;
  recordingId?: string;
  /** Raw Discogs tracklist entry, retained for provenance. */
  discogsMetadata?: unknown;
  /** Ordering within the release, preserving Discogs order. */
  sequence: number;
}

/** Shared underlying recording across pressings. Spec §4. */
export interface Recording extends Syncable {
  canonicalArtist: string;
  canonicalTitle: string;
  canonicalVersion?: string;
  duration?: number;
  isrc?: string;
  musicbrainzId?: string;
  externalIds?: Record<string, string>;
}

// ---------------------------------------------------------------------------
// Analysis + provenance
// ---------------------------------------------------------------------------

/**
 * One provider's claim about a track. We keep every candidate rather than
 * collapsing to a single value, so CONFLICT is representable. Spec §10.
 */
export interface AnalysisCandidate {
  source: DataSource;
  /** Adapter identity is distinct from the data source (one adapter may combine services). */
  providerId?: string;
  providerName?: string;
  /** Stable provider identity and review link for later verification/re-querying. */
  externalId?: string;
  externalUrl?: string;
  matchedArtist?: string;
  matchedTitle?: string;
  matchedVersion?: string;
  matchedDuration?: number;
  matchRationale?: string;
  verificationRequired?: boolean;
  sourceBpm?: number;
  canonicalBpm?: number;
  sourceKey?: string;
  canonicalKey?: MusicalKey;
  camelotKey?: CamelotKey;

  // --- native playback properties (spec v1.1 §5) ---------------------------
  /**
   * BPM and key at NOMINAL playback speed. Usually identical to the canonical
   * values, and kept explicit because a record played at a non-zero pitch is
   * not in its native key. These must never be overwritten with temporary
   * playback values. Read them through the helpers in /src/pitch/native.ts,
   * which fall back to the canonical fields.
   */
  nativeBpm?: number;
  nativeKey?: MusicalKey;
  nativeCamelot?: CamelotKey;
  /** Pitch class 0-11, C = 0. Redundant with nativeKey but handy for maths. */
  nativePitchClass?: number;
  nativeMode?: Tonality;
  /** Dimension-specific signal confidence; never infer one from the other. */
  bpmConfidence?: number;
  keyConfidence?: number;
  /** Legacy/summary confidence retained for old backups and compact displays. */
  confidence: number;
  observedAt: string;
  /** Why the BPM was transformed, e.g. "doubled for D&B range". */
  normalisationReason?: string;
  matchScore?: number;
  /** Human adjudication of this exact source claim. */
  reviewStatus?: 'approved' | 'rejected';
  reviewComment?: string;
  reviewedAt?: string;
}

export interface EnrichmentAttempt {
  provider: string;
  attemptedAt: string;
  outcome: 'found' | 'none' | 'error';
  message?: string;
}

/** Resolved BPM/key knowledge for a track. Spec §4, §10. */
export interface TrackAnalysis extends Syncable {
  trackId: string;
  recordingId?: string;

  sourceBpm?: number;
  canonicalBpm?: number;
  sourceKey?: string;
  canonicalKey?: MusicalKey;
  camelotKey?: CamelotKey;

  // --- native playback properties (spec v1.1 §5) ---------------------------
  /**
   * BPM and key at NOMINAL playback speed. Usually identical to the canonical
   * values, and kept explicit because a record played at a non-zero pitch is
   * not in its native key. These must never be overwritten with temporary
   * playback values. Read them through the helpers in /src/pitch/native.ts,
   * which fall back to the canonical fields.
   */
  nativeBpm?: number;
  nativeKey?: MusicalKey;
  nativeCamelot?: CamelotKey;
  /** Pitch class 0-11, C = 0. Redundant with nativeKey but handy for maths. */
  nativePitchClass?: number;
  nativeMode?: Tonality;

  bpmConfidence?: number;
  keyConfidence?: number;

  bpmSource?: DataSource;
  keySource?: DataSource;

  /** User verification always overrides automation. Spec §10. */
  verifiedBpm: boolean;
  verifiedKey: boolean;

  analysisMethod?: string;
  analysisDate?: string;
  normalisationReason?: string;

  /** Every competing claim, retained. */
  candidates: AnalysisCandidate[];
  /** Durable batch checkpoint, including negative lookups. */
  enrichmentAttempts?: EnrichmentAttempt[];
  state: AnalysisState;

  /** When the physical sticker was written for this track. Spec §23. */
  stickerDoneAt?: string | null;

  /** DJ-owned extras. Spec §5. */
  energy?: number;
  tags?: string[];
  mixNotes?: string;

  /** Compact evidence retained from the most recently accepted local capture. */
  localAnalysisEvidence?: {
    profile: 'general' | 'drum-and-bass';
    capturedSeconds: number;
    frameCount: number;
    rhythmicFrames: number;
    tonalWindows: number;
    localBpm?: number;
    localKey?: MusicalKey;
    sourceBpm?: number;
    sourceKey?: MusicalKey;
    bpmAgreed?: boolean;
    keyAgreed?: boolean;
    acceptedAt: string;
  };
}

// ---------------------------------------------------------------------------
// Bags / sets / play state — modelled now, surfaced in the next phase
// ---------------------------------------------------------------------------

export type BagStatus = 'planning' | 'active' | 'archived';

/** Physical records being taken somewhere. Spec §18. */
export interface Bag extends Syncable {
  name: string;
  description?: string;
  eventDate?: string;
  collectionItemIds: string[];
  status: BagStatus;
}

export type SetPlanMode = 'freeform' | 'shortlist' | 'ordered';

export interface SetPlan extends Syncable {
  name: string;
  bagId?: string;
  mode: SetPlanMode;
  trackIds: string[];
  notes?: string;
}

export type TransitionRating = 'great' | 'ok' | 'bad';

export interface Transition extends Syncable {
  fromTrackId: string;
  toTrackId: string;
  rating: TransitionRating;
  transitionType?: string;
  notes?: string;
  pitchPercent?: number;
  lastUsedAt?: string;
}

export interface PlayHistory extends Syncable {
  trackId: string;
  bagId?: string;
  setId?: string;
  playedAt: string;
  source?: string;
  notes?: string;
}

/** Per-session play state within a bag. Spec §22. */
export type PlayState =
  | 'packed'
  | 'unplayed'
  | 'played'
  | 'put-aside'
  | 'favourite';

export interface TrackPlayState extends Syncable {
  trackId: string;
  bagId: string;
  state: PlayState;
}

// ---------------------------------------------------------------------------
// App-level settings (single row)
// ---------------------------------------------------------------------------

export type ThemePreference = 'dark' | 'light' | 'system';
export type KeyNotation = 'camelot' | 'musical';

export interface SleeveColor {
  id: string;
  name: string;
  /** Six-digit CSS hex colour, including the leading #. */
  hex: string;
}

export interface Settings {
  id: 'settings';
  theme: ThemePreference;
  keyNotation: KeyNotation;
  discogsUsername?: string;
  /** Personal access token. Device-local only; never synced, never committed. */
  discogsToken?: string;
  /** Contact sent through the local proxy to identify MusicBrainz requests. Device-local. */
  metadataContact?: string;
  /** GetSongBPM API key. Device-local only; never exported or synced. */
  getSongBpmApiKey?: string;
  activeBagId?: string;
  deviceId: string;
  /** Preferred canonical BPM bands per genre, used by normalisation. */
  bpmPreferences?: Record<string, [number, number]>;
  /** Which deck the pitch maths should assume. Spec v1.1 §7. */
  deckProfileId?: string;
  /** Comfortable working pitch range, inside the deck's hard limit. §25 */
  preferredMaxPitchPercent?: number;
  /** Hide Discogs CD-positioned tracks from DJ workflows. Default: false. */
  vinylOnlyMode?: boolean;
  /** User-created additions to the built-in replacement sleeve palette. */
  customSleeveColors?: SleeveColor[];
  updatedAt: string;
}
