import { describe, expect, spyOn, test } from "bun:test";
import { Body, createApp, StandardPhysicsPlugin, Transform } from "@dylanebert/shallot";
import { AudioOutput } from "@dylanebert/shallot/audio";
import { spawnOnBeat } from "../combat";
import { dropExperience } from "../experience/state";
import { PlayerState } from "../player";
import type { MusicTransport, TransportObservation, TransportState } from "../rhythm/transport";
import { prepareUpgradeChoices, queueUpgradeLevels } from "../upgrades";
import {
    ObserveMusic, pauseSession, PrepareCombat, quitSession, resumeSession, ResolveCombat, selectUpgrade, Session, startSession,
} from "./index";

async function fixture(physics = false) {
    const app = await createApp({ defaults: false, plugins: physics ? [StandardPhysicsPlugin] : [] });
    const { world } = app;
    const session = world.resource(Session), player = world.resource(PlayerState);
    const context = {
        state: "running",
        resumeCalls: 0,
        resume: async () => { context.resumeCalls++; },
    };
    const transport = {
        state: "playing" as TransportState,
        position: 1.5,
        playbackRate: 1,
        resumes: 0,
        starts: 0,
        pauses: [] as string[],
        observation: {
            position: 1.5, visualPosition: 1.5, beats: [], completed: false,
        } as TransportObservation,
        observe() { return this.observation; },
        setVolumes() {},
        setVisualOffset() {},
        pause(reason = "user") { this.state = "paused"; this.pauses.push(reason); },
        async resume() { this.resumes++; this.state = "playing"; },
        async start() { this.starts++; this.state = "playing"; this.position = -2; },
        stop() { this.state = "stopped"; },
    };
    const output = world.resource(AudioOutput);
    output.context = context as unknown as AudioContext;
    output.bus = {} as AudioNode;
    session.transport = transport as unknown as MusicTransport;
    session.phase = "playing";
    session.position = session.visualPosition = 1.5;
    player.enabled = true;
    world.resume();
    const originalDocument = Object.getOwnPropertyDescriptor(globalThis, "document");
    Object.defineProperty(globalThis, "document", {
        configurable: true, value: { hidden: false, hasFocus: () => true },
    });
    return {
        app, world, session, player, context, transport,
        dispose() {
            app.dispose();
            if (originalDocument) Object.defineProperty(globalThis, "document", originalDocument);
            else Reflect.deleteProperty(globalThis, "document");
        },
    };
}

