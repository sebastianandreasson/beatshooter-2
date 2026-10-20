import { openLibraryDatabase, requestResult, withTransaction } from "../library/database";
import type { ChartRevision, LibraryTrack } from "../library/types";
import { isTerminalRun, validateRunRecord, type RunRecord } from "./model";

export const RUN_OWNER_LEASE_MS = 15_000;
const OWNER_ID = "active-run-owner";
const ACTIVE_ID = "active-run";
export interface RunLease {
    id: typeof OWNER_ID;
    ownerId: string;
    expiresAt: number;
    /** Legacy native leases lack this field; explicit fallback leases cannot be stolen. */
    mode?: "web-lock" | "lease";
}

export class RunConflictError extends Error {
    constructor(message = "This run changed in another tab. Reload its saved checkpoint.") {
        super(message);
        this.name = "RunConflictError";
    }
}
export class RunOwnershipError extends Error {
    constructor() {
        super("Another tab owns this run. Pause there before continuing here.");
        this.name = "RunOwnershipError";
    }
}

/** Shared by the transactional adapter and fault-injection tests. */
export function assertRunSave(
    current: RunRecord | undefined, next: RunRecord, expectedRevision: number | null,
    active: RunRecord | undefined,
): void {
    if (expectedRevision === null) {
        if (current || next.revision !== 0 || next.status !== "starting") throw new RunConflictError();
    } else {
        if (!current || current.revision !== expectedRevision || next.revision !== expectedRevision + 1 ||
            isTerminalRun(current)) throw new RunConflictError();
        if (next.id !== current.id || next.seed !== current.seed || next.createdAt !== current.createdAt ||
            JSON.stringify(next.songs) !== JSON.stringify(current.songs) ||
            JSON.stringify(next.map) !== JSON.stringify(current.map) ||
            next.songIndex < current.songIndex || next.songIndex > current.songIndex + 1 ||
            (current.initialChoiceCompleted && !next.initialChoiceCompleted) ||
            JSON.stringify(next.route.slice(0, current.route.length)) !== JSON.stringify(current.route)) {
            throw new RunConflictError("Immutable run identity or completed progress changed.");
        }
    }
    if (active && !isTerminalRun(active) && active.id !== next.id) {
        throw new RunConflictError("Abandon the saved run before starting another.");
    }
}

export function claimRunLease(
    existing: RunLease | undefined, ownerId: string, now: number, duration = RUN_OWNER_LEASE_MS,
    heldWebLock = false,
): RunLease | undefined {
    const nativeOwnerGone = heldWebLock && existing?.mode !== "lease";
    if (existing && existing.ownerId !== ownerId && existing.expiresAt > now && !nativeOwnerGone) return undefined;
    return { id: OWNER_ID, ownerId, expiresAt: now + duration, mode: heldWebLock ? "web-lock" : "lease" };
}

/** The adapter's commit must atomically check ownership, revision and the active pointer. */
export interface RunStorage {
    get(id: string): Promise<RunRecord | undefined>;
    activeRecord(): Promise<RunRecord | undefined>;
    claim(ownerId: string, now: number, heldWebLock?: boolean): Promise<boolean>;
    renew(ownerId: string, now: number): Promise<boolean>;
    release(ownerId: string): Promise<void>;
    save(next: RunRecord, expectedRevision: number | null, ownerId: string, now: number): Promise<void>;
}

