/** Identifier and timestamp helpers. Kept trivial and dependency-free. */

/**
 * Prefixed unique id. The prefix makes log output and IndexedDB inspection
 * readable, which matters a lot when debugging a 549-release import.
 */
export function newId(prefix: string): string {
  return `${prefix}_${crypto.randomUUID()}`;
}

export function nowIso(): string {
  return new Date().toISOString();
}

/** Stable deterministic id, for rows derived from an external key. */
export function derivedId(prefix: string, ...parts: (string | number)[]): string {
  return `${prefix}_${parts.join('-')}`;
}
