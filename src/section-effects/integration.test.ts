import { expect, test } from "bun:test";
import {
    Body, Camera, CameraMode, createApp, lookAtRotation, Materials, MeshInstance, StandardMaterial, Transform,
} from "@dylanebert/shallot";
import { Shape } from "@dylanebert/shallot/physics";
import type { SectionAnalysis } from "../analysis/sections";
import { Arena, box } from "../arena";
import { MusicVisuals, PresentMusicalVisuals, SampleMusicalVisuals } from "../music-visuals";
import { MusicFloorState } from "../music-visuals/floor";
import { generateTimeline } from "../rhythm/timeline";
import { Session } from "../session";
import { DEMO_TRACK } from "../tracks";
import { PresentSectionEffects, SampleSectionEffects, SectionEffects, SectionEffectsPlugin } from "./index";
import { SECTION_PALETTES } from "./state";

async function fixture() {
    const app = await createApp({ defaults: false, plugins: [] });
    const { world } = app;
    const arena = world.resource(Arena);
    const materials = world.resource(Materials);
    arena.materials.floor = materials.add(StandardMaterial({ baseColor: [0.006, 0.012, 0.018, 1] }));
    arena.materials.line = materials.add(StandardMaterial({ baseColor: [0.03, 0.09, 0.105, 1] }));
    arena.materials.wall = materials.add(StandardMaterial({ baseColor: [0.07, 0.19, 0.21, 1] }));
    arena.camera = world.create();
    world.add(arena.camera, Camera, {
        mode: CameraMode.Orthographic, size: 17, clearColor: 0x090f15,
    });
    world.add(arena.camera, Transform, {
        translation: [0, 32, 19], rotation: lookAtRotation(0, 32, 19, 0, 0, 0),
    });
    arena.floor = box(world, arena.materials.floor, [0, -0.4, 0], [37, 0.5, 37]);
    arena.lines = [
        box(world, arena.materials.line, [6, -0.135, 0], [0.035, 0.025, 36]),
        box(world, arena.materials.line, [0, -0.135, -9], [36, 0.025, 0.035]),
    ];
    for (const eid of [arena.floor, ...arena.lines]) {
        arena.mapVisuals.set(eid, [...world.get(eid, Transform)!.translation]);
    }
    const wall = box(world, arena.materials.wall, [18.5, 0.2, 0], [1, 0.8, 38]);
    const actor = box(world, arena.materials.wall, [3, 0.55, -2], [1, 1, 1]);
    for (const eid of [wall, actor]) {
        world.add(eid, Body);
        world.add(eid, Shape);
    }
    await SectionEffectsPlugin.initialize!(world);
    const session = world.resource(Session);
    const structure: SectionAnalysis = {
        version: 1, analyzerVersion: "integration-fixture", duration: 12, elapsedMs: 0, backend: "wasm",
        sections: [
            { start: 0, end: 2, label: "intro" },
            { start: 2, end: 8, label: "chorus" },
            { start: 8, end: 12, label: "verse" },
        ],
    };
    session.track = { ...DEMO_TRACK, duration: 12, beats: generateTimeline(12, 120) };
    session.loaded = {
        manifest: session.track, structure, buffer: { duration: 12 } as AudioBuffer, dispose() {},
    };
    session.phase = "playing";
    Object.assign(session.preferences.settings, {
        effectsIntensity: "standard", graphics: "high", reducedFlash: false, timingOffsetMs: 0,
    });
    const state = world.resource(SectionEffects);
    const render = (position = session.position) => {
        session.position = position;
        session.visualPosition = position + session.preferences.settings.timingOffsetMs / 1000;
        SampleMusicalVisuals.update!(world);
        SampleSectionEffects.update!(world);
        PresentSectionEffects.update!(world);
        PresentMusicalVisuals.update!(world);
    };
    const pose = () => ({
        rotation: world.get(arena.camera, Transform)!.rotation,
        size: world.get(arena.camera, Camera)!.size,
        clearColor: world.get(arena.camera, Camera)!.clearColor,
        map: [...arena.mapVisuals.keys()].map(eid => world.get(eid, Transform)),
        wall: world.get(wall, Transform),
        actor: world.get(actor, Transform),
        portals: state.portals.map(eid => world.get(eid, Transform)),
    });
    const portalWidths = () => state.portals.map(eid => {
        const scale = world.get(eid, Transform)!.scale;
        return Math.min(scale[0], scale[2]);
    });
    return { app, world, arena, session, state, render, pose, portalWidths, wall, actor };
}

