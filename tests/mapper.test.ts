import { describe, expect, it } from 'vitest';
import {
  artistSortKey,
  extractMixVersion,
  formatArtists,
  mapBasicInformationToRelease,
  mapCollectionInstance,
  mapTracklist,
  mergeFullRelease,
  parseDuration,
  resolveFieldMap,
} from '@/discogs/mapper';
import type { DiscogsCollectionPage, DiscogsRelease } from '@/discogs/api-types';

import artfulDodger from './fixtures/release-22987.json';
import rusko from './fixtures/release-962772.json';
import commix from './fixtures/release-999889.json';
import sirHiss from './fixtures/release-15831401.json';
import collectionPage from './fixtures/collection-page.json';

/**
 * These run against real API responses captured from the collection this app
 * is being built for — late-90s UK garage, dubstep and D&B 12"s, with the
 * white-label and promo quirks that break naive mapping.
 */

const asRelease = (fixture: unknown) => fixture as unknown as DiscogsRelease;
const page = collectionPage as unknown as DiscogsCollectionPage;

describe('artist formatting', () => {
  it('strips the Discogs duplicate-name disambiguator', () => {
    // Discogs writes "Caspa (3)" to distinguish artists sharing a name.
    expect(formatArtists([{ name: 'Caspa (3)' }])).toBe('Caspa');
    expect(formatArtists([{ name: 'Joker (5)' }])).toBe('Joker');
  });

  it('honours the join field between artists', () => {
    expect(formatArtists([{ name: 'Jakes', join: '/' }, { name: 'Joker (5)' }])).toBe('Jakes / Joker');
    expect(formatArtists([{ name: 'Sunship', join: ',' }, { name: 'Anita Kelsey' }])).toBe(
      'Sunship, Anita Kelsey',
    );
    expect(formatArtists([{ name: 'A', join: 'feat.' }, { name: 'B' }])).toBe('A feat. B');
  });

  it('prefers the as-credited name variation', () => {
    expect(formatArtists([{ name: 'Real Name', anv: 'As Credited' }])).toBe('As Credited');
  });

  it('falls back rather than producing an empty string', () => {
    expect(formatArtists([])).toBe('Unknown Artist');
    expect(formatArtists(undefined)).toBe('Unknown Artist');
    expect(formatArtists([{ name: '' }])).toBe('Unknown Artist');
  });

  it('files artists under the right letter for browsing', () => {
    expect(artistSortKey('The Prodigy')).toBe('prodigy');
    expect(artistSortKey('Artful Dodger')).toBe('artful dodger');
    // Discogs' own sort string wins when present.
    expect(artistSortKey('Various', 'Artful Dodger')).toBe('artful dodger');
  });
});

describe('duration parsing', () => {
  it('parses the formats Discogs emits', () => {
    expect(parseDuration('6:41')).toBe(401);
    expect(parseDuration('5:35')).toBe(335);
    expect(parseDuration('1:02:15')).toBe(3735);
    expect(parseDuration('0:45')).toBe(45);
  });

  it('returns undefined for the blanks that 12" singles usually carry', () => {
    for (const value of ['', '  ', undefined, '-', 'unknown', '0:00']) {
      expect(parseDuration(value as string), `for "${value}"`).toBeUndefined();
    }
  });
});

describe('mix version extraction', () => {
  it('handles the nested brackets on the Artful Dodger 12"', () => {
    // Real title: "Re-Rewind ... (Bump 'N' Flex (Sweet 'N' Low Mix))"
    const result = extractMixVersion(
      "Re-Rewind The Crowd Say Bo Selecta (Bump 'N' Flex (Sweet 'N' Low Mix))",
    );
    expect(result.title).toBe('Re-Rewind The Crowd Say Bo Selecta');
    expect(result.mixVersion).toBe("Bump 'N' Flex (Sweet 'N' Low Mix)");
  });

  it('extracts ordinary version qualifiers', () => {
    expect(extractMixVersion('Cockney Flute (Rusko Rmx)').mixVersion).toBe('Rusko Rmx');
    expect(extractMixVersion('Track (Radio Edit)').mixVersion).toBe('Radio Edit');
    expect(extractMixVersion('Track (Original Mix)').mixVersion).toBe('Original Mix');
    expect(extractMixVersion('Track [Dub]').mixVersion).toBe('Dub');
    expect(extractMixVersion('Track (VIP)').mixVersion).toBe('VIP');
  });

  it('leaves brackets that are not versions alone', () => {
    expect(extractMixVersion('Track (Explicit)').mixVersion).toBeUndefined();
    expect(extractMixVersion('Track (Explicit)').title).toBe('Track (Explicit)');
    expect(extractMixVersion('Fun (2000)').mixVersion).toBeUndefined();
    expect(extractMixVersion('No brackets here').mixVersion).toBeUndefined();
  });
});

