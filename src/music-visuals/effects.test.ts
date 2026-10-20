import { describe, expect, test } from "bun:test";
import type { World } from "@dylanebert/shallot";
import { advanceCombat, createCombat, onCombatBeat, type CombatEvent } from "../combat";
import { generateTimeline } from "../rhythm/timeline";
import { MusicalTimeline } from "../rhythm/visual";
import {
    burstAge, EffectDirector, feedbackAge, MAX_ACTIVE_BURSTS, MAX_FEEDBACK,
    MAX_PENDING_BURSTS, shardPose, type Burst,
} from "./effects";
import { MAX_EVENT_QUEUE, publishVisualEvents, type MusicEvent } from "./events";

function event(id: number, patch: Partial<MusicEvent> = {}): MusicEvent {
    return {
        id, kind: "kill", x: id * 2, z: 1, amount: 25, critical: false,
        simulationTime: 0.04, songTime: 0.04, visualTime: 0.04, generation: 1,
        ...patch,
    };
}

function timeline(bpm = 120): MusicalTimeline {
    return new MusicalTimeline(generateTimeline(60, bpm));
}

function queueWorld() {
    const queue: { pending: MusicEvent[]; dropped: number } = { pending: [], dropped: 0 };
    return { queue, world: { resource: () => queue } as unknown as World };
}

