import { describe, expect, test } from "bun:test";
import { Body, createApp, StandardPhysicsPlugin } from "@dylanebert/shallot";
import { AudioOutput } from "@dylanebert/shallot/audio";
import { createCombat, spawnOnBeat } from "../combat";
import { PlayerState } from "../player";
import type { MusicTransport, TransportObservation, TransportState } from "../rhythm/transport";
import { prepareUpgradeChoices, queueUpgradeLevels } from "../upgrades";
import {
    ObserveMusic, pauseSession, PrepareCombat, resumeSession, selectUpgrade, Session,
} from "./index";

function deferred() {
    let resolve!: () => void;
    let reject!: (error: Error) => void;
    const promise = new Promise<void>((success, failure) => { resolve = success; reject = failure; });
    return { promise, resolve, reject };
}

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
        state: "paused" as TransportState,
        position: 1.5,
        playbackRate: 0,
        resumes: 0,
        pauses: [] as string[],
        observation: {
            position: 1.5, visualPosition: 1.5, beats: [], completed: false,
        } as TransportObservation,
        observe() { return this.observation; },
        setVolumes() {},
        setVisualOffset() {},
        pause(reason = "user") { this.state = "paused"; this.pauses.push(reason); },
        async resume() { this.resumes++; this.state = "playing"; },
        stop() { this.state = "stopped"; },
    };
    const output = world.resource(AudioOutput);
    output.context = context as unknown as AudioContext;
    output.bus = {} as AudioNode;
    session.transport = transport as unknown as MusicTransport;
    session.phase = "upgrading";
    session.position = session.visualPosition = 1.5;
    session.combat.protectPlayer = true;
    player.enabled = false;
    world.pause();
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