describe('tracklist mapping — real releases', () => {
  const stub = (fixture: unknown) =>
    mergeFullRelease(
      mapBasicInformationToRelease({
        id: asRelease(fixture).id,
        title: asRelease(fixture).title,
      }),
      asRelease(fixture),
    );

  it('preserves A/AA white-label side notation', () => {
    // A/AA is standard on one-track-per-side 12"s and must survive verbatim.
    const tracks = mapTracklist(stub(rusko), asRelease(rusko).tracklist);
    expect(tracks.map((t) => t.position)).toEqual(['A', 'AA']);
  });

  it('keeps per-track artists that differ from the release artist', () => {
    // Rusko 12": the AA side is credited to Caspa, not Rusko.
    const tracks = mapTracklist(stub(rusko), asRelease(rusko).tracklist);
    expect(tracks[0]!.artist).toBe('Rusko');
    expect(tracks[1]!.artist).toBe('Caspa');
    expect(tracks[1]!.title).toBe('Cockney Flute');
    expect(tracks[1]!.mixVersion).toBe('Rusko Rmx');
  });

  it('maps numbered positions on a multi-track side', () => {
    const tracks = mapTracklist(stub(artfulDodger), asRelease(artfulDodger).tracklist);
    expect(tracks.map((t) => t.position)).toEqual(['A1', 'A2', 'B']);
    expect(tracks.every((t) => t.title === 'Re-Rewind The Crowd Say Bo Selecta')).toBe(true);
    // Three different mixes of the same song — exactly the version
    // distinction spec §8 insists on.
    expect(tracks.map((t) => t.mixVersion)).toEqual([
      'Radio Edit',
      "Bump 'N' Flex (Sweet 'N' Low Mix)",
      'Sharp Addiction To DTPM Dub',
    ]);
  });

  it('parses durations when present and tolerates absence', () => {
    const withDurations = mapTracklist(stub(commix), asRelease(commix).tracklist);
    expect(withDurations.map((t) => t.duration)).toEqual([401, 335]);

    const without = mapTracklist(stub(artfulDodger), asRelease(artfulDodger).tracklist);
    expect(without.every((t) => t.duration === undefined)).toBe(true);
  });

  it('assigns a stable sequence and unique ids', () => {
    const tracks = mapTracklist(stub(sirHiss), asRelease(sirHiss).tracklist);
    expect(tracks.map((t) => t.sequence)).toEqual([0, 1, 2]);
    expect(new Set(tracks.map((t) => t.id)).size).toBe(tracks.length);
    expect(tracks.map((t) => t.position)).toEqual(['A', 'B1', 'B2']);
  });

  it('skips heading rows and flattens index sub-tracks', () => {
    // Synthetic, because 12" singles rarely carry them but albums do.
    const release = stub(commix);
    const tracks = mapTracklist(release, [
      { type_: 'heading', title: 'Side A', position: '' },
      { type_: 'track', title: 'Real Track', position: 'A1' },
      {
        type_: 'index',
        position: 'B',
        title: 'Medley',
        sub_tracks: [
          { type_: 'track', title: 'Part One' },
          { type_: 'track', title: 'Part Two' },
        ],
      },
    ]);
    expect(tracks.map((t) => t.title)).toEqual(['Real Track', 'Part One', 'Part Two']);
    // Sub-tracks inherit the parent's vinyl position.
    expect(tracks.map((t) => t.position)).toEqual(['A1', 'B', 'B']);
  });

  it('never emits a track with an empty position', () => {
    const release = stub(commix);
    const tracks = mapTracklist(release, [
      { type_: 'track', title: 'Untitled A', position: '' },
      { type_: 'track', title: 'Untitled B' },
    ]);
    expect(tracks.every((t) => t.position.length > 0)).toBe(true);
  });
});

