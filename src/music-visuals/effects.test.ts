import { describe, expect, spyOn, test } from "bun:test";
import { createApp, Meshes, MeshInstance, Transform, type World } from "@dylanebert/shallot";
import type { MeshHandle } from "@dylanebert/shallot/mesh";
import { advanceCombat, createCombat, onCombatBeat, type CombatEvent } from "../combat";
import { generateTimeline } from "../rhythm/timeline";
import { MusicalTimeline } from "../rhythm/visual";
import {
    burstAge, damageNumberPose, EffectDirector, feedbackAge, MAX_ACTIVE_BURSTS, MAX_FEEDBACK,
    MAX_PENDING_BURSTS, shardPose, type Burst, type MusicalFeedback,
} from "./effects";
import { MAX_EVENT_QUEUE, publishVisualEvents, type MusicEvent } from "./events";
import { createParticlePool, renderParticles } from "./particles";

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

describe("musical damage numbers", () => {
    test("offbeat hits stay still until the next beat, then exit over one actual beat at every supported tempo", () => {
        for (const bpm of [20, 60, 120, 300]) {
            const beatDuration = 60 / bpm;
            for (const impactPhase of [0.01, 0.2, 0.9]) {
                const director = new EffectDirector(timeline(bpm), 1);
                const birth = beatDuration * impactPhase;
                director.consume([event(1, { kind: "hit", songTime: birth, visualTime: birth })], false);
                const feedback = director.feedback[0]!;
                for (const position of [birth, beatDuration * 0.999]) {
                    expect(damageNumberPose(director.timeline, feedback, position, true))
                        .toEqual({ progress: 0, rise: 0, scale: 0.55, opacity: 1 });
                }
                const accent = damageNumberPose(director.timeline, feedback, beatDuration, true);
                expect(accent.progress).toBeCloseTo(0);
                expect(accent.rise).toBeCloseTo(0);
                expect(accent.scale).toBeCloseTo(1.45);
                const held = damageNumberPose(director.timeline, feedback, beatDuration * 1.15, true);
                expect(held.rise).toBe(0);
                expect(held.scale).toBeGreaterThan(1.08);
                const midway = damageNumberPose(director.timeline, feedback, beatDuration * 1.5, true);
                expect(midway.progress).toBeCloseTo(0.5);
                expect(midway.rise).toBeGreaterThan(0);
                expect(midway.scale).toBe(1.08);
                expect(midway.opacity).toBe(1);
                const almostExpired = beatDuration * 1.999;
                director.step(almostExpired, false);
                expect(director.feedback).toHaveLength(1);
                expect(damageNumberPose(director.timeline, feedback, almostExpired, true).opacity).toBeLessThan(0.01);
                director.step(beatDuration * 2.001, false);
                expect(director.feedback).toHaveLength(0);
            }
        }
    });

    test("a hit landing exactly on a beat starts immediately and expires on the following beat", () => {
        for (const bpm of [20, 120, 300]) {
            const beatDuration = 60 / bpm, chart = timeline(bpm);
            const feedback: MusicalFeedback = { ...event(1), birth: beatDuration };
            expect(damageNumberPose(chart, feedback, beatDuration, true))
                .toEqual({ progress: 0, rise: 0, scale: 1.45, opacity: 1 });
            expect(damageNumberPose(chart, feedback, beatDuration * 1.5, true).progress).toBeCloseTo(0.5);
            expect(feedbackAge(chart, feedback, beatDuration * 2)).toBeCloseTo(1);
            expect(damageNumberPose(chart, feedback, beatDuration * 2, true).opacity).toBe(0);
        }
    });

    test("different offbeat impacts share the same next accent and follow changing authored intervals", () => {
        const times = [0, 0.5, 1.4, 2, 2.7, 3.2];
        const chart = new MusicalTimeline(generateTimeline(3, 120).slice(0, times.length)
            .map((beat, index) => ({ ...beat, time: times[index]! })));
        const feedback: MusicalFeedback = { ...event(1, { critical: true }), birth: 0.25 };
        const impact = damageNumberPose(chart, feedback, 0.25, true);
        expect(impact).toEqual({ progress: 0, rise: 0, scale: 0.55, opacity: 1 });
        expect(damageNumberPose(chart, feedback, 0.499, true)).toEqual(impact);
        expect(damageNumberPose(chart, feedback, 0.5, true).scale).toBe(1.6);
        const laterHit = { ...feedback, birth: 0.47 };
        for (const position of [0.5, 0.725, 0.95, 1.2, 1.4]) {
            const first = damageNumberPose(chart, feedback, position, true);
            const second = damageNumberPose(chart, laterHit, position, true);
            expect(first.progress).toBeCloseTo(second.progress);
            expect(first.rise).toBeCloseTo(second.rise);
            expect(first.scale).toBeCloseTo(second.scale);
            expect(first.opacity).toBeCloseTo(second.opacity);
        }
        // Half of the 0.9-second second interval is musical coordinate 1.5,
        // exactly one beat after this off-beat impact at coordinate 0.5.
        expect(feedbackAge(chart, feedback, 0.95)).toBeCloseTo(2 / 3);
        expect(damageNumberPose(chart, feedback, 0.95, true).progress).toBeCloseTo(0.5);
        const expired = damageNumberPose(chart, feedback, 1.4, true);
        expect(expired.progress).toBe(1);
        expect(expired.opacity).toBe(0);
        expect(expired.rise).toBe(1.15);
        const afterAccent = { ...feedback, birth: 0.51 };
        expect(damageNumberPose(chart, afterAccent, 1.399, true).rise).toBe(0);
        expect(damageNumberPose(chart, afterAccent, 1.4, true).scale).toBe(1.6);
        expect(damageNumberPose(chart, afterAccent, 1.7, true).progress).toBeCloseTo(0.5);
        expect(damageNumberPose(chart, afterAccent, 2, true).opacity).toBe(0);
    });

    test("paused numbers hold exactly, while reduced motion keeps static essential damage", () => {
        const chart = timeline();
        const feedback: MusicalFeedback = { ...event(1), birth: 0.04 };
        const pose = damageNumberPose(chart, feedback, 0.65, true);
        for (let render = 0; render < 100; render++) {
            expect(damageNumberPose(chart, feedback, 0.65, true)).toEqual(pose);
        }
        expect(damageNumberPose(chart, feedback, 0.8, true)).not.toEqual(pose);
        for (const position of [0.04, 0.3, 0.5, 0.6, 0.9]) {
            const quiet = damageNumberPose(chart, feedback, position, false);
            expect(quiet.rise).toBe(0);
            expect(quiet.scale).toBe(1);
            expect(quiet.opacity).toBeGreaterThan(0);
            expect(quiet.opacity).toBe(damageNumberPose(chart, feedback, position, true).opacity);
        }
    });

    test("gaps retire old and newly born feedback without a later resurrection", () => {
        const chart = new MusicalTimeline(generateTimeline(30, 120)
            .filter(beat => beat.time <= 1.5 || beat.time >= 20));
        const before: MusicalFeedback = { ...event(1), birth: 1.45 };
        const during: MusicalFeedback = { ...event(2), birth: 5 };
        expect(damageNumberPose(chart, before, 1.45, true).opacity).toBe(1);
        expect(feedbackAge(chart, before, 2)).toBeGreaterThanOrEqual(1);
        expect(damageNumberPose(chart, during, 5, true).opacity).toBe(1);
        expect(feedbackAge(chart, during, 5.5)).toBeGreaterThanOrEqual(1);
        for (const feedback of [before, during]) {
            expect(damageNumberPose(chart, feedback, 20.1, true).opacity).toBe(0);
        }
        const empty = new MusicalTimeline([]);
        expect(feedbackAge(empty, during, 6.5)).toBe(1);
        expect(damageNumberPose(empty, during, 6, true).rise).toBe(0);
        expect(damageNumberPose(empty, during, 6, true).scale).toBe(1);
    });
});

