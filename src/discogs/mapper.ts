import type {
  Artwork,
  CollectionItem,
  ExternalReference,
  Release,
  ReleaseFormat,
  ReleaseIdentifier,
  Track,
} from '@/domain/types';
import type {
  DiscogsArtistRef,
  DiscogsBasicInformation,
  DiscogsCollectionInstance,
  DiscogsRelease,
  DiscogsTrack,
} from './api-types';
import { newId, nowIso } from '@/utils/ids';
import { deduplicateReferences } from './references';

/**
 * Discogs wire format -> cratenav domain model.
 *
 * This is the only place Discogs shapes are allowed to appear. Everything here
 * is defensive: the pressings this app targets (90s promos, white labels,
 * obscure imports) frequently have missing artists, blank positions and
 * malformed durations.
 */

/** Current mapping logic version. Bump to force re-hydration of every release. */
export const METADATA_VERSION = 1;

/**
 * Join Discogs artist refs into a display string, honouring the `join` field
 * and the "as credited" name variation. Discogs also disambiguates duplicate
 * artist names with a trailing "(2)", which we strip for display.
 */
export function formatArtists(artists: readonly DiscogsArtistRef[] | undefined): string {
  if (!artists?.length) return 'Unknown Artist';

  let out = '';
  artists.forEach((artist, index) => {
    const name = (artist.anv?.trim() || artist.name?.trim() || '').replace(/\s*\(\d+\)$/, '');
    if (!name) return;
    out += name;
    const join = artist.join?.trim();
    if (index < artists.length - 1) {
      // A bare comma needs no leading space; words like "feat." do.
      out += join ? (join === ',' ? ', ' : ` ${join} `) : ', ';
    }
  });
  return out.trim().replace(/[,\s]+$/, '') || 'Unknown Artist';
}

/** Discogs "3:32" / "1:02:15" / "" -> seconds, or undefined. */
export function parseDuration(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const parts = value.trim().split(':').map((p) => Number(p));
  if (!parts.length || parts.some((p) => !Number.isFinite(p) || p < 0)) return undefined;
  const seconds = parts.reduce((total, part) => total * 60 + part, 0);
  return seconds > 0 ? seconds : undefined;
}

/**
 * Pull a remix/version qualifier out of a track title.
 * Vinyl titles carry this in brackets: "Try Me Out (Sunship Refix)".
 * Spec §8 requires distinguishing versions, so we keep it as its own field.
 */
export function extractMixVersion(title: string): { title: string; mixVersion?: string } {
  const trimmed = title.trim();
  const closer = trimmed.at(-1);
  if (closer !== ')' && closer !== ']') return { title: trimmed };

  // Scan back for the bracket that opens the trailing group, counting depth.
  // Real tracklists nest: Artful Dodger's "Re-Rewind ... (Bump 'N' Flex
  // (Sweet 'N' Low Mix))" must yield the whole outer group, not the inner one.
  const opener = closer === ')' ? '(' : '[';
  let depth = 0;
  let openIndex = -1;
  for (let i = trimmed.length - 1; i >= 0; i -= 1) {
    const char = trimmed[i];
    if (char === closer) depth += 1;
    else if (char === opener) {
      depth -= 1;
      if (depth === 0) {
        openIndex = i;
        break;
      }
    }
  }
  if (openIndex <= 0) return { title: trimmed };

  const base = trimmed.slice(0, openIndex).trim();
  const qualifier = trimmed.slice(openIndex + 1, -1).trim();
  if (!base || !qualifier) return { title: trimmed };

  // Brackets are also used for things that are not versions ("(Explicit)", or
  // part of the actual title), so only split on a recognisable version word.
  const VERSION_HINT =
    /\b(mix|remix|rmx|refix|dub|edit|version|vip|instrumental|acapella|a cappella|vocal|original|extended|radio|club|remaster|re-?edit|bootleg|flip|rework|take|part|pt|feat\.?|featuring)\b/i;
  if (!VERSION_HINT.test(qualifier)) return { title: trimmed };

  return { title: base, mixVersion: qualifier };
}

