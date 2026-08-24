export interface GoogleDriveBackupStatus {
  available: boolean;
  connected: boolean;
  hasBackup: boolean;
  automatic: boolean;
  saving: boolean;
  fileName: string;
  lastSavedAt?: string;
  error?: string;
}

export interface GoogleDriveBackupAccess {
  readonly status: GoogleDriveBackupStatus;
  connect(): Promise<boolean>;
  write(contents: string): Promise<boolean>;
  read(): Promise<string | null>;
  disconnect(): void;
  subscribe(listener: (status: GoogleDriveBackupStatus) => void): () => void;
}

interface TokenResponse {
  access_token?: string;
  expires_in?: number;
  error?: string;
  error_description?: string;
}

interface TokenClient {
  requestAccessToken(options?: { prompt?: string }): void;
}

interface GoogleIdentity {
  accounts: {
    oauth2: {
      initTokenClient(config: {
        client_id: string;
        scope: string;
        callback: (response: TokenResponse) => void;
        error_callback?: (error: { type?: string }) => void;
      }): TokenClient;
    };
  };
}

interface GoogleWindow extends Window {
  google?: GoogleIdentity;
}

interface DriveFile {
  id: string;
  name: string;
  modifiedTime?: string;
}

const DRIVE_SCOPE = 'https://www.googleapis.com/auth/drive.file';
const BACKUP_NAME = 'cratenav-library-backup.json';
const FILE_ID_KEY = 'cratenav.googleDriveBackupFileId';
const GIS_SCRIPT = 'https://accounts.google.com/gsi/client';

let scriptPromise: Promise<void> | undefined;

function loadGoogleIdentity(): Promise<void> {
  const googleWindow = window as GoogleWindow;
  if (googleWindow.google?.accounts.oauth2) return Promise.resolve();
  if (scriptPromise) return scriptPromise;
  scriptPromise = new Promise((resolve, reject) => {
    const existing = document.querySelector<HTMLScriptElement>(`script[src="${GIS_SCRIPT}"]`);
    const script = existing ?? document.createElement('script');
    script.addEventListener('load', () => resolve(), { once: true });
    script.addEventListener('error', () => reject(new Error('Google sign-in could not be loaded.')), { once: true });
    if (!existing) {
      script.src = GIS_SCRIPT;
      script.async = true;
      script.defer = true;
      document.head.append(script);
    }
  });
  return scriptPromise;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'Google Drive backup failed.';
}

/**
 * Browser-only Google Drive backup. Access tokens remain in memory and the
 * drive.file scope limits CrateNav to files it created or the user opened with
 * the app. The JSON is visible in My Drive and may be moved without breaking
 * updates because subsequent writes use its stable file id.
 */