describe("musical level-up celebration", () => {
    test("level-ups land on the next nearby subdivision, without damage numbers, and live for two beats", () => {
        const director = new EffectDirector(timeline(), 1);
        director.consume([event(1, { kind: "level-up", amount: 2 })], true);
        expect(director.feedback).toHaveLength(0);
        expect(director.pending).toHaveLength(1);
        expect(director.pending[0]!.birth).toBeCloseTo(0.125);
        director.step(0.124, true);
        expect(director.bursts).toHaveLength(0);
        director.step(0.125, true);
        const burst = director.bursts[0]!;
        expect(burstAge(director.timeline, burst, 0.625)).toBeCloseTo(0.5);
        expect(burstAge(director.timeline, burst, 1.125)).toBeCloseTo(1);
        director.step(1.125, true);
        expect(director.bursts).toHaveLength(0);
    });

    test("calibration that cannot provide a timely accent gives a quiet confirmation; off gives none", () => {
        const director = new EffectDirector(timeline(), 1);
        director.consume([event(1, {
            kind: "level-up", songTime: 1.04, visualTime: 0.79,
        })], true);
        expect(director.pending).toHaveLength(0);
        expect(director.bursts[0]!.quiet).toBe(true);
        expect(director.bursts[0]!.birth).toBe(0.79);
        const burst = director.bursts[0]!;
        const pose = shardPose(burst, 2, 0.4, true);
        expect(pose.y).toBe(0.48);
        expect(Math.hypot(pose.x - burst.x, pose.z - burst.z)).toBeCloseTo(0.2);
        director.clear();
        director.consume([event(2, { kind: "level-up" })], false);
        expect(director.bursts).toHaveLength(0);
        expect(director.pending).toHaveLength(0);
        expect(director.feedback).toHaveLength(0);
    });

    test("level-up survives a crowded death queue and cosmetic event bridge", () => {
        const director = new EffectDirector(timeline(), 1);
        director.consume(Array.from({ length: MAX_PENDING_BURSTS }, (_, index) => event(index + 1)), true);
        director.consume([event(100, { kind: "level-up" })], true);
        expect(director.pending).toHaveLength(MAX_PENDING_BURSTS);
        expect(director.pending.filter(burst => burst.kind === "level-up")).toHaveLength(1);
        director.consume([event(101)], true);
        expect(director.pending.some(burst => burst.kind === "level-up")).toBe(true);
        expect(director.feedback.every(item => item.kind !== "level-up")).toBe(true);

        const { world, queue } = queueWorld();
        queue.pending = Array.from({ length: MAX_EVENT_QUEUE }, (_, index) => event(index + 1));
        publishVisualEvents(world, [event(1000, { kind: "level-up" })], 0.04, 0.04, 1);
        expect(queue.pending).toHaveLength(MAX_EVENT_QUEUE);
        expect(queue.pending.some(item => item.kind === "level-up")).toBe(true);
    });

    test("the level-up pool stays bounded, freezes with music time, and reduces its effect for comfort modes", async () => {
        const app = await createApp({ defaults: false, plugins: [] });
        // Exercise real ECS ownership and transform storage without a GPU upload.
        const meshUpload = spyOn(app.world.resource(Meshes), "add").mockReturnValue(1 as MeshHandle);
        try {
            const { world } = app, pool = createParticlePool(world);
            const director = new EffectDirector(timeline(), 1);
            director.consume([event(1, { kind: "level-up" })], true);
            director.step(0.3, true);
            renderParticles(world, pool, director, 0.3, true, true, 0.85);
            expect(pool.activeShards).toBe(24);
            expect(pool.activeRings).toBe(2);
            const translation = world.storage(Transform).translation;
            const position = () => ({
                x: translation.x.get(pool.shards[0]!), y: translation.y.get(pool.shards[0]!),
                z: translation.z.get(pool.shards[0]!),
            });
            const held = position();
            for (let render = 0; render < 20; render++) {
                renderParticles(world, pool, director, 0.3, true, true, 0.85);
                expect(position()).toEqual(held);
            }
            renderParticles(world, pool, director, 0.4, false, true, 0.85);
            expect(pool.activeShards).toBe(12);
            expect(position()).not.toEqual(held);
            renderParticles(world, pool, director, 0.4, true, true, 0.3);
            expect(pool.activeShards).toBe(12);
            expect(pool.activeRings).toBe(1);
            renderParticles(world, pool, director, 0.4, true, false, 0.18);
            expect(pool.activeShards).toBe(6);
            expect(pool.activeRings).toBe(1);
            expect(position().y).toBeCloseTo(0.48);
            renderParticles(world, pool, director, 0.4, true, false, 0);
            expect(pool.visible.size).toBe(0);
            expect(pool.activeShards).toBe(0);
            expect(pool.activeRings).toBe(0);
            expect(world.has(pool.shards[0]!, MeshInstance)).toBe(false);

            director.consume(Array.from({ length: 30 }, (_, index) =>
                event(index + 2, { kind: "level-up" })), true);
            director.step(0.3, true);
            renderParticles(world, pool, director, 0.3, true, true, 0.85);
            expect(pool.activeShards).toBe(256);
            expect(pool.activeRings).toBe(8);
            expect(pool.visible.size).toBe(264);
            renderParticles(world, pool, director, 0.3, false, true, 0.85);
            expect(pool.activeShards).toBe(64);
            expect(pool.visible.size).toBeLessThanOrEqual(72);
        } finally {
            meshUpload.mockRestore();
            app.dispose();
        }
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
