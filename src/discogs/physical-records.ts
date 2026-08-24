import type { CollectionItem, Release, Track } from '@/domain/types';
import { isCdTrackPosition, type PhysicalRecord } from './track-position';

interface PositionIdentity {
  explicitRecord?: number;
  side?: string;
}

function positionIdentity(position: string): PositionIdentity {
  const clean = position.trim().toUpperCase();
  if (!clean || isCdTrackPosition(clean)) return {};

  // Numbered multi-disc tracklists commonly use 1-1, 1.1, 2-1, etc.
  const explicit = clean.match(/^(\d+)[ .:_-]+\d/);
  if (explicit) return { explicitRecord: Number(explicit[1]) };

  // Vinyl sides may be A/B, C/D, AA/BB and so on. Pair unique sides in
  // tracklist order rather than assuming AA means a second record: on many UK
  // 12-inches A/AA are the two sides of one physical disc.
  const side = clean.match(/^([A-Z]{1,3})(?:[ .:_-]*\d.*)?$/)?.[1];
  return side ? { side } : {};
}

function vinylQuantity(release: Release): number {
  return release.formats.reduce((total, format) => {
    const name = format.name?.toLowerCase() ?? '';
    if (!name.includes('vinyl') && !name.includes('shellac') && !name.includes('acetate')) {
      return total;
    }
    const quantity = Number(format.qty);
    return total + (Number.isInteger(quantity) && quantity > 0 ? quantity : 1);
  }, 0);
}

/**
 * Infer physical records from Discogs positions without baking the result into
 * catalogue data. Explicit numbered positions win; otherwise successive pairs
 * of unique side labels form record 1, record 2, and so on.
 */
export function physicalRecordsForRelease(
  release: Release,
  tracks: readonly Track[],
): PhysicalRecord[] {
  const identities = tracks.map((track) => ({ track, ...positionIdentity(track.position) }));
  const sides = [...new Set(identities.flatMap((entry) => entry.side ? [entry.side] : []))];
  const sideRecord = new Map<string, number>();
  const standardSides = sides.filter((side) => side.length === 1);
  for (const side of standardSides) {
    sideRecord.set(side, Math.floor((side.charCodeAt(0) - 65) / 2) + 1);
  }
  const standardMaximum = Math.max(0, ...standardSides.map((side) => sideRecord.get(side) ?? 0));
  const alternateSides = sides.filter((side) => side.length > 1);
  // A/AA is a common UK way to label the two sides of one disc. When ordinary
  // A/B sides are also present, AA/BB instead form the next successive pair.
  const alternateStart = standardMaximum === 1 && !standardSides.includes('B') &&
    vinylQuantity(release) <= 1
    ? 1
    : standardMaximum + 1;
  alternateSides.forEach((side, index) => {
    sideRecord.set(side, alternateStart + Math.floor(index / 2));
  });
  const explicitMaximum = Math.max(
    0,
    ...identities.map((entry) => entry.explicitRecord ?? 0),
  );
  const inferredMaximum = Math.max(0, ...sideRecord.values());
  const count = Math.max(vinylQuantity(release), explicitMaximum, inferredMaximum);
  if (count <= 0) return [];

  const records: PhysicalRecord[] = Array.from({ length: count }, (_, index) => ({
    number: index + 1,
    sides: [],
    trackIds: [],
  }));

  for (const entry of identities) {
    const number = entry.explicitRecord ?? (entry.side ? sideRecord.get(entry.side) : undefined);
    if (!number || number > records.length) continue;
    const record = records[number - 1]!;
    record.trackIds.push(entry.track.id);
    if (entry.side && !record.sides.includes(entry.side)) record.sides.push(entry.side);
  }

  return records;
}

export function recordNumberForTrack(
  trackId: string,
  records: readonly PhysicalRecord[],
): number | undefined {
  return records.find((record) => record.trackIds.includes(trackId))?.number;
}

/** Unknown/unmapped positions stay available so inference never hides a tune. */
export function isTrackAvailableOnItem(
  trackId: string,
  records: readonly PhysicalRecord[],
  item: CollectionItem,
): boolean {
  const number = recordNumberForTrack(trackId, records);
  return number === undefined || !(item.missingRecordNumbers ?? []).includes(number);
}

export function isTrackAvailableOnAnyItem(
  trackId: string,
  records: readonly PhysicalRecord[],
  items: readonly CollectionItem[],
): boolean {
  return items.some((item) => item.inCollection && isTrackAvailableOnItem(trackId, records, item));
}
