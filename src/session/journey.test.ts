import { describe, expect, test } from "bun:test";
import { Body, createApp, StandardPhysicsPlugin, Transform } from "@dylanebert/shallot";
import { AudioOutput } from "@dylanebert/shallot/audio";
import { advanceExperience, dropExperience } from "../experience/state";
import type { MusicLibrary } from "../library";
import { PlayerState } from "../player";
import { generateTimeline } from "../rhythm/timeline";
import type { MusicTransport, TransportState } from "../rhythm/transport";
import {
    abandonRun, chooseRunUpgrade, createRun, isTerminalRun, selectRunArena, validateRunRecord, type RunRecord,
} from "../run/model";
import { snapshotProgression } from "../run/progression";
import {
    assertRunSave, claimRunLease, RunOwnershipError, RunStore, type RunLease, type RunStorage,
} from "../run/store";
import type { LoadedTrack, TrackManifest } from "../tracks";
import { chooseUpgrade, prepareUpgradeChoices, queueUpgradeLevels } from "../upgrades";
import { pauseSession, quitSession, resumeSession, Session, startSession } from "./index";
import { continueCampaign, finishCampaignSong, Journey, selectCampaignUpgrade } from "./journey";

function checkpoint(status: "starting" | "song-active" = "song-active", count = 2): RunRecord {
    const run = createRun({
        id: "journey-test", title: "Campaign", seed: 42, now: 0,
        songs: Array.from({ length: count }, (_, i) => ({
            slotId: `song-${i}`, trackId: "a".repeat(64), audioHash: "a".repeat(64),
            chartId: "pinned-chart", title: `Song ${i + 1}`, artist: "Test", duration: 12, timing: "manual",
        })),
    });
    return status === "starting" ? run : selectRunArena(
        chooseRunUpgrade(run, run.progression.upgrades.offerIds[0]!, 1), "mixed-assault",
    );
}

function deferred() {
    let resolve!: () => void;
    const promise = new Promise<void>(r => { resolve = r; });
    return { promise, resolve };
}

/** An atomic adapter with explicit delayed/failing commits, retaining the real RunStore contract. */
class Checkpoints implements RunStorage {
    record: RunRecord;
    lease: RunLease | undefined;
    commits = 0;
    attempts = 0;
    failNext = false;
    gate: ReturnType<typeof deferred> | undefined;
    constructor(record: RunRecord) { this.record = validateRunRecord(record); }
    async get(id: string) { return id === this.record.id ? this.record : undefined; }
    async activeRecord() { return isTerminalRun(this.record) ? undefined : this.record; }
    async claim(ownerId: string, now: number) {
        const lease = claimRunLease(this.lease, ownerId, now);
        if (!lease) return false;
        this.lease = lease; return true;
    }
    async renew(ownerId: string, now: number) {
        if (this.lease?.ownerId !== ownerId) return false;
        this.lease = claimRunLease(this.lease, ownerId, now); return true;
    }
    async release(ownerId: string) {
        if (this.lease?.ownerId === ownerId) this.lease = undefined;
    }
    async save(next: RunRecord, expected: number | null, ownerId: string) {
        this.attempts++;
        const gate = this.gate;
        this.gate = undefined;
        if (gate) await gate.promise;
        if (this.lease?.ownerId !== ownerId) throw new RunOwnershipError();
        assertRunSave(this.record, next, expected, isTerminalRun(this.record) ? undefined : this.record);
        if (this.failNext) { this.failNext = false; throw new Error("Injected checkpoint failure"); }
        this.record = validateRunRecord(next);
        this.commits++;
    }
}

async function until(predicate: () => boolean, label: string, timeout = 3000): Promise<void> {
    const deadline = performance.now() + timeout;
    while (!predicate()) {
        if (performance.now() > deadline) throw new Error(`Timed out waiting for ${label}.`);
        await new Promise(resolve => setTimeout(resolve, 5));
    }
}