describe("upgrades during uninterrupted play", () => {
    test("new runs and restarts draw fresh upgrade seeds without changing the combat sequence", async () => {
        const f = await fixture(true);
        const seeds = [2026, 42, 99];
        let draws = 0;
        const entropy = spyOn(crypto, "getRandomValues").mockImplementation((array: ArrayBufferView) => {
            if (!(array instanceof Uint32Array) || array.length !== 1) {
                throw new Error("Unexpected random request.");
            }
            const seed = seeds[draws++];
            if (seed === undefined) throw new Error("An existing offer was rerolled.");
            array[0] = seed;
            return array;
        });
        try {
            f.player.body = f.world.create();
            f.world.add(f.player.body, Transform);
            f.world.add(f.player.body, Body);
            const offers: string[] = [];
            for (let run = 0; run < seeds.length; run++) {
                if (run === 2) quitSession(f.world);
                // Reusing the selection is also the pause/retry and dojo-reset path.
                await startSession(f.world, { mode: "dojo", bpm: 120 });
                expect(f.session.phase).toBe("starting");
                expect(f.session.error).toBeUndefined();
                const choices = f.session.combat.upgrades.choices;
                expect(choices).toHaveLength(3);
                expect(new Set(choices.map(choice => choice.id)).size).toBe(3);
                offers.push(choices.map(choice => choice.id).sort().join(","));
                expect(f.session.combat.randomState).toBe(2026);
                expect(prepareUpgradeChoices(f.session.combat)).toBe(choices);
            }
            expect(new Set(offers).size).toBe(3);
            expect(draws).toBe(3);
        } finally {
            entropy.mockRestore();
            f.dispose();
        }
    });

    test("the free starting choice applies once before playback and leaves XP-earned levels intact", async () => {
        const f = await fixture();
        try {
            f.session.phase = "starting";
            f.transport.stop();
            f.player.enabled = false;
            f.world.pause();
            f.session.combat.upgrades.pending = 1;
            const choice = prepareUpgradeChoices(f.session.combat)[0]!;
            expect(f.session.combat.upgrades.offeredLevel).toBe(1);
            expect(selectUpgrade(f.world, choice.id, 1)).toBe(true);
            expect(selectUpgrade(f.world, choice.id, 1)).toBe(false);
            expect(f.session.combat.upgrades.ranks[choice.id]).toBe(1);
            expect(f.session.startBusy).toBe(true);
            await Promise.resolve();
            await Promise.resolve();
            expect(String(f.session.phase)).toBe("playing");
            expect(f.session.startBusy).toBe(false);
            expect(f.transport.starts).toBe(1);
            expect(f.session.position).toBe(-2);
            expect(f.session.combat.experience.level).toBe(1);
            expect(f.session.combat.experience.totalXp).toBe(0);
            queueUpgradeLevels(f.session.combat.upgrades, 2);
            prepareUpgradeChoices(f.session.combat);
            expect(f.session.combat.upgrades.pending).toBe(1);
            expect(f.session.combat.upgrades.offeredLevel).toBe(2);
        } finally { f.dispose(); }
    });

    test("audio startup failure keeps the starting upgrade and retries without awarding it again", async () => {
        const f = await fixture();
        try {
            f.session.phase = "starting";
            f.transport.stop();
            f.world.pause();
            f.session.combat.upgrades.pending = 1;
            const choice = prepareUpgradeChoices(f.session.combat)[0]!;
            f.context.resume = async () => { throw new Error("Audio permission denied"); };
            selectUpgrade(f.world, choice.id, 1);
            await Promise.resolve();
            await Promise.resolve();
            expect(f.session.phase).toBe("starting");
            expect(f.session.error).toBe("Audio permission denied");
            expect(f.session.startBusy).toBe(false);
            expect(f.transport.starts).toBe(0);
            expect(f.session.combat.upgrades.ranks[choice.id]).toBe(1);
            f.context.resume = async () => {};
            await resumeSession(f.world);
            expect(String(f.session.phase)).toBe("playing");
            expect(f.transport.starts).toBe(1);
            expect(f.session.combat.upgrades.ranks[choice.id]).toBe(1);
        } finally { f.dispose(); }
    });

    test("earning more levels preserves the current offer, movement, and normal music speed", async () => {
        const f = await fixture();
        try {
            f.player.keys.add("KeyD");
            f.player.input = { x: 1, z: 0 };
            dropExperience(f.session.combat.experience, f.player.position, 40);
            f.world.step(1 / 60);
            ResolveCombat.update!(f.world);
            const first = f.session.combat.upgrades.choices;
            expect(first).toHaveLength(3);
            expect(f.session.combat.upgrades.offeredLevel).toBe(2);
            dropExperience(f.session.combat.experience, f.player.position, 60);
            ResolveCombat.update!(f.world);
            expect(f.session.combat.upgrades.pending).toBe(2);
            expect(f.session.combat.upgrades.choices).toBe(first);
            expect(f.player.keys.has("KeyD")).toBe(true);
            expect(f.player.input).toEqual({ x: 1, z: 0 });
            expect(f.player.enabled).toBe(true);
            expect(String(f.session.phase)).toBe("playing");
            expect(f.transport.pauses).toEqual([]);
            expect(f.transport.resumes).toBe(0);
            expect(f.transport.playbackRate).toBe(1);
            expect(f.world.time.paused).toBe(false);
            expect(f.world.time.scale).toBe(1);
        } finally { f.dispose(); }
    });

    test("each queued offer applies synchronously and stale selections cannot spend the next level", async () => {
        const f = await fixture();
        try {
            queueUpgradeLevels(f.session.combat.upgrades, 4);
            prepareUpgradeChoices(f.session.combat);
            selectUpgrade(f.world, "invalid", 2);
            expect(f.session.combat.upgrades.pending).toBe(3);
            for (const level of [2, 3, 4]) {
                expect(f.session.combat.upgrades.offeredLevel).toBe(level);
                const offered = f.session.combat.upgrades.choices[0]!;
                const before = f.session.combat.upgrades.ranks[offered.id];
                selectUpgrade(f.world, offered.id, level);
                expect(f.session.combat.upgrades.ranks[offered.id]).toBe(before + 1);
                expect(f.session.combat.upgrades.pending).toBe(4 - level);
                const held = structuredClone(f.session.combat.upgrades);
                // Even a valid ID from the new offer cannot be selected by an old card.
                selectUpgrade(f.world, f.session.combat.upgrades.choices[0]?.id ?? offered.id, level);
                expect(f.session.combat.upgrades).toEqual(held);
                expect(String(f.session.phase)).toBe("playing");
                expect(f.transport.pauses).toEqual([]);
                expect(f.transport.resumes).toBe(0);
                expect(f.context.resumeCalls).toBe(0);
                expect(f.world.time.paused).toBe(false);
                expect(f.player.enabled).toBe(true);
            }
            expect(f.session.combat.upgrades.choices).toEqual([]);
        } finally { f.dispose(); }
    });

    test("manual pause and focus loss retain pending choices; selection waits for explicit resume", async () => {
        const f = await fixture();
        try {
            queueUpgradeLevels(f.session.combat.upgrades, 3);
            prepareUpgradeChoices(f.session.combat);
            const offered = structuredClone(f.session.combat.upgrades);
            for (const reason of ["Paused by you", "Window lost focus"]) {
                pauseSession(f.world, reason);
                expect(f.session.phase).toBe("paused");
                selectUpgrade(f.world, offered.choices[0]!.id, offered.offeredLevel);
                expect(f.session.combat.upgrades).toEqual(offered);
                expect(f.world.time.paused).toBe(true);
                await resumeSession(f.world);
                expect(String(f.session.phase)).toBe("playing");
                expect(f.session.combat.upgrades).toEqual(offered);
            }
            selectUpgrade(f.world, offered.choices[0]!.id, offered.offeredLevel);
            expect(f.session.combat.upgrades.pending).toBe(1);
        } finally { f.dispose(); }
    });

    test("pending upgrades do not interrupt beat acceptance or combat, and completion wins over selection", async () => {
        const f = await fixture();
        try {
            queueUpgradeLevels(f.session.combat.upgrades, 2);
            const choice = prepareUpgradeChoices(f.session.combat)[0]!;
            f.session.combat.lastBeatIndex = 2;
            f.session.combat.lastBarIndex = 0;
            f.transport.observation = {
                position: 1.5, visualPosition: 1.5, completed: false,
                beats: [{ time: 1.5, index: 3, bar: 0, beatInBar: 3, downbeat: false, scheduledTime: 11 }],
            };
            ObserveMusic.update!(f.world);
            PrepareCombat.update!(f.world);
            expect(f.session.combat.projectiles).toHaveLength(1);
            expect(f.session.combat.score).toBe(2);
            expect(String(f.session.phase)).toBe("playing");
            f.transport.observation = { position: f.session.track.duration, visualPosition: f.session.track.duration, completed: true, beats: [] };
            ObserveMusic.update!(f.world);
            selectUpgrade(f.world, choice.id, 2);
            expect(f.session.combat.upgrades.ranks[choice.id]).toBe(0);
            ResolveCombat.update!(f.world);
            expect(f.session.phase).toBe("results");
            expect(f.session.result).toBe("complete");
            expect(f.transport.state).toBe("stopped");
            expect(f.world.time.paused).toBe(true);
        } finally { f.dispose(); }
    });

    for (const entry of [
        { phase: "playing", reason: "Paused by you", pausedPhase: "paused" },
        { phase: "playing", reason: "Window lost focus", pausedPhase: "paused" },
    ] as const) {
        test(`${entry.phase}: ${entry.reason} settles an observed arrival beat without stepping or replaying it`, async () => {
            const f = await fixture(true);
            try {
                f.session.phase = entry.phase;
                f.transport.state = "playing";
                f.transport.playbackRate = 1;
                f.player.enabled = entry.phase === "playing";
                f.world.resume();
                f.session.combat.time = 0.48;
                f.session.combat.lastBeatIndex = 0;
                f.session.combat.lastBarIndex = 0;
                const [reserved] = spawnOnBeat(f.session.combat, {
                    index: 0, barIndex: 0, isDownbeat: true, time: 0, nextBeatTime: 0.5,
                }, f.player.position);
                expect(reserved).toBeDefined();
                const origin = { x: reserved!.x, z: reserved!.z };
                queueUpgradeLevels(f.session.combat.upgrades, 2);
                prepareUpgradeChoices(f.session.combat);
                f.transport.observation = {
                    position: 0.5, visualPosition: 0.5, completed: false,
                    beats: [{ time: 0.5, index: 1, bar: 0, beatInBar: 1, downbeat: false, scheduledTime: 10 }],
                };
                // A render frame accepts the beat before its fixed accumulator
                // reaches one step. An input/focus event then requests a pause.
                ObserveMusic.update!(f.world);
                expect(f.session.pending).toHaveLength(1);
                expect(f.session.combat.pendingSpawns).toHaveLength(1);
                expect(f.session.combat.enemies).toEqual([]);
                expect(f.session.enemyBodies.size).toBe(0);
                pauseSession(f.world, entry.reason);

                expect(String(f.session.phase)).toBe(entry.pausedPhase);
                expect(f.transport.pauses.at(-1)).toBe(entry.reason === "Window lost focus" ? "hidden" : "user");
                expect(f.session.pending).toEqual([]);
                expect(f.session.combat.pendingSpawns).toEqual([]);
                expect(f.session.combat.enemies).toEqual([reserved!]);
                expect(f.session.enemyBodies.has(reserved!.id)).toBe(true);
                expect([...f.world.query([Body])]).toHaveLength(1);
                expect({ x: reserved!.x, z: reserved!.z }).toEqual(origin);
                expect(f.session.combat.time).toBe(0.48);
                expect(f.session.combat.lastBeatIndex).toBe(1);
                expect(f.session.combat.score).toBe(2);
                expect(f.session.combat.projectiles).toHaveLength(1);
                expect(f.player.enabled).toBe(false);
                expect(f.world.time.paused).toBe(true);
                expect(f.world.time.scale).toBe(1);
                const held = structuredClone(f.session.combat);
                pauseSession(f.world, entry.reason);
                PrepareCombat.update!(f.world);
                expect(f.session.combat).toEqual(held);
                await resumeSession(f.world);
                expect(String(f.session.phase)).toBe("playing");
                PrepareCombat.update!(f.world);
                expect(f.session.combat.pendingSpawns).toEqual([]);
                expect(f.session.combat.enemies).toHaveLength(1);
                expect(f.session.enemyBodies.size).toBe(1);
                expect(f.session.combat.lastBeatIndex).toBe(1);
                expect(f.session.combat.score).toBe(2);
                expect(f.session.combat.projectiles).toHaveLength(1);
                expect(f.session.combat.time).toBe(0.48);
            } finally { f.dispose(); }
        });
    }
});
