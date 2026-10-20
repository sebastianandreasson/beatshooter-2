import { requestResult, withTransaction } from "./database";

interface Lease { id: string; owner: string; expiresAt: number; kind?: "playback" }
const AUDIO_WORK_LOCK = "beatshooter-audio-work";
const ANALYSIS_LEASE = "library-analysis-owner";
const TTL = 30_000;
const wait = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

async function hasPlayback(db: IDBDatabase): Promise<boolean> {
    const locks = globalThis.navigator?.locks;
    if (locks) {
        const snapshot = await locks.query();
        if ([...snapshot.held ?? [], ...snapshot.pending ?? []]
            .some(lock => lock.name === AUDIO_WORK_LOCK && lock.mode === "shared")) return true;
    }
    return withTransaction(db, ["leases"], "readonly", async tx => {
        const leases = await requestResult<Lease[]>(tx.objectStore("leases").getAll());
        return leases.some(lease => lease.kind === "playback" && lease.expiresAt > Date.now());
    });
}

/**
 * Gameplay is a shared lock, so independent Quick Play tabs can coexist, while
 * analysis takes its exclusive counterpart. The analysis owner watches pending
 * gameplay requests and aborts promptly; its unabortable decode finishes first.
 */
export async function acquireGameplayOwnership(db: IDBDatabase, signal: AbortSignal): Promise<() => Promise<void>> {
    const locks = globalThis.navigator?.locks;
    if (locks) {
        let unlock: (() => void) | undefined, finished: Promise<unknown> | undefined;
        await new Promise<void>((resolve, reject) => {
            finished = locks.request(AUDIO_WORK_LOCK, { mode: "shared", signal }, async () => {
                if (signal.aborted) throw new DOMException("Playback preparation cancelled.", "AbortError");
                await new Promise<void>(done => { unlock = done; resolve(); });
            });
            void finished.catch(reject);
        });
        return async () => { unlock?.(); await finished; };
    }
    const owner = crypto.randomUUID(), id = `library-gameplay:${owner}`;
    let timer: ReturnType<typeof setInterval> | undefined, released = false;
    const release = async () => {
        if (released) return;
        released = true;
        clearInterval(timer);
        await withTransaction(db, ["leases"], "readwrite", tx => requestResult(tx.objectStore("leases").delete(id)));
    };
    const renew = async () => {
        if (released) return;
        await withTransaction(db, ["leases"], "readwrite", tx => requestResult(tx.objectStore("leases").put({
            id, owner, kind: "playback", expiresAt: Date.now() + TTL,
        } satisfies Lease)));
    };
    try {
        await renew();
        if (signal.aborted) throw new DOMException("Playback preparation cancelled.", "AbortError");
        timer = setInterval(() => { void renew().catch(() => {}); }, 10_000);
        while (!signal.aborted) {
            const analysis = await withTransaction(db, ["leases"], "readonly",
                tx => requestResult<Lease | undefined>(tx.objectStore("leases").get(ANALYSIS_LEASE)));
            if (!analysis || analysis.expiresAt <= Date.now()) break;
            await wait(50);
        }
        if (signal.aborted) throw new DOMException("Playback preparation cancelled.", "AbortError");
        return release;
    } catch (error) {
        await release();
        throw error;
    }
}

/**
 * A GPU job has one owner across tabs. Web Locks release on tab death; older
 * browsers use a renewed transactional lease and abort work if ownership lapses.
 */
export async function withAnalysisOwnership(
    db: IDBDatabase,
    signal: AbortSignal,
    work: (signal: AbortSignal) => Promise<void>,
): Promise<boolean> {
    const locks = globalThis.navigator?.locks;
    if (locks) {
        return locks.request(AUDIO_WORK_LOCK, { mode: "exclusive", ifAvailable: true }, async lock => {
            if (!lock || signal.aborted || await hasPlayback(db)) return false;
            await monitoredWork();
            return true;
        });
    }
    const id = ANALYSIS_LEASE, owner = crypto.randomUUID();
    const acquired = await withTransaction(db, ["leases"], "readwrite", async tx => {
        const store = tx.objectStore("leases");
        const leases = await requestResult<Lease[]>(store.getAll());
        if (leases.some(lease => lease.kind === "playback" && lease.expiresAt > Date.now())) return false;
        const current = await requestResult<Lease | undefined>(store.get(id));
        if (current && current.expiresAt > Date.now()) return false;
        store.put({ id, owner, expiresAt: Date.now() + TTL } satisfies Lease);
        return true;
    });
    if (!acquired || signal.aborted) {
        if (acquired) await release();
        return false;
    }
    const abort = new AbortController();
    const cancel = () => abort.abort();
    signal.addEventListener("abort", cancel, { once: true });
    const timer = setInterval(() => {
        void withTransaction(db, ["leases"], "readwrite", async tx => {
            const store = tx.objectStore("leases");
            const current = await requestResult<Lease | undefined>(store.get(id));
            if (current?.owner !== owner || current.expiresAt <= Date.now()) { abort.abort(); return; }
            store.put({ id, owner, expiresAt: Date.now() + TTL } satisfies Lease);
        }).catch(() => abort.abort());
    }, 10_000);
    try { await monitoredWork(abort.signal); }
    finally {
        clearInterval(timer);
        signal.removeEventListener("abort", cancel);
        await release();
    }
    return true;

    async function monitoredWork(parent = signal): Promise<void> {
        const controller = new AbortController(), cancel = () => controller.abort();
        parent.addEventListener("abort", cancel, { once: true });
        if (parent.aborted) cancel();
        let checking = false;
        const monitor = setInterval(() => {
            if (checking) return;
            checking = true;
            void hasPlayback(db).then(active => { if (active) controller.abort(); })
                .catch(() => controller.abort()).finally(() => { checking = false; });
        }, 100);
        try { await work(controller.signal); }
        finally { clearInterval(monitor); parent.removeEventListener("abort", cancel); }
    }

    async function release(): Promise<void> {
        await withTransaction(db, ["leases"], "readwrite", async tx => {
            const store = tx.objectStore("leases");
            const current = await requestResult<Lease | undefined>(store.get(id));
            if (current?.owner === owner) store.delete(id);
        });
    }
}