function mapFormats(release: DiscogsRelease | DiscogsBasicInformation): ReleaseFormat[] {
  return (release.formats ?? []).map((format) => ({
    name: format.name,
    qty: format.qty,
    text: format.text,
    descriptions: format.descriptions ?? [],
  }));
}

function mapArtwork(release: DiscogsRelease): Artwork[] {
  const images = release.images ?? [];
  if (images.length) {
    return images.map((image) => ({
      uri: image.uri,
      uri150: image.uri150,
      type: image.type,
      width: image.width,
      height: image.height,
    }));
  }
  // Releases with no image array may still have a thumb.
  return release.thumb ? [{ uri: release.thumb, uri150: release.thumb, type: 'primary' }] : [];
}

function mapIdentifiers(release: DiscogsRelease): ReleaseIdentifier[] {
  return (release.identifiers ?? []).map((identifier) => ({
    type: identifier.type,
    value: identifier.value,
    description: identifier.description,
  }));
}

function mapReferences(release: DiscogsRelease): ExternalReference[] {
  // Reference/verification aids only. Explicitly NOT an audio source. Spec §33.
  return deduplicateReferences(
    (release.videos ?? [])
      .filter((video): video is typeof video & { uri: string } => Boolean(video.uri))
      .map((video) => ({
        kind: 'video' as const,
        uri: video.uri,
        title: video.title,
        duration: video.duration,
      })),
  );
}

/**
 * Sort key for browsing. Discogs' own `artists_sort` is best when present;
 * otherwise we strip a leading article so "The Prodigy" files under P.
 */
export function artistSortKey(artist: string, artistsSort?: string): string {
  const base = (artistsSort?.trim() || artist).toLowerCase();
  return base.replace(/^(the|a|an)\s+/, '');
}

/** Build a stub Release from the collection endpoint's basic_information. */
export function mapBasicInformationToRelease(basic: DiscogsBasicInformation): Release {
  const artist = formatArtists(basic.artists);
  const timestamp = nowIso();
  const label = basic.labels?.[0];

  return {
    id: newId('rel'),
    createdAt: timestamp,
    updatedAt: timestamp,
    version: 1,
    discogsReleaseId: basic.id,
    discogsMasterId: basic.master_id || undefined,
    artist,
    artistSort: artistSortKey(artist),
    title: basic.title?.trim() || 'Untitled',
    label: label?.name,
    catalogueNumber: label?.catno,
    year: basic.year || undefined,
    formats: mapFormats(basic),
    genres: basic.genres ?? [],
    styles: basic.styles ?? [],
    identifiers: [],
    // basic_information gives us a usable cover immediately, so the grid is
    // populated before any per-release hydration happens.
    artwork: basic.cover_image || basic.thumb
      ? [{ uri: basic.cover_image ?? basic.thumb, uri150: basic.thumb, type: 'primary' }]
      : [],
    trackIds: [],
    references: [],
    metadataLastSyncedAt: null,
    metadataVersion: METADATA_VERSION,
    hydrationState: 'stub',
  } as Release;
}

/** Merge a full /releases/{id} response into an existing Release row. */
export function mergeFullRelease(existing: Release, full: DiscogsRelease): Release {
  const artist = formatArtists(full.artists);
  const label = full.labels?.[0];

  return {
    ...existing,
    // Discogs may have improved a white-label entry since we first saw it.
    // Catalogue identity is theirs to own, so we take the update. Our own
    // analysis lives in separate stores and is untouched. Spec §5, §24.
    artist,
    artistSort: artistSortKey(artist, full.artists_sort),
    title: full.title?.trim() || existing.title,
    label: label?.name ?? existing.label,
    catalogueNumber: label?.catno ?? existing.catalogueNumber,
    year: full.year || existing.year,
    country: full.country,
    formats: mapFormats(full).length ? mapFormats(full) : existing.formats,
    genres: full.genres ?? existing.genres,
    styles: full.styles ?? existing.styles,
    identifiers: mapIdentifiers(full),
    artwork: mapArtwork(full).length ? mapArtwork(full) : existing.artwork,
    references: mapReferences(full),
    releaseNotes: full.notes,
    credits: full.extraartists ?? [],
    discogsMasterId: full.master_id || existing.discogsMasterId,
    discogsDateChanged: full.date_changed,
    metadataLastSyncedAt: nowIso(),
    metadataVersion: METADATA_VERSION,
    hydrationState: 'hydrated',
    hydrationError: undefined,
    updatedAt: nowIso(),
    version: existing.version + 1,
  };
}