test("the floor turns using raw song time while the camera, actors and walls stay fixed, and pauses freeze the effect", async () => {
    const f = await fixture();
    try {
        const { world, session, state, arena, render, pose } = f;
        const originalCombat = structuredClone(session.combat);
        render(1);
        const original = pose();
        expect(state.roll).toBe(0);
        expect(state.zoom).toBe(1);
        expect(state.mapRoll).toBe(0);
        render(3);
        expect(state.frame.progress).toBeCloseTo(0.5);
        expect(state.mapRoll).toBeCloseTo(Math.PI);
        expect(state.mapDrop).toBeGreaterThan(0);
        expect(state.roll).toBe(0);
        expect(state.zoom).toBe(1);
        expect(pose().rotation).toEqual(original.rotation);
        expect(pose().size).toBe(original.size);
        expect(pose().wall).toEqual(original.wall);
        expect(pose().actor).toEqual(original.actor);
        // The floor's local right vector now points left: only this visual layer flips.
        const q = world.get(arena.floor, Transform)!.rotation;
        expect(1 - 2 * (q[1] ** 2 + q[2] ** 2)).toBeCloseTo(-1);
        expect(pose().map).not.toEqual(original.map);
        const floor = world.resource(MusicFloorState);
        expect(floor.parameters.map[0]).toBeCloseTo(-1);
        expect(floor.parameters.map[2]).toBe(state.mapDrop);
        expect(f.portalWidths().filter(width => width > 0)).toHaveLength(12);

        const held = structuredClone(pose());
        const heldFrame = structuredClone(state.frame);
        session.phase = "paused";
        world.pause();
        for (let draw = 0; draw < 20; draw++) render();
        expect(pose()).toEqual(held);
        expect(state.frame).toEqual(heldFrame);
        session.preferences.settings.timingOffsetMs = 250;
        render();
        expect(world.resource(MusicVisuals).frame.position).toBe(3.25);
        expect(state.frame).toEqual(heldFrame);
        expect(pose()).toEqual(held);

        session.phase = "playing";
        world.resume();
        for (const position of [2.1, 2.5, 2.9, 3.1, 3.5, 3.9]) {
            render(position);
            const map = world.get(arena.floor, Transform)!;
            const [, , qz, qw] = map.rotation;
            const sine = 2 * qz * qw, cosine = 1 - 2 * qz * qz;
            // Even when edge-on, every floor-box corner stays below the actors' plane.
            const highestCorner = map.translation[1] + 18.5 * Math.abs(sine) + 0.25 * Math.abs(cosine);
            expect(highestCorner).toBeLessThanOrEqual(-0.14999);
            expect(pose().rotation).toEqual(original.rotation);
            expect(pose().wall).toEqual(original.wall);
            expect(pose().actor).toEqual(original.actor);
        }
        render(4);
        expect(state.frame.active).toBe(false);
        expect(state.mapRoll).toBe(0);
        expect(state.mapDrop).toBe(0);
        expect(pose().rotation).toEqual(original.rotation);
        expect(pose().size).toBe(original.size);
        expect(pose().map).toEqual(original.map);
        expect(pose().wall).toEqual(original.wall);
        expect(pose().actor).toEqual(original.actor);
        expect(state.frame.palette).toEqual(SECTION_PALETTES.chorus);
        expect(world.resource(MusicFloorState).parameters.floorColor.slice(0, 3))
            .toEqual([...SECTION_PALETTES.chorus.floor]);
        expect(f.portalWidths().every(width => width === 0)).toBe(true);
        expect(session.combat).toEqual(originalCombat);
    } finally {
        f.app.dispose();
    }
});

