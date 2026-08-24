/**
 * Discogs API response shapes.
 *
 * These mirror the wire format and must not leak past /src/discogs/mapper.ts.
 * Everything is optional: this API is generous with missing fields, especially
 * on the obscure white-label and promo pressings this app is built for.
 */

export interface DiscogsPagination {
  page: number;
  pages: number;
  per_page: number;
  items: number;
  urls?: { next?: string; last?: string; prev?: string; first?: string };
}

export interface DiscogsArtistRef {
  name?: string;
  anv?: string; // artist name variation as credited on the record
  id?: number;
  join?: string;
  role?: string;
  tracks?: string;
}

export interface DiscogsLabelRef {
  name?: string;
  catno?: string;
  id?: number;
  entity_type?: string;
}

export interface DiscogsFormat {
  name?: string;
  qty?: string;
  text?: string;
  descriptions?: string[];
}

export interface DiscogsImage {
  type?: string;
  uri?: string;
  uri150?: string;
  resource_url?: string;
  width?: number;
  height?: number;
}

export interface DiscogsIdentifier {
  type?: string;
  value?: string;
  description?: string;
}

export interface DiscogsVideo {
  uri?: string;
  title?: string;
  duration?: number;
  description?: string;
  embed?: boolean;
}

export interface DiscogsTrack {
  position?: string;
  /** "track" | "heading" | "index". Only "track" is a real playable track. */
  type_?: string;
  title?: string;
  duration?: string;
  artists?: DiscogsArtistRef[];
  extraartists?: DiscogsArtistRef[];
  /** Present on "index" entries that group several titles under one position. */
  sub_tracks?: DiscogsTrack[];
}

/** Full response from /releases/{id}. */
export interface DiscogsRelease {
  id: number;
  master_id?: number;
  title?: string;
  artists?: DiscogsArtistRef[];
  artists_sort?: string;
  labels?: DiscogsLabelRef[];
  formats?: DiscogsFormat[];
  country?: string;
  year?: number;
  released?: string;
  genres?: string[];
  styles?: string[];
  identifiers?: DiscogsIdentifier[];
  images?: DiscogsImage[];
  tracklist?: DiscogsTrack[];
  videos?: DiscogsVideo[];
  notes?: string;
  extraartists?: DiscogsArtistRef[];
  companies?: unknown[];
  thumb?: string;
  date_changed?: string;
  data_quality?: string;
  uri?: string;
}

/** The trimmed release summary embedded in a collection instance. */
export interface DiscogsBasicInformation {
  id: number;
  master_id?: number;
  title?: string;
  year?: number;
  artists?: DiscogsArtistRef[];
  labels?: DiscogsLabelRef[];
  formats?: DiscogsFormat[];
  genres?: string[];
  styles?: string[];
  thumb?: string;
  cover_image?: string;
  resource_url?: string;
}

/** A note on a collection instance, keyed to a custom field definition. */
export interface DiscogsInstanceNote {
  field_id: number;
  value: string;
}

/** One owned copy, from /users/{u}/collection/folders/{id}/releases. */
export interface DiscogsCollectionInstance {
  /** Release id. */
  id: number;
  instance_id: number;
  folder_id?: number;
  date_added?: string;
  rating?: number;
  basic_information: DiscogsBasicInformation;
  /** Only returned when authenticated as the collection owner. */
  notes?: DiscogsInstanceNote[];
}

export interface DiscogsCollectionPage {
  pagination: DiscogsPagination;
  releases: DiscogsCollectionInstance[];
}

export interface DiscogsFolder {
  id: number;
  name?: string;
  count?: number;
  resource_url?: string;
}

export interface DiscogsFoldersResponse {
  folders: DiscogsFolder[];
}

/** Custom collection field definition, from /users/{u}/collection/fields. */
export interface DiscogsField {
  id: number;
  name?: string;
  type?: string;
  public?: boolean;
  options?: string[];
}

export interface DiscogsFieldsResponse {
  fields: DiscogsField[];
}

export interface DiscogsIdentity {
  id: number;
  username: string;
  resource_url?: string;
  consumer_name?: string;
}

export interface DiscogsProfile {
  id: number;
  username: string;
  name?: string;
  num_collection?: number;
  num_wantlist?: number;
  avatar_url?: string;
}
