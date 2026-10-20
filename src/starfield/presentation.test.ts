import { expect, test } from "bun:test";
import { Body, Camera, createApp, MeshInstance, Transform } from "@dylanebert/shallot";
import { Shape } from "@dylanebert/shallot/physics";
import type { SectionAnalysis } from "../analysis/sections";
import { Arena } from "../arena";
import { MusicVisuals, SampleMusicalVisuals } from "../music-visuals";
import { generateTimeline } from "../rhythm/timeline";
import { SampleSectionEffects } from "../section-effects";
import { Session } from "../session";
import { DEMO_TRACK } from "../tracks";
import { PresentStarfield, SampleStarfield, Starfield, StarfieldPlugin } from "./index";
import { LOW_DETAIL_STAR_COUNT, STAR_COUNT } from "./pose";

async function fixture() {
    const app = await createApp({ defaults: false, plugins: [] });
    const { world } = app, session = world.resource(Session), arena = world.resource(Arena);
    arena.camera = world.create();
    world.add(arena.camera, Camera, { size: 17 });
    world.add(arena.camera, Transform, { translation: [0, 32, 19] });
    const actor = world.create();
    world.add(actor, Transform, { translation: [4, 0.55, -3] });
    world.add(actor, Body);
    world.add(actor, Shape);
    await StarfieldPlugin.initialize!(world);
    const structure: SectionAnalysis = {
        version: 1, analyzerVersion: "starfield-fixture", duration: 12, elapsedMs: 0, backend: "wasm",
        sections: [{ start: 0, end: 2, label: "intro" }, { start: 2, end: 12, label: "chorus" }],
    };
    session.track = { ...DEMO_TRACK, duration: 12, beats: generateTimeline(12, 120) };
    session.loaded = { manifest: session.track, structure, buffer: { duration: 12 } as AudioBuffer, dispose() {} };
    session.phase = "playing";
    Object.assign(session.preferences.settings, {
        effectsIntensity: "standard", graphics: "high", reducedFlash: false, timingOffsetMs: 0,
    });
    const state = world.resource(Starfield);
    const render = (position = session.position) => {
        session.position = position;
        session.visualPosition = position + session.preferences.settings.timingOffsetMs / 1000;
        SampleMusicalVisuals.update!(world);
        SampleSectionEffects.update!(world);
        SampleStarfield.update!(world);
        PresentStarfield.update!(world);
    };
    const poses = () => state.stars.map(eid => world.get(eid, Transform));
    return { app, world, session, arena, state, actor, render, poses };
}

test("a fixed nonphysical star pool flows normally, boosts with sections and freezes exactly with the raw song clock", async () => {
    const f = await fixture();
    try {
        const { world, state, session, render, poses } = f;
        const actorBefore = world.get(f.actor, Transform), cameraBefore = world.get(f.arena.camera, Transform);
        const pool = [...state.stars];
        expect(pool).toHaveLength(STAR_COUNT);
        for (const eid of pool) {
            expect(world.has(eid, MeshInstance)).toBe(true);
            expect(world.has(eid, Body)).toBe(false);
            expect(world.has(eid, Shape)).toBe(false);
        }
        render(1);
        expect(state.distance).toBe(5);
        expect(state.speed).toBe(5);
        expect(state.boost).toBe(0);
        const normal = poses();
        render(1.5);
        expect(poses()).not.toEqual(normal);
        render(3);
        expect(state.speed).toBeCloseTo(125);
        expect(state.speed / 5).toBe(25);
        expect(state.boost).toBeCloseTo(1);
        expect(state.distance).toBeGreaterThan(15);
        expect(Math.max(...poses().map(pose => pose!.scale[1]))).toBeGreaterThan(4);
        const held = poses(), heldDistance = state.distance;
        session.phase = "paused";
        world.pause();
        for (let frame = 0; frame < 20; frame++) render();
        expect(poses()).toEqual(held);
        expect(state.distance).toBe(heldDistance);
        session.preferences.settings.timingOffsetMs = 250;
        render();
        expect(world.resource(MusicVisuals).frame.position).toBe(3.25);
        expect(poses()).toEqual(held);
        expect(state.distance).toBe(heldDistance);
        expect(state.stars).toEqual(pool);
        expect(world.get(f.actor, Transform)).toEqual(actorBefore);
        expect(world.get(f.arena.camera, Transform)).toEqual(cameraBefore);
        expect([...world.query([Body])]).toEqual([f.actor]);
        expect([...world.query([Shape])]).toEqual([f.actor]);
    } finally {
        f.app.dispose();
    }
});

test("Calm limits acceleration, low graphics halves visible work, and comfort modes hold the seed layout", async () => {
    const f = await fixture();
    try {
        const { world, state, session, render, poses } = f;
        render(0);
        const seedLayout = poses();
        render(3);
        const fullDistance = state.distance;
        session.preferences.settings.effectsIntensity = "calm";
        render();
        expect(state.speed).toBeCloseTo(26.6);
        expect(state.distance).toBeCloseTo(15 + (fullDistance - 15) * 0.18);
        session.preferences.settings.graphics = "low";
        render();
        expect(state.visibleStars).toBeLessThanOrEqual(LOW_DETAIL_STAR_COUNT);
        expect(poses().slice(LOW_DETAIL_STAR_COUNT).every(pose => pose!.scale.every(value => value === 0))).toBe(true);
        expect(state.stars).toHaveLength(STAR_COUNT);
        session.preferences.settings.graphics = "high";
        const changes = [
            () => { session.preferences.settings.effectsIntensity = "off"; },
            () => {
                session.preferences.settings.effectsIntensity = "standard";
                world.resource(MusicVisuals).osReducedMotion = true;
            },
            () => {
                world.resource(MusicVisuals).osReducedMotion = false;
                session.preferences.settings.reducedFlash = true;
            },
        ];
        for (const change of changes) {
            change();
            render(3.4);
            expect(state.motionAllowed).toBe(false);
            expect(state.distance).toBe(0);
            expect(state.speed).toBe(0);
            expect(state.boost).toBe(0);
            expect(poses()).toEqual(seedLayout);
            render(5);
            expect(poses()).toEqual(seedLayout);
        }
    } finally {
        f.app.dispose();
    }
});

test("ordinary songs still flow and retry/menu reuse all stars without carrying old boosts", async () => {
    const f = await fixture();
    try {
        const { state, session, render, poses, world } = f;
        const pool = [...state.stars];
        render(0);
        const seedLayout = poses();
        for (let retry = 0; retry < 5; retry++) {
            render(3);
            expect(state.speed).toBeGreaterThan(5);
            const oldTimeline = state.timeline;
            session.generation++;
            render(0);
            expect(state.timeline).not.toBe(oldTimeline);
            expect(state.distance).toBe(0);
            expect(state.speed).toBe(5);
            expect(poses()).toEqual(seedLayout);
            expect(state.stars).toEqual(pool);
        }
        session.loaded = undefined;
        session.track = { ...session.track, id: "no-section-song" };
        render(10);
        expect(state.distance).toBe(50);
        expect(state.speed).toBe(5);
        expect(state.boost).toBe(0);
        session.phase = "menu";
        render();
        expect(state.speed).toBe(0);
        expect(poses()).toEqual(seedLayout);
        expect(state.stars).toEqual(pool);
        expect([...world.query([MeshInstance])]).toHaveLength(STAR_COUNT);
    } finally {
        f.app.dispose();
    }
});
