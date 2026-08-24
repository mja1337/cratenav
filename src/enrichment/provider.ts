import type { AnalysisCandidate, Recording, Release, Settings, Track } from '@/domain/types';

/**
 * Metadata enrichment provider interface. Spec §8.
 *
 * Provider-independent matching and resolution live beside this interface.
 * Concrete network adapters are still deliberately separate, so no provider
 * becomes load-bearing by accident — spec §8 is explicit that none may be
 * hardcoded as essential.
 *
 * The hard problem here is not fetching, it is MATCHING. For the vinyl this app
 * targets, an artist-and-title match is not nearly good enough: a 1997 UK
 * garage 12" and its digital reissue share both, while being different
 * recordings at different tempos. So a provider returns scored candidates and
 * never a bare answer, and the caller decides whether the score justifies
 * READY, VERIFY or nothing at all.
 */

export interface MatchContext {
  track: Track;
  release: Release;
  /** Resolved recording identity, when this track is already linked to one. */
  recording?: Recording;
  /** Other tracks on the same release, useful for corroboration. */
  siblings: readonly Track[];
}

/** Provider-side identity fields evaluated by the central conservative matcher. */
export interface ProviderIdentity {
  artist: string;
  title: string;
  version?: string;
  duration?: number;
  isrc?: string;
  label?: string;
  catalogueNumber?: string;
  /** Album/release title, useful when a provider lacks duration or identifiers. */
  releaseTitle?: string;
  /** Provider release id when it directly references the owned Discogs release. */
  discogsReleaseId?: number;
  /** cratenav recording id when an adapter has already resolved one. */
  recordingId?: string;
}

export interface MatchEvidence {
  artistExact: boolean;
  titleExact: boolean;
  /** Whether the mix/version qualifier matched — decisive for vinyl. */
  versionExact: boolean;
  /** False when neither side supplied a version, so "exact" means no contradiction. */
  versionCompared: boolean;
  /** Absolute duration difference in seconds, when both are known. */
  durationDelta?: number;
  isrcMatch?: boolean;
  labelMatch?: boolean;
  catalogueMatch?: boolean;
  releaseTitleMatch?: boolean;
  releaseMatch?: boolean;
  recordingMatch?: boolean;
}

export interface ProviderMatch {
  providerId: string;
  providerName: string;
  /** 0..1. The caller applies its own threshold; providers do not self-approve. */
  score: number;
  evidence: MatchEvidence;
  identity: ProviderIdentity;
  candidate: AnalysisCandidate;
  /** Provider's own identifier, for re-querying later. */
  externalId?: string;
  externalUrl?: string;
  /** Human-readable account of why this matched, shown in the UI. */
  rationale: string;
  /** Provider policy requires a human check even when identity evidence is strong. */
  verificationRequired?: boolean;
}

/** Raw provider result. It deliberately has no provider-controlled match score. */
export interface ProviderResult {
  identity: ProviderIdentity;
  candidate: AnalysisCandidate;
  externalId?: string;
  externalUrl?: string;
  verificationRequired?: boolean;
}

export interface EnrichmentLookupOptions {
  signal?: AbortSignal;
  /** Maintainer contact used to identify cratenav to community metadata APIs. */
  contact?: string;
  /** Device-local GetSongBPM credential, forwarded only as an upstream header. */
  getSongBpmApiKey?: string;
}

/** Declarative credential field rendered by Analyse without naming an adapter. */
export interface ProviderConfiguration {
  setting: 'metadataContact' | 'getSongBpmApiKey';
  label: string;
  inputType: 'text' | 'password';
  placeholder: string;
  saveLabel: string;
  savedMessage: string;
  clearedMessage: string;
  helpText: string;
  helpUrl?: string;
  helpLinkText?: string;
  sanitize(value: string): string;
  value(settings: Settings): string;
}

export interface EnrichmentProvider {
  readonly id: string;
  readonly name: string;
  /** False when the provider needs credentials that are not configured. */
  readonly available: boolean;
  readonly unavailableReason?: string;
  /** Whether this provider can supply BPM, key, or both. */
  readonly supplies: { bpm: boolean; key: boolean };
  readonly configuration?: ProviderConfiguration;
  /** Credential/configuration gate. Missing configuration must not create a durable attempt. */
  configured?(options: EnrichmentLookupOptions): boolean;

  /**
   * Find candidate matches for a track. Must return an empty array rather than
   * a speculative guess: silence is a valid and often correct answer.
   */
  lookup(context: MatchContext, options?: EnrichmentLookupOptions): Promise<ProviderResult[]>;
}