describe("musical combat decoration ownership", () => {
    test("a death confirms immediately and expands only on the nearby future subdivision", () => {
        const director = new EffectDirector(timeline(), 1);
        director.consume([event(1)], true);
        expect(director.feedback.map(item => item.id)).toEqual([1]);
        expect(director.bursts).toHaveLength(0);
        expect(director.pending).toHaveLength(1);
        expect(director.pending[0]!.birth).toBeCloseTo(0.125, 10);
        director.step(0.124, true);
        expect(director.bursts).toHaveLength(0);
        director.step(0.126, true);
        expect(director.pending).toHaveLength(0);
        expect(director.bursts).toHaveLength(1);
        expect(burstAge(director.timeline, director.bursts[0]!, 0.126)).toBeGreaterThan(0);
    });

    test("calibration and slow intervals never cause an early accent or a visible wait over 100 ms", () => {
        let accented = 0, quiet = 0;
        for (const bpm of [20, 120, 300]) {
            for (const offset of [-0.25, 0, 0.25]) {
                const director = new EffectDirector(timeline(bpm), 1);
                const killed = event(1, { songTime: 1.04, visualTime: 1.04 + offset });
                director.consume([killed], true);
                expect(director.feedback).toHaveLength(1);
                if (director.pending.length) {
                    accented++;
                    const target = director.pending[0]!.birth;
                    expect(target + 1e-9).toBeGreaterThanOrEqual(killed.songTime);
                    expect(target + 1e-9).toBeGreaterThanOrEqual(killed.visualTime);
                    expect(target - killed.visualTime).toBeLessThanOrEqual(0.100000001);
                } else {
                    quiet++;
                    expect(director.bursts).toHaveLength(1);
                    expect(director.bursts[0]!.quiet).toBe(true);
                    expect(director.bursts[0]!.birth).toBe(killed.visualTime);
                }
            }
        }
        expect(accented).toBeGreaterThan(0);
        expect(quiet).toBeGreaterThan(0);
    });

    test("multiple fixed steps survive one render, while duplicate and old-generation events do not", () => {
        const director = new EffectDirector(timeline(), 1);
        const events = [event(1), event(2, { songTime: 0.05, visualTime: 0.05 }), event(3)];
        director.consume(events.slice(0, 1), true);
        director.consume(events.slice(1), true);
        director.consume(events, true);
        director.consume([event(99, { generation: 0 })], true);
        expect(director.accepted).toBe(3);
        expect(director.feedback.map(item => item.id)).toEqual([1, 2, 3]);
        director.step(0.13, true);
        expect(director.bursts.map(item => item.id)).toEqual([1, 2, 3]);
        const replacement = new EffectDirector(timeline(100), 2);
        replacement.consume([event(1), event(1, { generation: 2 })], true);
        expect(replacement.accepted).toBe(1);
        expect(replacement.feedback[0]!.generation).toBe(2);
    });

    test("pause holds age and pose, resume advances, and clearing for seek/retry removes ownership", () => {
        const director = new EffectDirector(timeline(), 1);
        director.consume([event(1)], true);
        director.step(0.2, true);
        const burst = director.bursts[0]!;
        const age = burstAge(director.timeline, burst, 0.2);
        const held = shardPose(burst, 2, age, true);
        for (let render = 0; render < 100; render++) {
            director.step(0.2, true);
            expect(shardPose(burst, 2, burstAge(director.timeline, burst, 0.2), true)).toEqual(held);
        }
        director.step(0.3, true);
        expect(shardPose(burst, 2, burstAge(director.timeline, burst, 0.3), true)).not.toEqual(held);
        director.clear();
        expect(director.bursts).toHaveLength(0);
        expect(director.feedback).toHaveLength(0);
        expect(director.pending).toHaveLength(0);
        // A fresh chart starts event numbering again; clear must release the old deduplication cursor.
        director.consume([event(1)], true);
        expect(director.feedback).toHaveLength(1);
    });

    test("an unseen expired burst is discarded after a large advance instead of replayed late", () => {
        const director = new EffectDirector(timeline(), 1);
        director.consume([event(1)], true);
        director.step(3, true);
        expect(director.bursts).toHaveLength(0);
        expect(director.pending).toHaveLength(0);
        expect(director.feedback).toHaveLength(0);
        director.step(3.1, true);
        expect(director.bursts).toHaveLength(0);
    });

    test("detection gaps suppress new accents and old effects cannot resurrect after the gap", () => {
        const beats = generateTimeline(30, 120).filter(beat => beat.time <= 1.5 || beat.time >= 20);
        const director = new EffectDirector(new MusicalTimeline(beats), 1);
        director.consume([event(1, { songTime: 1.04, visualTime: 1.04 })], true);
        director.step(1.2, true);
        const beforeGap = director.bursts[0]!;
        director.consume([event(2, { songTime: 2, visualTime: 2 })], true);
        expect(director.pending).toHaveLength(0);
        expect(director.bursts.find(burst => burst.id === 2)?.quiet).toBe(true);
        director.step(3.5, true);
        expect(director.bursts).toHaveLength(0);
        expect(feedbackAge(director.timeline, { ...beforeGap, birth: 1.125 }, 20.2)).toBeGreaterThanOrEqual(1);
        director.step(20.2, true);
        expect(director.bursts).toHaveLength(0);
        director.consume([event(3, { songTime: 20.24, visualTime: 20.24 })], true);
        expect(director.pending).toHaveLength(1);
    });

    test("crowded deaths keep immediate confirmations while bounded decoration merges or drops", () => {
        const director = new EffectDirector(timeline(), 1);
        director.consume(Array.from({ length: 160 }, (_, index) => event(index + 1)), true);
        expect(director.pending.length).toBeLessThanOrEqual(MAX_PENDING_BURSTS);
        expect(director.feedback).toHaveLength(MAX_FEEDBACK);
        expect(director.suppressed).toBeGreaterThan(0);
        director.step(0.13, true);
        expect(director.bursts.length).toBeLessThanOrEqual(MAX_ACTIVE_BURSTS);
        const clustered = new EffectDirector(timeline(), 1);
        clustered.consume([event(1, { x: 0 }), event(2, { x: 0.1 })], true);
        clustered.step(0.13, true);
        expect(clustered.feedback).toHaveLength(2);
        expect(clustered.bursts).toHaveLength(1);
    });

    test("active capacity prioritizes player feedback over decorative shots", () => {
        const director = new EffectDirector(timeline(), 1);
        director.consume(Array.from({ length: MAX_ACTIVE_BURSTS + 20 },
            (_, index) => event(index + 1, { kind: "shot", beatTime: 0 })), true);
        expect(director.bursts).toHaveLength(MAX_ACTIVE_BURSTS);
        director.consume([event(100, { kind: "player-hit" })], true);
        expect(director.bursts).toHaveLength(MAX_ACTIVE_BURSTS);
        expect(director.bursts.some(burst => burst.kind === "player-hit")).toBe(true);
        director.consume([event(101, { kind: "shot", beatTime: 0 })], true);
        expect(director.bursts.some(burst => burst.kind === "player-hit")).toBe(true);
        director.step(0.04, false);
        expect(director.bursts).toHaveLength(0);
        expect(director.pending).toHaveLength(0);
        expect(director.feedback.some(item => item.kind === "player-hit")).toBe(true);
    });

    test("damage number capacity cannot evict player feedback for an ordinary enemy hit", () => {
        const director = new EffectDirector(timeline(), 1);
        director.consume(Array.from({ length: MAX_FEEDBACK }, (_, index) =>
            event(index + 1, { kind: "player-hit" })), false);
        director.consume([event(MAX_FEEDBACK + 1, { kind: "hit" })], false);
        expect(director.feedback).toHaveLength(MAX_FEEDBACK);
        expect(director.feedback.every(item => item.kind === "player-hit")).toBe(true);
    });
});