/**
 * Flatten a Discogs tracklist into Track rows.
 *
 * Three entry types appear in `type_`:
 *   - "track"   a real track
 *   - "heading" a section label ("Side A", "Bonus Beats") with no audio
 *   - "index"   a grouping whose `sub_tracks` hold the real titles
 *
 * Multi-track 12"s in this collection are full of headings and index entries,
 * so treating every row as a track would invent tracks that do not exist.
 */
export function mapTracklist(release: Release, tracklist: readonly DiscogsTrack[] | undefined): Track[] {
  const tracks: Track[] = [];
  let sequence = 0;

  const visit = (entry: DiscogsTrack, inheritedPosition?: string): void => {
    const type = entry.type_ ?? 'track';

    if (type === 'heading') return; // no audio, nothing to analyse

    if (type === 'index' || (entry.sub_tracks?.length ?? 0) > 0) {
      // Recurse into the real titles, keeping the parent's vinyl position.
      for (const sub of entry.sub_tracks ?? []) {
        visit(sub, entry.position?.trim() || inheritedPosition);
      }
      return;
    }

    const rawTitle = entry.title?.trim();
    if (!rawTitle) return;

    const { title, mixVersion } = extractMixVersion(rawTitle);
    const timestamp = nowIso();

    // Track-level artists override the release artist on compilations and
    // split releases — common on jungle various-artists 12"s.
    const trackArtist = entry.artists?.length ? formatArtists(entry.artists) : release.artist;

    tracks.push({
      id: newId('trk'),
      createdAt: timestamp,
      updatedAt: timestamp,
      version: 1,
      releaseId: release.id,
      // A blank position is normal on single-sided promos; fall back to the
      // parent index position, then to a synthetic ordinal.
      position: entry.position?.trim() || inheritedPosition || String(sequence + 1),
      artist: trackArtist,
      title,
      mixVersion,
      duration: parseDuration(entry.duration),
      discogsMetadata: entry,
      sequence: sequence++,
    });
  };

  for (const entry of tracklist ?? []) visit(entry);
  return tracks;
}

/** Map one owned copy. Conditions/notes require an authenticated request. */
export function mapCollectionInstance(
  instance: DiscogsCollectionInstance,
  fieldMap: { media?: number; sleeve?: number; notes?: number },
  copyIndex = 0,
): CollectionItem {
  const timestamp = nowIso();
  const noteFor = (fieldId: number | undefined): string | undefined => {
    if (fieldId === undefined) return undefined;
    return instance.notes?.find((note) => note.field_id === fieldId)?.value || undefined;
  };

  return {
    id: newId('col'),
    createdAt: timestamp,
    updatedAt: timestamp,
    version: 1,
    discogsInstanceId: instance.instance_id,
    discogsReleaseId: instance.id,
    collectionFolderId: instance.folder_id,
    dateAdded: instance.date_added,
    rating: instance.rating || undefined,
    mediaCondition: noteFor(fieldMap.media),
    sleeveCondition: noteFor(fieldMap.sleeve),
    notes: noteFor(fieldMap.notes),
    inCollection: true,
    copyIndex,
  };
}

/**
 * Identify which custom field ids carry condition and notes.
 * Discogs seeds new accounts with fields named "Media Condition", "Sleeve
 * Condition" and "Notes", but users rename and reorder them, so we match on
 * name rather than assuming ids 1/2/3.
 */
export function resolveFieldMap(
  fields: readonly { id: number; name?: string }[] | undefined,
): { media?: number; sleeve?: number; notes?: number } {
  const map: { media?: number; sleeve?: number; notes?: number } = {};
  for (const field of fields ?? []) {
    const name = field.name?.toLowerCase() ?? '';
    if (!map.media && name.includes('media') && name.includes('condition')) map.media = field.id;
    else if (!map.sleeve && name.includes('sleeve') && name.includes('condition')) map.sleeve = field.id;
    else if (!map.notes && name.includes('note')) map.notes = field.id;
  }
  return map;
}
