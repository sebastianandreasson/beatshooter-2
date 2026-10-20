import { expect, test } from "bun:test";
import {
    Body, Camera, CameraMode, createApp, lookAtRotation, Materials, MeshInstance, StandardMaterial, Transform,
} from "@dylanebert/shallot";
import { Shape } from "@dylanebert/shallot/physics";
import type { SectionAnalysis } from "../analysis/sections";
import { Arena, box } from "../arena";
import { MusicVisuals, PresentMusicalVisuals, SampleMusicalVisuals } from "../music-visuals";
import { MusicFloorState, sectionShockwave } from "../music-visuals/floor";
import { generateTimeline } from "../rhythm/timeline";
import { Session } from "../session";
import { DEMO_TRACK } from "../tracks";
import { PresentSectionEffects, SampleSectionEffects, SectionEffects } from "./index";
import { SECTION_PALETTES } from "./state";

async function fixture() {
    const app = await createApp({ defaults: false, plugins: [] });
    const { world } = app;
    const arena = world.resource(Arena), materials = world.resource(Materials);
    arena.materials.floor = materials.add(StandardMaterial({ baseColor: [0.006, 0.012, 0.018, 1] }));
    arena.materials.line = materials.add(StandardMaterial({ baseColor: [0.03, 0.09, 0.105, 1] }));
    arena.materials.wall = materials.add(StandardMaterial({ baseColor: [0.07, 0.19, 0.21, 1] }));
    arena.camera = world.create();
    world.add(arena.camera, Camera, { mode: CameraMode.Orthographic, size: 17, clearColor: 0x090f15 });
    world.add(arena.camera, Transform, {
        translation: [0, 32, 19], rotation: lookAtRotation(0, 32, 19, 0, 0, 0),
    });
    arena.floor = box(world, arena.materials.floor, [0, -0.4, 0], [37, 0.5, 37]);
    arena.lines = [
        box(world, arena.materials.line, [6, -0.135, 0], [0.035, 0.025, 36]),
        box(world, arena.materials.line, [0, -0.135, -9], [36, 0.025, 0.035]),
    ];
    const wall = box(world, arena.materials.wall, [18.5, 0.2, 0], [1, 0.8, 38]);
    const actor = box(world, arena.materials.wall, [3, 0.55, -2], [1, 1, 1]);
    for (const eid of [wall, actor]) {
        world.add(eid, Body);
        world.add(eid, Shape);
    }
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
    const poses = () => [...world.query([Transform])].map(eid => ({ eid, pose: world.get(eid, Transform) }));
    const camera = () => world.get(arena.camera, Camera)!;
    const wave = () => {
        const p = world.resource(MusicFloorState).parameters;
        return structuredClone({
            section: p.section, floor: p.floorColor, line: p.lineColor, accent: p.accentColor,
            fromFloor: p.fromFloor, fromLine: p.fromLine, fromAccent: p.fromAccent,
        });
    };
    return { app, world, arena, session, state, render, poses, camera, wave, wall, actor };
}

