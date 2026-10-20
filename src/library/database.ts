/** One database makes library, playlist and run transitions atomic. */
export const LIBRARY_DATABASE_NAME = "beatshooter.library.v1";
export const LIBRARY_DATABASE_VERSION = 1;
export const LIBRARY_STORES = [
    "audio", "tracks", "charts", "playlists", "runs", "runResults", "runPins", "leases", "meta",
] as const;
export type LibraryStore = typeof LIBRARY_STORES[number];

export function openLibraryDatabase(
    factory: IDBFactory | undefined = globalThis.indexedDB,
    name = LIBRARY_DATABASE_NAME,
): Promise<IDBDatabase> {
    if (!factory) return Promise.reject(new Error("Local storage is unavailable. Quick Play still works."));
    return new Promise((resolve, reject) => {
        const request = factory.open(name, LIBRARY_DATABASE_VERSION);
        let rejected = false;
        request.onupgradeneeded = () => {
            for (const store of LIBRARY_STORES) {
                if (!request.result.objectStoreNames.contains(store)) {
                    request.result.createObjectStore(store, { keyPath: "id" });
                }
            }
        };
        request.onerror = () => reject(request.error ?? new Error("The music library could not open."));
        request.onblocked = () => {
            rejected = true;
            reject(new Error("Close other game tabs to finish opening the music library."));
        };
        request.onsuccess = () => {
            const db = request.result;
            if (rejected) { db.close(); return; }
            db.onversionchange = () => db.close();
            resolve(db);
        };
    });
}

export function requestResult<T>(request: IDBRequest<T>): Promise<T> {
    return new Promise((resolve, reject) => {
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error ?? new Error("The local storage request failed."));
    });
}

export function transactionDone(transaction: IDBTransaction): Promise<void> {
    return new Promise((resolve, reject) => {
        transaction.addEventListener("complete", () => resolve(), { once: true });
        transaction.addEventListener("abort", () => reject(
            transaction.error ?? new Error("The local save was cancelled; the previous save is intact."),
        ), { once: true });
        transaction.addEventListener("error", () => {
            // The abort event reports the final transaction result.
        }, { once: true });
    });
}

/**
 * Resolve only on commit. Inside operation, await IDB requests only: hashing,
 * decoding, fetching and inference must finish before opening the transaction.
 */
export async function withTransaction<T>(
    db: IDBDatabase,
    stores: readonly string[],
    mode: IDBTransactionMode,
    operation: (transaction: IDBTransaction) => T | Promise<T>,
): Promise<T> {
    const transaction = mode === "readwrite"
        ? db.transaction([...stores], mode, { durability: "strict" })
        : db.transaction([...stores], mode);
    const completed = transactionDone(transaction);
    // Attach immediately; an operation rejection can precede the abort event.
    void completed.catch(() => {});
    try {
        const result = await operation(transaction);
        await completed;
        return result;
    } catch (error) {
        try { transaction.abort(); } catch { /* Already completed or aborted. */ }
        await completed.catch(() => {});
        throw error;
    }
}

export function readRecord<T>(db: IDBDatabase, store: string, id: string): Promise<T | undefined> {
    return withTransaction(db, [store], "readonly",
        tx => requestResult<T | undefined>(tx.objectStore(store).get(id)));
}

export function readAll<T>(db: IDBDatabase, store: string): Promise<T[]> {
    return withTransaction(db, [store], "readonly",
        tx => requestResult<T[]>(tx.objectStore(store).getAll()));
}

export interface ActiveRunPins {
    id: "active-run";
    trackIds: string[];
    chartIds: string[];
}