export function createGoogleDriveBackupAccess(clientId: string | undefined): GoogleDriveBackupAccess {
  const listeners = new Set<(status: GoogleDriveBackupStatus) => void>();
  const configuredClientId = clientId?.trim();
  let token: string | undefined;
  let tokenExpiresAt = 0;
  let fileId = localStorage.getItem(FILE_ID_KEY) ?? undefined;
  let state: GoogleDriveBackupStatus = {
    available: Boolean(configuredClientId),
    connected: false,
    hasBackup: false,
    automatic: false,
    saving: false,
    fileName: BACKUP_NAME,
  };

  const publish = (patch: Partial<GoogleDriveBackupStatus>): void => {
    state = { ...state, ...patch };
    for (const listener of listeners) listener({ ...state });
  };

  const requireToken = (): string => {
    if (!token || Date.now() >= tokenExpiresAt) {
      token = undefined;
      publish({ connected: false, automatic: false, saving: false, error: 'Google Drive session expired. Reconnect to continue backups.' });
      throw new Error('Google Drive session expired.');
    }
    return token;
  };

  const driveFetch = async (url: string, init: RequestInit = {}): Promise<Response> => {
    const response = await fetch(url, {
      ...init,
      headers: {
        Authorization: `Bearer ${requireToken()}`,
        ...(init.headers ?? {}),
      },
    });
    if (response.status === 401) {
      token = undefined;
      publish({ connected: false, automatic: false, saving: false, error: 'Google Drive session expired. Reconnect to continue backups.' });
    }
    if (!response.ok) {
      const detail = await response.text().catch(() => '');
      throw new Error(`Google Drive returned ${response.status}${detail ? `: ${detail.slice(0, 180)}` : ''}`);
    }
    return response;
  };

  const findBackup = async (): Promise<DriveFile | undefined> => {
    const marker = "appProperties has { key='cratenavBackup' and value='primary' } and trashed=false";
    const url = new URL('https://www.googleapis.com/drive/v3/files');
    url.searchParams.set('q', marker);
    url.searchParams.set('spaces', 'drive');
    url.searchParams.set('pageSize', '10');
    url.searchParams.set('orderBy', 'modifiedTime desc');
    url.searchParams.set('fields', 'files(id,name,modifiedTime)');
    const response = await driveFetch(url.toString());
    const payload = await response.json() as { files?: DriveFile[] };
    const file = payload.files?.[0];
    if (file) {
      fileId = file.id;
      localStorage.setItem(FILE_ID_KEY, file.id);
      publish({ hasBackup: true, fileName: file.name, lastSavedAt: file.modifiedTime });
    } else {
      fileId = undefined;
      localStorage.removeItem(FILE_ID_KEY);
      publish({ hasBackup: false, lastSavedAt: undefined });
    }
    return file;
  };

  const createBackup = async (contents: string): Promise<DriveFile> => {
    const boundary = `cratenav_${crypto.randomUUID().replaceAll('-', '')}`;
    const metadata = JSON.stringify({
      name: BACKUP_NAME,
      mimeType: 'application/json',
      appProperties: { cratenavBackup: 'primary' },
    });
    const body = new Blob([
      `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n`,
      metadata,
      `\r\n--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n`,
      contents,
      `\r\n--${boundary}--`,
    ]);
    const response = await driveFetch(
      'https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id,name,modifiedTime',
      {
        method: 'POST',
        headers: { 'Content-Type': `multipart/related; boundary=${boundary}` },
        body,
      },
    );
    return response.json() as Promise<DriveFile>;
  };

  const updateBackup = async (id: string, contents: string): Promise<DriveFile> => {
    const response = await driveFetch(
      `https://www.googleapis.com/upload/drive/v3/files/${encodeURIComponent(id)}?uploadType=media&fields=id,name,modifiedTime`,
      {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json; charset=UTF-8' },
        body: contents,
      },
    );
    return response.json() as Promise<DriveFile>;
  };

  return {
    get status() {
      return { ...state };
    },

    async connect() {
      if (!configuredClientId) return false;
      try {
        await loadGoogleIdentity();
        return await new Promise<boolean>((resolve) => {
          const googleIdentity = (window as GoogleWindow).google;
          if (!googleIdentity) {
            publish({ error: 'Google sign-in did not initialise.' });
            resolve(false);
            return;
          }
          let settled = false;
          const finish = (value: boolean): void => {
            if (settled) return;
            settled = true;
            resolve(value);
          };
          const client = googleIdentity.accounts.oauth2.initTokenClient({
            client_id: configuredClientId,
            scope: DRIVE_SCOPE,
            callback: (response) => {
              if (!response.access_token || response.error) {
                publish({ error: response.error_description ?? response.error ?? 'Google authorization failed.' });
                finish(false);
                return;
              }
              token = response.access_token;
              tokenExpiresAt = Date.now() + Math.max(60, (response.expires_in ?? 3_600) - 60) * 1_000;
              publish({ connected: true, error: undefined });
              void findBackup().then(() => finish(true)).catch((error) => {
                publish({ error: errorMessage(error) });
                finish(false);
              });
            },
            error_callback: (error) => {
              publish({ error: error.type === 'popup_closed' ? 'Google sign-in was closed.' : 'Google sign-in could not open.' });
              finish(false);
            },
          });
          client.requestAccessToken({ prompt: '' });
        });
      } catch (error) {
        publish({ error: errorMessage(error) });
        return false;
      }
    },

    async write(contents) {
      if (!state.connected) return false;
      publish({ saving: true, error: undefined });
      try {
        let targetId = fileId;
        if (!targetId) targetId = (await findBackup())?.id;
        let file: DriveFile;
        try {
          file = targetId ? await updateBackup(targetId, contents) : await createBackup(contents);
        } catch (error) {
          // A locally remembered id can disappear if the user deletes the file.
          if (!targetId || !(error instanceof Error) || !error.message.includes('404')) throw error;
          fileId = undefined;
          localStorage.removeItem(FILE_ID_KEY);
          file = await createBackup(contents);
        }
        fileId = file.id;
        localStorage.setItem(FILE_ID_KEY, file.id);
        publish({
          saving: false,
          hasBackup: true,
          automatic: true,
          fileName: file.name || BACKUP_NAME,
          lastSavedAt: file.modifiedTime ?? new Date().toISOString(),
          error: undefined,
        });
        return true;
      } catch (error) {
        publish({ saving: false, error: errorMessage(error) });
        return false;
      }
    },

    async read() {
      if (!state.connected) return null;
      try {
        let targetId = fileId;
        if (!targetId) targetId = (await findBackup())?.id;
        if (!targetId) return null;
        const response = await driveFetch(
          `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(targetId)}?alt=media`,
        );
        return response.text();
      } catch (error) {
        publish({ error: errorMessage(error) });
        return null;
      }
    },

    disconnect() {
      token = undefined;
      tokenExpiresAt = 0;
      publish({ connected: false, automatic: false, saving: false, error: undefined });
    },

    subscribe(listener) {
      listeners.add(listener);
      listener({ ...state });
      return () => listeners.delete(listener);
    },
  };
}