test("the color wave follows raw song time and freezes on pause without moving any camera or map entities", async () => {
    const f = await fixture();
    try {
        const { world, session, state, render, poses, camera, wave } = f;
        const originalCombat = structuredClone(session.combat);
        render(1);
        const originalPoses = poses(), originalSize = camera().size, originalBackground = camera().clearColor;
        render(2.2);
        expect(state.frame.progress).toBeCloseTo(0.1);
        expect(wave().fromFloor.slice(0, 3)).toEqual([...SECTION_PALETTES.intro.floor]);
        expect(wave().floor.slice(0, 3)).toEqual([...SECTION_PALETTES.chorus.floor]);
        expect(sectionShockwave(state.frame.progress, state.strength, 0, 0.01).x).toBe(1);
        expect(sectionShockwave(state.frame.progress, state.strength, 10, 0.01).x).toBe(0);
        render(3);
        expect(state.frame.progress).toBeCloseTo(0.5);
        expect(sectionShockwave(state.frame.progress, state.strength, 15, 0.01).y).toBeGreaterThan(0.8);
        expect(camera().clearColor).toBe(originalBackground);
        expect(camera().size).toBe(originalSize);
        expect(poses()).toEqual(originalPoses);

        const held = wave(), heldFrame = structuredClone(state.frame);
        session.phase = "paused";
        world.pause();
        for (let draw = 0; draw < 20; draw++) render();
        expect(wave()).toEqual(held);
        expect(state.frame).toEqual(heldFrame);
        session.preferences.settings.timingOffsetMs = 250;
        render();
        expect(world.resource(MusicVisuals).frame.position).toBe(3.25);
        expect(state.frame).toEqual(heldFrame);
        expect(wave()).toEqual(held);
        expect(poses()).toEqual(originalPoses);

        session.phase = "playing";
        world.resume();
        render(3.5);
        expect(camera().clearColor).not.toBe(originalBackground);
        render(4);
        expect(state.frame.active).toBe(false);
        expect(state.strength).toBe(0);
        expect(state.frame.palette).toEqual(SECTION_PALETTES.chorus);
        expect(wave().floor.slice(0, 3)).toEqual([...SECTION_PALETTES.chorus.floor]);
        expect(world.resource(MusicFloorState).lastInput.section!.from).toBeUndefined();
        expect(poses()).toEqual(originalPoses);
        expect(camera().size).toBe(originalSize);
        expect(session.combat).toEqual(originalCombat);
    } finally {
        f.app.dispose();
    }
});

test("Calm softens the one wave, while Off and reduced motion use a stationary palette fade", async () => {
    const f = await fixture();
    try {
        const { world, session, state, render, poses, wave } = f;
        render(3);
        const standardStrength = state.strength, originalPoses = poses();
        session.preferences.settings.effectsIntensity = "calm";
        render();
        expect(state.strength).toBeGreaterThan(0);
        expect(state.strength).toBeLessThan(standardStrength);
        expect(poses()).toEqual(originalPoses);
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
            expect(state.strength).toBe(0);
            expect(wave().section[1]).toBe(0);
            expect(wave().floor.slice(0, 3)).toEqual([...state.frame.palette.floor]);
            expect(world.resource(MusicFloorState).lastInput.section!.from).toBeUndefined();
            expect(poses()).toEqual(originalPoses);
            expect(f.camera().size).toBe(17);
        }
        session.preferences.settings.reducedFlash = false;
        session.preferences.settings.graphics = "low";
        render();
        expect(state.strength).toBe(standardStrength);
        expect(world.resource(MusicFloorState).parameters.response[2]).toBe(0);
        expect(sectionShockwave(state.frame.progress, state.strength, 15, 0.01).y).toBeGreaterThan(0.8);
        expect(poses()).toEqual(originalPoses);
    } finally {
        f.app.dispose();
    }
});

test("retry, menu and track replacement clear the wave and restore colors without creating any entities", async () => {
    const f = await fixture();
    try {
        const { world, session, state, arena, render, poses } = f;
        render(0);
        const baseline = poses();
        for (let retry = 0; retry < 5; retry++) {
            render(3);
            expect(state.strength).toBeGreaterThan(0);
            const oldTimeline = state.timeline;
            session.generation++;
            render(0);
            expect(state.timeline).not.toBe(oldTimeline);
            expect(state.strength).toBe(0);
            expect(poses()).toEqual(baseline);
        }
        render(8.8);
        expect(state.strength).toBeGreaterThan(0);
        session.phase = "menu";
        render();
        expect(state.frame.index).toBe(-1);
        expect(state.strength).toBe(0);
        expect(f.camera().clearColor).toBe(0x090f15);
        expect(poses()).toEqual(baseline);
        expect(world.resource(MusicFloorState).lastInput.section).toBeUndefined();
        expect(world.resource(Materials).get(arena.materials.wall)!.baseColor.x).toBeCloseTo(0.07);
        session.phase = "playing";
        session.track = { ...session.track, id: "replacement-no-analysis" };
        session.loaded = undefined;
        render(3);
        expect(state.frame.index).toBe(-1);
        expect(state.strength).toBe(0);
        expect(poses()).toEqual(baseline);
        expect([...world.query([MeshInstance])]).toHaveLength(5);
        expect([...world.query([Body])]).toEqual([f.wall, f.actor]);
        expect([...world.query([Shape])]).toEqual([f.wall, f.actor]);
    } finally {
        f.app.dispose();
    }
});