describe("fixed-step cosmetic event bridge", () => {
    test("queue overflow preserves important damage facts and never modifies source events", () => {
        const { world, queue } = queueWorld();
        const shots = Array.from({ length: MAX_EVENT_QUEUE }, (_, index) =>
            Object.freeze(event(index + 1, { kind: "shot" })));
        const input = structuredClone(shots);
        publishVisualEvents(world, shots, 4, 4.05, 7, 4);
        publishVisualEvents(world, [event(300), event(301, { kind: "player-hit" })], 4.04, 4.09, 7);
        expect(queue.pending).toHaveLength(MAX_EVENT_QUEUE);
        expect(queue.pending.filter(item => item.kind === "kill")).toHaveLength(1);
        expect(queue.pending.filter(item => item.kind === "player-hit")).toHaveLength(1);
        expect(queue.pending[0]!.generation).toBe(7);
        expect(queue.pending[0]!.beatTime).toBe(4);
        expect(queue.dropped).toBe(2);
        expect(shots).toEqual(input);
        queue.pending = Array.from({ length: MAX_EVENT_QUEUE }, (_, index) =>
            event(index + 1, { kind: "player-hit" }));
        publishVisualEvents(world, [event(400, { kind: "shot" })], 4, 4, 7);
        expect(queue.pending.every(item => item.kind === "player-hit")).toBe(true);
        expect(queue.dropped).toBe(3);
    });
});

describe("analytic particle trajectories", () => {
    test("30, 60 and 144 Hz render histories produce the same musical pose", () => {
        const render = (rate: number) => {
            const director = new EffectDirector(timeline(), 1);
            director.consume([event(1, { critical: true })], true);
            for (let frame = 0; frame / rate < 0.37; frame++) director.step(frame / rate, true);
            director.step(0.37, true);
            const burst = director.bursts[0]!;
            return Array.from({ length: 16 }, (_, index) =>
                shardPose(burst, index, burstAge(director.timeline, burst, 0.37), true));
        };
        expect(render(30)).toEqual(render(60));
        expect(render(144)).toEqual(render(60));
    });

    test("reduced motion keeps a small local effect and the same event yields a stable seed", () => {
        const burst: Burst = { ...event(1), birth: 0.125, quiet: false };
        for (const age of [0, 0.2, 0.7, 1]) {
            const pose = shardPose(burst, 0, age, false);
            expect(pose.y).toBe(0.48);
            expect(Math.hypot(pose.x - burst.x, pose.z - burst.z)).toBeLessThan(0.35);
            expect(pose.rotation).toBe(shardPose(burst, 0, 0, false).rotation);
        }
        expect(shardPose(burst, 0, 1, true).scale).toBe(0);
        expect(shardPose(burst, 0, 0.4, true)).toEqual(shardPose({ ...burst }, 0, 0.4, true));
        expect(shardPose({ ...burst, generation: 2 }, 0, 0.4, true)).not.toEqual(shardPose(burst, 0, 0.4, true));
    });

    test("off, calm and differing particle budgets leave combat outcome and RNG identical", () => {
        const replay = (mode: "off" | "calm" | "low" | "high") => {
            const state = createCombat(77, { playerHealth: 1000 });
            const director = new EffectDirector(timeline(), 1);
            let rendered = 0;
            const consume = (events: CombatEvent[], position: number) => director.consume(events.map(item => ({
                ...item, songTime: position, visualTime: position, generation: 1,
            })), mode !== "off");
            for (let tick = 0; tick < 1200; tick++) {
                const position = tick / 60, phase = tick / 120;
                const player = { x: Math.cos(phase) * 5, z: Math.sin(phase) * 5 };
                if (tick % 30 === 0) {
                    const index = tick / 30;
                    const nearest = [...state.enemies].sort((a, b) =>
                        Math.hypot(a.x - player.x, a.z - player.z) - Math.hypot(b.x - player.x, b.z - player.z))[0];
                    const aim = nearest ? { x: nearest.x - player.x, z: nearest.z - player.z } : { x: 1, z: 0 };
                    consume(onCombatBeat(state, { index, barIndex: Math.floor(index / 4) }, player, aim), position);
                }
                consume(advanceCombat(state, 1 / 60, player).events, position);
                director.step(position, mode !== "off");
                for (const burst of director.bursts) {
                    for (let index = 0; index < (mode === "high" ? 16 : 8); index++) {
                        shardPose(burst, index, burstAge(director.timeline, burst, position), mode !== "calm");
                        rendered++;
                    }
                }
            }
            return { state, rendered };
        };
        const off = replay("off");
        expect(off.state.kills).toBeGreaterThan(0);
        expect(off.rendered).toBe(0);
        for (const mode of ["calm", "low", "high"] as const) {
            const result = replay(mode);
            expect(result.state).toEqual(off.state);
            expect(result.rendered).toBeGreaterThan(0);
        }
    });
});
