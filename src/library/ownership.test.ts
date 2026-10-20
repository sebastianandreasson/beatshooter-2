import { expect, test } from "bun:test";
import { IDBFactory } from "fake-indexeddb";
import { openLibraryDatabase, readAll } from "./database";
import { acquireGameplayOwnership, withAnalysisOwnership } from "./ownership";

/** A small fair lock scheduler exercises the native branch without a browser. */
function lockManager(): LockManager {
    interface Request {
        name: string; mode: LockMode; grant: () => void; reject: (reason: unknown) => void; signal?: AbortSignal;
    }
    const held: Request[] = [], pending: Request[] = [];
    const drain = () => {
        while (pending.length) {
            const next = pending[0]!;
            if (held.some(lock => lock.mode === "exclusive") || (next.mode === "exclusive" && held.length)) return;
            pending.shift(); held.push(next); next.grant();
            if (next.mode === "exclusive") return;
        }
    };
    const manager = {
        query: async () => ({
            held: held.map(lock => ({ name: lock.name, mode: lock.mode, clientId: "fixture" })),
            pending: pending.map(lock => ({ name: lock.name, mode: lock.mode, clientId: "fixture" })),
        }),
        request: (name: string, options: LockOptions, callback: LockGrantedCallback<unknown>) => {
            if (options.ifAvailable && (held.length || pending.length)) return Promise.resolve(callback(null));
            return new Promise<unknown>((resolve, reject) => {
                const request: Request = {
                    name, mode: options.mode ?? "exclusive", reject, signal: options.signal,
                    grant: () => {
                        options.signal?.removeEventListener("abort", abort);
                        Promise.resolve(callback({ name, mode: request.mode } as Lock)).then(resolve, reject).finally(() => {
                            held.splice(held.indexOf(request), 1);
                            drain();
                        });
                    },
                };
                const abort = () => {
                    const index = pending.indexOf(request);
                    if (index >= 0) pending.splice(index, 1);
                    reject(new DOMException("Cancelled", "AbortError"));
                    drain();
                };
                if (options.signal?.aborted) { abort(); return; }
                options.signal?.addEventListener("abort", abort, { once: true });
                pending.push(request); drain();
            });
        },
    };
    return manager as LockManager;
}

test("native shared gameplay locks interrupt exclusive analysis and allow independent players", async () => {
    const descriptor = Object.getOwnPropertyDescriptor(globalThis, "navigator");
    Object.defineProperty(globalThis, "navigator", { configurable: true, value: { locks: lockManager() } });
    const db = await openLibraryDatabase(new IDBFactory(), `native-${crypto.randomUUID()}`);
    let entered!: () => void, cancelled = false;
    const started = new Promise<void>(resolve => { entered = resolve; });
    const signal = new AbortController().signal;
    let releaseA: (() => Promise<void>) | undefined, releaseB: (() => Promise<void>) | undefined;
    try {
        const analysis = withAnalysisOwnership(db, signal, async signal => {
            entered();
            await new Promise<void>(resolve => signal.addEventListener("abort", () => {
                cancelled = true; resolve();
            }, { once: true }));
        });
        await started;
        releaseA = await acquireGameplayOwnership(db, signal);
        await analysis;
        expect(cancelled).toBe(true);
        releaseB = await acquireGameplayOwnership(db, signal);
        expect(await withAnalysisOwnership(db, signal, async () => { throw new Error("Must not run"); })).toBe(false);
        await releaseA(); releaseA = undefined;
        expect(await withAnalysisOwnership(db, signal, async () => { throw new Error("Still one player"); })).toBe(false);
        await releaseB(); releaseB = undefined;
        let ran = false;
        expect(await withAnalysisOwnership(db, signal, async () => { ran = true; })).toBe(true);
        expect(ran).toBe(true);
        expect(await readAll(db, "leases")).toEqual([]); // Native gameplay works even at storage quota.
    } finally {
        await releaseA?.(); await releaseB?.();
        db.close();
        if (descriptor) Object.defineProperty(globalThis, "navigator", descriptor);
        else Reflect.deleteProperty(globalThis, "navigator");
    }
});
