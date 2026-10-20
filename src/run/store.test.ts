import { describe, expect, test } from "bun:test";
import {
    abandonRun, chooseRunUpgrade, createRun, defeatRun, restoreRunCombat, selectRunArena, settleRunSong,
    validateRunRecord, type RunRecord,
} from "./model";
import { dropExperience } from "../experience/state";
import {
    assertRunSave, claimRunLease, RUN_OWNER_LEASE_MS, RunConflictError, RunOwnershipError,
    RunStore, type RunLease, type RunStorage,
} from "./store";

function fixture(id = "run-a"): RunRecord {
    return createRun({
        id, title: "Save test", seed: 12, now: 0,
        songs: [{
            slotId: "slot-a", trackId: "a".repeat(64), audioHash: "a".repeat(64),
            chartId: "chart-a", title: "Test", artist: "Artist", duration: 10, timing: "manual",
        }],
    });
}
function choose(run: RunRecord): RunRecord {
    return chooseRunUpgrade(run, run.progression.upgrades.offerIds[0]!, run.progression.upgrades.offeredLevel);
}

/** Each async method performs one atomic operation, matching the IDB transaction boundary. */
class MemoryStorage implements RunStorage {
    records = new Map<string, RunRecord>();
    results = new Map<string, RunRecord>();
    activeId: string | undefined;
    lease: RunLease | undefined;
    failNext = false;
    writes = 0;
    async get(id: string) { return this.records.get(id); }
    async activeRecord() { return this.activeId ? this.records.get(this.activeId) : undefined; }
    async claim(ownerId: string, now: number, heldWebLock = false) {
        const lease = claimRunLease(this.lease, ownerId, now, RUN_OWNER_LEASE_MS, heldWebLock);
        if (!lease) return false;
        this.lease = lease;
        return true;
    }
    async renew(ownerId: string, now: number) {
        if (this.lease?.ownerId !== ownerId) return false;
        this.lease = { ...this.lease, expiresAt: now + RUN_OWNER_LEASE_MS };
        return true;
    }
    async release(ownerId: string) {
        if (this.lease?.ownerId === ownerId) this.lease = undefined;
    }
    async save(next: RunRecord, revision: number | null, ownerId: string, now: number) {
        this.writes++;
        if (this.lease?.ownerId !== ownerId) throw new RunOwnershipError();
        assertRunSave(this.records.get(next.id), next, revision,
            this.activeId ? this.records.get(this.activeId) : undefined);
        if (this.failNext) {
            this.failNext = false;
            throw new Error("Injected quota/transaction failure");
        }
        this.records.set(next.id, structuredClone(next));
        if (["defeated", "completed", "abandoned"].includes(next.status)) {
            this.results.set(next.id, structuredClone(next));
            if (this.activeId === next.id) this.activeId = undefined;
        } else this.activeId = next.id;
        this.lease = { ...this.lease, id: "active-run-owner", ownerId, expiresAt: now + RUN_OWNER_LEASE_MS };
    }
}

function client(storage: MemoryStorage, id: string, now = () => 0, onOwnershipLost?: () => void): RunStore {
    return new RunStore(undefined, { storage, ownerId: id, locks: null, now, onOwnershipLost });
}

