import { Database } from './idb';

export interface BackupStatus {
  supported: boolean;
  configured: boolean;
  fileName?: string;
  permission?: PermissionState;
  lastSavedAt?: string;
  saving: boolean;
  error?: string;
}

export interface BackupFileAccess {
  readonly status: BackupStatus;
  initialise(): Promise<void>;
  choose(contents: string): Promise<boolean>;
  write(contents: string, requestPermission?: boolean): Promise<boolean>;
  disconnect(): Promise<void>;
  subscribe(listener: (status: BackupStatus) => void): () => void;
}

type PermissionFileHandle = FileSystemFileHandle & {
  queryPermission(descriptor: { mode: 'readwrite' }): Promise<PermissionState>;
  requestPermission(descriptor: { mode: 'readwrite' }): Promise<PermissionState>;
};

type SavePickerWindow = Window & {
  showSaveFilePicker?: (options: {
    suggestedName?: string;
    types?: Array<{
      description: string;
      accept: Record<string, string[]>;
    }>;
  }) => Promise<FileSystemFileHandle>;
};

interface StoredBackup {
  id: 'active';
  handle: PermissionFileHandle;
  fileName: string;
  lastSavedAt?: string;
}

const BACKUP_STORE = 'backup';
const backupDb = new Database('cratenav-backup', 1, [{ name: BACKUP_STORE, keyPath: 'id' }]);

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : 'The backup file could not be updated.';
}

/**
 * Maintains one user-selected JSON file through the File System Access API.
 * The handle is structured-cloned into a small, separate IndexedDB database so
 * choosing the file survives reloads without changing the library schema.
 */
export function createBackupFileAccess(): BackupFileAccess {
  const picker = (window as SavePickerWindow).showSaveFilePicker;
  const listeners = new Set<(status: BackupStatus) => void>();
  let record: StoredBackup | undefined;
  let state: BackupStatus = {
    supported: typeof picker === 'function',
    configured: false,
    saving: false,
  };

  const publish = (patch: Partial<BackupStatus>): void => {
    state = { ...state, ...patch };
    for (const listener of listeners) listener({ ...state });
  };

  const permissionFor = async (handle: PermissionFileHandle): Promise<PermissionState> => {
    if (typeof handle.queryPermission !== 'function') return 'granted';
    return handle.queryPermission({ mode: 'readwrite' });
  };

  const saveRecord = async (): Promise<void> => {
    if (record) await backupDb.put(BACKUP_STORE, record);
  };

  return {
    get status() {
      return { ...state };
    },

    async initialise() {
      if (!state.supported) return;
      try {
        await backupDb.open();
        record = await backupDb.get<StoredBackup>(BACKUP_STORE, 'active');
        if (!record) return;
        publish({
          configured: true,
          fileName: record.fileName,
          lastSavedAt: record.lastSavedAt,
          permission: await permissionFor(record.handle),
          error: undefined,
        });
      } catch (error) {
        publish({ error: messageOf(error) });
      }
    },

    async choose(contents) {
      if (!picker) return false;
      try {
        const handle = await picker.call(window, {
          suggestedName: 'cratenav-library-backup.json',
          types: [{
            description: 'CrateNav library backup',
            accept: { 'application/json': ['.json'] },
          }],
        }) as PermissionFileHandle;
        record = { id: 'active', handle, fileName: handle.name };
        await saveRecord();
        publish({
          configured: true,
          fileName: handle.name,
          permission: 'granted',
          error: undefined,
        });
        return this.write(contents, true);
      } catch (error) {
        if (error instanceof DOMException && error.name === 'AbortError') return false;
        publish({ error: messageOf(error), saving: false });
        return false;
      }
    },

    async write(contents, requestPermission = false) {
      if (!record) return false;
      try {
        let permission = await permissionFor(record.handle);
        if (permission === 'prompt' && requestPermission && typeof record.handle.requestPermission === 'function') {
          permission = await record.handle.requestPermission({ mode: 'readwrite' });
        }
        if (permission !== 'granted') {
          publish({ permission, error: undefined, saving: false });
          return false;
        }

        publish({ permission, saving: true, error: undefined });
        const writable = await record.handle.createWritable();
        await writable.write(new Blob([contents], { type: 'application/json;charset=utf-8' }));
        await writable.close();
        record.lastSavedAt = new Date().toISOString();
        await saveRecord();
        publish({ lastSavedAt: record.lastSavedAt, saving: false, error: undefined });
        return true;
      } catch (error) {
        publish({ error: messageOf(error), saving: false });
        return false;
      }
    },

    async disconnect() {
      record = undefined;
      if (state.supported) {
        await backupDb.open();
        await backupDb.delete(BACKUP_STORE, 'active');
      }
      state = { supported: state.supported, configured: false, saving: false };
      for (const listener of listeners) listener({ ...state });
    },

    subscribe(listener) {
      listeners.add(listener);
      listener({ ...state });
      return () => listeners.delete(listener);
    },
  };
}
