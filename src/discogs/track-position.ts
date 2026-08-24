/**
 * Discogs does not give each tracklist row a medium field. On mixed-media
 * releases, CD entries are conventionally positioned as `CD1`, `CD-1`,
 * `CD 1`, etc. Keep this deliberately narrow: numeric disc positions can be
 * vinyl, and should never be hidden by Vinyl-only mode.
 */
export function isCdTrackPosition(position: string): boolean {
  return /^CD(?:[ ._-]*\d+)?$/i.test(position.trim());
}

/** A stable description of one physical vinyl record within a release. */
export interface PhysicalRecord {
  /** One-based in tracklist order. Stored on CollectionItem when missing. */
  number: number;
  /** Side labels observed on this record, for example A / B or C / D. */
  sides: string[];
  trackIds: string[];
}
