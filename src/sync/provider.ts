/**
 * Cloud sync provider interface. Spec §25.
 *
 * NOT YET IMPLEMENTED. Google Drive is the intended first implementation, but
 * the interface deliberately says nothing about Drive so a different provider
 * can be dropped in later.
 *
 * Non-negotiable per spec §25: sync is never a runtime dependency. The app opens
 * from IndexedDB, and nothing here may ever block startup or DJing.
 */

export type SyncStatus = 'disconnected' | 'idle' | 'syncing' | 'error' | 'offline';

export interface SyncStatusReport {
  status: SyncStatus;
  lastPushAt?: string;
  lastPullAt?: string;
  /** Changes made locally that have not reached the remote yet. */
  queuedChanges: number;
  error?: string;
}

/**
 * One record's worth of change. Spec §26 forbids overwriting a single giant
 * library file, so the unit of sync is the individual object.
 */
export interface ChangeRecord {
  store: string;
  id: string;
  updatedAt: string;
  version: number;
  updatedByDevice?: string;
  deletedAt?: string | null;
  payload: unknown;
}

export interface MergeConflict {
  store: string;
  id: string;
  local: ChangeRecord;
  remote: ChangeRecord;
}

export interface SyncProvider {
  readonly id: string;
  readonly name: string;

  connect(): Promise<void>;
  disconnect(): Promise<void>;
  status(): Promise<SyncStatusReport>;

  /** Send local changes upward. */
  push(changes: readonly ChangeRecord[]): Promise<void>;
  /** Fetch remote changes since a watermark. */
  pull(since?: string): Promise<ChangeRecord[]>;
  /**
   * Conflicts are surfaced rather than silently resolved: a user-verified BPM
   * losing to a stale remote row would be a real data loss. Spec §10.
   */
  resolve(conflicts: readonly MergeConflict[]): Promise<void>;
}

export class SyncNotConfiguredError extends Error {
  constructor() {
    super('Cloud sync is not implemented yet.');
    this.name = 'SyncNotConfiguredError';
  }
}

export function activeSyncProvider(): SyncProvider | null {
  return null;
}