describe("upgrade selection and session lifecycle", () => {
    test("each earned level receives a choice; only the final choice resumes music and controls", async () => {
        const f = await fixture();
        try {
            queueUpgradeLevels(f.session.combat.upgrades, 4);
            prepareUpgradeChoices(f.session.combat);
            await selectUpgrade(f.world, "invalid");
            expect(f.session.combat.upgrades.pending).toBe(3);
            for (let remaining = 3; remaining > 0; remaining--) {
                const offered = f.session.combat.upgrades.choices[0]!;
                const previousRank = f.session.combat.upgrades.ranks[offered.id];
                await selectUpgrade(f.world, offered.id);
                expect(f.session.combat.upgrades.ranks[offered.id]).toBe(previousRank + 1);
                expect(f.session.combat.upgrades.pending).toBe(remaining - 1);
                if (remaining > 1) {
                    expect(f.session.phase).toBe("upgrading");
                    expect(f.transport.resumes).toBe(0);
                    expect(f.world.time.paused).toBe(true);
                    expect(f.player.enabled).toBe(false);
                    expect(f.session.combat.protectPlayer).toBe(true);
                    expect(f.session.combat.upgrades.choices).toHaveLength(3);
                }
            }
            expect(f.session.phase).toBe("playing");
            expect(f.transport.resumes).toBe(1);
            expect(f.player.enabled).toBe(true);
            expect(f.session.combat.protectPlayer).toBe(false);
            expect(f.world.time.paused).toBe(false);
            expect(f.world.time.scale).toBe(1);
            expect(f.session.upgradeBusy).toBe(false);
            expect(f.session.upgradeResumePending).toBe(false);
        } finally { f.dispose(); }
    });

    test("audio permission failure keeps the applied upgrade and explicit retry cannot apply it twice", async () => {
        const f = await fixture();
        try {
            queueUpgradeLevels(f.session.combat.upgrades, 2);
            const offered = prepareUpgradeChoices(f.session.combat)[0]!;
            f.context.resume = async () => { throw new Error("Permission denied"); };
            await selectUpgrade(f.world, offered.id);
            expect(f.session.phase).toBe("upgrading");
            expect(f.session.combat.upgrades.ranks[offered.id]).toBe(1);
            expect(f.session.combat.upgrades.pending).toBe(0);
            expect(f.session.upgradeResumePending).toBe(true);
            expect(f.session.upgradeBusy).toBe(false);
            expect(f.session.error).toBe("Permission denied");
            expect(f.world.time.paused).toBe(true);
            await selectUpgrade(f.world, offered.id);
            expect(f.session.combat.upgrades.ranks[offered.id]).toBe(1);
            f.context.resume = async () => {};
            await resumeSession(f.world);
            expect(f.session.phase).toBe("playing");
            expect(f.session.combat.upgrades.ranks[offered.id]).toBe(1);
            expect(f.transport.resumes).toBe(1);
        } finally { f.dispose(); }
    });

    test("visible-window focus loss during delayed audio permission preserves the upgrade and requires explicit resume", async () => {
        const f = await fixture();
        try {
            queueUpgradeLevels(f.session.combat.upgrades, 2);
            const offered = prepareUpgradeChoices(f.session.combat)[0]!;
            const permission = deferred();
            f.context.resume = () => permission.promise;
            const selection = selectUpgrade(f.world, offered.id);
            expect(f.session.upgradeBusy).toBe(true);
            pauseSession(f.world, "Window lost focus");
            permission.resolve();
            await selection;
            expect(f.session.phase).toBe("upgrading");
            expect(f.session.upgradeResumePending).toBe(true);
            expect(f.session.upgradeBusy).toBe(false);
            expect(f.transport.resumes).toBe(0);
            expect(f.player.enabled).toBe(false);
            expect(f.world.time.paused).toBe(true);
            expect(f.session.combat.upgrades.ranks[offered.id]).toBe(1);
            f.context.resume = async () => {};
            await resumeSession(f.world);
            expect(f.session.phase).toBe("playing");
            expect(f.transport.resumes).toBe(1);
        } finally { f.dispose(); }
    });

    test("focus loss during the transport resume itself stops its delayed source before enabling the game", async () => {
        const f = await fixture();
        try {
            queueUpgradeLevels(f.session.combat.upgrades, 2);
            const offered = prepareUpgradeChoices(f.session.combat)[0]!;
            const audio = deferred();
            let resumeStarted = false;
            f.transport.resume = async () => {
                resumeStarted = true;
                await audio.promise;
                f.transport.state = "playing";
            };
            const selection = selectUpgrade(f.world, offered.id);
            await Promise.resolve();
            expect(resumeStarted).toBe(true);
            pauseSession(f.world, "Window lost focus");
            audio.resolve();
            await selection;
            expect(f.transport.state).toBe("paused");
            expect(f.session.phase).toBe("upgrading");
            expect(f.session.upgradeResumePending).toBe(true);
            expect(f.player.enabled).toBe(false);
            expect(f.world.time.paused).toBe(true);
        } finally { f.dispose(); }
    });

    test("a replaced run invalidates the old pending resume even when the new run is also choosing an upgrade", async () => {
        const f = await fixture();
        try {
            queueUpgradeLevels(f.session.combat.upgrades, 2);
            const offered = prepareUpgradeChoices(f.session.combat)[0]!;
            const permission = deferred();
            f.context.resume = () => permission.promise;
            const selection = selectUpgrade(f.world, offered.id);
            // Model the next session owner arriving while browser permission is
            // unresolved. Matching phases must not let the stale owner resume it.
            const replacement = createCombat(7);
            f.session.loadToken++;
            f.session.combat = replacement;
            f.session.upgradeBusy = true;
            f.session.upgradeResumePending = false;
            f.transport.stop();
            permission.resolve();
            await selection;
            expect(f.session.phase).toBe("upgrading");
            expect(f.transport.state).toBe("stopped");
            expect(f.transport.resumes).toBe(0);
            expect(f.session.combat).toBe(replacement);
            expect(f.session.combat.upgrades.pending).toBe(0);
            expect(f.session.combat.upgrades.choices).toEqual([]);
            expect(f.session.combat.protectPlayer).toBe(false);
            expect(f.session.upgradeBusy).toBe(true);
            expect(f.session.upgradeResumePending).toBe(false);
            expect(f.player.enabled).toBe(false);
            expect(f.world.time.paused).toBe(true);
            expect(f.world.time.scale).toBe(1);
        } finally { f.dispose(); }
    });

    test("the exact pause-boundary beat is consumed once before fixed simulation freezes", async () => {
        const f = await fixture();
        try {
            f.session.phase = "upgrade-slowing";
            f.world.resume();
            f.world.setTimeScale(0.2);
            f.session.combat.lastBeatIndex = 2;
            f.session.combat.lastBarIndex = 0;
            f.transport.observation = {
                position: 1.5, visualPosition: 1.5, completed: false,
                pausedReason: "upgrade", slowedToPause: true,
                beats: [{ time: 1.5, index: 3, bar: 0, beatInBar: 3, downbeat: false, scheduledTime: 11 }],
            };
            ObserveMusic.update!(f.world);
            expect(String(f.session.phase)).toBe("upgrading");
            expect(f.session.position).toBe(1.5);
            expect(f.session.combat.lastBeatIndex).toBe(3);
            expect(f.session.combat.score).toBe(2);
            expect(f.session.combat.projectiles).toHaveLength(1);
            expect(f.session.pending).toEqual([]);
            expect(f.world.time.paused).toBe(true);
            expect(f.world.time.scale).toBe(1);
            ObserveMusic.update!(f.world);
            expect(f.session.combat.score).toBe(2);
            expect(f.session.combat.projectiles).toHaveLength(1);
        } finally { f.dispose(); }
    });

    for (const entry of [
        { phase: "playing", reason: "Paused by you", pausedPhase: "paused" },
        { phase: "playing", reason: "Window lost focus", pausedPhase: "paused" },
        { phase: "upgrade-slowing", reason: "Window lost focus", pausedPhase: "upgrading" },
    ] as const) {
        test(`${entry.phase}: ${entry.reason} settles an observed arrival beat without stepping or replaying it`, async () => {
            const f = await fixture(true);
            try {
                f.session.phase = entry.phase;
                f.transport.state = "playing";
                f.transport.playbackRate = entry.phase === "upgrade-slowing" ? 0.2 : 1;
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
                if (entry.phase === "upgrade-slowing") {
                    queueUpgradeLevels(f.session.combat.upgrades, 2);
                    prepareUpgradeChoices(f.session.combat);
                }
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
                if (entry.phase === "upgrade-slowing") {
                    await selectUpgrade(f.world, f.session.combat.upgrades.choices[0]!.id);
                } else {
                    await resumeSession(f.world);
                }
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

    test("track completion during slowdown wins over the pending upgrade and returns a clean result", async () => {
        const f = await fixture();
        try {
            queueUpgradeLevels(f.session.combat.upgrades, 2);
            prepareUpgradeChoices(f.session.combat);
            f.session.phase = "upgrade-slowing";
            f.world.resume();
            f.world.setTimeScale(0.12);
            f.transport.observation = {
                position: f.session.track.duration,
                visualPosition: f.session.track.duration,
                completed: true, beats: [],
            };
            ObserveMusic.update!(f.world);
            expect(String(f.session.phase)).toBe("results");
            expect(f.session.result).toBe("complete");
            expect(f.session.combat.protectPlayer).toBe(false);
            expect(f.session.upgradeBusy).toBe(false);
            expect(f.session.upgradeResumePending).toBe(false);
            expect(f.transport.state).toBe("stopped");
            expect(f.transport.resumes).toBe(0);
            expect(f.world.time.paused).toBe(true);
            expect(f.world.time.scale).toBe(1);
            expect(f.session.pending).toEqual([]);
        } finally { f.dispose(); }
    });
});
