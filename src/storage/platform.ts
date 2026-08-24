/**
 * Platform capability abstractions. Spec §40.
 *
 * Every browser-specific API the app touches is funnelled through one of these
 * interfaces so a Capacitor build can swap in a native implementation without
 * business logic changing. Browser implementations live here; native ones will
 * be registered alongside them later.
 */

export interface DeviceInfo {
  /** Stable per-device identifier, used for sync conflict attribution. */
  deviceId: string;
  platform: 'web' | 'android' | 'ios';
  isStandalone: boolean;
  isTouch: boolean;
}

export interface ScreenWakeLock {
  readonly supported: boolean;
  readonly active: boolean;
  request(): Promise<boolean>;
  release(): Promise<void>;
}

export interface FileAccess {
  /** Offer a file to the user for download. */
  save(filename: string, contents: Blob | string): Promise<void>;
  /** Prompt the user to pick a file and return its text. */
  openText(accept: string): Promise<{ name: string; text: string } | null>;
}

export interface ShareTarget {
  readonly supported: boolean;
  share(data: { title?: string; text?: string; url?: string }): Promise<boolean>;
}

// --- browser implementations -------------------------------------------------

const DEVICE_ID_KEY = 'cratenav.deviceId';

export function createDeviceInfo(): DeviceInfo {
  let deviceId = localStorage.getItem(DEVICE_ID_KEY);
  if (!deviceId) {
    deviceId = crypto.randomUUID();
    localStorage.setItem(DEVICE_ID_KEY, deviceId);
  }
  return {
    deviceId,
    platform: 'web',
    isStandalone:
      window.matchMedia('(display-mode: standalone)').matches ||
      // iOS Safari does not implement display-mode.
      (navigator as { standalone?: boolean }).standalone === true,
    isTouch: window.matchMedia('(hover: none) and (pointer: coarse)').matches,
  };
}

export function createWakeLock(): ScreenWakeLock {
  type SentinelLike = { release: () => Promise<void>; addEventListener: (t: string, f: () => void) => void };
  const api = (navigator as { wakeLock?: { request(type: 'screen'): Promise<SentinelLike> } }).wakeLock;
  let sentinel: SentinelLike | null = null;

  return {
    get supported() {
      return Boolean(api);
    },
    get active() {
      return sentinel !== null;
    },
    async request() {
      if (!api) return false;
      try {
        sentinel = await api.request('screen');
        sentinel.addEventListener('release', () => {
          sentinel = null;
        });
        return true;
      } catch {
        return false;
      }
    },
    async release() {
      await sentinel?.release().catch(() => undefined);
      sentinel = null;
    },
  };
}

export function createFileAccess(): FileAccess {
  return {
    async save(filename, contents) {
      const blob = typeof contents === 'string'
        ? new Blob([contents], { type: 'application/json;charset=utf-8' })
        : contents;
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = filename;
      anchor.rel = 'noopener';
      document.body.append(anchor);
      anchor.click();
      anchor.remove();
      // Revoke on the next tick so the download has started.
      setTimeout(() => URL.revokeObjectURL(url), 10_000);
    },

    openText(accept) {
      return new Promise((resolve) => {
        const input = document.createElement('input');
        input.type = 'file';
        input.id = 'library-backup-file';
        input.name = 'libraryBackupFile';
        input.accept = accept;
        input.addEventListener('change', async () => {
          const file = input.files?.[0];
          if (!file) {
            resolve(null);
            return;
          }
          resolve({ name: file.name, text: await file.text() });
        });
        // If the user cancels, no change event fires; resolve on window focus.
        input.addEventListener('cancel', () => resolve(null));
        input.click();
      });
    },
  };
}

export function createShareTarget(): ShareTarget {
  return {
    get supported() {
      return typeof navigator.share === 'function';
    },
    async share(data) {
      if (typeof navigator.share !== 'function') return false;
      try {
        await navigator.share(data);
        return true;
      } catch {
        return false;
      }
    },
  };
}

/** The single platform bundle the app consumes. */
export interface Platform {
  device: DeviceInfo;
  wakeLock: ScreenWakeLock;
  files: FileAccess;
  share: ShareTarget;
}

export function createBrowserPlatform(): Platform {
  return {
    device: createDeviceInfo(),
    wakeLock: createWakeLock(),
    files: createFileAccess(),
    share: createShareTarget(),
  };
}