export class IndexedDbRunStorage implements RunStorage {
    private readonly database: Promise<IDBDatabase>;
    constructor(db?: IDBDatabase) {
        this.database = db ? Promise.resolve(db) : openLibraryDatabase();
        // Opening may reject before the first user action awaits it.
        void this.database.catch(() => {});
    }
    async get(id: string): Promise<RunRecord | undefined> {
        const db = await this.database;
        return withTransaction(db, ["runs"], "readonly", async tx => {
            const record = await requestResult(tx.objectStore("runs").get(id));
            return record === undefined ? undefined : validateRunRecord(record);
        });
    }
    async activeRecord(): Promise<RunRecord | undefined> {
        const db = await this.database;
        return withTransaction(db, ["runs", "meta"], "readonly", async tx => {
            const pointer = await requestResult<{ runId: string } | undefined>(tx.objectStore("meta").get(ACTIVE_ID));
            if (!pointer) return undefined;
            const value = await requestResult(tx.objectStore("runs").get(pointer.runId));
            if (!value) throw new Error("The active run checkpoint is missing. Import its recovery file.");
            const run = validateRunRecord(value);
            return isTerminalRun(run) ? undefined : run;
        });
    }
    async claim(ownerId: string, now: number, heldWebLock = false): Promise<boolean> {
        const db = await this.database;
        return withTransaction(db, ["leases"], "readwrite", async tx => {
            const store = tx.objectStore("leases");
            const current = await requestResult<RunLease | undefined>(store.get(OWNER_ID));
            const lease = claimRunLease(current, ownerId, now, RUN_OWNER_LEASE_MS, heldWebLock);
            if (!lease) return false;
            await requestResult(store.put(lease));
            return true;
        });
    }
    async renew(ownerId: string, now: number): Promise<boolean> {
        const db = await this.database;
        return withTransaction(db, ["leases"], "readwrite", async tx => {
            const store = tx.objectStore("leases");
            const current = await requestResult<RunLease | undefined>(store.get(OWNER_ID));
            if (current?.ownerId !== ownerId) return false;
            await requestResult(store.put({ ...current, expiresAt: now + RUN_OWNER_LEASE_MS }));
            return true;
        });
    }
    async release(ownerId: string): Promise<void> {
        const db = await this.database;
        await withTransaction(db, ["leases"], "readwrite", async tx => {
            const store = tx.objectStore("leases");
            const current = await requestResult<RunLease | undefined>(store.get(OWNER_ID));
            if (current?.ownerId === ownerId) await requestResult(store.delete(OWNER_ID));
        });
    }
    async save(next: RunRecord, expectedRevision: number | null, ownerId: string, now: number): Promise<void> {
        const db = await this.database;
        await withTransaction(db,
            ["runs", "runResults", "meta", "runPins", "leases", "tracks", "charts"], "readwrite", async tx => {
                const leases = tx.objectStore("leases");
                const lease = await requestResult<RunLease | undefined>(leases.get(OWNER_ID));
                if (lease?.ownerId !== ownerId) throw new RunOwnershipError();
                const runs = tx.objectStore("runs");
                const currentValue = await requestResult(runs.get(next.id));
                const current = currentValue === undefined ? undefined : validateRunRecord(currentValue);
                const pointer = await requestResult<{ runId: string } | undefined>(tx.objectStore("meta").get(ACTIVE_ID));
                const activeValue = pointer ? await requestResult(runs.get(pointer.runId)) : undefined;
                if (pointer && !activeValue) throw new RunConflictError("The active run checkpoint is missing.");
                const active = activeValue === undefined ? undefined : validateRunRecord(activeValue);
                assertRunSave(current, next, expectedRevision, active);
                if (!isTerminalRun(next)) {
                    // Enforce references in the same transaction as pins, closing deletion races.
                    for (const song of next.songs) {
                        const track = await requestResult<LibraryTrack | undefined>(tx.objectStore("tracks").get(song.trackId));
                        const chart = await requestResult<ChartRevision | undefined>(tx.objectStore("charts").get(song.chartId));
                        if (!track || track.contentHash !== song.audioHash || !chart || chart.trackId !== song.trackId ||
                            chart.contentHash !== song.audioHash || Math.abs(chart.manifest.duration - song.duration) > 0.05) {
                            throw new Error(`The saved audio/chart reference for ${song.title} is missing.`);
                        }
                    }
                }
                await requestResult(runs.put(next));
                if (isTerminalRun(next)) {
                    await requestResult(tx.objectStore("runResults").put(next));
                    if (pointer?.runId === next.id) {
                        await requestResult(tx.objectStore("meta").delete(ACTIVE_ID));
                        await requestResult(tx.objectStore("runPins").delete(ACTIVE_ID));
                    }
                } else {
                    await requestResult(tx.objectStore("meta").put({ id: ACTIVE_ID, runId: next.id }));
                    await requestResult(tx.objectStore("runPins").put({
                        id: ACTIVE_ID, trackIds: [...new Set(next.songs.map(song => song.trackId))],
                        chartIds: [...new Set(next.songs.map(song => song.chartId))],
                    }));
                }
                await requestResult(leases.put({ ...lease, expiresAt: now + RUN_OWNER_LEASE_MS }));
            });
    }
}

export interface RunStoreOptions {
    /** Injectable atomic adapter for fault and concurrency tests. */
    storage?: RunStorage;
    ownerId?: string;
    now?: () => number;
    /** null deliberately exercises the lease fallback. */
    locks?: LockManager | null;
    onOwnershipLost?: () => void;
}