async function fixture(saved = checkpoint()) {
    const app = await createApp({ defaults: false, plugins: [StandardPhysicsPlugin] });
    const { world } = app;
    const session = world.resource(Session), player = world.resource(PlayerState), journey = world.resource(Journey);
    player.body = world.create();
    world.add(player.body, Transform);
    world.add(player.body, Body);
    const storage = new Checkpoints(saved);
    const store = new RunStore(undefined, { storage, ownerId: "journey-owner", locks: null });
    const context = { state: "running", resume: async () => {} };
    const transport = {
        state: "stopped" as TransportState, position: 0, visualPosition: 0,
        playbackRate: 1, starts: 0, resumes: 0, stops: 0,
        setVolumes() {}, setVisualOffset() {},
        async start() {
            this.starts++; this.state = "playing"; this.position = this.visualPosition = -2;
        },
        async resume() { this.resumes++; this.state = "playing"; },
        pause() { this.state = "paused"; },
        stop() { this.stops++; this.state = "stopped"; },
        unload() { this.stop(); },
    };
    const output = world.resource(AudioOutput);
    output.context = context as unknown as AudioContext;
    output.bus = {} as AudioNode;
    session.transport = transport as unknown as MusicTransport;
    const manifest: TrackManifest = {
        schemaVersion: 1, id: "pinned-chart", title: "Mutable library title", artist: "Artist",
        audioUrl: `library:${"a".repeat(64)}`, duration: 12, bpm: 120,
        firstBeatOffset: 0, beatsPerBar: 4, beats: generateTimeline(12, 120), source: "test", license: "test",
    };
    const library = {
        gameplay: [] as boolean[], loads: [] as string[], disposals: 0,
        loadGate: undefined as ReturnType<typeof deferred> | undefined,
        snapshot: { available: true, tracks: [], playlists: [] },
        async setGameplayActive(active: boolean) { this.gameplay.push(active); },
        async loadRevision(id: string): Promise<LoadedTrack> {
            this.loads.push(id);
            const gate = this.loadGate; this.loadGate = undefined;
            if (gate) await gate.promise;
            let disposed = false;
            return {
                manifest: { ...manifest }, buffer: {} as AudioBuffer,
                dispose: () => { if (!disposed) { disposed = true; library.disposals++; } },
            };
        },
    };
    journey.initialized = true;
    journey.initializing = Promise.resolve();
    journey.library = library as unknown as MusicLibrary;
    journey.store = store;
    journey.active = saved;
    world.pause();
    const originalDocument = Object.getOwnPropertyDescriptor(globalThis, "document");
    Object.defineProperty(globalThis, "document", {
        configurable: true, value: { hidden: false, hasFocus: () => true },
    });
    return {
        app, world, session, player, journey, storage, store, library, transport, context,
        async dispose() {
            await store.release();
            session.loaded?.dispose();
            app.dispose();
            if (originalDocument) Object.defineProperty(globalThis, "document", originalDocument);
            else Reflect.deleteProperty(globalThis, "document");
        },
    };
}