describe("run checkpoint ownership and atomic saves", () => {
    test("every durable boundary loads independently; failed transition leaves previous checkpoint intact", async () => {
        const storage = new MemoryStorage();
        const store = client(storage, "owner");
        try {
            expect(await store.acquire()).toBe(true);
            const starting = await store.save(fixture(), null);
            expect(await store.activeRecord()).toEqual(starting);
            const map = choose(starting);
            storage.failNext = true;
            await expect(store.save(map, starting.revision)).rejects.toThrow("Injected");
            expect(await store.activeRecord()).toEqual(starting);
            await store.save(map, starting.revision);
            expect(await store.activeRecord()).toEqual(map);
            const entry = selectRunArena(map, "mixed-assault");
            await store.save(entry, map.revision);
            expect(await store.activeRecord()).toEqual(entry);
            const dead = defeatRun(entry);
            await store.save(dead, entry.revision);
            expect(await store.activeRecord()).toBeUndefined();
            expect(await store.get(dead.id)).toEqual(dead);
            expect(storage.results.get(dead.id)).toEqual(dead);
        } finally { await store.release(); }
    });

    test("duplicate clicks and delayed saves cannot resurrect terminal runs", async () => {
        const storage = new MemoryStorage();
        const store = client(storage, "owner");
        try {
            await store.acquire();
            const initial = await store.save(fixture(), null);
            const map = choose(initial);
            const outcomes = await Promise.allSettled([
                store.save(map, initial.revision), store.save(map, initial.revision),
            ]);
            expect(outcomes.filter(result => result.status === "fulfilled")).toHaveLength(1);
            expect(outcomes.filter(result => result.status === "rejected")).toHaveLength(1);
            const abandoned = abandonRun(map);
            await store.save(abandoned, map.revision);
            const invented = { ...map, revision: abandoned.revision + 1 };
            await expect(store.save(invented, abandoned.revision)).rejects.toBeInstanceOf(RunConflictError);
            await expect(store.save(initial, null)).rejects.toBeInstanceOf(RunConflictError);
            expect(await store.activeRecord()).toBeUndefined();
            expect((await store.get(map.id))!.status).toBe("abandoned");
        } finally { await store.release(); }
    });

    test("settlement and each queued intermission choice commit independently with retry-safe XP", async () => {
        const storage = new MemoryStorage();
        const store = client(storage, "owner");
        try {
            await store.acquire();
            let run = fixture();
            const raw = structuredClone(run);
            raw.songs.push({ ...raw.songs[0]!, slotId: "slot-b" });
            // Build through the public constructor to pin both slots and their map.
            run = createRun({ id: raw.id, title: raw.title, songs: raw.songs, seed: raw.seed, now: 0 });
            await store.save(run, null);
            let next = choose(run);
            await store.save(next, run.revision);
            run = next;
            next = selectRunArena(run, "mixed-assault");
            await store.save(next, run.revision);
            run = next;
            const live = restoreRunCombat(run);
            dropExperience(live.experience, { x: 10, z: 10 }, 400);
            next = settleRunSong(run, live, { songIndex: 0 });
            storage.failNext = true;
            await expect(store.save(next, run.revision)).rejects.toThrow("Injected");
            const uncommitted = (await store.activeRecord())!;
            expect(uncommitted.status).toBe("song-active");
            expect(restoreRunCombat(uncommitted).experience.totalXp).toBe(0);
            await store.save(next, run.revision);
            run = (await store.activeRecord())!;
            expect(run.status).toBe("intermission");
            expect(run.progression.experience.totalXp).toBe(400);
            const stableOffer = run.progression.upgrades.offerIds;
            expect((await store.activeRecord())!.progression.upgrades.offerIds).toEqual(stableOffer);
            while (run.status === "intermission") {
                next = choose(run);
                await store.save(next, run.revision);
                run = (await store.activeRecord())!;
                expect(run.progression.experience.totalXp).toBe(400);
            }
            expect(run.status).toBe("choosing-arena");
            expect(run.songIndex).toBe(1);
            expect(run.route).toHaveLength(1);
        } finally { await store.release(); }
    });

    test("replacement requires explicit committed abandonment and keeps terminal history", async () => {
        const storage = new MemoryStorage();
        const store = client(storage, "owner");
        try {
            await store.acquire();
            const initial = await store.save(fixture(), null);
            await expect(store.save(fixture("run-b"), null)).rejects.toThrow("Abandon");
            await store.save(abandonRun(initial), initial.revision);
            await store.save(fixture("run-b"), null);
            expect((await store.activeRecord())!.id).toBe("run-b");
            expect((await store.get("run-a"))!.status).toBe("abandoned");
            expect(storage.results.size).toBe(1);
        } finally { await store.release(); }
    });

    test("malformed and incompatible data never enters a write transaction", async () => {
        const storage = new MemoryStorage();
        const store = client(storage, "owner");
        try {
            await store.acquire();
            const valid = await store.save(fixture(), null);
            const writes = storage.writes;
            const invalid = structuredClone(valid);
            invalid.rulesVersion = 99 as 1;
            await expect(store.save(invalid, valid.revision)).rejects.toThrow("unsupported");
            expect(storage.writes).toBe(writes);
            expect(await store.activeRecord()).toEqual(valid);
        } finally { await store.release(); }
    });

    test("lease fallback prevents concurrent owners and stale tabs lose writing access after takeover", async () => {
        const storage = new MemoryStorage();
        let now = 100;
        let lost = 0;
        const first = client(storage, "one", () => now, () => { lost++; });
        const second = client(storage, "two", () => now);
        try {
            expect(await first.acquire()).toBe(true);
            expect(await first.acquire()).toBe(true);
            const saved = await first.save(fixture(), null);
            expect(await second.acquire()).toBe(false);
            now += RUN_OWNER_LEASE_MS + 1;
            expect(await second.acquire()).toBe(true);
            expect(await first.renew()).toBe(false);
            expect(lost).toBe(1);
            expect(first.ownsRun).toBe(false);
            await expect(first.save(choose(saved), saved.revision)).rejects.toBeInstanceOf(RunOwnershipError);
            await second.save(choose(saved), saved.revision);
            // A stale owner releasing cannot delete the new owner's lease.
            await first.release();
            expect(storage.lease!.ownerId).toBe("two");
            expect((await second.activeRecord())!.status).toBe("choosing-arena");
        } finally { await first.release(); await second.release(); }
    });

    test("Web Lock is held until release, while read-only inspection remains available", async () => {
        let held = false;
        const locks = {
            async request(_name: string, _options: LockOptions, callback: LockGrantedCallback<unknown>) {
                if (held) return callback(null);
                held = true;
                try { return await callback({ name: "test", mode: "exclusive" } as Lock); }
                finally { held = false; }
            },
        } as LockManager;
        const storage = new MemoryStorage();
        const first = new RunStore(undefined, { storage, locks, ownerId: "one" });
        const second = new RunStore(undefined, { storage, locks, ownerId: "two" });
        try {
            expect(await first.acquire()).toBe(true);
            expect(await second.acquire()).toBe(false);
            await first.save(fixture(), null);
            expect((await second.activeRecord())!.id).toBe("run-a");
            await first.release();
            expect(await second.acquire()).toBe(true);
        } finally { await first.release(); await second.release(); }
    });

    test("leaving during an unfinished acquisition cannot retain a hidden owner", async () => {
        const storage = new MemoryStorage();
        let proceed!: () => void;
        const barrier = new Promise<void>(resolve => { proceed = resolve; });
        const claim = storage.claim.bind(storage);
        storage.claim = async (owner, now) => { await barrier; return claim(owner, now); };
        const store = client(storage, "owner");
        const acquiring = store.acquire();
        await store.release();
        proceed();
        expect(await acquiring).toBe(false);
        expect(store.ownsRun).toBe(false);
        expect(storage.lease).toBeUndefined();
    });

    test("fresh native owner immediately reclaims a reload's lease, but not an active fallback owner", async () => {
        const locks = {
            async request(_name: string, _options: LockOptions, callback: LockGrantedCallback<unknown>) {
                return callback({ name: "test", mode: "exclusive" } as Lock);
            },
        } as LockManager;
        const storage = new MemoryStorage();
        storage.lease = {
            id: "active-run-owner", ownerId: "closed-page", expiresAt: 15_000, mode: "web-lock",
        };
        const fresh = new RunStore(undefined, { storage, locks, ownerId: "fresh-page", now: () => 1 });
        try {
            expect(await fresh.acquire()).toBe(true);
            expect(storage.lease.ownerId).toBe("fresh-page");
            expect(storage.lease.mode).toBe("web-lock");
        } finally { await fresh.release(); }
        storage.lease = { id: "active-run-owner", ownerId: "fallback-page", expiresAt: 15_000, mode: "lease" };
        const blocked = new RunStore(undefined, { storage, locks, ownerId: "native-page", now: () => 1 });
        try {
            expect(await blocked.acquire()).toBe(false);
            expect(storage.lease.ownerId).toBe("fallback-page");
        } finally { await blocked.release(); }
    });

    test("immutable route and chart references cannot change under a valid revision", () => {
        const starting = fixture();
        const map = choose(starting);
        const changedSongs = structuredClone(map);
        changedSongs.songs[0]!.chartId = "new-chart";
        expect(() => assertRunSave(starting, validateRunRecord(changedSongs), 0, starting)).toThrow("Immutable");
        const changedSeed = structuredClone(map);
        changedSeed.seed++;
        expect(() => assertRunSave(starting, changedSeed, 0, starting)).toThrow("Immutable");
    });
});
