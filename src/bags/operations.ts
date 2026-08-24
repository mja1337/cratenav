import type { Bag, BagStatus } from '@/domain/types';
import { newId, nowIso } from '@/utils/ids';

/**
 * Bag lifecycle. Spec §18.
 *
 * A bag is the set of records physically going to a gig, which makes it the
 * search scope during a set. Pure helpers so the rules are testable; storage
 * lives in the repositories.
 */

export function createBag(input: {
  name: string;
  description?: string;
  eventDate?: string;
  collectionItemIds?: readonly string[];
  status?: BagStatus;
}): Bag {
  const timestamp = nowIso();
  return {
    id: newId('bag'),
    createdAt: timestamp,
    updatedAt: timestamp,
    version: 1,
    name: input.name.trim() || 'Untitled bag',
    description: input.description,
    eventDate: input.eventDate,
    collectionItemIds: [...(input.collectionItemIds ?? [])],
    status: input.status ?? 'planning',
  };
}

/** Copy a bag's contents into a new one. Spec §18: duplicate and reuse. */
export function duplicateBag(source: Bag, name?: string): Bag {
  return createBag({
    name: name ?? `${source.name} (copy)`,
    description: source.description,
    collectionItemIds: source.collectionItemIds,
    status: 'planning',
  });
}

function touch(bag: Bag): Bag {
  return { ...bag, updatedAt: nowIso(), version: bag.version + 1 };
}

export function addToBag(bag: Bag, collectionItemIds: readonly string[]): Bag {
  // Set semantics: a record is either in the bag or it is not. Two physical
  // copies are two different collection items, so they add separately.
  const merged = new Set([...bag.collectionItemIds, ...collectionItemIds]);
  if (merged.size === bag.collectionItemIds.length) return bag;
  return touch({ ...bag, collectionItemIds: [...merged] });
}

export function removeFromBag(bag: Bag, collectionItemIds: readonly string[]): Bag {
  const removing = new Set(collectionItemIds);
  const remaining = bag.collectionItemIds.filter((id) => !removing.has(id));
  if (remaining.length === bag.collectionItemIds.length) return bag;
  return touch({ ...bag, collectionItemIds: remaining });
}

export function toggleInBag(bag: Bag, collectionItemId: string): Bag {
  return bag.collectionItemIds.includes(collectionItemId)
    ? removeFromBag(bag, [collectionItemId])
    : addToBag(bag, [collectionItemId]);
}

export function renameBag(bag: Bag, name: string): Bag {
  const trimmed = name.trim();
  if (!trimmed || trimmed === bag.name) return bag;
  return touch({ ...bag, name: trimmed });
}

export function setBagStatus(bag: Bag, status: BagStatus): Bag {
  if (bag.status === status) return bag;
  return touch({ ...bag, status });
}

/**
 * Make one bag active.
 *
 * Exactly one bag can be active, because "the active bag" is what live mode and
 * recommendations default to. Returns every bag that changed so the caller can
 * persist them together.
 */
export function activate(bags: readonly Bag[], bagId: string): Bag[] {
  const changed: Bag[] = [];
  for (const bag of bags) {
    if (bag.id === bagId && bag.status !== 'active') {
      changed.push(setBagStatus(bag, 'active'));
    } else if (bag.id !== bagId && bag.status === 'active') {
      // Demote the previous holder rather than archiving it.
      changed.push(setBagStatus(bag, 'planning'));
    }
  }
  return changed;
}

export function activeBag(bags: readonly Bag[]): Bag | undefined {
  return bags.find((bag) => bag.status === 'active' && !bag.deletedAt);
}

/** Sort for the bag list: active first, then planning, then archived. */
export function sortBags(bags: readonly Bag[]): Bag[] {
  const rank: Record<BagStatus, number> = { active: 0, planning: 1, archived: 2 };
  return [...bags]
    .filter((bag) => !bag.deletedAt)
    .sort(
      (a, b) =>
        rank[a.status] - rank[b.status] ||
        (b.eventDate ?? '').localeCompare(a.eventDate ?? '') ||
        b.updatedAt.localeCompare(a.updatedAt),
    );
}