/** Holds one global run owner; browsing and read-only recovery need no lock. */
export class RunStore {
    private readonly storage: RunStorage;
    private readonly ownerId: string;
    private readonly now: () => number;
    private readonly locks: LockManager | undefined;
    private readonly onOwnershipLost: (() => void) | undefined;
    private unlock: (() => void) | undefined;
    private lockTask: Promise<unknown> | undefined;
    private heartbeat: ReturnType<typeof setInterval> | undefined;
    private acquiring: Promise<boolean> | undefined;
    private renewing = false;
    private owned = false;
    private generation = 0;

    constructor(db?: IDBDatabase, options: RunStoreOptions = {}) {
        this.storage = options.storage ?? new IndexedDbRunStorage(db);
        this.ownerId = options.ownerId ?? crypto.randomUUID();
        this.now = options.now ?? Date.now;
        this.locks = options.locks === null ? undefined : options.locks ?? globalThis.navigator?.locks;
        this.onOwnershipLost = options.onOwnershipLost;
    }
    get ownsRun(): boolean { return this.owned; }
    async get(id: string): Promise<RunRecord | undefined> {
        const value = await this.storage.get(id);
        return value === undefined ? undefined : validateRunRecord(value);
    }
    async activeRecord(): Promise<RunRecord | undefined> {
        const value = await this.storage.activeRecord();
        return value === undefined ? undefined : validateRunRecord(value);
    }
    acquire(): Promise<boolean> {
        if (this.owned) return Promise.resolve(true);
        if (this.acquiring) return this.acquiring;
        const generation = this.generation;
        this.acquiring = this.acquireOwner(generation).finally(() => { this.acquiring = undefined; });
        return this.acquiring;
    }
    private async acquireOwner(generation: number): Promise<boolean> {
        try {
            if (this.locks && !await this.holdWebLock()) return false;
            if (generation !== this.generation) { this.dropLock(); return false; }
            // A reload releases its browser lock synchronously but can leave the
            // IDB lease behind. The newly held lock proves that native owner left.
            const claimed = await this.storage.claim(this.ownerId, this.now(), !!this.locks);
            if (!claimed || generation !== this.generation) {
                if (claimed) await this.storage.release(this.ownerId);
                this.dropLock();
                return false;
            }
            this.owned = true;
            this.heartbeat = setInterval(() => { void this.renew(); }, RUN_OWNER_LEASE_MS / 3);
            return true;
        } catch (error) {
            this.dropLock();
            throw error;
        }
    }
    private holdWebLock(): Promise<boolean> {
        return new Promise((resolve, reject) => {
            this.lockTask = this.locks!.request("beatshooter:active-run", { mode: "exclusive", ifAvailable: true }, async lock => {
                if (!lock) { resolve(false); return; }
                await new Promise<void>(release => { this.unlock = release; resolve(true); });
            }).catch(reject);
        });
    }
    /** A failed/expired owner's next write is rejected even if its tab kept simulating. */
    async renew(): Promise<boolean> {
        if (!this.owned) return false;
        if (this.renewing) return true;
        const generation = this.generation;
        this.renewing = true;
        try {
            if (await this.storage.renew(this.ownerId, this.now())) return this.owned && generation === this.generation;
        } catch { /* Losing storage also loses the promise of exclusive ownership. */ }
        finally { this.renewing = false; }
        if (!this.owned || generation !== this.generation) return false;
        this.owned = false;
        this.stopHeartbeat();
        this.dropLock();
        this.onOwnershipLost?.();
        return false;
    }
    async save(next: RunRecord, expectedRevision: number | null): Promise<RunRecord> {
        // Validation is outside the transaction, so malformed input never touches a save.
        const validated = validateRunRecord(next);
        if (!this.owned) throw new RunOwnershipError();
        await this.storage.save(validated, expectedRevision, this.ownerId, this.now());
        return validated;
    }
    async release(): Promise<void> {
        this.generation++;
        this.owned = false;
        this.stopHeartbeat();
        try { await this.storage.release(this.ownerId); }
        finally {
            const task = this.lockTask;
            this.dropLock();
            await task;
            if (this.lockTask === task) this.lockTask = undefined;
        }
    }
    private stopHeartbeat(): void {
        if (this.heartbeat !== undefined) clearInterval(this.heartbeat);
        this.heartbeat = undefined;
    }
    private dropLock(): void { this.unlock?.(); this.unlock = undefined; }
}
