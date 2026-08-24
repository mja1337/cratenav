import type { MatchContext, MatchEvidence, ProviderIdentity } from './provider';

export interface IdentityScore {
  score: number;
  evidence: MatchEvidence;
  rationale: string;
}

function words(value: string | undefined): string {
  return (value ?? '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/\(\d+\)\s*$/, '')
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

function compact(value: string | undefined): string {
  return words(value).replace(/\s+/g, '');
}

function version(value: string | undefined): string {
  return words(value)
    .replace(/\brmx\b/g, 'remix')
    .replace(/\brefix\b/g, 'remix')
    .replace(/\bre edit\b/g, 'reedit')
    .replace(/\bextended version\b/g, 'extended mix');
}

function finiteDuration(value: number | undefined): value is number {
  return value !== undefined && Number.isFinite(value) && value > 0;
}

/**
 * Score a provider identity against the exact vinyl track being enriched.
 *
 * The weights are intentionally fixed rather than normalised over whichever
 * fields happen to be present. That prevents artist + title alone from becoming
 * a misleading 100% match when all pressing/version evidence is absent.
 */
export function scoreIdentity(context: MatchContext, identity: ProviderIdentity): IdentityScore {
  const artistExact = words(context.track.artist) === words(identity.artist);
  const titleExact = words(context.track.title) === words(identity.title);
  const targetVersion = version(context.track.mixVersion);
  const providerVersion = version(identity.version);
  const versionCompared = Boolean(targetVersion || providerVersion);
  const versionExact = versionCompared ? targetVersion === providerVersion : true;

  const durationDelta =
    finiteDuration(context.track.duration) && finiteDuration(identity.duration)
      ? Math.abs(context.track.duration - identity.duration)
      : undefined;
  const targetIsrc = context.recording?.isrc;
  const isrcMatch = targetIsrc && identity.isrc
    ? compact(targetIsrc) === compact(identity.isrc)
    : undefined;
  const labelMatch = context.release.label && identity.label
    ? words(context.release.label) === words(identity.label)
    : undefined;
  const catalogueMatch = context.release.catalogueNumber && identity.catalogueNumber
    ? compact(context.release.catalogueNumber) === compact(identity.catalogueNumber)
    : undefined;
  const releaseTitleMatch = identity.releaseTitle
    ? words(context.release.title) === words(identity.releaseTitle)
    : undefined;
  const releaseMatch = identity.discogsReleaseId !== undefined
    ? context.release.discogsReleaseId === identity.discogsReleaseId
    : undefined;
  const recordingId = context.recording?.id ?? context.track.recordingId;
  const recordingMatch = recordingId && identity.recordingId
    ? recordingId === identity.recordingId
    : undefined;

  const evidence: MatchEvidence = {
    artistExact,
    titleExact,
    versionExact,
    versionCompared,
    durationDelta,
    isrcMatch,
    labelMatch,
    catalogueMatch,
    releaseTitleMatch,
    releaseMatch,
    recordingMatch,
  };

  let score = 0;
  score += artistExact ? 0.2 : -0.35;
  score += titleExact ? 0.22 : -0.35;
  score += versionCompared ? (versionExact ? 0.18 : -0.3) : 0.04;

  if (durationDelta !== undefined) {
    score += durationDelta <= 3 ? 0.1 : durationDelta <= 10 ? 0.07 : durationDelta <= 20 ? 0.03 : -0.18;
  }
  if (isrcMatch !== undefined) score += isrcMatch ? 0.22 : -0.45;
  if (labelMatch !== undefined) score += labelMatch ? 0.04 : -0.04;
  if (catalogueMatch !== undefined) score += catalogueMatch ? 0.08 : -0.08;
  if (releaseTitleMatch !== undefined) score += releaseTitleMatch ? 0.1 : -0.08;
  if (releaseMatch !== undefined) score += releaseMatch ? 0.06 : -0.16;
  if (recordingMatch !== undefined) score += recordingMatch ? 0.25 : -0.45;

  const reasons: string[] = [];
  reasons.push(artistExact ? 'artist matches' : 'artist differs');
  reasons.push(titleExact ? 'title matches' : 'title differs');
  if (versionCompared) reasons.push(versionExact ? 'version matches' : 'version differs');
  else reasons.push('version not supplied');
  if (durationDelta !== undefined) reasons.push(`duration differs by ${Math.round(durationDelta)}s`);
  if (isrcMatch !== undefined) reasons.push(isrcMatch ? 'ISRC matches' : 'ISRC differs');
  if (catalogueMatch !== undefined) reasons.push(catalogueMatch ? 'catalogue matches' : 'catalogue differs');
  if (releaseTitleMatch !== undefined) {
    reasons.push(releaseTitleMatch ? 'release title matches' : 'release title differs');
  }
  if (releaseMatch !== undefined) reasons.push(releaseMatch ? 'exact release matches' : 'release differs');
  if (recordingMatch !== undefined) reasons.push(recordingMatch ? 'recording matches' : 'recording differs');

  return {
    score: Math.round(Math.max(0, Math.min(1, score)) * 1000) / 1000,
    evidence,
    rationale: reasons.join('; '),
  };
}