test("Calm limits the floor tilt, while Off and reduced motion retain only the section colors", async () => {
    const f = await fixture();
    try {
        const { world, session, state, render, pose } = f;
        render(2.5);
        const standardRoll = state.mapRoll;
        const standardCamera = pose().rotation;
        session.preferences.settings.effectsIntensity = "calm";
        render();
        expect(Math.abs(state.mapRoll)).toBeCloseTo(0.08);
        expect(Math.abs(state.mapRoll)).toBeLessThan(Math.abs(standardRoll));
        expect(pose().rotation).toEqual(standardCamera);
        expect(pose().size).toBe(17);
        expect(state.mapDrop).toBeGreaterThan(0);
        const palette = state.frame.palette;
        const cameraColor = pose().clearColor;
        const checks: Array<() => void> = [
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
        for (const change of checks) {
            change();
            render();
            expect(state.roll).toBe(0);
            expect(state.zoom).toBe(1);
            expect(state.mapRoll).toBe(0);
            expect(state.mapDrop).toBe(0);
            expect(state.strength).toBe(0);
            expect(state.frame.palette).toEqual(palette);
            expect(pose().clearColor).toBe(cameraColor);
            expect(f.portalWidths().every(width => width === 0)).toBe(true);
            expect(world.resource(MusicFloorState).parameters.section[1]).toBe(0);
            expect(world.resource(MusicFloorState).parameters.floorColor.slice(0, 3)).toEqual([...palette.floor]);
        }
        session.preferences.settings.reducedFlash = false;
        session.preferences.settings.graphics = "low";
        render();
        expect(f.portalWidths().slice(0, 4).every(width => width > 0)).toBe(true);
        expect(f.portalWidths().slice(4).every(width => width === 0)).toBe(true);
        expect(world.resource(MusicFloorState).parameters.response[2]).toBe(0);
    } finally {
        f.app.dispose();
    }
});

test("retry, track replacement and menu restore the floor without leaking or moving physical entities", async () => {
    const f = await fixture();
    try {
        const { world, session, state, arena, render, pose } = f;
        const pool = [...state.portals];
        expect(pool).toHaveLength(12);
        expect(new Set(pool).size).toBe(12);
        for (const eid of [...pool, ...arena.mapVisuals.keys()]) {
            expect(world.has(eid, MeshInstance)).toBe(true);
            expect(world.has(eid, Body)).toBe(false);
            expect(world.has(eid, Shape)).toBe(false);
        }
        render(0);
        const baseline = pose();
        for (let retry = 0; retry < 5; retry++) {
            render(3);
            expect(state.mapRoll).toBeCloseTo(Math.PI);
            const oldTimeline = state.timeline;
            session.generation++;
            render(0);
            expect(state.timeline).not.toBe(oldTimeline);
            expect(state.mapRoll).toBe(0);
            expect(state.mapDrop).toBe(0);
            expect(pose().rotation).toEqual(baseline.rotation);
            expect(pose().size).toBe(baseline.size);
            expect(pose().map).toEqual(baseline.map);
            expect(pose().wall).toEqual(baseline.wall);
            expect(pose().actor).toEqual(baseline.actor);
            expect(state.portals).toEqual(pool);
        }
        render(8.8);
        expect(state.mapRoll).not.toBe(0);
        session.phase = "menu";
        render();
        expect(state.frame.index).toBe(-1);
        expect(state.roll).toBe(0);
        expect(state.zoom).toBe(1);
        expect(state.mapRoll).toBe(0);
        expect(state.mapDrop).toBe(0);
        expect(pose().rotation).toEqual(baseline.rotation);
        expect(pose().map).toEqual(baseline.map);
        expect(pose().wall).toEqual(baseline.wall);
        expect(pose().actor).toEqual(baseline.actor);
        expect(pose().clearColor).toBe(0x090f15);
        expect(f.portalWidths().every(width => width === 0)).toBe(true);
        expect(world.resource(MusicFloorState).lastInput.section).toBeUndefined();
        expect(world.resource(Materials).get(arena.materials.wall)!.baseColor.x).toBeCloseTo(0.07);

        session.phase = "playing";
        session.track = { ...session.track, id: "replacement-no-analysis" };
        session.loaded = undefined;
        render(3);
        expect(state.frame.index).toBe(-1);
        expect(state.mapRoll).toBe(0);
        expect(pose().rotation).toEqual(baseline.rotation);
        expect(pose().map).toEqual(baseline.map);
        expect(state.portals).toEqual(pool);
        expect([...world.query([MeshInstance])]).toHaveLength(17);
        expect([...world.query([Body])]).toEqual([f.wall, f.actor]);
        expect([...world.query([Shape])]).toEqual([f.wall, f.actor]);
    } finally {
        f.app.dispose();
    }
});
