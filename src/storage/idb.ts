/**
 * Minimal promise wrapper over IndexedDB. Zero runtime dependencies.
 *
 * Deliberately small and generic: the app talks to repositories in /src/data,
 * never to this file directly. That keeps the door open for a Capacitor SQLite
 * backend later without touching business logic. Spec §40.
 */

export interface IndexSpec {
  name: string;
  keyPath: string | string[];
  unique?: boolean;
  multiEntry?: boolean;
}

export interface StoreSpec {
  name: string;
  keyPath: string;
  indexes?: IndexSpec[];
}

export type Migration = (db: IDBDatabase, tx: IDBTransaction, fromVersion: number) => void;

function promisify<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('IndexedDB request failed'));
  });
}

export class Database {
  private db: IDBDatabase | null = null;

  constructor(
    private readonly name: string,
    private readonly version: number,
    private readonly stores: StoreSpec[],
    private readonly migrations: Migration[] = [],
  ) {}

  async open(): Promise<void> {
    if (this.db) return;

    this.db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open(this.name, this.version);

      request.onupgradeneeded = (event) => {
        const db = request.result;
        const tx = request.transaction!;

        // Declarative store/index creation is idempotent, so it doubles as the
        // migration path for added stores and indexes.
        for (const spec of this.stores) {
          const store = db.objectStoreNames.contains(spec.name)
            ? tx.objectStore(spec.name)
            : db.createObjectStore(spec.name, { keyPath: spec.keyPath });

          for (const index of spec.indexes ?? []) {
            if (!store.indexNames.contains(index.name)) {
              store.createIndex(index.name, index.keyPath, {
                unique: index.unique ?? false,
                multiEntry: index.multiEntry ?? false,
              });
            }
          }
        }

        for (const migration of this.migrations) {
          migration(db, tx, event.oldVersion);
        }
      };

      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error ?? new Error('Could not open database'));
      request.onblocked = () =>
        reject(new Error('Database upgrade blocked — close cratenav in other tabs'));
    });

    // Another tab requested a version change; release our handle so it can proceed.
    this.db.onversionchange = () => {
      this.db?.close();
      this.db = null;
    };
  }

  private require(): IDBDatabase {
    if (!this.db) throw new Error('Database not open — call open() first');
    return this.db;
  }

  async get<T>(store: string, key: IDBValidKey): Promise<T | undefined> {
    const tx = this.require().transaction(store, 'readonly');
    return promisify<T | undefined>(tx.objectStore(store).get(key) as IDBRequest<T | undefined>);
  }

  async getAll<T>(store: string, query?: IDBKeyRange | IDBValidKey, count?: number): Promise<T[]> {
    const tx = this.require().transaction(store, 'readonly');
    return promisify<T[]>(tx.objectStore(store).getAll(query, count) as IDBRequest<T[]>);
  }

  async getAllFromIndex<T>(
    store: string,
    index: string,
    query?: IDBKeyRange | IDBValidKey,
    count?: number,
  ): Promise<T[]> {
    const tx = this.require().transaction(store, 'readonly');
    return promisify<T[]>(
      tx.objectStore(store).index(index).getAll(query, count) as IDBRequest<T[]>,
    );
  }

  async count(store: string, query?: IDBKeyRange | IDBValidKey): Promise<number> {
    const tx = this.require().transaction(store, 'readonly');
    return promisify<number>(tx.objectStore(store).count(query));
  }

  async countFromIndex(
    store: string,
    index: string,
    query?: IDBKeyRange | IDBValidKey,
  ): Promise<number> {
    const tx = this.require().transaction(store, 'readonly');
    return promisify<number>(tx.objectStore(store).index(index).count(query));
  }

  async put<T>(store: string, value: T): Promise<void> {
    const tx = this.require().transaction(store, 'readwrite');
    tx.objectStore(store).put(value);
    await this.done(tx);
  }

  /** Bulk write in a single transaction — the import path depends on this. */
  async putAll<T>(store: string, values: readonly T[]): Promise<void> {
    if (!values.length) return;
    const tx = this.require().transaction(store, 'readwrite');
    const objectStore = tx.objectStore(store);
    for (const value of values) objectStore.put(value);
    await this.done(tx);
  }

  /** Write across several stores atomically. */
  async transaction(
    stores: readonly string[],
    run: (tx: IDBTransaction) => void,
  ): Promise<void> {
    const tx = this.require().transaction(stores, 'readwrite');
    try {
      run(tx);
    } catch (error) {
      tx.abort();
      throw error;
    }
    await this.done(tx);
  }

  async delete(store: string, key: IDBValidKey): Promise<void> {
    const tx = this.require().transaction(store, 'readwrite');
    tx.objectStore(store).delete(key);
    await this.done(tx);
  }

  async clear(store: string): Promise<void> {
    const tx = this.require().transaction(store, 'readwrite');
    tx.objectStore(store).clear();
    await this.done(tx);
  }

  /** Stream a store without materialising it all in memory. */
  async each<T>(
    store: string,
    visit: (value: T) => void | 'stop',
    options?: { index?: string; query?: IDBKeyRange | IDBValidKey; direction?: IDBCursorDirection },
  ): Promise<void> {
    const tx = this.require().transaction(store, 'readonly');
    const source = options?.index
      ? tx.objectStore(store).index(options.index)
      : tx.objectStore(store);

    await new Promise<void>((resolve, reject) => {
      const request = source.openCursor(options?.query, options?.direction);
      request.onsuccess = () => {
        const cursor = request.result;
        if (!cursor) {
          resolve();
          return;
        }
        if (visit(cursor.value as T) === 'stop') {
          resolve();
          return;
        }
        cursor.continue();
      };
      request.onerror = () => reject(request.error ?? new Error('Cursor failed'));
    });
  }

  private done(tx: IDBTransaction): Promise<void> {
    return new Promise((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error ?? new Error('Transaction failed'));
      tx.onabort = () => reject(tx.error ?? new Error('Transaction aborted'));
    });
  }

  close(): void {
    this.db?.close();
    this.db = null;
  }
}
