import type { Store } from './store';
import { exportLibrary } from '@/data/repositories';

const BACKUP_DEBOUNCE_MS = 1_500;

/**
 * Update the configured backup shortly after local state changes settle.
 * IndexedDB remains authoritative; failure or revoked permission never blocks
 * local work and can be repaired from Settings with a user gesture.
 */
export async function startAutomaticBackup(store: Store): Promise<() => void> {
  const backup = store.platform.backup;
  const googleDrive = store.platform.googleDriveBackup;
  if (!backup && !googleDrive) return () => undefined;

  await backup?.initialise();
  let timer: number | undefined;
  let stopped = false;

  const schedule = (): void => {
    const fileReady = backup?.status.configured ?? false;
    const driveReady = Boolean(googleDrive?.status.connected && googleDrive.status.automatic);
    if (stopped || (!fileReady && !driveReady)) return;
    if (timer !== undefined) window.clearTimeout(timer);
    timer = window.setTimeout(() => {
      timer = undefined;
      void exportLibrary()
        .then((contents) => Promise.all([
          fileReady ? backup?.write(contents, false) : undefined,
          driveReady ? googleDrive?.write(contents) : undefined,
        ]))
        .catch(() => undefined);
    }, BACKUP_DEBOUNCE_MS);
  };

  const unsubscribe = store.subscribe(schedule);
  // Refresh a previously configured backup on launch when permission persisted.
  schedule();

  return () => {
    stopped = true;
    if (timer !== undefined) window.clearTimeout(timer);
    unsubscribe();
  };
}