describe("campaign session integration", () => {
    test("initial choice waits for durable save, ignores duplicate clicks and occurs only once", async () => {
        const f = await fixture(checkpoint("starting"));
        try {
            await continueCampaign(f.world);
            expect(f.session.phase).toBe("starting");
            expect(f.session.combat.upgrades.pending).toBe(1);
            expect(f.transport.starts).toBe(0);
            const choice = f.session.combat.upgrades.choices[0]!;
            const gate = deferred(); f.storage.gate = gate;
            expect(selectCampaignUpgrade(f.world, choice.id, 1)).toBe(true);
            expect(selectCampaignUpgrade(f.world, choice.id, 1)).toBe(false);
            quitSession(f.world);
            expect(f.journey.current?.status).toBe("starting");
            expect(f.storage.record.initialChoiceCompleted).toBe(false);
            expect(f.session.combat.upgrades.ranks[choice.id]).toBe(0);
            expect(f.journey.busy).toBe(true);
            gate.resolve();
            await until(() => !f.journey.busy, "starting upgrade feedback");
            expect(f.session.phase).toBe("map");
            expect(f.storage.commits).toBe(1);
            expect(f.storage.record.initialChoiceCompleted).toBe(true);
            expect(f.session.combat.upgrades.ranks[choice.id]).toBe(1);
            expect(f.session.combat.upgrades.pending).toBe(0);
            quitSession(f.world);
            await continueCampaign(f.world);
            expect(f.session.phase).toBe("map");
            expect(f.session.combat.upgrades.pending).toBe(0);
            expect(f.transport.starts).toBe(0);
            expect(selectCampaignUpgrade(f.world, choice.id, 1)).toBe(false);
        } finally { await f.dispose(); }
    });

    test("Continue loads pinned chart once, and save/exit replays the entry without mid-song gains", async () => {
        const entry = checkpoint();
        const f = await fixture(entry);
        try {
            await Promise.all([continueCampaign(f.world), continueCampaign(f.world)]);
            expect(f.session.phase).toBe("playing");
            expect(f.session.position).toBe(-2);
            expect(f.session.track.title).toBe(entry.songs[0]!.title);
            expect(f.library.loads).toEqual(["pinned-chart"]);
            expect(f.transport.starts).toBe(1);
            expect(f.session.combat.encounter?.id).toBe("mixed-assault");
            expect(f.session.combat.upgrades.pending).toBe(0);
            const initial = snapshotProgression(f.session.combat);
            const initialPickups = structuredClone(f.session.combat.pickups);
            expect(initialPickups.schedule).toHaveLength(4);
            f.session.combat.pickups.nextSpawn = 3;
            f.session.combat.pickups.collected.health = 1;
            dropExperience(f.session.combat.experience, f.player.position, 180);
            advanceExperience(f.session.combat.experience, 0.01, f.player.position);
            queueUpgradeLevels(f.session.combat.upgrades, f.session.combat.experience.level);
            prepareUpgradeChoices(f.session.combat);
            chooseUpgrade(f.session.combat, f.session.combat.upgrades.choices[0]!.id, 5);
            f.session.combat.score = 10000;
            f.session.combat.kills = 99;
            f.session.combat.health = 1;
            f.session.combat.regenerationDueAt = 50;
            f.session.combat.time = 7;
            f.player.keys.add("KeyD");
            pauseSession(f.world);
            quitSession(f.world);
            expect(f.journey.current).toBeUndefined();
            expect(f.session.phase).toBe("menu");
            expect(f.storage.record).toEqual(entry);
            expect(f.storage.commits).toBe(0);
            expect(f.library.disposals).toBe(1);
            await continueCampaign(f.world);
            expect(snapshotProgression(f.session.combat)).toEqual(initial);
            expect(f.session.combat.pickups).toEqual(initialPickups);
            expect(f.session.combat.health).toBe(f.session.combat.playerStats.effective.maxHealth);
            expect(f.session.combat.time).toBe(0);
            expect(f.session.combat.experience.drops).toEqual([]);
            expect(f.session.combat.projectiles).toEqual([]);
            expect(f.player.keys.size).toBe(0);
            expect(f.transport.starts).toBe(2);
            expect(f.library.loads).toEqual(["pinned-chart", "pinned-chart"]);
        } finally { await f.dispose(); }
    });

    test("failed clear stays frozen with original entry, then retries one settlement and commits each intermission pick", async () => {
        const entry = checkpoint();
        const f = await fixture(entry);
        try {
            await continueCampaign(f.world);
            dropExperience(f.session.combat.experience, f.player.position, 36);
            advanceExperience(f.session.combat.experience, 0.01, f.player.position);
            queueUpgradeLevels(f.session.combat.upgrades, f.session.combat.experience.level);
            prepareUpgradeChoices(f.session.combat);
            const offered = f.session.combat.upgrades.choices.map(choice => choice.id);
            dropExperience(f.session.combat.experience, { x: 15, z: 15 }, 200);
            f.session.position = 12;
            f.player.keys.add("KeyD");
            f.storage.failNext = true;
            finishCampaignSong(f.world, "complete");
            finishCampaignSong(f.world, "complete");
            expect(f.session.phase).toBe("settling");
            expect(f.transport.state).toBe("stopped");
            expect(f.world.time.paused).toBe(true);
            expect(f.player.enabled).toBe(false);
            expect(f.player.keys.size).toBe(0);
            await until(() => !f.journey.busy, "failed clear");
            expect(f.storage.record).toEqual(entry);
            expect(f.storage.attempts).toBe(1);
            expect(f.journey.retrySave).toBeDefined();
            expect(f.journey.error).toContain("Progress was not saved");
            quitSession(f.world);
            expect(f.session.phase).toBe("settling");
            expect(f.journey.current).toEqual(entry);
            await f.journey.retrySave!();
            expect(f.session.phase).toBe("intermission");
            expect(f.storage.commits).toBe(1);
            expect(f.storage.record.route).toHaveLength(1);
            expect(f.storage.record.progression.experience.totalXp).toBe(236);
            expect(f.session.combat.upgrades.choices.map(choice => choice.id)).toEqual(offered);
            expect(f.session.combat.health).toBe(f.session.combat.playerStats.effective.maxHealth);
            let picks = 0;
            while (f.session.phase === "intermission") {
                const before = f.session.combat.upgrades.pending;
                const offer = f.session.combat.upgrades;
                expect(selectCampaignUpgrade(f.world, offer.choices[0]!.id, offer.offeredLevel)).toBe(true);
                expect(selectCampaignUpgrade(f.world, offer.choices[0]!.id, offer.offeredLevel)).toBe(false);
                await until(() => !f.journey.busy, "intermission selection");
                picks++;
                expect(f.storage.record.progression.upgrades.pending).toBe(before - 1);
                const persisted = snapshotProgression(f.session.combat);
                quitSession(f.world);
                await continueCampaign(f.world);
                expect(snapshotProgression(f.session.combat)).toEqual(persisted);
                expect(f.storage.record.progression.experience.totalXp).toBe(236);
            }
            expect(picks).toBe(3);
            expect(f.session.phase).toBe("map");
            expect(f.storage.commits).toBe(1 + picks);
            expect(f.transport.starts).toBe(1);
            expect(f.library.loads).toHaveLength(1);
        } finally { await f.dispose(); }
    });

    for (const fatal of [false, true]) {
        test(`final completion${fatal ? " with a fatal last step" : ""} becomes durable before showing its result`, async () => {
            const f = await fixture(checkpoint("song-active", 1));
            try {
                await continueCampaign(f.world);
                dropExperience(f.session.combat.experience, { x: 10, z: 10 }, 1000);
                f.session.position = 12;
                if (fatal) { f.session.combat.health = 0; f.session.combat.defeated = true; }
                const gate = deferred(); f.storage.gate = gate;
                finishCampaignSong(f.world, "complete");
                expect(f.session.phase).toBe("settling");
                expect(f.storage.record.status).toBe("song-active");
                expect(f.journey.active).toBeDefined();
                gate.resolve();
                await until(() => !f.journey.busy, "terminal result");
                expect(f.session.phase).toBe("results");
                expect(f.session.result).toBe(fatal ? "defeat" : "complete");
                expect(f.storage.record.status).toBe(fatal ? "defeated" : "completed");
                expect(f.storage.record.progression.experience.totalXp).toBe(fatal ? 0 : 1000);
                expect(f.journey.active).toBeUndefined();
                expect(f.store.ownsRun).toBe(false);
                expect(f.session.position).toBe(12);
                finishCampaignSong(f.world, "complete");
                expect(f.storage.commits).toBe(1);
                expect(await f.store.activeRecord()).toBeUndefined();
            } finally { await f.dispose(); }
        });
    }

    test("Quick Play uses a fresh character while preserving the suspended campaign", async () => {
        const entry = checkpoint();
        const f = await fixture(entry);
        try {
            await continueCampaign(f.world);
            f.session.combat.score = 999;
            await startSession(f.world, { mode: "dojo", bpm: 120 });
            expect(f.journey.current).toBeUndefined();
            expect(f.session.phase).toBe("starting");
            expect(f.session.combat.score).toBe(0);
            expect(f.session.combat.upgrades.pending).toBe(1);
            expect(Object.values(f.session.combat.upgrades.ranks).every(rank => rank === 0)).toBe(true);
            expect(f.storage.record).toEqual(entry);
            expect(f.storage.commits).toBe(0);
            expect(f.store.ownsRun).toBe(false);
            await continueCampaign(f.world);
            expect(f.session.phase).toBe("playing");
            expect(f.session.combat.upgrades.pending).toBe(0);
            expect(f.session.combat.score).toBe(0);
            expect(f.storage.record).toEqual(entry);
        } finally { await f.dispose(); }
    });

    test("a late campaign load is disposed after switching to Quick Play and cannot replace its session", async () => {
        const entry = checkpoint();
        const f = await fixture(entry);
        try {
            const gate = deferred(); f.library.loadGate = gate;
            const continuing = continueCampaign(f.world);
            await until(() => f.library.loads.length === 1, "campaign load");
            await startSession(f.world, { mode: "dojo", bpm: 120 });
            expect(f.session.phase).toBe("starting");
            gate.resolve();
            await continuing;
            expect(f.session.phase).toBe("starting");
            expect(f.session.selection.mode).toBe("dojo");
            expect(f.session.track.id).toBe("practice-120");
            expect(f.journey.current).toBeUndefined();
            expect(f.session.loaded).toBeUndefined();
            expect(f.library.disposals).toBe(1);
            expect(f.transport.starts).toBe(0);
            expect(f.storage.record).toEqual(entry);
        } finally { await f.dispose(); }
    });

    test("cancelled Quick Play audio startup cannot clear a newer campaign or release its owner", async () => {
        const f = await fixture();
        const gate = deferred();
        try {
            let resumes = 0;
            f.context.resume = async () => { if (++resumes === 1) await gate.promise; };
            const staleStart = startSession(f.world, { mode: "dojo", bpm: 120 });
            expect(f.session.phase).toBe("loading");
            quitSession(f.world);
            await continueCampaign(f.world);
            const campaign = f.journey.current;
            expect(campaign?.status).toBe("song-active");
            expect(f.session.phase).toBe("playing");
            expect(f.store.ownsRun).toBe(true);
            gate.resolve();
            await staleStart;
            expect(f.journey.current).toBe(campaign);
            expect(f.store.ownsRun).toBe(true);
            expect(f.session.phase).toBe("playing");
            expect(f.session.selection.mode).toBe("library");
            expect(f.storage.record).toEqual(campaign!);
        } finally { gate.resolve(); await f.dispose(); }
    });

    test("ownership lost while audio resume is pending cannot restart campaign playback", async () => {
        const f = await fixture();
        try {
            await continueCampaign(f.world);
            pauseSession(f.world);
            const gate = deferred();
            f.context.resume = async () => { await gate.promise; };
            const resuming = resumeSession(f.world);
            await f.store.release();
            gate.resolve();
            await resuming;
            expect(f.session.phase).toBe("paused");
            expect(f.transport.resumes).toBe(0);
            expect(f.player.enabled).toBe(false);
            expect(f.world.time.paused).toBe(true);
        } finally { await f.dispose(); }
    });

    test("ownership lost during transport resume pauses audio again before enabling the player", async () => {
        const f = await fixture();
        try {
            await continueCampaign(f.world);
            pauseSession(f.world);
            const gate = deferred();
            let requested = false;
            f.transport.resume = async () => {
                requested = true;
                await gate.promise;
                f.transport.resumes++;
                f.transport.state = "playing";
            };
            const resuming = resumeSession(f.world);
            await until(() => requested, "transport resume");
            await f.store.release();
            gate.resolve();
            await resuming;
            expect(f.session.phase).toBe("paused");
            expect(f.transport.state).not.toBe("playing");
            expect(f.player.enabled).toBe(false);
            expect(f.world.time.paused).toBe(true);
        } finally { await f.dispose(); }
    });

    test("ownership lost during count-in startup stops audio and keeps the entry replayable", async () => {
        const f = await fixture();
        try {
            const gate = deferred();
            let requested = false;
            f.transport.start = async () => {
                requested = true;
                await gate.promise;
                f.transport.starts++;
                f.transport.state = "playing";
            };
            const continuing = continueCampaign(f.world);
            await until(() => requested, "transport start");
            await f.store.release();
            gate.resolve();
            await continuing;
            expect(f.session.phase).not.toBe("playing");
            expect(f.transport.state).not.toBe("playing");
            expect(f.player.enabled).toBe(false);
            expect(f.world.time.paused).toBe(true);
            expect(f.storage.record.status).toBe("song-active");
            expect(f.storage.commits).toBe(0);
        } finally { await f.dispose(); }
    });

    test("ownership loss prevents resume and prevents a delayed upgrade handoff from opening its map", async () => {
        const f = await fixture();
        try {
            await continueCampaign(f.world);
            pauseSession(f.world);
            await f.store.release();
            await resumeSession(f.world);
            expect(f.session.phase).toBe("paused");
            expect(f.transport.resumes).toBe(0);
            expect(f.session.error).toContain("no longer owns");
        } finally { await f.dispose(); }
        const start = await fixture(checkpoint("starting"));
        try {
            await continueCampaign(start.world);
            const offer = start.session.combat.upgrades;
            selectCampaignUpgrade(start.world, offer.choices[0]!.id, offer.offeredLevel);
            await until(() => start.journey.current?.status === "choosing-arena", "saved initial selection");
            await start.store.release();
            await until(() => !start.journey.busy, "ownership guard during upgrade feedback");
            expect(start.session.phase).toBe("settling");
            expect(start.storage.record.status).toBe("choosing-arena");
            expect(start.journey.error).toContain("ownership changed");
            expect(start.transport.starts).toBe(0);
        } finally { await start.dispose(); }
    });

    test("retrying a committed handoff never restores a checkpoint another owner has already ended", async () => {
        const f = await fixture(checkpoint("starting"));
        try {
            await continueCampaign(f.world);
            const offer = f.session.combat.upgrades;
            selectCampaignUpgrade(f.world, offer.choices[0]!.id, offer.offeredLevel);
            await until(() => f.journey.current?.status === "choosing-arena", "committed choice");
            await f.store.release();
            await until(() => !f.journey.busy, "interrupted handoff");
            expect(f.journey.retrySave).toBeDefined();
            // Another tab owns, abandons and releases the campaign before Retry.
            f.storage.record = abandonRun(f.storage.record);
            const terminal = f.storage.record;
            await expect(f.journey.retrySave!()).rejects.toThrow("newer checkpoint");
            expect(f.session.phase).toBe("settling");
            expect(f.transport.starts).toBe(0);
            expect(f.storage.record).toEqual(terminal);
            expect(f.storage.commits).toBe(1);
            expect(f.journey.error).toContain("Reload saved checkpoint");
        } finally { await f.dispose(); }
    });

    test("disposing during a pending checkpoint does not create a retry UI or touch the disposed world", async () => {
        const f = await fixture(checkpoint("starting"));
        let disposed = false;
        const gate = deferred();
        try {
            await continueCampaign(f.world);
            f.storage.gate = gate;
            const offer = f.session.combat.upgrades;
            selectCampaignUpgrade(f.world, offer.choices[0]!.id, offer.offeredLevel);
            expect(f.journey.busy).toBe(true);
            await f.dispose(); disposed = true;
            gate.resolve();
            await until(() => !f.journey.busy, "disposed checkpoint callback");
            expect(f.journey.error).toBeUndefined();
            expect(f.journey.retrySave).toBeUndefined();
            expect(f.storage.record.status).toBe("starting");
            expect(f.store.ownsRun).toBe(false);
        } finally { gate.resolve(); if (!disposed) await f.dispose(); }
    });
});