describe('release mapping — real releases', () => {
  it('builds a browsable stub from basic_information alone', () => {
    const instance = page.releases[0]!;
    const release = mapBasicInformationToRelease(instance.basic_information);

    expect(release.discogsReleaseId).toBe(instance.basic_information.id);
    expect(release.artist).toBeTruthy();
    expect(release.title).toBeTruthy();
    expect(release.hydrationState).toBe('stub');
    expect(release.metadataLastSyncedAt).toBeNull();
    // A cover is available before any per-release hydration, so the grid is
    // never a wall of placeholders.
    expect(release.artwork.length).toBeGreaterThan(0);
    expect(release.trackIds).toEqual([]);
  });

  it('promotes a stub to hydrated without discarding local identity', () => {
    const stub = mapBasicInformationToRelease({
      id: asRelease(commix).id,
      title: 'Old Title',
    });
    const merged = mergeFullRelease(stub, asRelease(commix));

    expect(merged.id).toBe(stub.id);            // identity preserved
    expect(merged.createdAt).toBe(stub.createdAt);
    expect(merged.version).toBe(stub.version + 1);
    expect(merged.hydrationState).toBe('hydrated');
    expect(merged.metadataLastSyncedAt).not.toBeNull();

    // And it took the better catalogue data.
    expect(merged.title).toBe(asRelease(commix).title);
    expect(merged.country).toBe('UK');
    expect(merged.styles).toContain('Drum n Bass');
    expect(merged.discogsDateChanged).toBeTruthy();
  });

  it('captures runout etchings and barcodes for pressing identification', () => {
    const merged = mergeFullRelease(
      mapBasicInformationToRelease({ id: asRelease(commix).id, title: 'x' }),
      asRelease(commix),
    );
    const types = merged.identifiers.map((i) => i.type);
    expect(types).toContain('Barcode');
    // Matrix/runout is how you actually tell white-label pressings apart.
    expect(types).toContain('Matrix / Runout');
  });

  it('stores video references without treating them as audio', () => {
    const merged = mergeFullRelease(
      mapBasicInformationToRelease({ id: asRelease(artfulDodger).id, title: 'x' }),
      asRelease(artfulDodger),
    );
    expect(merged.references.length).toBeGreaterThan(0);
    expect(merged.references.every((r) => r.kind === 'video')).toBe(true);
    expect(merged.references.every((r) => r.uri.startsWith('http'))).toBe(true);
    // The captured API response repeats several URLs even though the Discogs
    // web page shows each video once.
    expect(merged.references.length).toBeLessThan(asRelease(artfulDodger).videos!.length);
    expect(new Set(merged.references.map((reference) => reference.uri)).size).toBe(
      merged.references.length,
    );
  });

  it('deduplicates alternate URL forms for the same YouTube video', () => {
    const full: DiscogsRelease = {
      id: 1,
      title: 'x',
      videos: [
        { uri: 'https://www.youtube.com/watch?v=abc123', title: 'Watch' },
        { uri: 'https://youtu.be/abc123?t=5', title: 'Short URL' },
        { uri: 'https://www.youtube.com/embed/abc123', title: 'Embed' },
      ],
    };
    const merged = mergeFullRelease(mapBasicInformationToRelease({ id: 1, title: 'x' }), full);
    expect(merged.references).toHaveLength(1);
    expect(merged.references[0]?.uri).toBe('https://www.youtube.com/watch?v=abc123');
  });
});

describe('collection instance mapping', () => {
  it('maps the owned-copy fields from a real collection page', () => {
    const instance = page.releases[0]!;
    const item = mapCollectionInstance(instance, {});

    expect(item.discogsInstanceId).toBe(instance.instance_id);
    expect(item.discogsReleaseId).toBe(instance.id);
    expect(item.inCollection).toBe(true);
    expect(item.dateAdded).toBe(instance.date_added);
  });

  it('reads condition and notes out of custom fields', () => {
    const fieldMap = resolveFieldMap([
      { id: 1, name: 'Media Condition' },
      { id: 2, name: 'Sleeve Condition' },
      { id: 3, name: 'Notes' },
    ]);
    expect(fieldMap).toEqual({ media: 1, sleeve: 2, notes: 3 });

    const item = mapCollectionInstance(
      {
        ...page.releases[0]!,
        notes: [
          { field_id: 1, value: 'Very Good Plus (VG+)' },
          { field_id: 2, value: 'Generic' },
          { field_id: 3, value: 'slight warp, plays fine' },
        ],
      },
      fieldMap,
    );
    expect(item.mediaCondition).toBe('Very Good Plus (VG+)');
    expect(item.sleeveCondition).toBe('Generic');
    expect(item.notes).toBe('slight warp, plays fine');
  });

  it('matches renamed and reordered custom fields', () => {
    // Users rename these, so we must not assume ids 1/2/3.
    expect(resolveFieldMap([
      { id: 7, name: 'My Notes' },
      { id: 4, name: 'sleeve condition' },
      { id: 9, name: 'MEDIA CONDITION' },
    ])).toEqual({ media: 9, sleeve: 4, notes: 7 });
  });

  it('copes with no custom fields at all (unauthenticated sync)', () => {
    const item = mapCollectionInstance(page.releases[0]!, resolveFieldMap(undefined));
    expect(item.mediaCondition).toBeUndefined();
    expect(item.notes).toBeUndefined();
    expect(item.inCollection).toBe(true);
  });

  it('distinguishes duplicate copies of the same release', () => {
    const first = mapCollectionInstance(page.releases[0]!, {}, 0);
    const second = mapCollectionInstance(page.releases[0]!, {}, 1);
    expect(first.copyIndex).toBe(0);
    expect(second.copyIndex).toBe(1);
    expect(first.id).not.toBe(second.id);
  });
});
